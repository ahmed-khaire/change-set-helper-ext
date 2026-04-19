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

    // Salesforce caps POST form size; keep each batch conservative.
    var BATCH_SIZE = 100;
    var MAX_ATTEMPTS = 3;
    var RETRY_BASE_MS = 2000;

    // -----------------------------------------------------------------------
    // Extension-alive guard
    //
    // When the user updates/reloads the extension, every content script on
    // every tab becomes orphaned: chrome.runtime.id turns undefined and every
    // subsequent chrome.* call throws "Extension context invalidated". Before
    // this guard, runRender would surface that error hundreds of times (once
    // per mutation/scroll/render tick) and the cart UI silently froze.
    //
    // We now check cshExtAlive() before touching chrome.*, flip extDead once
    // when it first reports false, and let runRender show a one-time refresh
    // banner instead of re-throwing.
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
    function storageSet(obj) {
        return new Promise(function (resolve) {
            if (!cshExtAlive()) { markExtDead(); resolve(); return; }
            try {
                chrome.storage.local.set(obj, function () {
                    if (chrome.runtime.lastError) markExtDead();
                    resolve();
                });
            } catch (_) { markExtDead(); resolve(); }
        });
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

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(function () {
            flushTimer = null;
            flushNow();
        }, FLUSH_DEBOUNCE_MS);
    }

    async function flushNow() {
        if (!pendingAll) return;
        var snap = pendingAll;
        pendingAll = null;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        await storageSet({ [CART_KEY]: snap });
    }

    // beforeunload can't await a Promise, but chrome.storage.local.set is
    // fire-and-forget from our side — the runtime will still persist the
    // write even after the tab is gone. Good enough for typical navigation;
    // we accept losing the last 150ms of changes on a hard crash.
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
        return { all: all, cart: all[changeSetId] };
    }

    function saveCart(all) {
        pendingAll = all;
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
        scheduleFlush();
        notifyCartChanged();
        return Promise.resolve();
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

    // Carts saved before the counts cache was introduced won't have .counts
    // in storage — fall through to a one-shot recount so doRender can stay
    // O(1) from then on. Fresh carts post-introduction carry .counts in
    // storage (set by recountCart in saveCart) and skip this.
    function ensureCounts(cart) {
        if (!cart.counts) recountCart(cart);
        return cart.counts;
    }

    async function addItems(changeSetId, type, items /* [{id, name}] */) {
        var { all, cart } = await getCart(changeSetId);
        // Dedup against existing staged/submitting items of the same type+id.
        var key = function (type, id) { return type + '::' + id; };
        var seen = {};
        cart.items.forEach(function (it) {
            if (it.status !== 'done') seen[key(it.type, it.salesforceId)] = true;
        });
        var added = 0;
        items.forEach(function (it) {
            if (!it.id) return;
            if (seen[key(type, it.id)]) return;
            cart.items.push({
                uid: uid(),
                type: type,
                salesforceId: it.id,
                name: it.name || it.id,
                status: 'staged',
                source: 'ui',
                addedAt: Date.now()
            });
            added++;
        });
        await saveCart(all);
        return added;
    }

    // Batch insert — used when pushing many items at once. One getCart + one
    // saveCart for the whole batch, versus N round-trips when calling
    // addItems() in a loop. Server-sync callers should use syncItemsFromServer
    // instead; it layers dedup/promote semantics on top.
    async function addItemsBatch(changeSetId, items /* [{type, id, name, status?, extra?}] */) {
        if (!items || !items.length) return 0;
        var { all, cart } = await getCart(changeSetId);
        var key = function (t, id) { return t + '::' + id; };
        var seen = {};
        cart.items.forEach(function (it) {
            if (it.status !== 'done') seen[key(it.type, it.salesforceId)] = true;
        });
        var added = 0;
        items.forEach(function (it) {
            if (!it.id || !it.type) return;
            if (seen[key(it.type, it.id)]) return;
            var row = {
                uid: uid(),
                type: it.type,
                salesforceId: it.id,
                name: it.name || it.id,
                status: it.status || 'staged',
                source: it.source || 'ui',
                addedAt: Date.now()
            };
            if (it.extra) Object.assign(row, it.extra);
            cart.items.push(row);
            added++;
        });
        await saveCart(all);
        return added;
    }

    // Server-sync insert — reconciles cart with what actually exists in the
    // change set on the server. Called by background sync (#6) after it
    // walks the classic components view and reads (cid, type) pairs that
    // are currently members.
    //
    // Per-row dedup/promote semantics:
    //   - existing 'done' (any source) → keep as-is; server-sync is
    //     authoritative that the row is in the change set, which matches.
    //   - existing 'staged' or 'failed' with same type+cid → promote to
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
    // 'done' row whose (type, salesforceId) is NOT in the input list is
    // pruned (it was removed from the change set elsewhere). 'staged',
    // 'submitting', and 'failed' rows are never pruned — those represent
    // user-side state, not claims about server state.
    //
    // Returns { inserted, promoted, kept, pruned } so callers can report
    // progress.
    async function syncItemsFromServer(changeSetId, items /* [{type, id, name?, extra?}] */, options) {
        options = options || {};
        if (!items) items = [];
        // Empty input → no-op. For authoritative callers this is defensive:
        // "empty authoritative" is almost always a scrape failure (fetch
        // returned a parseable but rowless page, or the 033 id was wrong),
        // NOT a genuine claim that the change set is empty. Wiping the
        // cart based on a bad scrape destroys user state, so we refuse and
        // let the caller retry. Callers that really want to wipe should
        // use clearDone instead.
        if (!items.length) {
            if (options.authoritative) {
                console.warn('cshCart.syncItemsFromServer: refusing to authoritative-prune with empty input');
            }
            return { inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        }
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
        var key = function (t, id) { return t + '::' + sfId15(id); };
        // Pre-pass: collapse any pre-existing 15/18-char duplicate rows in
        // the stored cart. Prior sync rounds (before this canonicalization)
        // may have left the cart with two entries for the same component.
        // Normalize each row's salesforceId to 15 chars in place and merge
        // collisions, preferring non-'done' rows (user has in-flight work)
        // over 'done' ones. Idempotent on carts that already have no
        // duplicates.
        var seenKeys = {};
        var dupesMerged = 0;
        cart.items = cart.items.filter(function (it) {
            if (it.salesforceId) it.salesforceId = sfId15(it.salesforceId);
            if (!it.type || !it.salesforceId) return true;
            var k = key(it.type, it.salesforceId);
            var prev = seenKeys[k];
            if (!prev) { seenKeys[k] = it; return true; }
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
            return false;
        });
        if (dupesMerged > 0) {
            console.log('cshCart.syncItemsFromServer: merged', dupesMerged, 'pre-existing duplicate row(s)');
        }
        var byKey = seenKeys;
        var inputKeys = {};
        var inserted = 0, promoted = 0, kept = 0, pruned = 0;
        items.forEach(function (it) {
            if (!it.id || !it.type) return;
            var canonicalId = sfId15(it.id);
            inputKeys[key(it.type, canonicalId)] = true;
            var existing = byKey[key(it.type, canonicalId)];
            if (existing) {
                if (existing.status === 'done') {
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
                if (it.extra) Object.assign(existing, it.extra);
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
            byKey[key(row.type, row.salesforceId)] = row;
            inserted++;
        });
        if (options.authoritative) {
            var beforeLen = cart.items.length;
            cart.items = cart.items.filter(function (it) {
                if (it.status !== 'done') return true;
                if (!it.type || !it.salesforceId) return true;
                return inputKeys[key(it.type, it.salesforceId)] === true;
            });
            pruned = beforeLen - cart.items.length;
        }
        await saveCart(all);
        return { inserted: inserted, promoted: promoted, kept: kept, pruned: pruned };
    }

    async function removeItem(changeSetId, uid) {
        var { all, cart } = await getCart(changeSetId);
        var removed = null;
        cart.items = cart.items.filter(function (it) {
            if (it.uid === uid) { removed = it; return false; }
            return true;
        });
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
        var { all, cart } = await getCart(changeSetId);
        cart.items = cart.items.filter(function (it) {
            return !(it.type === type && it.status === 'staged');
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
        cart.items = cart.items.filter(function (it) {
            if (it.status !== 'done') return true;
            if (opts.keepServerSynced && it.source === 'server-sync') return true;
            return false;
        });
        await saveCart(all);
    }

    // Clears staged + failed items, preserving done/submitting. This is the
    // "discard my pending picks" action — keeps authoritative state (what's
    // already in the change set, what's actively posting) and drops only
    // the user's in-flight selections.
    async function clearStaged(changeSetId) {
        var { all, cart } = await getCart(changeSetId);
        cart.items = cart.items.filter(function (it) {
            return it.status !== 'staged' && it.status !== 'failed';
        });
        await saveCart(all);
        uncheckAllRowCheckboxes();
    }

    async function cacheFormShape(changeSetId, type, formShape) {
        var { all, cart } = await getCart(changeSetId);
        cart.form[type] = Object.assign({ capturedAt: Date.now() }, formShape);
        await saveCart(all);
    }

    async function updateItemStatuses(changeSetId, predicate, patch) {
        var { all, cart } = await getCart(changeSetId);
        cart.items.forEach(function (it) {
            if (predicate(it)) Object.assign(it, patch);
        });
        await saveCart(all);
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
        _cartType = type;
        $(document).off('change.cshAutoSave click.cshAutoSave')
            .on('change.cshAutoSave click.cshAutoSave',
                'table.list tr.dataRow input[type="checkbox"]',
                function () {
                    if (autoSaveTimer) clearTimeout(autoSaveTimer);
                    // Short debounce coalesces a native Select-All click that
                    // toggles every visible checkbox at once.
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

    async function syncCartFromCheckboxes(changeSetId, type) {
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
            if (it.type !== type) { kept.push(it); return; }
            // In-flight / terminal items protected.
            if (it.status !== 'staged') { kept.push(it); seen[it.salesforceId] = true; return; }

            if (visibleChecked[it.salesforceId]) {
                // Row is visible and ticked — keep.
                kept.push(it);
                seen[it.salesforceId] = true;
            } else if (visibleUnchecked[it.salesforceId]) {
                // Row is visible and explicitly unticked — drop from cart.
                // (Do nothing — item is intentionally omitted from `kept`.)
            } else {
                // Row isn't in the DOM at all (filtered / paged away). Preserve
                // cart state; user hasn't interacted with this item in this view.
                kept.push(it);
                seen[it.salesforceId] = true;
            }
        });

        // Add newly-checked visible items not yet in the cart.
        Object.keys(visibleChecked).forEach(function (id) {
            if (seen[id]) return;
            var info = visibleChecked[id];
            kept.push({
                uid: uid(),
                type: type,
                salesforceId: id,
                name: info.name,
                fullName: info.fullName,
                status: 'staged',
                addedAt: Date.now()
            });
        });

        cart.items = kept;
        await saveCart(all);
    }

    // After a DataTable draw (filter / sort / page), re-apply the cart's
    // ticked state to the newly-rendered rows. Does NOT untick rows — only
    // ticks rows that should be ticked per the cart. Doesn't trigger the
    // change event (would cause recursive auto-save), just sets .checked.
    async function restoreVisibleTicksFromCart(changeSetId, type) {
        if (!changeSetId || !type) return;
        var { cart } = await getCart(changeSetId);
        var wanted = {};
        cart.items.forEach(function (it) {
            if (it.type !== type) return;
            if (it.status === 'done') return;
            wanted[it.salesforceId] = true;
        });
        findRowCheckboxes().each(function () {
            var id = idForRow(this);
            if (id && wanted[id] && !this.checked) this.checked = true;
        });
    }

    async function restoreFromCart(changeSetId, type) {
        var { cart } = await getCart(changeSetId);
        var wanted = {};
        cart.items.forEach(function (it) {
            if (it.type !== type) return;
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

    var workerRunning = false;
    async function runWorker(changeSetId) {
        if (workerRunning) return;
        var acquired = await acquireWorkerLock(changeSetId);
        if (!acquired) {
            window.cshToast && window.cshToast.show(
                'Another Salesforce tab is already submitting cart items. ' +
                'Wait for it to finish, then try again.',
                { type: 'info', duration: 5000 }
            );
            return;
        }
        workerRunning = true;
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

                // Group by type, pick the first type, take up to BATCH_SIZE ids.
                var byType = {};
                staged.forEach(function (it) {
                    (byType[it.type] = byType[it.type] || []).push(it);
                });
                var type = Object.keys(byType)[0];
                var batchItems = byType[type].slice(0, BATCH_SIZE);
                var batchId = uid();

                await updateItemStatuses(
                    changeSetId,
                    function (it) { return batchItems.some(function (b) { return b.uid === it.uid; }); },
                    { status: 'submitting', batchId: batchId }
                );
                renderPanel();

                var formShape = cart.form && cart.form[type];
                if (!formShape) {
                    await updateItemStatuses(
                        changeSetId,
                        function (it) { return it.batchId === batchId; },
                        {
                            status: 'failed',
                            error: 'No form shape cached for ' + type +
                                   '. Visit the ' + type + ' type in Add Components once, then retry.'
                        }
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
                        var resp = await chrome.runtime.sendMessage({
                            type: 'cshCartSubmit',
                            formShape: formShape,
                            ids: batchItems.map(function (it) { return it.salesforceId; })
                        });
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
                    await updateItemStatuses(
                        changeSetId,
                        function (it) { return it.batchId === batchId; },
                        { status: 'done' }
                    );
                    window.cshToast && window.cshToast.show(
                        'Cart: added ' + batchItems.length + ' ' + type + ' item(s) to change set.',
                        { type: 'success', duration: 4000 }
                    );
                } else {
                    await updateItemStatuses(
                        changeSetId,
                        function (it) { return it.batchId === batchId; },
                        { status: 'failed', error: lastError }
                    );
                    window.cshToast && window.cshToast.show(
                        'Cart: batch for ' + type + ' failed after ' + MAX_ATTEMPTS + ' attempts. ' + lastError,
                        { type: 'error' }
                    );
                }
                renderPanel();
            }
        } finally {
            workerRunning = false;
            await releaseWorkerLock();
            renderPanel();
        }
    }

    async function retryFailed(changeSetId) {
        await updateItemStatuses(
            changeSetId,
            function (it) { return it.status === 'failed'; },
            { status: 'staged', error: '' }
        );
        runWorker(changeSetId);
    }

    // -----------------------------------------------------------------------
    // Presets — named snapshots of cart items so the user can replay a known
    // selection across deploys without re-picking everything. Stored in
    // chrome.storage.local (sync's 8KB/item cap is easy to exceed on a
    // 1000-item preset). Keyed by user-supplied name; scoped to the org host.
    // -----------------------------------------------------------------------
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
                         '60.0';
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
        var { all, cart } = await getCart(changeSetId);
        // Dedup by (type + fullName) among unresolved items to avoid double-import.
        var seen = {};
        cart.items.forEach(function (it) {
            if (!it.salesforceId && it.fullName) seen[type + '||' + it.fullName] = true;
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
        var { all, cart } = await getCart(changeSetId);
        var unresolved = cart.items.filter(function (it) {
            return it.type === type && !it.salesforceId && it.fullName;
        });
        var needsFullName = cart.items.filter(function (it) {
            return it.type === type && it.salesforceId && !it.fullName;
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
    function _findDelHrefInRow(rowEl) {
        var candidates = rowEl.querySelectorAll('a, button');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var txt = (el.textContent || '').trim();
            var href = el.getAttribute('href') || '';
            if (/^del\b/i.test(txt)) return href;
            if (/listComponentRemoveForPackage|outboundChangeSetComponentRemove/i.test(href)) return href;
        }
        return null;
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
    async function syncFromChangeSetView(changeSetId, packageId) {
        if (!packageId) throw new Error('syncFromChangeSetView: packageId required');
        var items = [];
        var nextUrl = new URL('/' + packageId + '?tab=PackageComponents&rowsperpage=5000', location.href).href;
        var safety = 200;
        var pageNum = 0;
        while (nextUrl && safety-- > 0) {
            pageNum++;
            var r = await fetch(nextUrl, { credentials: 'include' });
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching classic components view');
            var html = await r.text();
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var table = doc.querySelector('table.list');
            if (!table) {
                if (pageNum === 1) throw new Error('No table.list on classic components view (' + r.url + ')');
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
            var dropped = { noCid: 0, noType: 0 };
            rows.forEach(function (row, rowIdx) {
                // Prefer Del link (its ?cid= query is the canonical component
                // id). If no Del link — e.g., Package Components view — fall
                // back to the first SF-id-shaped anchor href, preferring the
                // Name column so we pick the component link over any
                // Parent Object / Included By / Owned By cross-reference.
                var cid = null;
                var href = _findDelHrefInRow(row);
                if (href) {
                    var m = href.match(/[?&]cid=([^&]+)/i);
                    if (m) cid = decodeURIComponent(m[1]);
                }
                if (!cid) cid = _findCidInRowAnchors(row, packageId, idx.name);
                if (!cid) { dropped.noCid++; return; }
                var cells = row.children;
                var type = idx.type >= 0 && cells[idx.type] ? (cells[idx.type].textContent || '').trim() : '';
                var name = idx.name >= 0 && cells[idx.name] ? (cells[idx.name].textContent || '').trim() : '';
                var fullName = idx.fullName >= 0 && cells[idx.fullName] ? (cells[idx.fullName].textContent || '').trim() : '';
                if (!type) { dropped.noType++; return; }
                var it = { id: cid, type: type, name: name || cid };
                if (fullName) it.extra = { fullName: fullName };
                items.push(it);
            });
            console.log('[CSH] Add-page authoritative sync page', pageNum,
                ': rows=', rows.length, 'kept=', rows.length - dropped.noCid - dropped.noType,
                'dropped=', dropped, 'headerIdx=', idx);
            var nextHref = _findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        // Write to every distinct key so both the Add page (033 MetadataPackage
        // id) and the Detail page (0A2 outbound change-set id) see the same
        // authoritative state.
        var keys = [];
        if (changeSetId) keys.push(changeSetId);
        if (packageId && packageId !== changeSetId) keys.push(packageId);
        var summary = { count: items.length, inserted: 0, promoted: 0, kept: 0, pruned: 0 };
        for (var k = 0; k < keys.length; k++) {
            var r2 = await syncItemsFromServer(keys[k], items, { authoritative: true });
            summary.inserted += r2.inserted;
            summary.promoted += r2.promoted;
            summary.kept += r2.kept;
            summary.pruned += r2.pruned;
            console.log('[CSH] Add-page sync key=' + keys[k] +
                ': inserted=' + r2.inserted + ' promoted=' + r2.promoted +
                ' kept=' + r2.kept + ' pruned=' + (r2.pruned || 0) +
                ' (scanned=' + items.length + ')');
        }
        return summary;
    }

    // -----------------------------------------------------------------------
    // Floating panel UI
    // -----------------------------------------------------------------------
    function ensurePanel() {
        var panel = document.getElementById('csh-cart-panel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'csh-cart-panel';
        // On the Change Set Detail page the user isn't actively adding items,
        // they're reviewing an already-populated cart — default to collapsed
        // so the panel doesn't cover the component table on load. The header
        // bar stays visible and one click on "–" expands it. The Add
        // Components pages keep the default expanded state because that's
        // where cart-building actually happens.
        if (/\/changemgmt\/outboundChangeSetDetailPage\.apexp/i.test(location.pathname)) {
            panel.classList.add('csh-cart-collapsed');
        }
        panel.innerHTML =
            '<div class="csh-cart-header">' +
              '<span class="csh-cart-title">Change Set Cart</span>' +
              '<button class="csh-cart-toggle-all" title="Collapse/expand all groups" aria-label="Collapse or expand all groups">⇅</button>' +
              '<button class="csh-cart-close" title="Collapse" aria-label="Collapse">–</button>' +
            '</div>' +
            '<div class="csh-cart-search-row">' +
              '<input type="search" class="csh-cart-search" placeholder="Search cart…" aria-label="Search cart items">' +
            '</div>' +
            '<div class="csh-cart-body"></div>' +
            '<div class="csh-cart-section">' +
              '<label class="csh-cart-section-label">Saved presets</label>' +
              '<div class="csh-cart-section-row">' +
                '<select class="csh-cart-preset-select"><option value="">Load preset…</option></select>' +
                '<button class="csh-cart-save-preset" title="Save current cart as a named preset">Save</button>' +
                '<button class="csh-cart-delete-preset" title="Delete selected preset">Delete</button>' +
              '</div>' +
            '</div>' +
            '<div class="csh-cart-section">' +
              '<label class="csh-cart-section-label">package.xml</label>' +
              '<div class="csh-cart-section-row">' +
                '<button class="csh-cart-export-pkg" title="Download the cart as a Salesforce package.xml file">Export</button>' +
                '<button class="csh-cart-import-pkg" title="Load a package.xml file into the cart">Import</button>' +
                '<button class="csh-cart-import-info" type="button" title="What does Import do?" aria-label="About Import">i</button>' +
                '<input type="file" class="csh-cart-pkg-file" accept=".xml,application/xml" style="display:none">' +
              '</div>' +
            '</div>' +
            '<div class="csh-cart-footer">' +
              '<button class="csh-cart-submit">Submit All</button>' +
              '<button class="csh-cart-retry" style="display:none">Retry failed</button>' +
              '<button class="csh-cart-clear">Clear cart</button>' +
            '</div>';
        document.body.appendChild(panel);
        var searchInput = panel.querySelector('.csh-cart-search');
        // Debounce live re-renders on each keystroke so a fast typist at a
        // 4k cart doesn't queue a render per character. Render pipeline is
        // already rAF-coalesced but the filter pass itself is O(n).
        var searchDebounce = null;
        searchInput.addEventListener('input', function () {
            searchQuery = searchInput.value.trim().toLowerCase();
            if (searchDebounce) clearTimeout(searchDebounce);
            searchDebounce = setTimeout(function () {
                searchDebounce = null;
                renderPanel();
            }, 80);
        });
        // <input type="search">'s native clear button fires a 'search' event;
        // also handle it so clearing refreshes without waiting for blur.
        searchInput.addEventListener('search', function () {
            searchQuery = searchInput.value.trim().toLowerCase();
            renderPanel();
        });
        panel.querySelector('.csh-cart-close').addEventListener('click', togglePanel);
        // Delegated chip click — chips live inside the body, which is
        // re-rendered on every paint, so wire the listener on the stable
        // panel element. Click toggles: same filter → clear; other → switch.
        panel.addEventListener('click', function (ev) {
            var chip = ev.target.closest && ev.target.closest('[data-status-filter]');
            if (!chip || !panel.contains(chip)) return;
            var f = chip.getAttribute('data-status-filter');
            statusFilter = (statusFilter === f) ? '' : f;
            renderPanel();
        });
        panel.querySelector('.csh-cart-toggle-all').addEventListener('click', function () {
            // Mixed state (some open, some closed) → collapse-all wins so
            // the click always produces a visibly uniform result. Pin the
            // decision via expandOverride so the next render honours it.
            var groups = panel.querySelectorAll('.csh-cart-body details.csh-cart-group');
            if (!groups.length) return;
            var anyOpen = Array.prototype.some.call(groups, function (d) { return d.open; });
            var openAll = !anyOpen;
            Array.prototype.forEach.call(groups, function (d) {
                var key = d.getAttribute('data-group-key');
                if (key) expandOverride.set(key, openAll);
            });
            renderPanel();
        });
        panel.querySelector('.csh-cart-submit').addEventListener('click', function () {
            var changeSetId = currentChangeSetId();
            if (changeSetId) runWorker(changeSetId);
        });
        panel.querySelector('.csh-cart-retry').addEventListener('click', function () {
            var changeSetId = currentChangeSetId();
            if (changeSetId) retryFailed(changeSetId);
        });
        panel.querySelector('.csh-cart-clear').addEventListener('click', async function () {
            var changeSetId = currentChangeSetId();
            if (!changeSetId) return;
            var { cart } = await getCart(changeSetId);
            var counts = recountCart(cart);
            var stagedAndFailed = counts.staged + counts.failed;
            var action = await showClearPrompt(counts);
            if (action === 'cancel' || !action) return;
            if (action === 'staged') {
                if (!stagedAndFailed) return;
                await clearStaged(changeSetId);
            } else if (action === 'done') {
                if (!counts.done) return;
                await clearDone(changeSetId);
            } else if (action === 'all') {
                if (!confirm('Clear every cart item — staged, completed, and failed? This cannot be undone.')) return;
                var s = await storageGet([CART_KEY]);
                var all = s[CART_KEY] || {};
                if (all[changeSetId]) {
                    all[changeSetId].items = [];
                    await saveCart(all);
                }
                uncheckAllRowCheckboxes();
            }
        });

        // Preset save
        panel.querySelector('.csh-cart-save-preset').addEventListener('click', async function () {
            var name = prompt('Save current cart as preset. Name?');
            if (!name) return;
            try {
                var p = await savePreset(name);
                window.cshToast && window.cshToast.show('Saved "' + p.name + '" (' + p.itemCount + ' item(s))', { type: 'success' });
                await refreshPresetSelect();
            } catch (e) {
                window.cshToast && window.cshToast.show('Save preset failed: ' + e.message, { type: 'error' });
            }
        });

        // Preset load
        panel.querySelector('.csh-cart-preset-select').addEventListener('change', async function () {
            var name = this.value;
            if (!name) return;
            try {
                var res = await loadPreset(name);
                window.cshToast && window.cshToast.show(
                    'Loaded "' + name + '": added ' + res.added + ' new staged item(s). ' +
                    (res.added < res.total ? (res.total - res.added) + ' were already in cart.' : ''),
                    { type: 'success' }
                );
            } catch (e) {
                window.cshToast && window.cshToast.show('Load preset failed: ' + e.message, { type: 'error' });
            }
            this.value = '';
        });

        // Preset delete
        panel.querySelector('.csh-cart-delete-preset').addEventListener('click', async function () {
            var select = panel.querySelector('.csh-cart-preset-select');
            var name = select.value;
            if (!name) {
                alert('Pick a preset from the dropdown first.');
                return;
            }
            if (!confirm('Delete preset "' + name + '"?')) return;
            await deletePreset(name);
            await refreshPresetSelect();
        });

        // Package.xml export
        panel.querySelector('.csh-cart-export-pkg').addEventListener('click', async function () {
            try { await exportCartAsPackageXml(); }
            catch (e) { window.cshToast && window.cshToast.show('Export failed: ' + e.message, { type: 'error' }); }
        });

        // Package.xml import
        var pkgFileInput = panel.querySelector('.csh-cart-pkg-file');
        panel.querySelector('.csh-cart-import-pkg').addEventListener('click', function () {
            pkgFileInput.click();
        });
        panel.querySelector('.csh-cart-import-info').addEventListener('click', function () {
            window.cshToast && window.cshToast.show(
                'Import loads items from a package.xml into the cart as staged selections only. ' +
                'They are not added to the change set yet — click "Submit All" to send them to Salesforce.',
                { type: 'info', duration: 9000 }
            );
        });
        pkgFileInput.addEventListener('change', async function (ev) {
            var file = ev.target.files && ev.target.files[0];
            if (!file) return;
            try {
                var text = await file.text();
                var added = await importPackageXml(text);
                window.cshToast && window.cshToast.show(
                    'Imported ' + added + ' item(s) from ' + file.name + '. ' +
                    'Items without a Salesforce Id will resolve when you visit each type.',
                    { type: 'success', duration: 6000 }
                );
            } catch (e) {
                window.cshToast && window.cshToast.show('Import failed: ' + e.message, { type: 'error' });
            }
            pkgFileInput.value = '';
        });

        return panel;
    }

    async function refreshPresetSelect() {
        var panel = ensurePanel();
        var select = panel.querySelector('.csh-cart-preset-select');
        if (!select) return;
        var presets = await listPresets();
        select.innerHTML = '<option value="">Load preset…</option>' +
            presets.map(function (p) {
                var label = p.name + ' (' + p.itemCount + ')';
                return '<option value="' + escapeAttr(p.name) + '">' + escapeHtml(label) + '</option>';
            }).join('');
    }

    function togglePanel() {
        var panel = ensurePanel();
        panel.classList.toggle('csh-cart-collapsed');
    }

    // Render coalescing — dirty-flag pattern.
    // At most one render is scheduled or in flight at any time. Calls during
    // an in-flight render flip renderPending; when the current render finishes
    // we re-schedule exactly once, so a burst of N notifyCartChanged() calls
    // produces at most 2 renders (the one in flight + one trailing). Critical
    // for bg sync at 4k items where hundreds of mutations can arrive per
    // second.
    var renderScheduled = false;
    var renderPending = false;
    function renderPanel() {
        if (renderScheduled) { renderPending = true; return; }
        renderScheduled = true;
        requestAnimationFrame(function () { runRender(); });
    }
    async function runRender() {
        renderPending = false;
        try {
            if (extDead || !cshExtAlive()) {
                if (!extDead) markExtDead();
                renderExtDeadBanner();
            } else {
                await doRender();
            }
        } catch (e) {
            var msg = e && e.message ? e.message : String(e);
            if (/Extension context invalidated/i.test(msg)) {
                markExtDead();
                try { renderExtDeadBanner(); } catch (_) {}
            } else {
                console.warn('cshCart render failed:', msg);
            }
        } finally {
            renderScheduled = false;
            if (renderPending && !extDead) renderPanel();
        }
    }

    // Shown in place of the cart when the content script is orphaned by an
    // extension reload/update. We render once, make the panel visible (even
    // when the normal render would have hidden it because items were empty),
    // and give the user a single Reload button — the only real remedy.
    function renderExtDeadBanner() {
        var panel = document.getElementById('csh-cart-panel');
        if (!panel) {
            // Can't use ensurePanel() here because its handlers touch chrome.*
            // indirectly. Build a minimal standalone panel.
            panel = document.createElement('div');
            panel.id = 'csh-cart-panel';
            panel.className = 'csh-cart-ext-dead';
            document.body.appendChild(panel);
        }
        panel.classList.add('csh-cart-ext-dead');
        panel.style.display = '';
        panel.innerHTML =
            '<div class="csh-cart-header">' +
              '<span class="csh-cart-title">Change Set Cart</span>' +
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
    // -----------------------------------------------------------------------
    // Virtualization — per-group windowed rendering.
    //
    // At 4k items rendering every <li> burns DOM nodes and re-layout time
    // on every cart mutation. Groups past VIRT_THRESHOLD get a fixed-height
    // scroll container whose inner spacer matches total*ITEM_H; only rows
    // inside the viewport (+ buffer) actually exist in the DOM. The scroll
    // handler recomputes the window and rewrites rows in place — no full
    // rebuild per scroll tick.
    //
    // Row height is fixed to VIRT_ITEM_H and names single-line with CSS
    // ellipsis when virtualized. Full name/subname are preserved in the
    // row's title attribute so hovering still reveals them. Click removal
    // uses delegation on body so we don't have to rewire listeners when
    // rows are swapped mid-scroll.
    // -----------------------------------------------------------------------
    var VIRT_THRESHOLD = 80;
    var VIRT_ITEM_H = 32;
    var VIRT_VIEWPORT_H = 320;
    var VIRT_BUFFER = 4;

    // Live search filter — user-typed query applied in doRender against
    // name / fullName / salesforceId. Lowercased once on input, compared
    // with substring matches. Empty string means no filter.
    var searchQuery = '';

    // Status filter — click-to-toggle on the top chips. '' = no filter.
    // Valid values: 'staged' | 'submitting' | 'done' | 'failed'.
    var statusFilter = '';

    // Background-sync status. Updated by setSyncState() from callers like
    // detailcomponents.js while syncItemsFromServer is in flight. The render
    // layer reflects this in the header (adds "· Syncing…" and a spinner
    // that's visible even when the panel is collapsed) so users get feedback
    // while the cart reconciles against the server.
    var syncState = 'idle'; // 'idle' | 'syncing' | 'error'
    var syncStateDetail = '';

    function applySyncStateToPanel() {
        var panel = document.getElementById('csh-cart-panel');
        if (!panel) return;
        panel.classList.toggle('csh-cart-syncing', syncState === 'syncing');
        panel.classList.toggle('csh-cart-sync-error', syncState === 'error');
        var titleEl = panel.querySelector('.csh-cart-title');
        if (titleEl) {
            var base = 'Change Set Cart';
            if (syncState === 'syncing') {
                titleEl.innerHTML = escapeHtml(base) +
                    ' <span class="csh-cart-sync-badge">· Syncing' +
                    (syncStateDetail ? ' ' + escapeHtml(syncStateDetail) : '') +
                    '<span class="csh-cart-sync-dot"></span></span>';
            } else if (syncState === 'error') {
                titleEl.innerHTML = escapeHtml(base) +
                    ' <span class="csh-cart-sync-badge csh-cart-sync-badge-error" title="' +
                    escapeAttr(syncStateDetail || 'Sync failed') + '">· Sync failed</span>';
            } else {
                titleEl.textContent = base;
            }
        }
        // When the panel has no visible items but a sync is running, show
        // the panel anyway so the loading badge isn't hidden.
        if (syncState === 'syncing' && panel.style.display === 'none') {
            panel.style.display = '';
        }
    }

    function setSyncState(state, detail) {
        if (state !== 'idle' && state !== 'syncing' && state !== 'error') {
            state = 'idle';
        }
        syncState = state;
        syncStateDetail = detail || '';
        applySyncStateToPanel();
    }

    function itemMatchesSearch(it, q) {
        if (!q) return true;
        var name = (it.name || '').toLowerCase();
        if (name.indexOf(q) !== -1) return true;
        var fullName = (it.fullName || '').toLowerCase();
        if (fullName.indexOf(q) !== -1) return true;
        var sfid = (it.salesforceId || '').toLowerCase();
        if (sfid.indexOf(q) !== -1) return true;
        return false;
    }

    // Auto-collapse groups when the whole cart exceeds this. Avoids mounting
    // N large group bodies up front on cart open — user picks which ones to
    // expand. Toggles still virtualize inside; collapsing just hides the
    // virtualized container entirely.
    var AUTO_COLLAPSE_TOTAL = 500;
    // Session-scoped "user expanded X" memory so re-renders don't reset the
    // user's manual toggles. Keyed by changeSetId + type like scroll state.
    var expandOverride = new Map(); // groupKey -> true/false (user set)

    // scroll-top persisted across re-renders so the user's viewport isn't
    // kicked back to the top every time an item status flips.
    var scrollTopByGroupKey = new Map();
    // Live registry of virtualized group containers on the current panel.
    // Rebuilt on every render; scroll handlers look up the list from here.
    var virtGroupState = new Map();

    function groupKey(changeSetId, type) {
        return changeSetId + '::' + type;
    }

    function itemRowHtml(it, primary, secondary, positioned) {
        var virtualized = positioned != null;
        var tag = virtualized ? 'div' : 'li';
        var style = virtualized
            ? ' style="position:absolute;top:' + (positioned * VIRT_ITEM_H) + 'px;left:0;right:0;height:' + VIRT_ITEM_H + 'px;"'
            : '';
        var cls = 'csh-cart-item status-' + it.status + (virtualized ? ' csh-cart-item-virt' : '');
        return '<' + tag + ' class="' + cls + '" data-uid="' + escapeAttr(it.uid) + '"' + style +
                  ' title="' + escapeAttr(primary + (secondary ? '\n' + secondary : '')) + '">' +
                  '<div class="csh-cart-item-text">' +
                    '<div class="csh-cart-item-name">' + escapeHtml(primary) + '</div>' +
                    (secondary && !virtualized ? '<div class="csh-cart-item-subname">' + escapeHtml(secondary) + '</div>' : '') +
                  '</div>' +
                  '<span class="csh-cart-item-status">' + statusLabel(it) + '</span>' +
                  // 'done' (= already added to the change set) rows have no
                  // × button. Removing those locally doesn't delete them
                  // server-side — the next background sync just re-inserts
                  // them — so the button was misleading. Removal of added
                  // components lives on the Detail page's bulk-remove
                  // toolbar instead.
                  (it.status === 'done'
                    ? ''
                    : '<button class="csh-cart-remove" title="' + escapeAttr(removeTitle(it)) + '"' +
                        (it.status === 'submitting' ? ' data-submitting="1"' : '') +
                        '>×</button>') +
                '</' + tag + '>';
    }

    // Choose primary/secondary display names for an item.
    function itemNames(it) {
        var primary = bestDisplayName(it);
        var secondary = '';
        if (it.fullName && it.name && it.fullName !== it.name && primary === it.fullName) {
            secondary = it.name;
        } else if (it.fullName && it.name && it.fullName !== it.name && primary === it.name) {
            secondary = it.fullName;
        }
        return { primary: primary, secondary: secondary };
    }

    function renderInlineItemsHtml(list) {
        var out = '';
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var n = itemNames(it);
            out += itemRowHtml(it, n.primary, n.secondary, null);
        }
        return out;
    }

    // Renders just the outer virtualized shell — rows are injected by
    // updateVirtWindow() once the DOM is live and we can read scrollTop.
    function renderVirtShellHtml(groupKey, list) {
        var totalH = list.length * VIRT_ITEM_H;
        return '<div class="csh-cart-virt" data-group-key="' + escapeAttr(groupKey) + '"' +
                 ' style="max-height:' + VIRT_VIEWPORT_H + 'px;overflow-y:auto;position:relative;">' +
                 '<div class="csh-cart-virt-inner" style="position:relative;height:' + totalH + 'px;">' +
                 '</div>' +
               '</div>';
    }

    function updateVirtWindow(container, list) {
        var inner = container.querySelector('.csh-cart-virt-inner');
        if (!inner) return;
        var scrollTop = container.scrollTop;
        var viewH = container.clientHeight || VIRT_VIEWPORT_H;
        var first = Math.max(0, Math.floor(scrollTop / VIRT_ITEM_H) - VIRT_BUFFER);
        var visibleCount = Math.ceil(viewH / VIRT_ITEM_H) + 2 * VIRT_BUFFER;
        var last = Math.min(list.length, first + visibleCount);
        var html = '';
        for (var i = first; i < last; i++) {
            var it = list[i];
            var n = itemNames(it);
            html += itemRowHtml(it, n.primary, n.secondary, i);
        }
        inner.innerHTML = html;
    }

    function wireVirtGroup(container, list, savedScrollTop) {
        virtGroupState.set(container, list);
        if (savedScrollTop) container.scrollTop = savedScrollTop;
        updateVirtWindow(container, list);
        // rAF-coalesce scroll — a fast scroll generates many events but we
        // only need one DOM rewrite per frame.
        var scrollPending = false;
        container.addEventListener('scroll', function () {
            if (scrollPending) return;
            scrollPending = true;
            requestAnimationFrame(function () {
                scrollPending = false;
                var current = virtGroupState.get(container);
                if (current) updateVirtWindow(container, current);
            });
            var key = container.getAttribute('data-group-key');
            if (key) scrollTopByGroupKey.set(key, container.scrollTop);
        });
        // When a collapsed <details> re-opens, the container's clientHeight
        // was 0 at wire time — repaint now that it's visible.
        var details = container.closest('details.csh-cart-group');
        if (details) {
            details.addEventListener('toggle', function () {
                if (details.open) {
                    var current = virtGroupState.get(container);
                    if (current) updateVirtWindow(container, current);
                }
            });
        }
    }

    async function doRender() {
            var panel = ensurePanel();
            var changeSetId = currentChangeSetId();
            if (!changeSetId) { panel.style.display = 'none'; return; }
            var { cart } = await getCart(changeSetId);
            var items = cart.items || [];
            if (items.length === 0 && syncState !== 'syncing') {
                panel.style.display = 'none';
                return;
            }
            panel.style.display = '';
            if (items.length === 0) {
                // Empty cart + active sync: show a loading shell so the user
                // sees feedback while the sync discovers items.
                var emptyBody = panel.querySelector('.csh-cart-body');
                if (emptyBody) {
                    emptyBody.innerHTML = '<div class="csh-cart-empty">Syncing cart with server…</div>';
                }
                applySyncStateToPanel();
                return;
            }
            var q = searchQuery;
            var sf = statusFilter;
            var byType = {};
            var visibleTotal = 0;
            items.forEach(function (it) {
                if (!itemMatchesSearch(it, q)) return;
                if (sf && (it.status || 'staged') !== sf) return;
                (byType[it.type] = byType[it.type] || []).push(it);
                visibleTotal++;
            });
            // Top chips stay as overall cart state so users still see the
            // submission pipeline while filtering. Per-group (N) counts
            // below naturally reflect the filter.
            var counts = ensureCounts(cart);
            virtGroupState = new Map(); // reset per render; populated below
            var body = panel.querySelector('.csh-cart-body');
            function statusChipHtml(filter, count, label, colorClass, alwaysShow) {
                // Render when the chip has a count OR is the active filter —
                // otherwise the user would lose the handle to clear a filter
                // whose last matching item just changed state.
                if (!count && !alwaysShow && sf !== filter) return '';
                var active = sf === filter;
                return '<span class="chip ' + colorClass +
                    (active ? ' chip-active' : '') +
                    '" data-status-filter="' + filter +
                    '" role="button" tabindex="0" title="Click to ' +
                    (active ? 'clear filter' : 'show only ' + label) +
                    '">' + count + ' ' + label + '</span>';
            }
            var html = '<div class="csh-cart-counts">' +
                statusChipHtml('staged', counts.staged, 'staged', 'chip-staged', true) +
                statusChipHtml('submitting', counts.submitting, 'submitting', 'chip-submitting', false) +
                statusChipHtml('done', counts.done, 'added', 'chip-done', false) +
                statusChipHtml('failed', counts.failed, 'failed', 'chip-failed', false) +
                (q ? '<span class="chip chip-filter">' + visibleTotal + ' matching “' + escapeHtml(q) + '”</span>' : '') +
                '</div>';
            if ((q || sf) && visibleTotal === 0) {
                html += '<div class="csh-cart-empty">No items match the current filter.</div>';
            }
            var virtualizedGroups = []; // {key, list} — wired post-innerHTML
            // With a search active, auto-expand every group so the user
            // sees matches immediately without hunting through collapsed
            // groups. When search clears, saved overrides / auto-collapse
            // resume as before.
            var autoCollapseAll = !q && items.length > AUTO_COLLAPSE_TOTAL;
            Object.keys(byType).sort().forEach(function (type) {
                var list = byType[type];
                var key = groupKey(changeSetId, type);
                // Expand decision: user override wins; otherwise default is
                // open when total cart is small, collapsed when large so the
                // initial paint stays cheap.
                var override = expandOverride.get(key);
                // With search active, always expand matching groups so the
                // hits are visible. Otherwise honour the user's override or
                // fall back to the auto-collapse default.
                var isOpen = q
                    ? true
                    : (override != null ? override : !autoCollapseAll);
                // Summary shows a preview of the first few names so the user
                // can scan the cart without having to expand every group.
                var previewNames = list
                    .slice(0, 3)
                    .map(function (it) { return bestDisplayName(it); })
                    .join(', ');
                if (list.length > 3) previewNames += ', +' + (list.length - 3) + ' more';

                html += '<details class="csh-cart-group"' + (isOpen ? ' open' : '') + ' data-group-key="' + escapeAttr(key) + '">' +
                        '<summary>' +
                          '<span class="csh-cart-group-type">' + escapeHtml(type) + '</span> ' +
                          '<span class="csh-cart-type-count">(' + list.length + ')</span>' +
                          '<div class="csh-cart-group-preview" title="' + escapeAttr(previewNames) + '">' +
                            escapeHtml(previewNames) +
                          '</div>' +
                        '</summary>';
                if (list.length > VIRT_THRESHOLD) {
                    html += renderVirtShellHtml(key, list);
                    virtualizedGroups.push({ key: key, list: list });
                } else {
                    html += '<ul>' + renderInlineItemsHtml(list) + '</ul>';
                }
                html += '</details>';
            });
            body.innerHTML = html;
            virtualizedGroups.forEach(function (g) {
                var container = body.querySelector('.csh-cart-virt[data-group-key="' + cssSel(g.key) + '"]');
                if (container) {
                    wireVirtGroup(container, g.list, scrollTopByGroupKey.get(g.key));
                }
            });
            wireRemoveClickDelegation(body);
            wireExpandOverrideTracking(body);
            panel.querySelector('.csh-cart-retry').style.display = counts.failed ? '' : 'none';
            panel.querySelector('.csh-cart-submit').disabled = (counts.staged === 0) || workerRunning;
            panel.querySelector('.csh-cart-submit').textContent = workerRunning
                ? 'Submitting…'
                : 'Submit All (' + counts.staged + ')';
            applySyncStateToPanel();
    }

    // CSS attribute-selector escape for data-group-key lookups. changeSetId
    // and type are usually safe identifiers but we escape defensively.
    function cssSel(s) {
        return String(s).replace(/["\\]/g, '\\$&');
    }

    // One delegated toggle listener: when the user opens or closes a group,
    // remember that choice so re-renders don't fight the user. The toggle
    // event doesn't bubble natively — use capture so we catch it on body.
    function wireExpandOverrideTracking(body) {
        if (body._cshToggleWired) return;
        body._cshToggleWired = true;
        body.addEventListener('toggle', function (ev) {
            var det = ev.target;
            if (!det || det.tagName !== 'DETAILS') return;
            var key = det.getAttribute('data-group-key');
            if (!key) return;
            expandOverride.set(key, !!det.open);
        }, true);
    }

    // One delegated click listener for the lifetime of the body element.
    // Reads the current change-set id inside the handler so navigations
    // within the same panel target the right cart.
    function wireRemoveClickDelegation(body) {
        if (body._cshRemoveWired) return;
        body._cshRemoveWired = true;
        body.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('.csh-cart-remove');
            if (!btn) return;
            // Block remove while the worker is actively submitting this row.
            // The worker reconciles status by uid/predicate, so pulling the
            // row out from under it isn't outright corrupting — but it means
            // the user could see a stale "submitting…" flash re-appear if
            // the row is re-added, which is confusing. Simpler to block.
            if (btn.getAttribute('data-submitting') === '1' && workerRunning) {
                if (window.cshToast) {
                    window.cshToast.show(
                        'Can\'t remove an item that\'s currently submitting. Wait for it to finish.',
                        { type: 'warning', duration: 4000 }
                    );
                }
                return;
            }
            var li = btn.closest('.csh-cart-item');
            if (!li) return;
            var csId = currentChangeSetId();
            if (csId) removeItem(csId, li.getAttribute('data-uid'));
        });
    }

    function statusLabel(it) {
        if (it.status === 'staged') return 'staged';
        if (it.status === 'submitting') return 'submitting…';
        if (it.status === 'done') return 'added ✓';
        if (it.status === 'failed') return 'failed — ' + (it.error || '');
        return it.status;
    }

    // Tooltip text for the per-row × button. Conveys the real effect of the
    // click, which differs by status. Server-side delete isn't implemented
    // here yet (blocked on bulk-remove #1), so 'done' rows only remove from
    // the local cart — background sync on next detail-page visit will re-
    // add them from the server as source:'server-sync'.
    function removeTitle(it) {
        if (!it) return 'Remove';
        if (it.status === 'staged') return 'Remove (not yet submitted)';
        if (it.status === 'failed') return 'Remove failed item from cart';
        if (it.status === 'submitting') return 'Submission in progress — cannot remove yet';
        if (it.status === 'done') {
            if (it.source === 'server-sync') {
                return 'Remove from cart only (still in change set on server)';
            }
            return 'Remove from cart (still in change set on server)';
        }
        return 'Remove';
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

    // -----------------------------------------------------------------------
    // Type-switch prompt
    //   Wraps the Component Type dropdown so we can intercept before
    //   Salesforce reloads the page.
    // -----------------------------------------------------------------------
    function installTypeSwitchGuard(currentType) {
        var $typeSelect = $('#entityType').length
            ? $('#entityType')
            : $('select[name="entityType"], select[name="p3"]').first();
        if (!$typeSelect.length) return;

        $typeSelect.off('change.csh').on('change.csh', async function (e) {
            var checked = harvestChecked();
            if (checked.length === 0) return; // nothing to stage, let it navigate
            e.preventDefault();
            e.stopImmediatePropagation();
            var newType = $typeSelect.val();
            var action = await showStagingPrompt(currentType, newType, checked.length);
            var changeSetId = currentChangeSetId();
            if (!changeSetId) return;
            if (action === 'cancel') {
                // revert the select to the previous type
                $typeSelect.val(currentType);
                return;
            }
            if (action === 'stage') {
                await addItems(changeSetId, currentType, checked);
            } else if (action === 'submit') {
                await addItems(changeSetId, currentType, checked);
                runWorker(changeSetId); // fire-and-forget
            }
            // discard = do nothing to the cart; just navigate
            navigateToType($typeSelect, newType);
        });
    }

    function navigateToType($typeSelect, newType) {
        // Re-fire Salesforce's own change handler by removing our namespace
        // and calling change() once more. If Salesforce's handler is bound
        // via inline onchange we trigger that too.
        $typeSelect.off('change.csh');
        var onchange = $typeSelect.attr('onchange');
        if (onchange) {
            try { new Function('event', onchange).call($typeSelect[0]); return; } catch (_) {}
        }
        $typeSelect.trigger('change');
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

    function showStagingPrompt(currentType, newType, count) {
        return new Promise(function (resolve) {
            var scrim = document.createElement('div');
            scrim.className = 'csh-modal-scrim';
            scrim.innerHTML =
                '<div class="csh-modal">' +
                  '<h3>Save your ' + escapeHtml(currentType) + ' selections?</h3>' +
                  '<p>You have <strong>' + count + '</strong> unsaved ' + escapeHtml(currentType) +
                  ' selection(s). Switching to <strong>' + escapeHtml(newType) +
                  '</strong> will lose them unless you stage them first.</p>' +
                  '<div class="csh-modal-actions">' +
                    '<button data-action="stage" class="btn-primary">Save to cart</button>' +
                    '<button data-action="submit">Save &amp; submit in background</button>' +
                    '<button data-action="discard">Discard selections</button>' +
                    '<button data-action="cancel" class="btn-ghost">Cancel</button>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(scrim);
            scrim.addEventListener('click', function (e) {
                var action = e.target && e.target.getAttribute('data-action');
                if (!action) return;
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

        // Cache the form shape for this type so the worker can replay later
        // even if the user has navigated away.
        var shape = scrapeFormShape();
        if (shape && opts.currentType) {
            await cacheFormShape(_currentChangeSetId, opts.currentType, shape);
        }

        // Restore staged-but-not-submitted items for this type.
        if (opts.currentType) {
            var restored = await restoreFromCart(_currentChangeSetId, opts.currentType);
            if (restored > 0) {
                console.log('cshCart: restored', restored, 'checkbox(es) from cart');
            }
        }

        // Watch for new storage writes from other tabs or from the worker.
        if (cshExtAlive()) {
            try {
                chrome.storage.onChanged.addListener(function (changes, area) {
                    if (area !== 'local') return;
                    if (changes[CART_KEY]) renderPanel();
                });
            } catch (_) { markExtDead(); }
        }

        // Install the auto-save delegate. This is the primary persistence
        // mechanism for user selections — every checkbox click flushes to
        // chrome.storage.local before any Salesforce-initiated navigation can
        // run, so the cart survives refresh without relying on modal timing.
        if (opts.currentType) {
            installCheckboxAutoSave(_currentChangeSetId, opts.currentType);
        }
        // Type-switch guard kept as NO-OP: dropdown change now lets Salesforce
        // navigate freely because state is already persisted on every click.
        // (Previously a modal tried to intercept and lost the race.)
        renderPanel();
        // Populate the presets dropdown asynchronously; doesn't gate init.
        refreshPresetSelect().catch(function (e) {
            console.warn('refreshPresetSelect failed:', e && e.message);
        });
        // Lazily resolve any imported-but-unresolved items for this type.
        if (opts.currentType) {
            rescanForFullNames(_currentChangeSetId, opts.currentType).catch(function () {});
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
        syncItemsFromServer: syncItemsFromServer,
        setSyncState: setSyncState,
        removeItem: removeItem,
        clearType: clearType,
        clearDone: clearDone,
        clearStaged: clearStaged,
        runWorker: runWorker,
        retryFailed: retryFailed,
        harvestChecked: harvestChecked,
        restoreFromCart: restoreFromCart,
        getCart: getCart,
        flushNow: flushNow,
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
