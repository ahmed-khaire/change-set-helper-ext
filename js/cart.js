// ---------------------------------------------------------------------------
// Change Set Helper — Cart module (Phase 3)
//
// Solves "switching component type loses my selections" by persisting checkbox
// state across type switches in chrome.storage.local, surfacing a floating
// cart panel, and streaming pending selections to Salesforce's native Add
// Components endpoint in batches via a background worker so large (1k+) carts
// submit without blocking the user's navigation.
//
// State layout (chrome.storage.local):
//   cshCart = {
//     [changeSetId]: {
//       host, createdAt,
//       items: [
//         { uid, type, salesforceId, name, status, batchId, error }
//       ],
//       form: {                    // cached per-type form-shape snapshot
//         [type]: { action, hidden: {...}, submitName, submitValue, capturedAt }
//       }
//     }
//   }
//   cshJobs = {
//     [jobId]: { changeSetId, type, ids: [...], status, attempt, error, startedAt }
//   }
//
// Item statuses:
//   staged       — user checked it, awaiting submit
//   submitting   — part of an in-flight batch
//   done         — confirmed added to change set
//   failed       — last attempt failed; see .error
// ---------------------------------------------------------------------------

(function () {
    var CART_KEY = 'cshCart';
    var JOBS_KEY = 'cshJobs';
    var SYNC_STATE_KEY = 'cshCartAuthoritativeSync';

    var MAX_ATTEMPTS = 3;
    var RETRY_BASE_MS = 2000;
    var AUTHORITATIVE_SYNC_FRESH_MS = 10 * 60 * 1000;
    var AUTHORITATIVE_SYNC_RUNNING_TTL_MS = 15 * 60 * 1000;

    // -----------------------------------------------------------------------
    // Extension-alive guard
    //
    // When the user updates/reloads the extension, every content script on
    // every tab becomes orphaned: chrome.runtime.id turns undefined and every
    // subsequent chrome.* call throws "Extension context invalidated". Before
    // this guard, the render pipeline surfaced that error hundreds of times
    // (once per mutation) and the cart UI silently froze.
    //
    // We now check cshExtAlive() before touching chrome.*, flip extDead once
    // when it first reports false, and show a one-time refresh banner
    // (renderExtDeadBanner) instead of re-throwing.
    // -----------------------------------------------------------------------
    var extDead = false;
    function cshExtAlive() {
        try {
            return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
        } catch (_) { return false; }
    }
    function markExtDead() {
        if (extDead) return;
        extDead = true;
        // Wake the render pipeline so the refresh banner paints even if no
        // other mutation is queued (e.g., user just opened the page on a
        // stale content script).
        try { renderPanel(); } catch (_) {}
    }

    // -----------------------------------------------------------------------
    // Storage primitives
    // -----------------------------------------------------------------------
    function storageGet(keys) {
        return new Promise(function (resolve) {
            if (!cshExtAlive()) { markExtDead(); resolve({}); return; }
            try {
                chrome.storage.local.get(keys, function (items) {
                    if (chrome.runtime.lastError) { markExtDead(); resolve({}); return; }
                    resolve(items || {});
                });
            } catch (_) { markExtDead(); resolve({}); }
        });
    }
    // Reason string for the most recent failed write, read by flushNow so it
    // can tell the user what actually went wrong. Cleared on the next success.
    var lastStorageError = null;
    function storageSet(obj) {
        return new Promise(function (resolve) {
            if (!cshExtAlive()) { markExtDead(); resolve(false); return; }
            try {
                chrome.storage.local.set(obj, function () {
                    var err = chrome.runtime.lastError;
                    if (err) {
                        var msg = err.message || 'unknown storage error';
                        // A quota failure is not extension death — flipping
                        // the "Extension was reloaded" banner would be wrong
                        // and non-actionable. Surface what the user can
                        // actually do about it instead.
                        if (/quota|QUOTA_BYTES/i.test(msg)) {
                            lastStorageError = 'Cart storage is full (browser limit reached).';
                            window.cshToast && window.cshToast.show(
                                'Cart storage is full — remove completed items or clear the cart, then try again.',
                                { type: 'error', duration: 8000 }
                            );
                        } else if (/context invalidated|Extension context/i.test(msg)) {
                            // Genuine orphaned content script — the reload
                            // banner IS the right response here.
                            lastStorageError = msg;
                            markExtDead();
                        } else {
                            // Any other write failure: report it honestly
                            // rather than mislabelling it as an extension
                            // reload, which sent users chasing the wrong fix.
                            lastStorageError = msg;
                        }
                        resolve(false);
                        return;
                    }
                    lastStorageError = null;
                    resolve(true);
                });
            } catch (e) {
                var thrown = (e && e.message) || String(e);
                lastStorageError = thrown;
                // Same classification as the callback path above — a synchronous
                // throw that isn't context invalidation shouldn't raise the
                // "Extension was reloaded" banner either.
                if (/context invalidated|Extension context/i.test(thrown)) {
                    markExtDead();
                }
                resolve(false);
            }
        });
    }

    function uniqueSyncKeys(keys) {
        var out = [];
        var seen = {};
        (keys || []).forEach(function (k) {
            if (!k || seen[k]) return;
            seen[k] = true;
            out.push(k);
        });
        return out;
    }

    function syncStateKey(id) {
        return String(serverUrl || location.host || '') + '::' + id;
    }

    async function readAuthoritativeSyncState() {
        var s = await storageGet([SYNC_STATE_KEY]);
        return s[SYNC_STATE_KEY] || {};
    }

    async function writeAuthoritativeSyncState(state) {
        await storageSet({ [SYNC_STATE_KEY]: state || {} });
    }

    function findFreshSyncEntry(state, keys, now) {
        for (var i = 0; i < keys.length; i++) {
            var entry = state[syncStateKey(keys[i])];
            if (entry && entry.completedAt && (now - entry.completedAt) < AUTHORITATIVE_SYNC_FRESH_MS) {
                return entry;
            }
        }
        return null;
    }

    function findRunningSyncEntry(state, keys, now) {
        for (var i = 0; i < keys.length; i++) {
            var entry = state[syncStateKey(keys[i])];
            if (entry && entry.running && entry.startedAt &&
                    (now - entry.startedAt) < AUTHORITATIVE_SYNC_RUNNING_TTL_MS) {
                return entry;
            }
        }
        return null;
    }

    async function beginAuthoritativeSync(keys, opts) {
        opts = opts || {};
        keys = uniqueSyncKeys(keys);
        if (!keys.length) return { started: false, reason: 'no-keys' };
        var state = await readAuthoritativeSyncState();
        var now = Date.now();
        var running = findRunningSyncEntry(state, keys, now);
        if (running && !opts.force) {
            return { started: false, reason: 'running', entry: running };
        }
        var fresh = findFreshSyncEntry(state, keys, now);
        if (fresh && !opts.force) {
            return { started: false, reason: 'fresh', entry: fresh };
        }
        if (!opts.force) {
            state = await readAuthoritativeSyncState();
            running = findRunningSyncEntry(state, keys, Date.now());
            if (running) {
                return { started: false, reason: 'running', entry: running };
            }
            fresh = findFreshSyncEntry(state, keys, Date.now());
            if (fresh) {
                return { started: false, reason: 'fresh', entry: fresh };
            }
        }
        var claimId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
        var marker = {
            running: true,
            startedAt: now,
            host: serverUrl || location.host || '',
            keys: keys,
            claimId: claimId
        };
        keys.forEach(function (k) {
            state[syncStateKey(k)] = Object.assign({}, state[syncStateKey(k)] || {}, marker);
        });
        await writeAuthoritativeSyncState(state);
        var verify = await readAuthoritativeSyncState();
        for (var i = 0; i < keys.length; i++) {
            var entry = verify[syncStateKey(keys[i])];
            if (!entry || entry.claimId !== claimId) {
                return { started: false, reason: 'running', entry: entry || null };
            }
        }
        return { started: true, keys: keys };
    }

    async function finishAuthoritativeSync(keys, count) {
        keys = uniqueSyncKeys(keys);
        if (!keys.length) return;
        var state = await readAuthoritativeSyncState();
        var now = Date.now();
        keys.forEach(function (k) {
            state[syncStateKey(k)] = {
                running: false,
                startedAt: state[syncStateKey(k)] && state[syncStateKey(k)].startedAt,
                completedAt: now,
                count: count || 0,
                host: serverUrl || location.host || '',
                keys: keys
            };
        });
        await writeAuthoritativeSyncState(state);
    }

    async function failAuthoritativeSync(keys, error) {
        keys = uniqueSyncKeys(keys);
        if (!keys.length) return;
        var state = await readAuthoritativeSyncState();
        var now = Date.now();
        keys.forEach(function (k) {
            var prev = state[syncStateKey(k)] || {};
            prev.running = false;
            prev.failedAt = now;
            prev.error = error || 'Sync failed';
            state[syncStateKey(k)] = prev;
        });
        await writeAuthoritativeSyncState(state);
    }

    // Debounced write layer. saveCart() used to fire a full-blob chrome.storage
    // write per mutation; during background sync inserting hundreds of items
    // that's a death-by-a-thousand-cuts. We now hold the latest snapshot in
    // pendingAll and flush it once per FLUSH_DEBOUNCE_MS, collapsing bursts
    // into a single IO. getCart() prefers pendingAll when present so the
    // same-tab read-after-write still sees the latest data without waiting
    // for the disk write.
    var FLUSH_DEBOUNCE_MS = 150;
    var pendingAll = null;
    var flushTimer = null;
    // Cross-tab merge bookkeeping. Content scripts run in every Setup tab
    // (all_frames), so two tabs can hold the same change set at once. A
    // blind full-blob write from one tab would clobber whatever the other
    // tab flushed between our read and our write, so flushNow() re-reads
    // storage and merges before writing. Deletions need explicit tracking
    // or the merge would resurrect them from the other tab's copy:
    //   removedUids     — item uids this tab deleted since its last flush.
    //   replacedCartIds — change sets this tab rewrote wholesale (clear-all,
    //                     mergeRelatedCarts); our version wins outright.
    var removedUids = {};
    var replacedCartIds = {};
    // Set when a flush could not write to disk, so the panel can warn that the
    // cart it is displaying only exists in memory. Null when storage is
    // healthy.
    var persistFailure = null;
    // Bumped by saveCart so an in-flight flush can tell whether a newer
    // mutation landed while its read/write was awaiting — if so it must not
    // clear pendingAll/tombstones out from under that mutation's own flush.
    var flushGen = 0;
    var flushInFlight = null;

    // Every item deletion routes through here so the flush-time merge knows
    // the row is gone on purpose. Filters cart.items with `shouldRemove`,
    // tombstones each dropped uid, and returns the dropped rows.
    function dropCartItems(cart, shouldRemove) {
        var dropped = [];
        cart.items = cart.items.filter(function (it) {
            if (shouldRemove(it)) { dropped.push(it); return false; }
            return true;
        });
        dropped.forEach(function (it) {
            if (it && it.uid) removedUids[it.uid] = true;
        });
        return dropped;
    }

    // Wholesale replacement — this tab's items array for the change set is
    // authoritative; the merge must not pull rows back in from disk.
    function markCartReplaced(changeSetId) {
        if (changeSetId) replacedCartIds[changeSetId] = true;
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(function () {
            flushTimer = null;
            flushNow();
        }, FLUSH_DEBOUNCE_MS);
    }

    // Reconcile our snapshot with whatever is on disk at write time. Change
    // sets only on disk are kept as-is (another tab owns them); change sets
    // we replaced wholesale take our version; everything else merges per
    // item uid — our row wins on a shared uid, disk-only rows survive
    // unless we tombstoned them (deliberate removal) or they duplicate a
    // component we already hold (same 15-char salesforceId staged
    // independently in both tabs).
    function mergeAllForFlush(disk, snap) {
        var out = {};
        var id;
        for (id in disk) {
            if (disk.hasOwnProperty(id)) out[id] = disk[id];
        }
        for (id in snap) {
            if (!snap.hasOwnProperty(id)) continue;
            var mine = snap[id];
            var theirs = out[id];
            if (!theirs || replacedCartIds[id] || !Array.isArray(theirs.items)) {
                out[id] = mine;
                continue;
            }
            var haveUid = {};
            var haveSfId = {};
            (mine.items || []).forEach(function (it) {
                if (!it) return;
                if (it.uid) haveUid[it.uid] = true;
                if (it.salesforceId) haveSfId[String(it.salesforceId).slice(0, 15)] = true;
            });
            var items = (mine.items || []).slice();
            theirs.items.forEach(function (it) {
                if (!it || !it.uid) return;
                if (haveUid[it.uid] || removedUids[it.uid]) return;
                if (it.salesforceId && haveSfId[String(it.salesforceId).slice(0, 15)]) return;
                items.push(it);
            });
            var merged = Object.assign({}, theirs, mine);
            merged.items = items;
            merged.form = Object.assign({}, theirs.form || {}, mine.form || {});
            recountCart(merged);
            out[id] = merged;
        }
        return out;
    }

    async function flushNow() {
        // Serialize flushes: the debounce timer and a {flush:true} caller
        // can overlap, and interleaved read-merge-write cycles would clobber
        // each other just like two tabs would.
        while (flushInFlight) await flushInFlight;
        if (!pendingAll) return;
        flushInFlight = (async function () {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            var snap = pendingAll;
            var gen = flushGen;
            var s = await storageGet([CART_KEY]);
            var merged = mergeAllForFlush(s[CART_KEY] || {}, snap);
            var ok = await storageSet({ [CART_KEY]: merged });
            // Only reset the cache/tombstones after a clean write with no
            // saveCart() during the awaits above — a mid-flight mutation has
            // its own flush queued and still needs them, and a failed write
            // (quota) keeps state around so a later flush can retry once the
            // user frees space. Re-applying tombstones is idempotent.
            if (ok && flushGen === gen) {
                pendingAll = null;
                removedUids = {};
                replacedCartIds = {};
            }
            // A failed write leaves the cart live in memory but NOT on disk —
            // the panel would keep rendering it as though it were saved, and
            // the state silently disappears on refresh. Surface it so the user
            // can act before losing work, and clear the warning once a write
            // gets through.
            if (!ok) {
                persistFailure = lastStorageError || 'Could not save the cart to browser storage.';
                console.error('[CSH] cart persist FAILED — in-memory state is not saved:', persistFailure);
                // Quota failures already toast in storageSet; surface the
                // rest here so unsaved state is never silent (the panel
                // badge that used to show this is gone).
                if (!/quota|QUOTA_BYTES|storage is full/i.test(persistFailure)) {
                    window.cshToast && window.cshToast.show(
                        'Cart could not be saved (' + persistFailure + ') — changes may be lost on refresh.',
                        { type: 'error', duration: 8000 }
                    );
                }
            } else {
                persistFailure = null;
            }
        })();
        try { await flushInFlight; } finally { flushInFlight = null; }
    }

    // beforeunload can't await a Promise, but chrome.storage.local.set is
    // fire-and-forget from our side — the runtime will still persist the
    // write even after the tab is gone. Good enough for typical navigation;
    // we accept losing the last 150ms of changes on a hard crash. This is a
    // blind (unmerged) write — the read half of the merge can't run
    // synchronously here — so it carries the same small cross-tab exposure.
    window.addEventListener('beforeunload', function () {
        if (pendingAll && cshExtAlive()) {
            try { chrome.storage.local.set({ [CART_KEY]: pendingAll }); } catch (_) {}
        }
    });

    function uid() {
        return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // -----------------------------------------------------------------------
    // Cart CRUD
    // -----------------------------------------------------------------------
    // Read-only view: unlike getCart this NEVER creates the cart entry, so
    // observers (toolbar counts, the detail-page pending toast) cannot leak
    // empty cart records into a later flush.
    async function peekCart(changeSetId) {
        var all;
        if (pendingAll) {
            all = pendingAll;
        } else {
            var s = await storageGet([CART_KEY]);
            all = s[CART_KEY] || {};
        }
        return all[changeSetId] || null;
    }

    async function getCart(changeSetId) {
        var all;
        if (pendingAll) {
            all = pendingAll;
        } else {
            var s = await storageGet([CART_KEY]);
            all = s[CART_KEY] || {};
        }
        if (!all[changeSetId]) {
            all[changeSetId] = {
                host: serverUrl,
                createdAt: Date.now(),
                items: [],
                form: {}
            };
        }
        normalizeCartItems(all[changeSetId]);
        return { all: all, cart: all[changeSetId] };
    }

    async function saveCart(all, opts) {
        opts = opts || {};
        pendingAll = all;
        flushGen++; // an in-flight flush must not clear this newer state
        // Cached status counts on each cart so renders avoid re-iterating
        // the whole item list on every frame. Every mutation flows through
        // saveCart so this is the single authoritative recount site.
        if (all && typeof all === 'object') {
            for (var csId in all) {
                if (all.hasOwnProperty(csId) && all[csId] && Array.isArray(all[csId].items)) {
                    recountCart(all[csId]);
                }
            }
        }
        if (opts.flush) {
            await flushNow();
        } else {
            scheduleFlush();
        }
        notifyCartChanged();
    }

    function recountCart(cart) {
        var c = { staged: 0, submitting: 0, done: 0, failed: 0 };
        var items = cart.items;
        for (var i = 0; i < items.length; i++) {
            var s = items[i].status;
            c[s] = (c[s] || 0) + 1;
        }
        cart.counts = c;
        return c;
    }

    function itemIdentity(it) {
        if (!it) return '';
        if (it.salesforceId || it.id) return 'id:' + String(it.salesforceId || it.id).slice(0, 15);
        if (it.type && it.fullName) return 'fullName:' + it.type + '::' + it.fullName;
        if (it.type && it.name) return 'name:' + it.type + '::' + it.name;
        return '';
    }

    function normalizeCartType(type) {
        var t = String(type || '').trim();
        if (t === 'CustomFieldDefinition' || t === 'CustomField') return 'Custom Field';
        // Rows synced from the change-set view carry the UI label ("Flow
        // Definition", "List View") while rows added on the Add page carry
        // the API type name ("FlowDefinition", "ListView"). Canonicalize the
        // API form to the spaced label so grouping and identity keys line up
        // — otherwise the panel shows two sections for the same type and the
        // server sync can't match rows it should merge. (Types whose UI label
        // isn't a plain camel-case split — e.g. AuraDefinitionBundle vs
        // "Lightning Component Bundle" — still diverge; the id-based dedup
        // covers those once a salesforceId is known.)
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(t) && /[a-z][A-Z]/.test(t)) {
            return t.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        }
        return t;
    }

    function normalizeCartItems(cart) {
        if (!cart || !Array.isArray(cart.items)) return false;
        var changed = false;
        cart.items.forEach(function (it) {
            var next = normalizeCartType(it.type);
            if (next && next !== it.type) {
                it.type = next;
                changed = true;
            }
        });
        if (cart.form && typeof cart.form === 'object') {
            Object.keys(cart.form).forEach(function (key) {
                var next = normalizeCartType(key);
                if (!next || next === key) return;
                cart.form[next] = Object.assign({}, cart.form[key], cart.form[next] || {});
                delete cart.form[key];
                changed = true;
            });
        }
        return changed;
    }

    function statusPriority(status) {
        if (status === 'done') return 4;
        if (status === 'submitting') return 3;
        if (status === 'staged') return 2;
        if (status === 'failed') return 1;
        return 0;
    }

    function mergeCartRows(a, b) {
        var winner = statusPriority(b.status) > statusPriority(a.status) ? b : a;
        var other = winner === b ? a : b;
        var merged = Object.assign({}, other, winner);
        merged.uid = winner.uid || other.uid || uid();
        merged.type = normalizeCartType(winner.type || other.type);
        merged.salesforceId = winner.salesforceId || other.salesforceId;
        if (merged.salesforceId) merged.salesforceId = String(merged.salesforceId).slice(0, 15);
        merged.name = winner.name || other.name || merged.salesforceId;
        merged.fullName = winner.fullName || other.fullName;
        merged.removeHref = winner.removeHref || other.removeHref;
        merged.error = winner.error || other.error || '';
        if (merged.status === 'done' || merged.status === 'staged') merged.error = '';
        // Verified beats unverified. Object.assign can only ever carry the flag
        // forward (a confirmed row simply lacks the property, so it never
        // overwrites a true), which would let a stale unverified duplicate
        // re-flag a row the server has since confirmed.
        //
        // Only a *verified done* row is evidence the component is really in the
        // change set. Merely lacking the flag is not — a 'staged' or 'failed'
        // duplicate says nothing about server presence, so it must not clear a
        // legitimate unverified marker.
        if ((a.status === 'done' && !a.unverified) ||
                (b.status === 'done' && !b.unverified)) {
            delete merged.unverified;
        }
        return merged;
    }

    async function mergeRelatedCarts(changeSetIds) {
        var keys = uniqueSyncKeys(Array.isArray(changeSetIds) ? changeSetIds : [changeSetIds]);
        if (keys.length < 2) return { merged: false, keys: keys, count: 0 };
        var s = pendingAll ? null : await storageGet([CART_KEY]);
        var all = pendingAll || (s && s[CART_KEY]) || {};
        var byIdentity = {};
        var forms = {};
        keys.forEach(function (k) {
            var cart = all[k];
            if (!cart) return;
            if (cart.form) Object.assign(forms, cart.form);
            (cart.items || []).forEach(function (it) {
                it.type = normalizeCartType(it.type);
                var ident = itemIdentity(it);
                if (!ident) return;
                byIdentity[ident] = byIdentity[ident] ? mergeCartRows(byIdentity[ident], it) : Object.assign({}, it);
            });
        });
        var items = Object.keys(byIdentity).map(function (k) { return byIdentity[k]; });
        if (!items.length && !Object.keys(forms).length) return { merged: false, keys: keys, count: 0 };
        var now = Date.now();
        keys.forEach(function (k) {
            var existing = all[k] || {};
            all[k] = {
                host: existing.host || serverUrl,
                createdAt: existing.createdAt || now,
                updatedAt: now,
                items: items.map(function (it) { return Object.assign({}, it); }),
                form: Object.assign({}, forms, existing.form || {})
            };
        });
        // Every key was rebuilt wholesale; the flush merge must take our
        // version rather than re-merging per uid with whatever is on disk.
        keys.forEach(markCartReplaced);
        await saveCart(all, { flush: true });
        return { merged: true, keys: keys, count: items.length };
    }

    // Carts saved before the counts cache was introduced won't have .counts
    // in storage — fall through to a one-shot recount so readers can stay
    // O(1) from then on. Fresh carts post-introduction carry .counts in
    // storage (set by recountCart in saveCart) and skip this.
    function ensureCounts(cart) {
        if (!cart.counts) recountCart(cart);
        return cart.counts;
    }

    async function addItems(changeSetId, type, items /* [{id, name}] */) {
        type = normalizeCartType(type);
        var { all, cart } = await getCart(changeSetId);
        // Salesforce component ids are globally unique. Use the id as cart
        // identity so display/API type label differences do not create a
        // duplicate staged row for the same component.
        var key = function (id) { return id ? String(id).slice(0, 15) : ''; };
        var seen = {};
        cart.items.forEach(function (it) {
            if (it.status !== 'done') seen[key(it.salesforceId)] = true;
        });
        var added = 0;
        items.forEach(function (it) {
            if (!it.id) return;
            if (seen[key(it.id)]) return;
            cart.items.push({
                uid: uid(),
                type: type,
                salesforceId: it.id,
                name: it.name || it.id,
                status: 'staged',
                source: 'ui',
                addedAt: Date.now()
            });
            seen[key(it.id)] = true;
            added++;
        });
        await saveCart(all);
        if (window.cshDb && added > 0) {
            window.cshDb.markMembers(changeSetId, items.map(function (it) {
                return { id: it.id, type: type, name: it.name };
            }), 'pending_add', { source: 'cart-add' }).catch(function (e) {
                console.warn('cshDb cart add cache failed:', e && e.message);
            });
        }
        return added;
    }

    // Batch insert — used when pushing many items at once. One getCart + one
    // saveCart for the whole batch, versus N round-trips when calling
    // addItems() in a loop. Server-sync callers should use syncItemsFromServer
    // instead; it layers dedup/promote semantics on top.
    async function addItemsBatch(changeSetId, items /* [{type, id, name, status?, extra?}] */) {
        if (!items || !items.length) return 0;
        var { all, cart } = await getCart(changeSetId);
        var key = function (id) { return id ? String(id).slice(0, 15) : ''; };
        var seen = {};
        cart.items.forEach(function (it) {
            if (it.status !== 'done') seen[key(it.salesforceId)] = true;
        });
        var added = 0;
        items.forEach(function (it) {
            if (!it.id || !it.type) return;
            var type = normalizeCartType(it.type);
            if (seen[key(it.id)]) return;
            var row = {
                uid: uid(),
                type: type,
                salesforceId: it.id,
                name: it.name || it.id,
                status: it.status || 'staged',
                source: it.source || 'ui',
                addedAt: Date.now()
            };
            if (it.extra) Object.assign(row, it.extra);
            cart.items.push(row);
            seen[key(it.id)] = true;
            added++;
        });
        await saveCart(all);
        if (window.cshDb && added > 0) {
            window.cshDb.markMembers(changeSetId, items.map(function (it) {
                return Object.assign({}, it, { type: normalizeCartType(it.type) });
            }), 'pending_add', { source: 'cart-batch-add' })
                .catch(function (e) { console.warn('cshDb batch add cache failed:', e && e.message); });
        }
        return added;
    }

    async function setItemChecked(changeSetId, type, item, checked) {
        type = normalizeCartType(type);
        if (!changeSetId || !type || !item) return false;
        var sfId = item.id || item.salesforceId;
        if (!sfId) return false;
        sfId = String(sfId).slice(0, 15);

        var { all, cart } = await getCart(changeSetId);
        var rowKey = function (it) {
            return it && String(it.salesforceId || '').slice(0, 15) === sfId;
        };
        var existing = null;
        for (var i = 0; i < cart.items.length; i++) {
            if (rowKey(cart.items[i])) {
                existing = cart.items[i];
                break;
            }
        }

        if (checked) {
            if (existing) {
                existing.type = type;
                if (existing.status === 'failed') {
                    existing.status = 'staged';
                    existing.error = '';
                }
                if (item.name && (!existing.name || existing.name === existing.salesforceId)) existing.name = item.name;
                if (item.fullName && !existing.fullName) existing.fullName = item.fullName;
            } else {
                existing = {
                    uid: uid(),
                    type: type,
                    salesforceId: sfId,
                    name: item.name || item.fullName || sfId,
                    fullName: item.fullName || undefined,
                    status: 'staged',
                    source: 'data-table',
                    addedAt: Date.now()
                };
                cart.items.push(existing);
            }
        } else {
            dropCartItems(cart, function (it) {
                return rowKey(it) && (it.status === 'staged' || it.status === 'failed');
            });
        }

        await saveCart(all);
        if (window.cshDb && checked) {
            window.cshDb.markMembers(changeSetId, [{
                id: sfId,
                type: type,
                name: item.name || item.fullName || sfId,
                fullName: item.fullName || undefined
            }], 'pending_add', { source: 'cart-data-table-selection' })
                .catch(function (e) { console.warn('cshDb data-table selection cache failed:', e && e.message); });
        }
        renderPanel();
        return true;
    }

    // Server-sync insert — reconciles cart with what actually exists in the
    // change set on the server. Called by background sync (#6) after it
    // walks the classic components view and reads (cid, type) pairs that
    // are currently members.
    //
    // Per-row dedup/promote semantics:
    //   - existing 'done' (any source) → keep as-is; server-sync is
    //     authoritative that the row is in the change set, which matches.
    //   - existing 'staged' or 'failed' with same cid -> promote to
    //     'done' + source='server-sync'. The component landed (via another
    //     tab, a manual add, or a previously-failed-then-retried worker
    //     run) and we shouldn't double-post it.
    //   - existing 'submitting' → leave alone. The in-flight batch will
    //     terminate shortly and write its own status; clobbering it would
    //     confuse the worker's self-accounting.
    //   - no existing row → insert as 'done' + source='server-sync'.
    //
    // options.authoritative — when true, the caller guarantees `items` is
    // the complete server-side membership of the change set. Any existing
    // 'done' row whose salesforceId is NOT in the input list is
    // pruned (it was removed from the change set elsewhere). 'staged',
    // 'submitting', and 'failed' rows are never pruned — those represent
    // user-side state, not claims about server state.
    //
    // Returns { inserted, promoted, kept, pruned } so callers can report
    // progress.
    async function syncItemsFromServer(changeSetId, items /* [{type, id, name?, extra?}] */, options) {
        options = options || {};
        if (!items) items = [];
        items = items.map(function (it) {
            if (!it) return it;
            return Object.assign({}, it, { type: normalizeCartType(it.type) });
        });
        // Empty input → no-op. For authoritative callers this is defensive:
        // "empty authoritative" is almost always a scrape failure (fetch
        // returned a parseable but rowless page, or the 033 id was wrong),
        // NOT a genuine claim that the change set is empty. Wiping the
        // cart based on a bad scrape destroys user state, so we refuse and
        // let the caller retry. Callers that really want to wipe should
        // use clearDone instead.
        var { all, cart } = await getCart(changeSetId);
        // Salesforce exposes the same component as either a 15-char
        // case-sensitive id or an 18-char case-insensitive id depending on
        // which view generated the reference. The VF detail page's
        // confirmRemoveComponent(cid) call and the classic components
        // view's Del ?cid= query can disagree on which form they embed.
        // We canonicalize to the 15-char prefix for all dedup keys so the
        // same component collapses to one cart row regardless of which
        // sync path populated it. Without this, navigating back and forth
        // between the Add and Detail pages produced visible duplicates —
        // each page's sync inserted its own form of the id as a "new" row.
        function sfId15(id) { return id ? String(id).slice(0, 15) : ''; }
        var key = function (id) { return sfId15(id); };
        // Pre-pass: collapse any pre-existing 15/18-char duplicate rows in
        // the stored cart. Prior sync rounds (before this canonicalization)
        // may have left the cart with two entries for the same component.
        // Normalize each row's salesforceId to 15 chars in place and merge
        // collisions, preferring non-'done' rows (user has in-flight work)
        // over 'done' ones. Idempotent on carts that already have no
        // duplicates.
        var seenKeys = {};
        var dupesMerged = 0;
        dropCartItems(cart, function (it) {
            if (it.salesforceId) it.salesforceId = sfId15(it.salesforceId);
            if (!it.type || !it.salesforceId) return false;
            var k = key(it.salesforceId);
            var prev = seenKeys[k];
            if (!prev) { seenKeys[k] = it; return false; }
            dupesMerged++;
            var preferThis = (prev.status === 'done' && it.status !== 'done');
            if (preferThis) {
                prev.status = it.status;
                prev.source = it.source;
                prev.addedAt = it.addedAt || prev.addedAt;
                if (it.error) prev.error = it.error;
                else delete prev.error;
            }
            if (!prev.name && it.name) prev.name = it.name;
            if (!prev.fullName && it.fullName) prev.fullName = it.fullName;
            return true;
        });
        if (dupesMerged > 0) {
            console.log('cshCart.syncItemsFromServer: merged', dupesMerged, 'pre-existing duplicate row(s)');
        }
        if (!items.length) {
            if (options.authoritative && options.allowEmptyAuthoritative) {
                var emptyPruned = dropCartItems(cart, function (it) {
                    return it.status === 'done';
                }).length;
                await saveCart(all);
                // Also wipe the IndexedDB membership cache — it re-hydrates
                // the cart on every Add-page load (syncFromChangeSetView), so
                // leaving 'present' rows there would resurrect the pruned
                // items until the next successful non-empty sync.
                if (window.cshDb && window.cshDb.deleteChangeSetMembers) {
                    window.cshDb.deleteChangeSetMembers([changeSetId]).catch(function (e) {
                        console.warn('cshDb.deleteChangeSetMembers failed:', e && e.message);
                    });
                }
                return { inserted: 0, promoted: 0, kept: 0, pruned: emptyPruned };
            }
            if (options.authoritative) {
                console.warn('cshCart.syncItemsFromServer: refusing to authoritative-prune with empty input');
            }
            return { inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        }
        var byKey = seenKeys;
        // Fallback index for rows that never learned their salesforceId —
        // cart submissions post a classic form and get no record id back, so
        // those rows sit as 'done' with only a type + name/fullName. Without
        // this, the id-keyed loop below inserts the server's copy of the same
        // component as a duplicate row (and the panel shows it twice), and
        // the authoritative prune can never retire the id-less original.
        var byNameKey = {};
        function nameKeys(type, names) {
            var t = normalizeCartType(type);
            return names
                .map(function (n) { return String(n || '').trim().toLowerCase(); })
                .filter(Boolean)
                .map(function (n) { return t + '::' + n; });
        }
        cart.items.forEach(function (it) {
            if (!it || it.salesforceId || !it.type) return;
            nameKeys(it.type, [it.fullName, it.name]).forEach(function (k) {
                if (!byNameKey[k]) byNameKey[k] = it;
            });
        });
        var inputKeys = {};
        var inserted = 0, promoted = 0, kept = 0, pruned = 0;
        items.forEach(function (it) {
            if (!it.id || !it.type) return;
            var canonicalId = sfId15(it.id);
            inputKeys[key(canonicalId)] = true;
            var existing = byKey[key(canonicalId)];
            if (!existing) {
                // No id match — try to claim an id-less row by name and
                // backfill its salesforceId so every later id-keyed path
                // (prune, removeServerItems, dedup) can see it.
                var candidates = nameKeys(it.type, [it.extra && it.extra.fullName, it.name]);
                for (var c = 0; c < candidates.length; c++) {
                    var ghost = byNameKey[candidates[c]];
                    if (ghost) {
                        ghost.salesforceId = canonicalId;
                        byKey[key(canonicalId)] = ghost;
                        nameKeys(ghost.type, [ghost.fullName, ghost.name]).forEach(function (k) {
                            if (byNameKey[k] === ghost) delete byNameKey[k];
                        });
                        existing = ghost;
                        break;
                    }
                }
            }
            if (existing) {
                existing.type = it.type;
                // The server just told us this component IS in the change set,
                // which retires any done-but-unverified marker from a submit
                // whose post-check couldn't reach the classic view.
                if (existing.unverified) delete existing.unverified;
                if (existing.status === 'done') {
                    if (it.name && (!existing.name || existing.name === existing.salesforceId)) {
                        existing.name = it.name;
                    }
                    if (it.extra) existing.extra = Object.assign({}, existing.extra || {}, it.extra);
                    kept++;
                    return;
                }
                if (existing.status === 'submitting') {
                    // Don't race the worker; its completion handler will
                    // flip status to 'done' or 'failed' momentarily.
                    kept++;
                    return;
                }
                // staged / failed → promote.
                existing.status = 'done';
                existing.source = 'server-sync';
                existing.syncedAt = Date.now();
                delete existing.error;
                if (it.name && (!existing.name || existing.name === existing.salesforceId)) {
                    existing.name = it.name;
                }
                if (it.extra) existing.extra = Object.assign({}, existing.extra || {}, it.extra);
                promoted++;
                return;
            }
            var row = {
                uid: uid(),
                type: it.type,
                salesforceId: canonicalId,
                name: it.name || canonicalId,
                status: 'done',
                source: 'server-sync',
                addedAt: Date.now(),
                syncedAt: Date.now()
            };
            if (it.extra) Object.assign(row, it.extra);
            cart.items.push(row);
            byKey[key(row.salesforceId)] = row;
            inserted++;
        });
        if (options.authoritative) {
            pruned = dropCartItems(cart, function (it) {
                if (it.status !== 'done') return false;
                // Id-less 'done' rows that no server component claimed via
                // the name backfill above are stale — the component was
                // removed from the change set elsewhere. Before the backfill
                // existed these were unprunable ghosts that lingered forever.
                if (!it.salesforceId) return true;
                if (!it.type) return false;
                return inputKeys[key(it.salesforceId)] !== true;
            }).length;
        }
        await saveCart(all);
        if (window.cshDb) {
            window.cshDb.upsertChangeSetMembers(
                [changeSetId],
                items.map(function (it) {
                    var out = {
                        id: it.id,
                        type: normalizeCartType(it.type),
                        name: it.name,
                        source: 'server-sync'
                    };
                    if (it.extra) Object.assign(out, it.extra);
                    return out;
                }),
                { authoritative: !!options.authoritative, source: 'server-sync', status: 'present' }
            ).catch(function (e) {
                console.warn('cshDb change-set member cache failed:', e && e.message);
            });
        }
        return { inserted: inserted, promoted: promoted, kept: kept, pruned: pruned };
    }

    async function hydrateFromIndexedDb(changeSetIds) {
        if (!window.cshDb || !window.cshDb.getChangeSetMembers) {
            return { count: 0, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        }
        var keys = uniqueSyncKeys(Array.isArray(changeSetIds) ? changeSetIds : [changeSetIds]);
        if (window.cshDb.markChangeSetsUsed) {
            window.cshDb.markChangeSetsUsed(keys, { source: 'cart-hydrate' }).catch(function (e) {
                console.warn('cshDb change-set usage update failed:', e && e.message);
            });
        }
        var cached = [];
        var seen = {};
        for (var i = 0; i < keys.length; i++) {
            var rows = await window.cshDb.getChangeSetMembers(keys[i], { status: 'present' });
            rows.forEach(function (row) {
                var itemKey = [normalizeCartType(row.type), row.componentId || row.fullName || row.name].join('::');
                if (seen[itemKey]) return;
                seen[itemKey] = true;
                cached.push({
                    id: row.componentId || row.id,
                    type: normalizeCartType(row.type),
                    name: row.name || row.fullName || row.componentId,
                    extra: {
                        fullName: row.fullName || undefined,
                        removeHref: row.removeHref || undefined
                    }
                });
            });
        }
        if (!cached.length) {
            return { count: 0, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        }
        var summary = { count: cached.length, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        for (var k = 0; k < keys.length; k++) {
            var r = await syncItemsFromServer(keys[k], cached, { authoritative: false });
            summary.inserted += r.inserted;
            summary.promoted += r.promoted;
            summary.kept += r.kept;
            summary.pruned += r.pruned;
        }
        console.log('[CSH] hydrated cart from IndexedDB membership:', summary);
        return summary;
    }

    async function removeItem(changeSetId, uid) {
        var { all, cart } = await getCart(changeSetId);
        var removed = dropCartItems(cart, function (it) {
            return it.uid === uid;
        })[0] || null;
        await saveCart(all);
        // On the Add page, mirror the cart removal to the row's checkbox so
        // the table UI stops showing a ticked row for something the user
        // just dropped from the cart. _cartType is populated by
        // installCheckboxAutoSave — it's null on the Detail page and in
        // frames without the selection table, in which case this is a
        // no-op.
        if (removed && _cartType && removed.type === _cartType) {
            uncheckRowForSfId(removed.salesforceId);
        }
    }

    function uncheckRowForSfId(sfId) {
        if (!sfId) return;
        var id15 = String(sfId).slice(0, 15);
        findRowCheckboxes().each(function () {
            var rowId = idForRow(this);
            if (!rowId || String(rowId).slice(0, 15) !== id15) return;
            if (!this.checked) return;
            // Use a native click rather than setting .checked directly.
            // Setting .checked silently bypasses DataTables-Checkboxes'
            // internal state (which tracks selection via change events) —
            // the checkbox flips visually but on the next DataTable draw
            // the plugin restores it from its own tracked set. click()
            // fires change, the plugin updates, and the cart auto-save
            // delegate re-runs — harmless because the cart item we're
            // responding to is already removed, so syncCartFromCheckboxes
            // has nothing to add back.
            this.click();
        });
    }

    async function removeServerItems(changeSetIds, items) {
        if (!Array.isArray(changeSetIds)) changeSetIds = [changeSetIds];
        changeSetIds = changeSetIds.filter(Boolean);
        items = Array.isArray(items) ? items.filter(function (it) { return it && it.id; }) : [];
        items = items.map(function (it) {
            return Object.assign({}, it, { type: normalizeCartType(it.type) });
        });
        if (!changeSetIds.length || !items.length) return { removed: 0 };

        function sfId15(id) { return id ? String(id).slice(0, 15) : ''; }
        var byId = {};
        items.forEach(function (it) {
            byId[sfId15(it.id)] = it;
        });

        // Prefer the unflushed snapshot when we have one — reading disk here
        // would silently drop mutations still waiting on the debounce.
        var s = pendingAll ? null : await storageGet([CART_KEY]);
        var all = pendingAll || (s && s[CART_KEY]) || {};
        var removed = 0;
        changeSetIds.forEach(function (changeSetId) {
            var cart = all[changeSetId];
            if (!cart || !Array.isArray(cart.items)) return;
            removed += dropCartItems(cart, function (row) {
                if (row.status !== 'done' || !row.salesforceId) return false;
                return !!byId[sfId15(row.salesforceId)];
            }).length;
        });

        if (removed > 0) await saveCart(all, { flush: true });

        if (window.cshDb) {
            await Promise.all(changeSetIds.map(function (changeSetId) {
                return window.cshDb.markMembers(changeSetId, items, 'removed', { source: 'detail-remove' })
                    .catch(function (e) { console.warn('cshDb removed member cache failed:', e && e.message); });
            }));
        }

        return { removed: removed };
    }

    async function relatedChangeSetKeys(changeSetId) {
        var keys = uniqueSyncKeys([changeSetId]);
        try {
            var packageId = await _resolvePackageIdForServerRemove(changeSetId);
            if (packageId) keys = uniqueSyncKeys(keys.concat([packageId]));
        } catch (_) {}
        return keys;
    }

    async function getItemByUid(changeSetId, uid) {
        var { cart } = await getCart(changeSetId);
        return (cart.items || []).find(function (it) { return it.uid === uid; }) || null;
    }

    async function removeDoneItemFromServerAndCart(changeSetId, uid) {
        var item = await getItemByUid(changeSetId, uid);
        if (!item) return;
        if (item.status !== 'done') {
            await removeItem(changeSetId, uid);
            return;
        }
        var label = bestDisplayName(item);
        if (!item.salesforceId) {
            window.cshToast && window.cshToast.show(
                'Cannot remove "' + label + '" from Salesforce because its component id is missing.',
                { type: 'error' }
            );
            return;
        }
        if (!await window.cshDialog.confirm(
                'Remove "' + label + '" from this change set? This cannot be undone.',
                { title: 'Remove component', confirmLabel: 'Remove', destructive: true })) return;
        if (window.cshChangeSetOps && window.cshChangeSetOps.removeById) {
            await window.cshChangeSetOps.removeById(item.salesforceId);
        } else {
            await removeDoneItemViaClassicView(changeSetId, item);
        }
        await removeServerItems(await relatedChangeSetKeys(changeSetId), [{
            id: item.salesforceId,
            type: item.type,
            name: label,
            fullName: item.fullName
        }]);
        window.cshToast && window.cshToast.show(
            'Removed "' + label + '" from the change set.',
            { type: 'success', duration: 3000 }
        );
    }

    async function removeDoneTypeFromServerAndCart(changeSetId, type) {
        type = normalizeCartType(type);
        var { cart } = await getCart(changeSetId);
        var items = (cart.items || []).filter(function (it) {
            return normalizeCartType(it.type) === type && it.status === 'done' && it.salesforceId;
        });
        if (!items.length) return;
        if (!await window.cshDialog.confirm(
                'Remove all ' + items.length + ' "' + type + '" component(s) from this change set? This cannot be undone.',
                { title: 'Remove components', confirmLabel: 'Remove', destructive: true })) return;

        var ids = items.map(function (it) { return it.salesforceId; });
        var removedItems = [];
        if (window.cshChangeSetOps && window.cshChangeSetOps.removeManyByIds) {
            var result = await window.cshChangeSetOps.removeManyByIds(ids);
            var failed = {};
            (result.errors || []).forEach(function (e) {
                if (e && e.cid) failed[String(e.cid).slice(0, 15)] = true;
            });
            removedItems = items.filter(function (it) {
                return !failed[String(it.salesforceId).slice(0, 15)];
            }).map(function (it) {
                return { id: it.salesforceId, type: it.type, name: bestDisplayName(it), fullName: it.fullName };
            });
            if (result.failed && window.cshToast) {
                window.cshToast.show(
                    'Removed ' + result.done + ' ' + type + ' component(s); ' + result.failed + ' failed.',
                    { type: 'warning', duration: 7000 }
                );
            }
        } else {
            for (var i = 0; i < items.length; i++) {
                await removeDoneItemViaClassicView(changeSetId, items[i]);
                removedItems.push({
                    id: items[i].salesforceId,
                    type: items[i].type,
                    name: bestDisplayName(items[i]),
                    fullName: items[i].fullName
                });
            }
        }
        if (!removedItems.length) return;
        await removeServerItems(await relatedChangeSetKeys(changeSetId), removedItems);
        window.cshToast && window.cshToast.show(
            'Removed ' + removedItems.length + ' ' + type + ' component(s) from the change set.',
            { type: 'success', duration: 4000 }
        );
    }

    // Unticks every currently-rendered row checkbox. Used by the "Clear
    // cart" paths that wipe staged items en masse — any checkbox visible
    // in the current DataTable view corresponds to a staged (or paused)
    // selection, so clearing the cart has to clear the DOM state too or
    // the next auto-save would re-stage everything. No-op on the Detail
    // page (no such table exists there).
    function uncheckAllRowCheckboxes() {
        if (!_cartType) return;
        findRowCheckboxes().each(function () {
            if (this.checked) this.click();
        });
    }

    async function clearType(changeSetId, type) {
        type = normalizeCartType(type);
        var { all, cart } = await getCart(changeSetId);
        dropCartItems(cart, function (it) {
            return normalizeCartType(it.type) === type && it.status === 'staged';
        });
        await saveCart(all);
    }

    // Clears completed items. By default wipes every 'done' row regardless of
    // source. Pass { keepServerSynced: true } to preserve rows that were
    // promoted/inserted via syncItemsFromServer — useful when the user wants
    // to prune their own completed adds but keep the background-synced
    // inventory of what's already in the change set on the server.
    async function clearDone(changeSetId, opts) {
        opts = opts || {};
        var { all, cart } = await getCart(changeSetId);
        dropCartItems(cart, function (it) {
            if (it.status !== 'done') return false;
            if (opts.keepServerSynced && it.source === 'server-sync') return false;
            return true;
        });
        await saveCart(all);
    }

    // Clears staged + failed items, preserving done/submitting. This is the
    // "discard my pending picks" action — keeps authoritative state (what's
    // already in the change set, what's actively posting) and drops only
    // the user's in-flight selections.
    // sessionStorage marker bridging a native form submit and the page that
    // loads after it. The submit bridge cannot await storage before the
    // navigation tears the page down, but sessionStorage writes are
    // synchronous and survive same-tab navigation, so the NEXT page's init
    // performs the cart cleanup with async room to breathe. Content scripts
    // share DOM storage with the page, and both the Add page and the detail
    // retURL target live on the same origin.
    var NATIVE_ADD_MARKER = 'cshPendingNativeAddV1';

    var NATIVE_ADD_MARKER_TTL_MS = 10 * 60 * 1000;

    function markNativeAddSubmitted(changeSetId, ids, packageId) {
        try {
            sessionStorage.setItem(NATIVE_ADD_MARKER, JSON.stringify({
                key: changeSetId,
                pkg: packageId || null,
                ts: Date.now(),
                ids: (ids || []).map(function (id) { return String(id).slice(0, 15); })
            }));
        } catch (e) {
            console.warn('[CSH] could not record native-add marker:', e && e.message);
        }
    }

    // The marker records INTENT, not success — the native submit may have
    // died on a Salesforce validation page after the marker was written.
    // So consumption never deletes anything on faith: it re-reads the live
    // membership and lets syncItemsFromServer PROMOTE the staged rows that
    // actually landed to 'done' (which stops restoreFromCart re-ticking
    // them and removes them from the Submit staged count). Rows that did
    // not land stay staged — which is exactly right, because they were not
    // added. If the membership read fails, everything stays staged and the
    // restore-toast + Clear cart mitigation applies; a stale marker on an
    // unrelated page costs one scrape and promotes nothing.
    async function consumeNativeAddMarker() {
        var raw = null;
        try {
            raw = sessionStorage.getItem(NATIVE_ADD_MARKER);
            if (raw) sessionStorage.removeItem(NATIVE_ADD_MARKER);
        } catch (_) { return 0; }
        if (!raw) return 0;
        try {
            var marker = JSON.parse(raw);
            if (!marker || !marker.key || !Array.isArray(marker.ids) || !marker.ids.length) return 0;
            if (marker.ts && (Date.now() - marker.ts) > NATIVE_ADD_MARKER_TTL_MS) {
                console.log('[CSH] native-add marker expired — leaving staged rows untouched');
                return 0;
            }
            // Package id from the marker itself, else the id-map cache.
            // Never the current page's DOM - a stale marker consumed on an
            // unrelated change set's page would otherwise verify against
            // the WRONG package.
            var packageId = (marker.pkg && PACKAGE_ID_RE.test(marker.pkg)) ? marker.pkg : null;
            if (!packageId && PACKAGE_ID_RE.test(marker.key)) packageId = marker.key;
            if (!packageId && window.cshIdMap) {
                var cached = await window.cshIdMap.getPackageId(marker.key);
                if (cached && PACKAGE_ID_RE.test(cached)) packageId = cached;
            }
            if (!packageId) {
                console.warn('[CSH] native-add verification: no trusted 033 id for', marker.key);
                return 0;
            }
            // Bounded: init awaits this, and neither fetch path has its own
            // timeout - a hung request must not stall checkbox restore and
            // auto-save installation indefinitely.
            var live = await Promise.race([
                fetchChangeSetViewItems(packageId),
                new Promise(function (_, rej) {
                    setTimeout(function () { rej(new Error('verification timed out after 15s')); }, 15000);
                })
            ]);
            // Scope strictly to what THIS native submit sent. Passing the
            // full inventory would insert every server component into the
            // cart as 'done' - re-creating the whole-change-set-in-storage
            // bloat the panel removal eliminated.
            var wanted = {};
            marker.ids.forEach(function (id) { wanted[String(id).slice(0, 15)] = true; });
            var confirmed = live.filter(function (it) {
                return it && it.id && wanted[String(it.id).slice(0, 15)];
            });
            if (!confirmed.length) {
                console.log('[CSH] native-add verification: none of the submitted ids are in the change set');
                return 0;
            }
            var r = await syncItemsFromServer(marker.key, confirmed, { authoritative: false });
            console.log('[CSH] native-add verification: promoted', r.promoted,
                'of', marker.ids.length, 'submitted row(s) confirmed in the change set');
            return r.promoted;
        } catch (e) {
            console.warn('[CSH] native-add verification failed — staged rows left untouched:', e && e.message);
            return 0;
        }
    }

    async function clearStaged(changeSetId) {
        var { all, cart } = await getCart(changeSetId);
        dropCartItems(cart, function (it) {
            return it.status === 'staged' || it.status === 'failed';
        });
        await saveCart(all);
        uncheckAllRowCheckboxes();
    }

    async function cacheFormShape(changeSetId, type, formShape) {
        type = normalizeCartType(type);
        var { all, cart } = await getCart(changeSetId);
        cart.form[type] = Object.assign({ capturedAt: Date.now() }, formShape);
        await saveCart(all);
    }

    async function updateItemStatuses(changeSetId, predicate, patch, opts) {
        var { all, cart } = await getCart(changeSetId);
        cart.items.forEach(function (it) {
            if (predicate(it)) Object.assign(it, patch);
        });
        await saveCart(all, opts);
    }

    // -----------------------------------------------------------------------
    // Form-shape scrape
    //   Captures the current Add-Components form so the background worker
    //   can replay a native POST later without us being on that page.
    // -----------------------------------------------------------------------
    function scrapeFormShape() {
        var form = document.forms['editPage'] || document.getElementById('editPage');
        if (!form) return null;
        var hidden = {};
        $(form).find('input[type="hidden"]').each(function () {
            var el = this;
            if (!el.name) return;
            hidden[el.name] = el.value;
        });
        // The native "Save" / "Add" submit button's name/value pair must be
        // included or Salesforce will render the search page instead of
        // committing the add.
        var submit = $(form).find('input[type="submit"][name]').first();
        var submitName = submit.length ? submit.attr('name') : 'save';
        var submitValue = submit.length ? submit.val() : 'Save';
        return {
            action: form.action || (location.origin + location.pathname),
            method: (form.method || 'POST').toUpperCase(),
            hidden: hidden,
            submitName: submitName,
            submitValue: submitValue
        };
    }

    // -----------------------------------------------------------------------
    // Checkbox tracking
    //   Listens to clicks on row checkboxes, accumulates pending-for-cart
    //   state in memory, and exposes harvest/restore helpers for the Type
    //   switch prompt.
    // -----------------------------------------------------------------------
    function findRowCheckboxes() {
        // Salesforce's Add Components page renders data rows with a hidden
        // input per row named ids/"ids" carrying the Salesforce ID. A
        // companion visible checkbox is usually named differently; to be
        // safe we treat any <input type="checkbox"> inside tr.dataRow as a
        // selector and derive the ID from the row's hidden ids input.
        return $('table.list tr.dataRow input[type="checkbox"]');
    }

    function idForRow(row) {
        // Prefer the hidden `ids`-named input on the row, which holds the
        // 15-char Salesforce ID; fall back to the checkbox's own value.
        var $row = $(row).closest('tr.dataRow');
        var hidden = $row.find('input[name="ids"]').first();
        if (hidden.length && hidden.val()) return hidden.val();
        var cb = $row.find('input[type="checkbox"]').first();
        return cb.length ? cb.val() : null;
    }

    function nameForRow(row) {
        var $row = $(row).closest('tr.dataRow');
        // After applyMetadataToRows runs, td[0] carries data-fullName — the
        // Metadata API's canonical name, which is preferable to the raw text
        // (handles CustomField as "Account.MyField" etc.).
        var fn = $row.children('td').eq(0).attr('data-fullName');
        if (fn) return fn;
        // Fall back to the first cell's text, stripped of any nested inputs
        // / checkboxes that might be in the action column on some layouts.
        var firstCell = $row.children('td').eq(0).clone();
        firstCell.find('input, label, button, img').remove();
        var text = $.trim(firstCell.text());
        if (text) return text;
        return $.trim($row.children('td').eq(1).text()) || '(unnamed)';
    }

    function fullNameForRow(row) {
        var $row = $(row).closest('tr.dataRow');
        return $row.children('td').eq(0).attr('data-fullName') || null;
    }

    function harvestChecked() {
        var out = [];
        findRowCheckboxes().each(function () {
            if (!this.checked) return;
            var id = idForRow(this);
            if (!id) return;
            out.push({
                id: id,
                name: nameForRow(this),
                fullName: fullNameForRow(this) || undefined
            });
        });
        return out;
    }

    // Auto-save: persists every checkbox toggle to chrome.storage.local so
    // cart state survives dropdown-triggered page reloads AND DataTable
    // filter changes.
    //
    // Why this was subtle: DataTable (with deferRender:true + filter-search)
    // REMOVES non-matching rows from the DOM entirely rather than hiding
    // them. A naive full-reconcile — "cart = all currently-checked rows" —
    // would wipe out items whose row is filtered away, even though the user
    // meant to keep them. So the reconcile below treats three cases per
    // item:
    //
    //   row visible + checked    -> keep / add (staged)
    //   row visible + unchecked  -> drop from cart (explicit untick)
    //   row NOT in DOM           -> preserve existing cart state
    //
    // Combined with the draw.dt hook below that re-ticks cart items when
    // their rows become visible again, the filter-then-select pattern now
    // composes correctly across any number of cycles.
    var autoSaveTimer = null;
    var _cartType = null;
    function installCheckboxAutoSave(changeSetId, type) {
        type = normalizeCartType(type);
        _cartType = type;
        // Selector intentionally scoped to `table.list input[type="checkbox"]`
        // rather than `tr.dataRow input[...]` so the header "Select All"
        // checkbox in <thead> is also covered. Salesforce's inline
        // onclick="clickAll(this)" on the header directly mutates .checked on
        // every row without dispatching change/click events, so a row-scoped
        // delegation never fires for those programmatic toggles and the cart
        // would go stale after Select All. Matching on the header checkbox's
        // own click bubble gives us one handler invocation per Select-All,
        // and the 60ms debounce lets clickAll finish before syncCartFromCheckboxes
        // reads the resulting .checked states.
        $(document).off('change.cshAutoSave click.cshAutoSave')
            .on('change.cshAutoSave click.cshAutoSave',
                'table.list input[type="checkbox"]',
                function () {
                    if (autoSaveTimer) clearTimeout(autoSaveTimer);
                    autoSaveTimer = setTimeout(function () {
                        syncCartFromCheckboxes(changeSetId, type).catch(function (e) {
                            console.warn('cshCart auto-save failed:', e && e.message);
                        });
                    }, 60);
                });

        // When DataTable redraws (filter, sort, page change), re-tick any
        // newly-visible row whose id is already in the cart. Without this
        // the user loses visual confirmation of their prior selection after
        // navigating the filter.
        var $table = $('table.list');
        $table.off('draw.cshAutoSave').on('draw.cshAutoSave', function () {
            restoreVisibleTicksFromCart(changeSetId, type).catch(function () {});
        });
    }

    // Synchronously-awaitable harvest for callers that must not race the
    // 60ms checkbox debounce (the Add-all dialog starts the worker
    // immediately; a just-ticked row must be staged before it reads).
    async function harvestNow() {
        if (_currentChangeSetId && _cartType) {
            await syncCartFromCheckboxes(_currentChangeSetId, _cartType);
        }
    }

    async function syncCartFromCheckboxes(changeSetId, type) {
        type = normalizeCartType(type);
        if (!changeSetId || !type) return;

        // Partition every checkbox currently in the DOM into visible-checked
        // and visible-unchecked. Anything NOT in this partition is a row
        // that's been filtered out (not in DOM) and must not influence the
        // cart decision.
        var visibleChecked = {};   // id -> { name, fullName }
        var visibleUnchecked = {}; // id -> true
        findRowCheckboxes().each(function () {
            var cb = this;
            var id = idForRow(cb);
            if (!id) return;
            if (cb.checked) {
                visibleChecked[id] = { name: nameForRow(cb), fullName: fullNameForRow(cb) };
            } else {
                visibleUnchecked[id] = true;
            }
        });

        var { all, cart } = await getCart(changeSetId);
        var kept = [];
        var seen = {};
        cart.items.forEach(function (it) {
            // Items for other types untouched.
            if (normalizeCartType(it.type) !== type) { kept.push(it); return; }
            // In-flight / terminal items protected.
            if (it.status !== 'staged') { kept.push(it); seen[it.salesforceId] = true; return; }

            if (visibleChecked[it.salesforceId]) {
                // Row is visible and ticked — keep.
                kept.push(it);
                seen[it.salesforceId] = true;
            } else if (visibleUnchecked[it.salesforceId]) {
                // Row is visible and explicitly unticked — drop from cart.
                // Tombstone the uid so the flush merge doesn't restore it
                // from another tab's copy.
                if (it.uid) removedUids[it.uid] = true;
            } else {
                // Row isn't in the DOM at all (filtered / paged away). Preserve
                // cart state; user hasn't interacted with this item in this view.
                kept.push(it);
                seen[it.salesforceId] = true;
            }
        });

        // Add newly-checked visible items not yet in the cart.
        var newlyChecked = [];
        Object.keys(visibleChecked).forEach(function (id) {
            if (seen[id]) return;
            var info = visibleChecked[id];
            var row = {
                uid: uid(),
                type: type,
                salesforceId: id,
                name: info.name,
                fullName: info.fullName,
                status: 'staged',
                addedAt: Date.now()
            };
            kept.push(row);
            newlyChecked.push(row);
        });

        cart.items = kept;
        await saveCart(all);
        if (window.cshDb && newlyChecked.length) {
            window.cshDb.markMembers(changeSetId, newlyChecked, 'pending_add', { source: 'add-page-selection' })
                .catch(function (e) { console.warn('cshDb selection cache failed:', e && e.message); });
        }
    }

    // After a DataTable draw (filter / sort / page), re-apply the cart's
    // ticked state to the newly-rendered rows. Does NOT untick rows — only
    // ticks rows that should be ticked per the cart. Doesn't trigger the
    // change event (would cause recursive auto-save), just sets .checked.
    async function restoreVisibleTicksFromCart(changeSetId, type) {
        type = normalizeCartType(type);
        if (!changeSetId || !type) return;
        var { cart } = await getCart(changeSetId);
        var wanted = {};
        cart.items.forEach(function (it) {
            if (normalizeCartType(it.type) !== type) return;
            if (it.status === 'done') return;
            wanted[it.salesforceId] = true;
        });
        findRowCheckboxes().each(function () {
            var id = idForRow(this);
            if (id && wanted[id] && !this.checked) this.checked = true;
        });
    }

    async function restoreFromCart(changeSetId, type) {
        type = normalizeCartType(type);
        var { cart } = await getCart(changeSetId);
        var wanted = {};
        cart.items.forEach(function (it) {
            if (normalizeCartType(it.type) !== type) return;
            if (it.status === 'done') return;
            wanted[it.salesforceId] = it;
        });
        var restored = 0;
        findRowCheckboxes().each(function () {
            var id = idForRow(this);
            if (id && wanted[id] && !this.checked) {
                this.checked = true;
                $(this).trigger('change');
                restored++;
            }
        });
        return restored;
    }

    // -----------------------------------------------------------------------
    // Worker — submits cart items in batches via chrome.runtime message to
    // the service worker, which does the actual fetch() against Salesforce.
    // -----------------------------------------------------------------------
    // Cross-tab worker lock. workerRunning is only in-memory for THIS tab; if
    // the user has the change set open on two Setup tabs and clicks Submit All
    // in both, both in-memory flags start at false, both workers run, both
    // read the same staged items, both POST. Salesforce's add-to-change-set
    // endpoint is idempotent so the change set doesn't get duplicates, but we
    // waste API quota and throw confusing toasts. The soft lock is a time-
    // stamped record in chrome.storage.local; a fresh tab sees the existing
    // lock and bails with a message. 30-second TTL is refreshed per batch so
    // legitimately long runs don't expire mid-flight.
    var LOCK_KEY = 'cshCartWorkerLock';
    var LOCK_TTL_MS = 30 * 1000;

    async function acquireWorkerLock(changeSetId) {
        var s = await storageGet([LOCK_KEY]);
        var existing = s[LOCK_KEY];
        if (existing && existing.lockedAt && (Date.now() - existing.lockedAt) < LOCK_TTL_MS) {
            return false;
        }
        await storageSet({ [LOCK_KEY]: { lockedAt: Date.now(), changeSetId: changeSetId } });
        return true;
    }

    async function refreshWorkerLock(changeSetId) {
        await storageSet({ [LOCK_KEY]: { lockedAt: Date.now(), changeSetId: changeSetId } });
    }

    async function releaseWorkerLock() {
        await storageSet({ [LOCK_KEY]: null });
    }

    function submitCartBatch(formShape, ids) {
        return new Promise(function (resolve, reject) {
            if (!cshExtAlive()) {
                markExtDead();
                reject(new Error('Extension was reloaded — refresh this page to continue.'));
                return;
            }

            var port;
            var settled = false;
            function finish(err, response) {
                if (settled) return;
                settled = true;
                try { if (port) port.disconnect(); } catch (_) {}
                if (err) reject(err);
                else resolve(response);
            }

            try {
                port = chrome.runtime.connect({ name: 'cartSubmitHandler' });
                port.onMessage.addListener(function (message) {
                    if (!message || message.type !== 'cshCartSubmitResult') return;
                    finish(null, message.response || { ok: false, error: 'Empty cart submit response' });
                });
                port.onDisconnect.addListener(function () {
                    if (settled) return;
                    var err = chrome.runtime.lastError && chrome.runtime.lastError.message;
                    finish(new Error(err || 'Cart submit channel closed before a response was received.'));
                });
                port.postMessage({
                    type: 'cshCartSubmit',
                    formShape: formShape,
                    ids: ids
                });
            } catch (e) {
                if (/Extension context invalidated/i.test(e && e.message || '')) {
                    markExtDead();
                }
                finish(e);
            }
        });
    }

    var workerRunning = false;
    // Resolves with an outcome summary so callers can tell success from
    // silent failure. The Add-page submit bridge cancels Salesforce's native
    // submit before delegating here; without a reported outcome a failed run
    // consumed the user's click, added nothing, and surfaced no error.
    //   { ran:false, reason }                        — never started
    //   { ran:true, batches, submitted, failed, lastError }
    async function runWorker(changeSetId) {
        // `indeterminate` means at least one batch reached a state where the
        // server outcome is unknown — the POST was reported failed but the
        // follow-up read of the change set also failed, so we cannot tell
        // whether it landed. Callers must NOT retry on their own after that.
        var summary = { ran: true, batches: 0, submitted: 0, failed: 0, indeterminate: false, lastError: '' };
        if (workerRunning) return { ran: false, reason: 'already running in this tab' };
        var acquired = await acquireWorkerLock(changeSetId);
        if (!acquired) {
            window.cshToast && window.cshToast.show(
                'Another Salesforce tab is already submitting cart items. ' +
                'Wait for it to finish, then try again.',
                { type: 'info', duration: 5000 }
            );
            return { ran: false, reason: 'another tab holds the submit lock' };
        }
        workerRunning = true;
        renderPanel();
        try {
            while (true) {
                // Refresh the lock at the start of every batch so other tabs
                // see we're still alive even during long-running deploys.
                await refreshWorkerLock(changeSetId);
                var { cart } = await getCart(changeSetId);
                // Only submit staged items that have a resolved salesforceId.
                // Imported items without an Id stay staged until the user
                // visits that type's page (rescanForFullNames fills them in).
                var staged = cart.items.filter(function (it) {
                    return it.status === 'staged' && it.salesforceId;
                });
                if (staged.length === 0) break;

                // Group by type and submit one component type per request.
                // runWorker awaits each request before moving to the next type.
                var byType = {};
                staged.forEach(function (it) {
                    (byType[it.type] = byType[it.type] || []).push(it);
                });
                var type = Object.keys(byType)[0];
                var batchItems = byType[type];
                var batchId = uid();

                await updateItemStatuses(
                    changeSetId,
                    function (it) { return batchItems.some(function (b) { return b.uid === it.uid; }); },
                    { status: 'submitting', batchId: batchId },
                    { flush: true }
                );
                renderPanel();

                summary.batches++;
                var formShape = cart.form && cart.form[type];
                if (!formShape) {
                    summary.failed += batchItems.length;
                    summary.lastError = 'no cached form shape for ' + type;
                    await updateItemStatuses(
                        changeSetId,
                        function (it) { return it.batchId === batchId; },
                        {
                            status: 'failed',
                            error: 'No form shape cached for ' + type +
                                   '. Visit the ' + type + ' type in Add Components once, then retry.'
                        },
                        { flush: true }
                    );
                    renderPanel();
                    continue;
                }

                var attempt = 0;
                var success = false;
                var lastError = '';
                while (attempt < MAX_ATTEMPTS && !success) {
                    attempt++;
                    if (!cshExtAlive()) {
                        markExtDead();
                        lastError = 'Extension was reloaded — refresh this page to continue.';
                        break;
                    }
                    try {
                        var resp = await submitCartBatch(
                            formShape,
                            batchItems.map(function (it) { return it.salesforceId; })
                        );
                        if (resp && resp.ok) {
                            success = true;
                        } else {
                            lastError = (resp && resp.error) || 'Unknown error';
                        }
                    } catch (e) {
                        lastError = e && e.message ? e.message : String(e);
                        if (/Extension context invalidated/i.test(lastError)) {
                            markExtDead();
                            break;
                        }
                    }
                    if (!success && attempt < MAX_ATTEMPTS) {
                        await new Promise(function (r) { setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)); });
                    }
                }

                if (success) {
                    var verified = null;
                    // Set when the unverified path has already told the user
                    // what happened, so the trailing success toast below can't
                    // contradict it with "added N item(s)".
                    var reportedToUser = false;
                    try {
                        verified = await reconcileSubmittedBatch(
                            changeSetId,
                            await _resolvePackageIdForServerRemove(changeSetId),
                            batchItems,
                            'Component was not added. It may have been deleted or is no longer selectable in Salesforce.'
                        );
                    } catch (e) {
                        // We could not confirm the add against the server. The
                        // POST looked successful, so 'done' is still the most
                        // likely truth and demoting to 'failed' would push the
                        // user into needless re-submits — but we must not
                        // present this as verified:
                        //   * flag the rows unverified so the panel can say so
                        //     and a later sync can tell them apart;
                        //   * do NOT write them into the IndexedDB membership
                        //     cache — that cache re-hydrates the cart, so
                        //     seeding it with an unconfirmed row is how a
                        //     phantom component survives a refresh and then
                        //     vanishes on the next trustworthy sync.
                        console.warn('[CSH] post-submit verification failed; marking batch done-but-unverified:',
                            e && e.message);
                        await updateItemStatuses(
                            changeSetId,
                            function (it) { return it.batchId === batchId; },
                            { status: 'done', unverified: true },
                            { flush: true }
                        );
                        window.cshToast && window.cshToast.show(
                            'Cart: submitted ' + batchItems.length + ' ' + type + ' item(s), but could not verify ' +
                            'them against the change set (' + ((e && e.message) || 'sync failed') + '). ' +
                            'Use Full Sync to confirm what actually landed.',
                            { type: 'warning', duration: 9000 }
                        );
                        reportedToUser = true;
                    }
                    if (verified) {
                        summary.submitted += verified.present || 0;
                        summary.failed += verified.missing || 0;
                    } else {
                        // Unverified: the POST succeeded, so count it as
                        // submitted rather than reporting a false zero to the
                        // caller (which would trigger a duplicate native
                        // submit) — the rows carry `unverified` for the UI.
                        summary.submitted += batchItems.length;
                    }
                    if (verified && verified.missing) {
                        window.cshToast && window.cshToast.show(
                            'Cart: added ' + verified.present + ' ' + type + ' item(s); ' +
                            verified.missing + ' stale item(s) were not found in the change set.',
                            { type: verified.present ? 'warning' : 'error', duration: 7000 }
                        );
                    } else if (!reportedToUser) {
                        window.cshToast && window.cshToast.show(
                            'Cart: added ' + batchItems.length + ' ' + type + ' item(s) to change set.',
                            { type: 'success', duration: 4000 }
                        );
                    }
                } else {
                    var reconciledFailure = null;
                    try {
                        reconciledFailure = await reconcileSubmittedBatch(
                            changeSetId,
                            await _resolvePackageIdForServerRemove(changeSetId),
                            batchItems,
                            lastError
                        );
                    } catch (e) {
                        // POST reported failure AND we could not re-read the
                        // change set to check. The rows are marked failed for
                        // the UI, but the server outcome is genuinely unknown,
                        // so the caller must not treat this as "nothing landed"
                        // and submit again.
                        summary.indeterminate = true;
                        console.warn('[CSH] post-failure verification failed:', e && e.message);
                        await updateItemStatuses(
                            changeSetId,
                            function (it) { return it.batchId === batchId; },
                            { status: 'failed', error: lastError },
                            { flush: true }
                        );
                    }
                    summary.submitted += (reconciledFailure && reconciledFailure.present) || 0;
                    summary.failed += reconciledFailure
                        ? (reconciledFailure.missing || 0)
                        : batchItems.length;
                    summary.lastError = lastError || summary.lastError;
                    window.cshToast && window.cshToast.show(
                        reconciledFailure && reconciledFailure.present
                            ? ('Cart: added ' + reconciledFailure.present + ' ' + type +
                               ' item(s); ' + reconciledFailure.missing + ' item(s) failed. ' + lastError)
                            : ('Cart: batch for ' + type + ' failed after ' + attempt + ' attempt(s). ' + lastError),
                        { type: reconciledFailure && reconciledFailure.present ? 'warning' : 'error' }
                    );
                }
                renderPanel();
            }
        } finally {
            workerRunning = false;
            await releaseWorkerLock();
            renderPanel();
        }
        return summary;
    }

    async function retryFailed(changeSetId) {
        await updateItemStatuses(
            changeSetId,
            function (it) { return it.status === 'failed'; },
            { status: 'staged', error: '' }
        );
        // Return the worker's outcome summary so the toolbar's Submit
        // staged button can report a run that never started.
        return runWorker(changeSetId);
    }

    // -----------------------------------------------------------------------
    // Presets — named snapshots of cart items so the user can replay a known
    // selection across deploys without re-picking everything. Stored in
    // chrome.storage.local (sync's 8KB/item cap is easy to exceed on a
    // 1000-item preset). Keyed by user-supplied name; scoped to the org host.
    //
    // UI is currently hidden (CART_PRESETS_ENABLED = false) — the feature
    // works but we're suppressing the "Saved presets" row from the cart panel
    // until we revisit the UX. All storage-facing functions (listPresets /
    // savePreset / loadPreset / deletePreset) remain intact so any saved
    // presets survive a round-trip through this disabled state, and so the
    // public API on window.cshCart stays stable.
    // -----------------------------------------------------------------------
    var CART_PRESETS_ENABLED = false;
    var PRESETS_KEY = 'cshCartPresets';

    async function listPresets() {
        var s = await storageGet([PRESETS_KEY]);
        var all = s[PRESETS_KEY] || {};
        var host = serverUrl;
        return Object.keys(all)
            .filter(function (name) { return all[name] && all[name].host === host; })
            .map(function (name) { return all[name]; })
            .sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    }

    async function savePreset(name) {
        name = (name || '').trim();
        if (!name) throw new Error('Preset name is required');
        var changeSetId = currentChangeSetId();
        if (!changeSetId) throw new Error('No change-set context');
        var { cart } = await getCart(changeSetId);
        // Only snapshot items that represent a selection — staged or done —
        // skip submitting/failed so presets stay consistent.
        var items = cart.items
            .filter(function (it) { return it.status === 'staged' || it.status === 'done'; })
            .map(function (it) {
                return { type: it.type, salesforceId: it.salesforceId, name: it.name, fullName: it.fullName || null };
            });
        if (items.length === 0) throw new Error('Cart is empty — nothing to save');

        var s = await storageGet([PRESETS_KEY]);
        var all = s[PRESETS_KEY] || {};
        var host = serverUrl;
        var key = host + '|' + name;
        all[key] = {
            name: name,
            host: host,
            savedAt: Date.now(),
            itemCount: items.length,
            items: items
        };
        await storageSet({ [PRESETS_KEY]: all });
        return all[key];
    }

    async function loadPreset(name) {
        var changeSetId = currentChangeSetId();
        if (!changeSetId) throw new Error('No change-set context');
        var s = await storageGet([PRESETS_KEY]);
        var all = s[PRESETS_KEY] || {};
        var key = serverUrl + '|' + name;
        var preset = all[key];
        if (!preset) throw new Error('Preset not found: ' + name);
        // Group by type and add to cart
        var byType = {};
        preset.items.forEach(function (it) {
            (byType[it.type] = byType[it.type] || []).push({ id: it.salesforceId, name: it.name });
        });
        var total = 0;
        for (var type in byType) {
            total += await addItems(changeSetId, type, byType[type]);
        }
        return { added: total, total: preset.items.length };
    }

    async function deletePreset(name) {
        var s = await storageGet([PRESETS_KEY]);
        var all = s[PRESETS_KEY] || {};
        var key = serverUrl + '|' + name;
        delete all[key];
        await storageSet({ [PRESETS_KEY]: all });
    }

    // -----------------------------------------------------------------------
    // package.xml I/O
    //
    // Export: build a Salesforce metadata package.xml from the current cart
    // (staged + done items), download it.
    //
    // Import: parse a user-supplied package.xml, add items to the cart as
    // "unresolved" (no salesforceId yet). When the user navigates to each
    // type's Add Components page, rescanForFullNames matches stored fullNames
    // to rendered rows and fills in the salesforceId so the cart worker can
    // submit them.
    // -----------------------------------------------------------------------
    function escapeXml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    async function exportCartAsPackageXml() {
        var changeSetId = currentChangeSetId();
        if (!changeSetId) throw new Error('No change-set context');
        var { cart } = await getCart(changeSetId);
        var eligible = cart.items.filter(function (it) {
            return it.status === 'staged' || it.status === 'done';
        });
        if (eligible.length === 0) throw new Error('Cart has no staged or submitted items');

        var byType = {};
        eligible.forEach(function (it) {
            var member = it.fullName || it.name;
            if (!member) return;
            (byType[it.type] = byType[it.type] || []).push(member);
        });

        var apiVersion = (window.cshApiVersion && window.cshApiVersion.resolved) ||
                         (window.cshApiVersion && window.cshApiVersion.fallback) ||
                         '66.0';
        var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
                  '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
        Object.keys(byType).sort().forEach(function (type) {
            xml += '    <types>\n';
            byType[type].sort().forEach(function (m) {
                xml += '        <members>' + escapeXml(m) + '</members>\n';
            });
            xml += '        <name>' + escapeXml(type) + '</name>\n';
            xml += '    </types>\n';
        });
        xml += '    <version>' + escapeXml(apiVersion) + '</version>\n';
        xml += '</Package>\n';

        var stamp = new Date().toISOString().slice(0, 10);
        var fname = 'csh-cart-package-' + stamp + '.xml';
        var blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            a.remove();
            URL.revokeObjectURL(url);
        }, 500);
        window.cshToast && window.cshToast.show(
            'Exported ' + eligible.length + ' cart item(s) to ' + fname,
            { type: 'success' }
        );
    }

    async function importPackageXml(xmlText) {
        var changeSetId = currentChangeSetId();
        if (!changeSetId) throw new Error('No change-set context');

        var doc;
        try {
            doc = new DOMParser().parseFromString(xmlText, 'application/xml');
            if (doc.querySelector('parsererror')) throw new Error('Malformed XML');
        } catch (e) {
            throw new Error('Could not parse package.xml: ' + e.message);
        }

        // Salesforce package.xml default namespace is soap.sforce.com/2006/04/metadata.
        // Use getElementsByTagNameNS on the namespace to be robust, with a
        // fallback that ignores namespace for loose files.
        var ns = 'http://soap.sforce.com/2006/04/metadata';
        var typesNodes = Array.from(doc.getElementsByTagNameNS(ns, 'types'));
        if (typesNodes.length === 0) {
            typesNodes = Array.from(doc.getElementsByTagName('types'));
        }
        if (typesNodes.length === 0) {
            throw new Error('No <types> blocks found in XML');
        }

        var addedCount = 0;
        for (var i = 0; i < typesNodes.length; i++) {
            var typesEl = typesNodes[i];
            var nameEls = typesEl.getElementsByTagNameNS(ns, 'name');
            if (nameEls.length === 0) nameEls = typesEl.getElementsByTagName('name');
            var type = nameEls[0] ? nameEls[0].textContent.trim() : null;
            if (!type) continue;

            var memberEls = typesEl.getElementsByTagNameNS(ns, 'members');
            if (memberEls.length === 0) memberEls = typesEl.getElementsByTagName('members');
            var members = Array.from(memberEls)
                .map(function (m) { return m.textContent.trim(); })
                .filter(Boolean);
            // Strip wildcards. <members>*</members> in a real package.xml
            // means "all components of this type" — but we can't add a
            // literal "*" to the cart (the POST replay needs concrete ids).
            // Surfacing a warning is more honest than silently adding a
            // broken item.
            var wildcards = members.filter(function (m) { return m === '*'; });
            members = members.filter(function (m) { return m !== '*'; });
            if (wildcards.length > 0) {
                console.warn('cart: skipping wildcard <members>*</members> for type ' + type +
                    ' — the cart needs concrete component names. Visit the ' + type +
                    ' Add Components page once and stage the items you want, or list them explicitly in the package.xml.');
                if (window.cshToast) {
                    window.cshToast.show(
                        'Skipped wildcard "*" for ' + type +
                        '. Use explicit component names in package.xml, or stage that type manually.',
                        { type: 'warning', duration: 7000 }
                    );
                }
            }
            if (members.length === 0) continue;

            // addItems de-dupes by type+salesforceId, but our imported members
            // don't have a salesforceId yet. We store them with salesforceId
            // empty so restoreFromCart can resolve them lazily when the user
            // navigates to that type. addItems's dedupe keys won't filter them
            // since the key includes salesforceId — that's intentional.
            var items = members.map(function (m) {
                return { id: null, name: m, fullName: m };
            });
            var added = await addUnresolvedItems(changeSetId, type, items);
            addedCount += added;
        }
        return addedCount;
    }

    // Specialised addItems for imports: stores fullName so rescanForFullNames
    // can resolve salesforceId on page visit.
    async function addUnresolvedItems(changeSetId, type, items) {
        type = normalizeCartType(type);
        var { all, cart } = await getCart(changeSetId);
        // Dedup by (type + fullName) among unresolved items to avoid double-import.
        var seen = {};
        cart.items.forEach(function (it) {
            if (!it.salesforceId && it.type && it.fullName) seen[it.type + '||' + it.fullName] = true;
        });
        var added = 0;
        items.forEach(function (it) {
            if (!it.fullName) return;
            if (seen[type + '||' + it.fullName]) return;
            cart.items.push({
                uid: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                type: type,
                salesforceId: null,
                fullName: it.fullName,
                name: it.name || it.fullName,
                status: 'staged',
                source: 'ui',
                addedAt: Date.now()
            });
            added++;
        });
        await saveCart(all);
        return added;
    }

    // Rescans the current page for rows whose data-fullName matches an
    // unresolved cart item of this type; fills in salesforceId so the worker
    // can submit it. Called by changeset.js after applyMetadataToRows.
    //
    // Also walks the reverse direction: staged items that were auto-saved
    // BEFORE metadata finished loading have only a plain DOM-text name. Now
    // that metadata is live, look up their row by salesforceId and upgrade
    // the cart item's display to the canonical fullName — makes the cart
    // panel show "Account.MyField" instead of just "MyField" for custom
    // fields, etc.
    async function rescanForFullNames(changeSetId, type) {
        type = normalizeCartType(type);
        var { all, cart } = await getCart(changeSetId);
        var unresolved = cart.items.filter(function (it) {
            return normalizeCartType(it.type) === type && !it.salesforceId && it.fullName;
        });
        var needsFullName = cart.items.filter(function (it) {
            return normalizeCartType(it.type) === type && it.salesforceId && !it.fullName;
        });
        if (unresolved.length === 0 && needsFullName.length === 0) return 0;

        var byFullName = {};
        unresolved.forEach(function (it) { byFullName[it.fullName] = it; });
        var byId = {};
        needsFullName.forEach(function (it) { byId[it.salesforceId] = it; });

        var resolved = 0, enriched = 0;
        $('td[data-fullName]').each(function () {
            var fn = $(this).attr('data-fullName');
            var row = $(this).closest('tr.dataRow');
            var idInput = row.find('input[name="ids"]').first();
            var sfId = idInput.val();

            // Backfill salesforceId on imported items.
            var target = byFullName[fn];
            if (target && sfId) {
                target.salesforceId = sfId;
                resolved++;
            }
            // Backfill fullName on auto-saved items.
            if (sfId && byId[sfId] && fn) {
                byId[sfId].fullName = fn;
                enriched++;
            }
        });
        if (resolved > 0 || enriched > 0) {
            await saveCart(all);
            console.log('cshCart: resolved ' + resolved + ' id(s), enriched ' + enriched + ' fullName(s) for type', type);
        }
        return resolved + enriched;
    }

    // -----------------------------------------------------------------------
    // Server-side sync for the Add page
    //
    // Fetches /<033>?tab=PackageComponents&rowsperpage=5000 paginated, scrapes
    // the (cid, type, name, fullName) tuple for every row, and hands the list
    // to syncItemsFromServer as an authoritative membership claim. Mirrors the
    // Phase-2 path detailcomponents.js uses, but lives here so the Add page
    // (which doesn't load detailcomponents.js) can populate its cart panel
    // with the components already in the change set — previously the Add
    // page's panel stayed empty until the user had first visited the Detail
    // page and the dual-key sync had happened to land on the 033 key.
    // -----------------------------------------------------------------------
    var PACKAGE_ID_RE = /^033[A-Za-z0-9]{12,15}$/;

    function _findDelHrefInRow(rowEl) {
        var candidates = rowEl.querySelectorAll('a, button');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var txt = (el.textContent || '').trim();
            var title = (el.getAttribute('title') || '').trim();
            var href = el.getAttribute('href') || '';
            var onclick = el.getAttribute('onclick') || '';
            if (/^(del|remove)\b/i.test(txt) || /^(del|remove)\b/i.test(title)) {
                if (/[?&](?:cid|delID)=/i.test(href)) return href;
                var fromOnclick = _extractCidUrlFromAttr(onclick);
                if (fromOnclick) return fromOnclick;
            }
            if (/listComponentRemoveForPackage|outboundChangeSetComponentRemove|listComponentRemove|removeComponent|componentRemove|componentDelete|deleteredirect\.jsp/i.test(href)) return href;
        }
        return null;
    }

    function _extractCidUrlFromAttr(str) {
        if (!str) return null;
        var m = str.match(/['"]((?:[^'"]+)\?[^'"]*\b(?:cid|delID)=[^'"]+)['"]/i);
        return m ? m[1] : null;
    }

    function _extractCidFromDelHref(href) {
        if (!href) return null;
        var m = href.match(/[?&](?:cid|delID)=([^&]+)/i);
        return m ? decodeURIComponent(m[1]) : null;
    }
    // Extract a 15/18-char Salesforce ID from anchor hrefs in the row. Used as
    // a fallback when the view has no Del link (e.g., the classic Package
    // Components detail view, /<033>?tab=PackageComponents, which renders
    // "Action | Component Name | Parent Object | Type | ..." with no remove
    // affordance). Prefers the Name column's anchor, then scans other cells.
    // Skips IDs that share the packageId's 15-char prefix so the component
    // ID can't collide with the enclosing package's own id.
    function _findCidInRowAnchors(rowEl, packageId, preferredCellIdx) {
        var SF_ID_RE = /^\/?([0-9a-zA-Z]{15}(?:[0-9a-zA-Z]{3})?)(?:[?#\/]|$)/;
        var pkgPrefix = packageId ? packageId.slice(0, 15) : null;
        function extract(anchors) {
            for (var i = 0; i < anchors.length; i++) {
                var href = anchors[i].getAttribute('href') || '';
                var m = href.match(SF_ID_RE);
                if (!m) continue;
                var id = m[1];
                if (pkgPrefix && id.slice(0, 15) === pkgPrefix) continue;
                return id;
            }
            return null;
        }
        if (preferredCellIdx != null && preferredCellIdx >= 0) {
            var cell = rowEl.children[preferredCellIdx];
            if (cell) {
                var id = extract(cell.querySelectorAll('a[href]'));
                if (id) return id;
            }
        }
        return extract(rowEl.querySelectorAll('a[href]'));
    }

    function _findCidInRowFields(rowEl, packageId) {
        var SF_ID_RE = /^[0-9a-zA-Z]{15}(?:[0-9a-zA-Z]{3})?$/;
        var pkgPrefix = packageId ? packageId.slice(0, 15) : null;
        var attrs = ['value', 'data-cid', 'data-id', 'data-component-id', 'data-recordid'];
        var nodes = rowEl.querySelectorAll('input, button, a, span, div');
        for (var i = 0; i < nodes.length; i++) {
            for (var j = 0; j < attrs.length; j++) {
                var val = nodes[i].getAttribute(attrs[j]) || '';
                if (!SF_ID_RE.test(val)) continue;
                if (pkgPrefix && val.slice(0, 15) === pkgPrefix) continue;
                return val;
            }
        }
        return null;
    }

    function _findNextPageHrefInDoc(doc) {
        var anchors = doc.querySelectorAll('a');
        for (var i = 0; i < anchors.length; i++) {
            var txt = (anchors[i].textContent || '').trim();
            if (/^next\s*(page|›)?$/i.test(txt)) {
                var href = anchors[i].getAttribute('href');
                if (href) return href;
            }
        }
        return null;
    }
    // Salesforce's 2024 domain split serves Setup pages (including
    // AddToPackageFromChangeMgmtUi) from *.salesforce-setup.com and the
    // rest of the app — including outbound change-set detail pages and their
    // ?tab=PackageComponents view — from *.my.salesforce.com. Cookies don't
    // cross those eTLDs, so a `credentials:'include'` fetch built against
    // location.href on a Setup page hits the wrong origin for this URL and
    // Salesforce returns a Lightning shell / login page with no tr.dataRow.
    // Translating just the host back to my.salesforce.com keeps the rest of
    // the URL (path, query) intact and ships the right cookies.
    function _appOriginForChangeSetView() {
        var host = location.host || '';
        if (/\.salesforce-setup\.com$/i.test(host)) {
            return location.protocol + '//' + host.replace(/\.salesforce-setup\.com$/i, '.salesforce.com');
        }
        return location.origin;
    }
    // Cross-origin credentialed fetches from content scripts are blocked by
    // Chrome even when the extension declares host_permissions for both
    // domains. The service worker doesn't have that limitation, so we proxy
    // through it via cshClassicFetch (background.js). Returns the same shape
    // a raw fetch+text() would produce: { ok, status, url, text }. Same-origin
    // fetches still go direct to avoid an unnecessary SW round trip on legacy
    // *.my.salesforce.com orgs.
    function _fetchClassicPage(url) {
        var sameOrigin = (function () {
            try { return new URL(url).origin === location.origin; }
            catch (_) { return false; }
        })();
        if (sameOrigin) {
            return fetch(url, { credentials: 'include' }).then(function (r) {
                return r.text().then(function (text) {
                    return { ok: r.ok, status: r.status, url: r.url, text: text };
                });
            });
        }
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage({ type: 'cshClassicFetch', url: url }, function (resp) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!resp) {
                    reject(new Error('cshClassicFetch: no response from service worker'));
                    return;
                }
                if (resp.error) {
                    reject(new Error(resp.error));
                    return;
                }
                resolve({ ok: resp.ok, status: resp.status, url: resp.finalUrl || url, text: resp.text || '' });
            });
        });
    }

    // Complete-or-throw scraper for reconcileSubmittedBatch, its only caller.
    // Reconciliation marks every batch item NOT found in this list as failed
    // (and, in the caller's failed-POST branch, decides whether a native
    // re-submit is safe), so a silently partial list here converts "we could
    // not read the server" into "the server does not have it" — which either
    // fails rows that actually landed or triggers a duplicate submit. Unlike
    // the additive sync paths there is no safe way to consume a partial
    // result, so any incompleteness throws:
    //   * pagination broke mid-chain or the safety budget ran out;
    //   * a page rendered rows but we could not parse ALL of them (the
    //     localized/renamed-header case drops every row as no-type).
    // Callers already handle the throw as "unverified" (successful POST) or
    // "indeterminate" (failed POST).
    async function fetchChangeSetViewItems(packageId) {
        var items = [];
        // Zero rows only counts as "genuinely empty" when page 1 carried the
        // classic view's own empty placeholder — the same rule the
        // authoritative sync uses (sawEmptyListMarker). An unexpected page can
        // contain an empty table.list too, and returning [] for it would be a
        // false confirmed-zero: reconciliation would fail rows that may have
        // landed, and the submit bridge would native-resubmit on top of them.
        var emptyConfirmed = false;
        var appOrigin = _appOriginForChangeSetView();
        var nextUrl = new URL('/' + packageId + '?tab=PackageComponents&rowsperpage=5000', appOrigin).href;
        var safety = 200;
        var pageNum = 0;
        while (nextUrl && safety-- > 0) {
            pageNum++;
            var r = await _fetchClassicPage(nextUrl);
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching classic components view');
            var doc = new DOMParser().parseFromString(r.text, 'text/html');
            var table = doc.querySelector('table.list');
            if (!table) {
                throw new Error('No table.list on classic components view page ' + pageNum +
                    ' (' + r.url + ') — membership list would be ' +
                    (pageNum === 1 ? 'unreadable' : 'incomplete'));
            }
            var header = table.querySelector('tr.headerRow');
            var idx = { name: -1, type: -1, fullName: -1 };
            if (header) {
                Array.prototype.forEach.call(header.children, function (cell, i) {
                    var text = (cell.textContent || '').trim().toLowerCase();
                    if ((text === 'name' || text === 'component name') && idx.name === -1) idx.name = i;
                    else if (text === 'type' && idx.type === -1) idx.type = i;
                    else if ((text === 'api name' || text === 'full name') && idx.fullName === -1) idx.fullName = i;
                });
            }
            var rows = table.querySelectorAll('tr.dataRow');
            if (pageNum === 1 && rows.length === 0) {
                emptyConfirmed = !!table.querySelector('.noRowsHeader') ||
                    /no (records to display|package components defined)/i.test(table.textContent || '');
            }
            var dropped = { noCid: 0, noType: 0 };
            rows.forEach(function (row) {
                // Prefer componentId below; href is kept for removeHref only.
                var href = _findDelHrefInRow(row);
                var componentId = _findCidInRowAnchors(row, packageId, idx.name);
                var fieldId = _findCidInRowFields(row, packageId);
                var cid = componentId || fieldId || _extractCidFromDelHref(href);
                if (!cid) { dropped.noCid++; return; }
                var cells = row.children;
                var type = idx.type >= 0 && cells[idx.type] ? (cells[idx.type].textContent || '').trim() : '';
                if (!type) { dropped.noType++; return; }
                var name = idx.name >= 0 && cells[idx.name] ? (cells[idx.name].textContent || '').trim() : '';
                var fullName = idx.fullName >= 0 && cells[idx.fullName] ? (cells[idx.fullName].textContent || '').trim() : '';
                var it = { id: cid, type: type, name: name || cid };
                if (fullName || href) {
                    it.extra = {};
                    if (fullName) it.extra.fullName = fullName;
                    if (href) it.extra.removeHref = new URL(href, nextUrl).href;
                }
                items.push(it);
            });
            if (dropped.noCid > 0 || dropped.noType > 0) {
                throw new Error('Could not parse ' + (dropped.noCid + dropped.noType) + ' of ' +
                    rows.length + ' row(s) on page ' + pageNum +
                    ' (noCid=' + dropped.noCid + ', noType=' + dropped.noType +
                    ', headerIdx=' + JSON.stringify(idx) + ') — refusing to reconcile against a partial list');
            }
            var nextHref = _findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        if (nextUrl && safety <= 0) {
            throw new Error('Pagination safety budget exhausted with pages remaining — membership list incomplete');
        }
        if (items.length === 0 && !emptyConfirmed) {
            throw new Error('Scrape returned zero components but the classic view never showed its ' +
                'empty-list placeholder — cannot distinguish "empty change set" from "wrong page".');
        }
        return items;
    }

    async function reconcileSubmittedBatch(changeSetId, packageId, batchItems, fallbackError) {
        var liveItems = await fetchChangeSetViewItems(packageId);
        // Verify by Salesforce component id first. If Salesforce only exposes
        // a package-member/remove id on the Package Components row, fall back
        // to component name/fullName so a successful add is not marked failed.
        var present = {};
        var presentNames = {};
        function nameKey(value) {
            return value ? String(value).trim().toLowerCase() : '';
        }
        liveItems.forEach(function (it) {
            var id = _id15(it.id);
            if (id) present[id] = true;
            var n = nameKey(it.fullName || (it.extra && it.extra.fullName) || it.name);
            if (n) presentNames[n] = true;
        });
        var presentUids = {};
        var missingUids = {};
        batchItems.forEach(function (it) {
            var idPresent = present[_id15(it.salesforceId)];
            var submittedName = nameKey(it.fullName || it.name);
            if (idPresent || (submittedName && presentNames[submittedName])) {
                presentUids[it.uid] = true;
            } else {
                missingUids[it.uid] = true;
            }
        });
        var presentCount = Object.keys(presentUids).length;
        var missingCount = Object.keys(missingUids).length;
        if (presentCount) {
            await updateItemStatuses(
                changeSetId,
                function (it) { return presentUids[it.uid]; },
                { status: 'done', error: '' },
                { flush: true }
            );
            if (window.cshDb) {
                try {
                    await window.cshDb.markMembers(
                        changeSetId,
                        batchItems.filter(function (it) { return presentUids[it.uid]; }),
                        'present',
                        { source: 'cart-submit-verified' }
                    );
                } catch (e) {
                    console.warn('cshDb verified submit cache failed:', e && e.message);
                }
            }
        }
        if (missingCount) {
            await updateItemStatuses(
                changeSetId,
                function (it) { return missingUids[it.uid]; },
                {
                    status: 'failed',
                    error: fallbackError || 'Component was not added. It may have been deleted or is no longer selectable in Salesforce.'
                },
                { flush: true }
            );
        }
        return { present: presentCount, missing: missingCount, total: batchItems.length };
    }

    async function syncFromChangeSetView(changeSetId, packageId, opts) {
        opts = opts || {};
        if (!packageId) throw new Error('syncFromChangeSetView: packageId required');
        var keys = uniqueSyncKeys([changeSetId, packageId]);
        await mergeRelatedCarts(keys);
        if (window.cshDb && !opts.force) {
            try {
                if (window.cshDb.markChangeSetsUsed) {
                    window.cshDb.markChangeSetsUsed(keys, { source: 'add-page-change-set-use' }).catch(function (e) {
                        console.warn('cshDb change-set usage update failed:', e && e.message);
                    });
                }
                for (var ck = 0; ck < keys.length; ck++) {
                    var cachedMembers = await window.cshDb.getChangeSetMembers(keys[ck], { status: 'present' });
                    if (cachedMembers && cachedMembers.length) {
                        var hydrated = await hydrateFromIndexedDb(keys);
                        console.log('[CSH] Add-page cart hydrated from IndexedDB before authoritative sync:',
                            cachedMembers.length, 'cached member(s)', hydrated);
                        break;
                    }
                }
            } catch (e) {
                console.warn('cshDb cached member check failed:', e && e.message);
            }
        }
        var syncClaim = await beginAuthoritativeSync(keys, { force: !!opts.force });
        if (!syncClaim.started) {
            console.log('[CSH] Add-page authoritative sync skipped:', syncClaim.reason);
            return {
                count: (syncClaim.entry && syncClaim.entry.count) || 0,
                inserted: 0,
                promoted: 0,
                kept: 0,
                pruned: 0,
                skipped: syncClaim.reason
            };
        }
        try {
        var items = [];
        var sawEmptyListMarker = false;
        // Pagination broke mid-chain, so `items` is a PARTIAL membership list.
        // The zero-rows guard below doesn't catch this case (the list is
        // non-empty), so track it separately and downgrade the sync to
        // additive — an authoritative prune against a partial list deletes
        // every component on the pages we never read.
        var sawPartialScrape = false;
        var appOrigin = _appOriginForChangeSetView();
        var nextUrl = new URL('/' + packageId + '?tab=PackageComponents&rowsperpage=5000', appOrigin).href;
        var safety = 200;
        var pageNum = 0;
        while (nextUrl && safety-- > 0) {
            pageNum++;
            var r = await _fetchClassicPage(nextUrl);
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching classic components view');
            var html = r.text;
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var table = doc.querySelector('table.list');
            if (!table) {
                if (pageNum === 1) throw new Error('No table.list on classic components view (' + r.url + ')');
                sawPartialScrape = true;
                break;
            }
            var header = table.querySelector('tr.headerRow');
            var idx = { name: -1, type: -1, fullName: -1 };
            if (header) {
                Array.prototype.forEach.call(header.children, function (cell, i) {
                    var text = (cell.textContent || '').trim().toLowerCase();
                    // Package Components view labels the name column "Component
                    // Name"; Outbound Change Set view labels it "Name". Accept
                    // either. fullName column only exists on the change-set view.
                    if ((text === 'name' || text === 'component name') && idx.name === -1) idx.name = i;
                    else if (text === 'type' && idx.type === -1) idx.type = i;
                    else if ((text === 'api name' || text === 'full name') && idx.fullName === -1) idx.fullName = i;
                });
            }
            var rows = table.querySelectorAll('tr.dataRow');
            // A genuinely empty change set still renders table.list, with a
            // "No records to display" placeholder instead of data rows. That
            // marker lets us distinguish "user removed everything" (prune is
            // correct) from "scrape landed on the wrong page" (prune would
            // destroy state) in the zero-rows branch below.
            if (pageNum === 1 && rows.length === 0) {
                // Empty Package Components view (verified against a live
                // org): <th class="noRowsHeader">No package components
                // defined</th> inside table.list. Other classic lists use
                // td.noRowsHeader / "No records to display" — accept both.
                sawEmptyListMarker = !!table.querySelector('.noRowsHeader') ||
                    /no (records to display|package components defined)/i.test(table.textContent || '');
            }
            var dropped = { noCid: 0, noType: 0 };
            rows.forEach(function (row, rowIdx) {
                // Prefer Del link (its ?cid= query is the canonical component
                // id). If no Del link — e.g., Package Components view — fall
                // back to the first SF-id-shaped anchor href, preferring the
                // Name column so we pick the component link over any
                // Parent Object / Included By / Owned By cross-reference.
                // Prefer componentId below; href is kept for removeHref only.
                var href = _findDelHrefInRow(row);
                var componentId = _findCidInRowAnchors(row, packageId, idx.name);
                var fieldId = _findCidInRowFields(row, packageId);
                var cid = componentId || fieldId || _extractCidFromDelHref(href);
                if (!cid) { dropped.noCid++; return; }
                var cells = row.children;
                var type = idx.type >= 0 && cells[idx.type] ? (cells[idx.type].textContent || '').trim() : '';
                var name = idx.name >= 0 && cells[idx.name] ? (cells[idx.name].textContent || '').trim() : '';
                var fullName = idx.fullName >= 0 && cells[idx.fullName] ? (cells[idx.fullName].textContent || '').trim() : '';
                if (!type) { dropped.noType++; return; }
                var it = { id: cid, type: type, name: name || cid };
                if (fullName || href) {
                    it.extra = {};
                    if (fullName) it.extra.fullName = fullName;
                    if (href) it.extra.removeHref = new URL(href, nextUrl).href;
                }
                items.push(it);
            });
            var keptOnPage = rows.length - dropped.noCid - dropped.noType;
            console.log('[CSH] Add-page authoritative sync page', pageNum,
                ': rows=', rows.length, 'kept=', keptOnPage,
                'dropped=', dropped, 'headerIdx=', idx);
            // Rows rendered but none understood — a parse failure (usually no
            // Type column index on a localized/renamed header), not an empty
            // change set. Fail loudly rather than letting the prune below
            // treat "we understood nothing" as "there is nothing".
            if (rows.length > 0 && keptOnPage === 0) {
                throw new Error('Parsed ' + rows.length + ' component row(s) on page ' + pageNum +
                    ' but understood none (dropped noCid=' + dropped.noCid +
                    ', noType=' + dropped.noType + ', headerIdx=' + JSON.stringify(idx) +
                    '). Refusing to report an empty change set.');
            }
            // ANY dropped row means the list isn't a provably complete
            // membership claim, so it must not drive a prune — see the matching
            // guard in detailcomponents.js:fetchAllChangeSetComponents.
            if (dropped.noCid > 0 || dropped.noType > 0) {
                sawPartialScrape = true;
            }
            var nextHref = _findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        if (nextUrl && safety <= 0) sawPartialScrape = true;
        // Zero scraped rows from a page that DID parse (table.list was found,
        // else page-1 would have thrown above) means Salesforce served us a
        // Lightning shell / unexpected layout, not a genuinely empty change
        // set. Calling syncItemsFromServer with authoritative:true would be
        // refused by its own defensive guard — skipping here keeps the log
        // clean and avoids masking real work under a downstream warning.
        // Callers see a zero-count summary and the preceding per-page log
        // makes the cause (row dropped counts / headerIdx / shell response)
        // easy to diagnose when it matters.
        if (items.length === 0) {
            // `&& !sawPartialScrape` is belt-and-braces: an empty-list marker
            // on page 1 plus a broken later page should be impossible (an empty
            // set has no page 2), but the two flags are set independently and
            // the cost of being wrong here is wiping the user's inventory.
            if (sawEmptyListMarker && !sawPartialScrape) {
                // The classic view rendered its "No records to display"
                // placeholder — the change set is genuinely empty, so the
                // right move is the opposite of the defensive skip below:
                // prune every stale 'done' row so the panel matches reality.
                var emptySummary = { count: 0, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
                for (var ek = 0; ek < syncClaim.keys.length; ek++) {
                    var er = await syncItemsFromServer(syncClaim.keys[ek], [],
                        { authoritative: true, allowEmptyAuthoritative: true });
                    emptySummary.pruned += er.pruned || 0;
                }
                console.log('[CSH] Add-page authoritative sync: change set is empty — pruned',
                    emptySummary.pruned, 'stale done row(s)');
                await finishAuthoritativeSync(syncClaim.keys, 0);
                return emptySummary;
            }
            console.warn('[CSH] Add-page authoritative sync: zero rows scraped from ' +
                         new URL('/' + packageId + '?tab=PackageComponents&rowsperpage=5000', appOrigin).href +
                         ' — skipping authoritative prune to preserve cart state. ' +
                         'Likely causes: Lightning-shell response, wrong id kind (0A2 vs 033), ' +
                         'or classic-DOM selectors not matching this org\'s rendered rows.');
            await failAuthoritativeSync(syncClaim.keys, 'zero rows scraped');
            return { count: 0, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        }
        // Write to every distinct key so both the Add page (033 MetadataPackage
        // id) and the Detail page (0A2 outbound change-set id) see the same
        // authoritative state.
        var summary = { count: items.length, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        if (sawPartialScrape) {
            console.warn('[CSH] Add-page sync: partial scrape (' + items.length +
                ' component(s) read before pagination broke) — syncing additively, not pruning.');
        }
        for (var k = 0; k < syncClaim.keys.length; k++) {
            var r2 = await syncItemsFromServer(syncClaim.keys[k], items, { authoritative: !sawPartialScrape });
            summary.inserted += r2.inserted;
            summary.promoted += r2.promoted;
            summary.kept += r2.kept;
            summary.pruned += r2.pruned;
            console.log('[CSH] Add-page sync key=' + syncClaim.keys[k] +
                ': inserted=' + r2.inserted + ' promoted=' + r2.promoted +
                ' kept=' + r2.kept + ' pruned=' + (r2.pruned || 0) +
                ' (scanned=' + items.length + ')');
        }
        if (sawPartialScrape) {
            // Never stamp a partial scrape as a completed authoritative sync —
            // that marks it fresh for AUTHORITATIVE_SYNC_FRESH_MS and blocks
            // the real full sync for the next 10 minutes.
            await failAuthoritativeSync(syncClaim.keys, 'partial scrape — pagination incomplete');
        } else {
            await finishAuthoritativeSync(syncClaim.keys, items.length);
        }
        return summary;
        } catch (e) {
            await failAuthoritativeSync(syncClaim.keys, (e && e.message) || String(e));
            throw e;
        }
    }

    function _id15(id) {
        return id ? String(id).slice(0, 15) : '';
    }

    async function _resolvePackageIdForServerRemove(changeSetId) {
        if (changeSetId && PACKAGE_ID_RE.test(changeSetId)) return changeSetId;
        if (window.cshIdMap && changeSetId) {
            var cached = await window.cshIdMap.getPackageId(changeSetId);
            if (cached && PACKAGE_ID_RE.test(cached)) return cached;
        }
        var inputs = document.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
            var val = inputs[i].value || '';
            if (PACKAGE_ID_RE.test(val)) return val;
        }
        var bodyMatch = (document.body && document.body.innerHTML || '').match(/033[A-Za-z0-9]{12,15}/);
        return bodyMatch ? bodyMatch[0] : null;
    }

    async function _findClassicRemoveHref(packageId, item) {
        var appOrigin = _appOriginForChangeSetView();
        var nextUrl = new URL('/' + packageId + '?tab=PackageComponents&rowsperpage=5000', appOrigin).href;
        var wantedId = _id15(item.salesforceId);
        var wantedName = String(item.fullName || item.name || '').trim();
        var safety = 200;
        while (nextUrl && safety-- > 0) {
            var r = await _fetchClassicPage(nextUrl);
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching classic components view');
            var doc = new DOMParser().parseFromString(r.text, 'text/html');
            var table = doc.querySelector('table.list');
            if (!table) throw new Error('No table.list on classic components view (' + r.url + ')');
            var header = table.querySelector('tr.headerRow');
            var idx = { name: -1, fullName: -1 };
            if (header) {
                Array.prototype.forEach.call(header.children, function (cell, i) {
                    var text = (cell.textContent || '').trim().toLowerCase();
                    if ((text === 'name' || text === 'component name') && idx.name === -1) idx.name = i;
                    else if ((text === 'api name' || text === 'full name') && idx.fullName === -1) idx.fullName = i;
                });
            }
            var rows = table.querySelectorAll('tr.dataRow');
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var href = _findDelHrefInRow(row);
                if (!href) continue;
                var delId = _id15(_extractCidFromDelHref(href));
                var componentId = _id15(_findCidInRowAnchors(row, packageId, idx.name));
                var cells = row.children;
                var rowName = idx.name >= 0 && cells[idx.name] ? (cells[idx.name].textContent || '').trim() : '';
                var rowFullName = idx.fullName >= 0 && cells[idx.fullName] ? (cells[idx.fullName].textContent || '').trim() : '';
                var idMatches = wantedId && (wantedId === delId || wantedId === componentId);
                var nameMatches = wantedName && (wantedName === rowName || wantedName === rowFullName);
                if (idMatches || nameMatches) {
                    return new URL(href, nextUrl).href;
                }
            }
            var nextHref = _findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        throw new Error('Remove URL not found for ' + (item.fullName || item.name || item.salesforceId));
    }

    function _submitClassicForm(action, method, body) {
        method = (method || 'POST').toUpperCase();
        var sameOrigin = (function () {
            try { return new URL(action).origin === location.origin; }
            catch (_) { return false; }
        })();
        if (sameOrigin) {
            return fetch(action, {
                method: method,
                credentials: 'include',
                redirect: 'follow',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });
        }
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage({
                type: 'cshClassicFormSubmit',
                url: action,
                method: method,
                body: body.toString()
            }, function (resp) {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                if (!resp) return reject(new Error('cshClassicFormSubmit: no response from service worker'));
                resolve({
                    ok: !!resp.ok,
                    status: resp.status,
                    url: resp.finalUrl || action,
                    text: function () { return Promise.resolve(resp.text || ''); }
                });
            });
        });
    }

    async function _deleteViaClassicHref(delHref) {
        var isOneShotRedirect = /\/setup\/own\/deleteredirect\.jsp/i.test(delHref);
        var r = await _fetchClassicPage(delHref);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' on confirm page');
        if (isOneShotRedirect) return;
        var doc = new DOMParser().parseFromString(r.text, 'text/html');
        var forms = doc.querySelectorAll('form');
        if (forms.length === 0) return;
        var form = null;
        for (var i = 0; i < forms.length; i++) {
            var f = forms[i];
            var actionHint = (f.getAttribute('action') || '').toLowerCase();
            if (/remove|delete|listremove|listcomponentremove/.test(actionHint) ||
                f.querySelector('input[type="submit"][name*="ave" i]') ||
                f.querySelector('input[type="submit"][value*="OK" i]')) {
                form = f; break;
            }
        }
        if (!form) form = forms[0];
        var action = new URL(form.getAttribute('action') || delHref, delHref).href;
        var method = (form.getAttribute('method') || 'POST').toUpperCase();
        var body = new URLSearchParams();
        form.querySelectorAll('input[type="hidden"], input[type="text"]').forEach(function (inp) {
            if (inp.name) body.append(inp.name, inp.value);
        });
        var submit = form.querySelector('input[type="submit"][name]');
        if (submit) body.append(submit.name, submit.value);
        var r2 = await _submitClassicForm(action, method, body);
        if (!r2.ok && !(r2.status >= 300 && r2.status < 400)) {
            throw new Error('HTTP ' + r2.status + ' on confirm POST');
        }
    }

    async function removeDoneItemViaClassicView(changeSetId, item) {
        var packageId = await _resolvePackageIdForServerRemove(changeSetId);
        if (!packageId) {
            throw new Error('Could not resolve 033 MetadataPackage id for server-side removal');
        }
        var href = item.removeHref || await _findClassicRemoveHref(packageId, item);
        await _deleteViaClassicHref(href);
        if (window.cshDb) {
            window.cshDb.markMembers(changeSetId, [item], 'removed', { source: 'cart-remove' })
                .catch(function (e) { console.warn('cshDb remove cache failed:', e && e.message); });
        }
    }

    // -----------------------------------------------------------------------
    // Clear-cart flow — relocated from the removed floating panel; backs the
    // Add-page toolbar's "Clear staged" button. Returns the action taken.
    // -----------------------------------------------------------------------
    async function clearWithPrompt(changeSetId) {
        if (!changeSetId) return 'cancel';
        var { cart } = await getCart(changeSetId);
        var counts = recountCart(cart);
        var action = await showClearPrompt(counts);
        if (action === 'cancel' || !action) return 'cancel';
        if (action === 'staged') {
            if (counts.staged + counts.failed) await clearStaged(changeSetId);
        } else if (action === 'done') {
            if (counts.done) await clearDone(changeSetId);
        } else if (action === 'all') {
            if (!await window.cshDialog.confirm(
                    'Clear every cart item — staged, completed, and failed? This cannot be undone.',
                    { title: 'Clear cart', confirmLabel: 'Clear everything', destructive: true })) {
                return 'cancel';
            }
            // Re-read via getCart so an unflushed snapshot isn't lost, and
            // mark the wipe wholesale so the flush merge doesn't restore
            // rows from another tab's copy.
            var fresh = await getCart(changeSetId);
            fresh.cart.items = [];
            markCartReplaced(changeSetId);
            await saveCart(fresh.all);
            uncheckAllRowCheckboxes();
        }
        return action;
    }

    // The floating "Change Set Details" panel is gone — keeping its display
    // truthful required an authoritative server sync on every page load, and
    // that machinery (plus its prune) caused more breakage than the panel
    // was worth. renderPanel survives as the cart's change beacon: worker
    // and storage code still call it after every mutation, and toolbar UIs
    // (changeset.js) listen for the event to refresh their staged counts.
    // The extension-reload banner keeps its old behaviour.
    var renderScheduled = false;
    function renderPanel() {
        if (extDead || !cshExtAlive()) {
            if (!extDead) markExtDead();
            try { renderExtDeadBanner(); } catch (_) {}
            return;
        }
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(function () {
            renderScheduled = false;
            try { window.dispatchEvent(new CustomEvent('csh:cart-changed')); } catch (_) {}
        });
    }

    // Shown in place of the cart when the content script is orphaned by an
    // extension reload/update. We render once, make the panel visible (even
    // when the normal render would have hidden it because items were empty),
    // and give the user a single Reload button — the only real remedy.
    function renderExtDeadBanner() {
        var panel = document.getElementById('csh-cart-panel');
        if (!panel) {
            // Standalone on purpose: this banner must not depend on any
            // chrome.* API (the context is already dead).
            panel = document.createElement('div');
            panel.id = 'csh-cart-panel';
            panel.className = 'csh-cart-ext-dead';
            document.body.appendChild(panel);
        }
        panel.classList.add('csh-cart-ext-dead');
        // Non-collapsed and non-toggleable so the reload message is always
        // visible.
        panel.classList.remove('csh-cart-collapsed');
        panel.style.display = '';
        panel.innerHTML =
            '<div class="csh-cart-header">' +
              '<span class="csh-cart-title">Change Set Details</span>' +
            '</div>' +
            '<div class="csh-cart-body">' +
              '<div class="csh-cart-empty" style="padding:14px 12px;line-height:1.4;">' +
                '<strong>Extension was reloaded.</strong><br/>' +
                'This tab is running a stale copy and can no longer talk to ' +
                'the extension. Refresh the page to continue.' +
                '<div style="margin-top:10px;text-align:right;">' +
                  '<button type="button" id="csh-cart-ext-dead-reload" ' +
                    'style="padding:6px 12px;background:#0176d3;color:#fff;border:0;border-radius:3px;cursor:pointer;font:inherit;">' +
                    'Reload this page' +
                  '</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        var btn = panel.querySelector('#csh-cart-ext-dead-reload');
        if (btn) btn.addEventListener('click', function () { location.reload(); });
    }
    var syncState = 'idle'; // 'idle' | 'syncing' | 'error'
    var syncStateDetail = '';

    function setSyncState(state, detail) {
        if (state !== 'idle' && state !== 'syncing' && state !== 'error') {
            state = 'idle';
        }
        syncState = state;
        syncStateDetail = detail || '';
    }

    // Choose the most human-readable identifier for a cart item.
    // Preference: fullName (e.g. "Account.MyField") > name (e.g. "MyField") > id.
    // Falls back to "(unnamed)" so the UI never renders an empty row.
    function bestDisplayName(it) {
        if (!it) return '(unnamed)';
        if (it.fullName && it.fullName !== '*') return String(it.fullName);
        if (it.name && it.name !== '(unnamed)') return String(it.name);
        if (it.salesforceId) return String(it.salesforceId);
        return '(unnamed)';
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function escapeAttr(s) { return escapeHtml(s); }

    function notifyCartChanged() {
        renderPanel();
    }

    // Three-way clear picker: staged+failed only, completed only, or
    // everything. Buttons for empty buckets are disabled so the user can't
    // accidentally run a no-op. Returns 'staged' | 'done' | 'all' | 'cancel'.
    function showClearPrompt(counts) {
        return new Promise(function (resolve) {
            var stagedAndFailed = (counts.staged || 0) + (counts.failed || 0);
            var doneCount = counts.done || 0;
            var submittingCount = counts.submitting || 0;
            var total = stagedAndFailed + doneCount + submittingCount;
            if (total === 0) {
                resolve('cancel');
                return;
            }
            var stagedDisabled = stagedAndFailed === 0 ? ' disabled' : '';
            var doneDisabled = doneCount === 0 ? ' disabled' : '';
            var submittingNote = submittingCount
                ? '<p><em>' + submittingCount + ' item(s) are currently submitting and will not be cleared.</em></p>'
                : '';
            var scrim = document.createElement('div');
            scrim.className = 'csh-modal-scrim';
            scrim.innerHTML =
                '<div class="csh-modal">' +
                  '<h3>Clear cart</h3>' +
                  '<p>Pick what to remove from the cart. Items already in the change set on the server are not affected.</p>' +
                  submittingNote +
                  '<div class="csh-modal-actions">' +
                    '<button data-action="staged" class="btn-primary"' + stagedDisabled + '>' +
                      'Clear staged (' + stagedAndFailed + ')' +
                    '</button>' +
                    '<button data-action="done"' + doneDisabled + '>' +
                      'Clear completed (' + doneCount + ')' +
                    '</button>' +
                    '<button data-action="all">Clear everything</button>' +
                    '<button data-action="cancel" class="btn-ghost">Cancel</button>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(scrim);
            scrim.addEventListener('click', function (e) {
                var btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
                if (!btn) return;
                if (btn.disabled) return;
                var action = btn.getAttribute('data-action');
                scrim.remove();
                resolve(action);
            });
        });
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------
    var _currentChangeSetId = null;
    function currentChangeSetId() { return _currentChangeSetId; }

    async function init(opts) {
        opts = opts || {};
        _currentChangeSetId = opts.changeSetId || ($('#id').val() || null);
        if (!_currentChangeSetId) return;
        var currentType = normalizeCartType(opts.currentType);

        // A native Add submit on the previous page may have taken staged
        // rows with it — clean them up BEFORE restoreFromCart re-ticks them
        // as if they were still pending.
        await consumeNativeAddMarker();

        // Cache the form shape for this type so the worker can replay later
        // even if the user has navigated away.
        var shape = scrapeFormShape();
        if (shape && currentType) {
            await cacheFormShape(_currentChangeSetId, currentType, shape);
        }

        // Restore staged-but-not-submitted items for this type.
        if (currentType) {
            var restored = await restoreFromCart(_currentChangeSetId, currentType);
            if (restored > 0) {
                console.log('cshCart: restored', restored, 'checkbox(es) from cart');
                // Visible, with an exit: silently re-ticked stale selections
                // were how 67 forgotten Apps ended up one click from being
                // submitted. Clear staged in the toolbar is the undo.
                window.cshToast && window.cshToast.show(
                    'Restored ' + restored + ' saved selection(s) from your last visit. ' +
                    'Untick any you no longer want, or use "Clear cart" in the toolbar.',
                    { type: 'info', duration: 8000 }
                );
            }
        }

        // Watch for new storage writes from other tabs or from the worker.
        if (cshExtAlive()) {
            try {
                chrome.storage.onChanged.addListener(function (changes, area) {
                    if (area !== 'local') return;
                    if (changes[CART_KEY]) {
                        // Another tab (or the worker) wrote the cart. If this
                        // tab has no unflushed mutations, drop the write-back
                        // cache so the next getCart() reads the fresh blob
                        // instead of serving a stale snapshot.
                        if (pendingAll && !flushTimer && !flushInFlight) pendingAll = null;
                        renderPanel();
                    }
                });
            } catch (_) { markExtDead(); }
        }

        // Install the auto-save delegate. This is the primary persistence
        // mechanism for user selections — every checkbox click flushes to
        // chrome.storage.local before any Salesforce-initiated navigation can
        // run, so the cart survives refresh without relying on modal timing.
        if (currentType) {
            installCheckboxAutoSave(_currentChangeSetId, currentType);
        }
        // Type-switch guard kept as NO-OP: dropdown change now lets Salesforce
        // navigate freely because state is already persisted on every click.
        // (Previously a modal tried to intercept and lost the race.)
        renderPanel();
        // Lazily resolve any imported-but-unresolved items for this type.
        if (currentType) {
            rescanForFullNames(_currentChangeSetId, currentType).catch(function () {});
        }

        // Resume anything left in "submitting" from a prior session that was
        // interrupted — mark as staged so the worker retries.
        await updateItemStatuses(_currentChangeSetId,
            function (it) { return it.status === 'submitting'; },
            { status: 'staged' }
        );
        // If there's staged work left and nothing running, keep it paused
        // until the user clicks Submit All; we don't auto-submit on page
        // load so a mistake never cascades.
    }

    window.cshCart = {
        init: init,
        addItems: addItems,
        addItemsBatch: addItemsBatch,
        setItemChecked: setItemChecked,
        syncItemsFromServer: syncItemsFromServer,
        setSyncState: setSyncState,
        removeItem: removeItem,
        removeServerItems: removeServerItems,
        clearType: clearType,
        clearDone: clearDone,
        clearStaged: clearStaged,
        clearWithPrompt: clearWithPrompt,
        markNativeAddSubmitted: markNativeAddSubmitted,
        peekCart: peekCart,
        harvestNow: harvestNow,
        runWorker: runWorker,
        retryFailed: retryFailed,
        harvestChecked: harvestChecked,
        restoreFromCart: restoreFromCart,
        getCart: getCart,
        flushNow: flushNow,
        mergeRelatedCarts: mergeRelatedCarts,
        hydrateFromIndexedDb: hydrateFromIndexedDb,
        beginAuthoritativeSync: beginAuthoritativeSync,
        finishAuthoritativeSync: finishAuthoritativeSync,
        failAuthoritativeSync: failAuthoritativeSync,
        // Phase 6 additions
        listPresets: listPresets,
        savePreset: savePreset,
        loadPreset: loadPreset,
        deletePreset: deletePreset,
        exportCartAsPackageXml: exportCartAsPackageXml,
        importPackageXml: importPackageXml,
        rescanForFullNames: rescanForFullNames,
        syncFromChangeSetView: syncFromChangeSetView
    };
})();
