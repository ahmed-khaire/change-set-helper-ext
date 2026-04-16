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
    // Storage primitives
    // -----------------------------------------------------------------------
    function storageGet(keys) {
        return new Promise(function (resolve) {
            chrome.storage.local.get(keys, function (items) { resolve(items || {}); });
        });
    }
    function storageSet(obj) {
        return new Promise(function (resolve) {
            chrome.storage.local.set(obj, function () { resolve(); });
        });
    }

    function uid() {
        return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // -----------------------------------------------------------------------
    // Cart CRUD
    // -----------------------------------------------------------------------
    async function getCart(changeSetId) {
        var s = await storageGet([CART_KEY]);
        var all = s[CART_KEY] || {};
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

    async function saveCart(all) {
        await storageSet({ [CART_KEY]: all });
        notifyCartChanged();
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
                addedAt: Date.now()
            });
            added++;
        });
        await saveCart(all);
        return added;
    }

    async function removeItem(changeSetId, uid) {
        var { all, cart } = await getCart(changeSetId);
        cart.items = cart.items.filter(function (it) { return it.uid !== uid; });
        await saveCart(all);
    }

    async function clearType(changeSetId, type) {
        var { all, cart } = await getCart(changeSetId);
        cart.items = cart.items.filter(function (it) {
            return !(it.type === type && it.status === 'staged');
        });
        await saveCart(all);
    }

    async function clearDone(changeSetId) {
        var { all, cart } = await getCart(changeSetId);
        cart.items = cart.items.filter(function (it) { return it.status !== 'done'; });
        await saveCart(all);
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
    // Floating panel UI
    // -----------------------------------------------------------------------
    function ensurePanel() {
        var panel = document.getElementById('csh-cart-panel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'csh-cart-panel';
        panel.innerHTML =
            '<div class="csh-cart-header">' +
              '<span class="csh-cart-title">Change Set Cart</span>' +
              '<button class="csh-cart-close" title="Collapse" aria-label="Collapse">–</button>' +
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
                '<input type="file" class="csh-cart-pkg-file" accept=".xml,application/xml" style="display:none">' +
              '</div>' +
            '</div>' +
            '<div class="csh-cart-footer">' +
              '<button class="csh-cart-submit">Submit All</button>' +
              '<button class="csh-cart-retry" style="display:none">Retry failed</button>' +
              '<button class="csh-cart-clear">Clear cart</button>' +
            '</div>';
        document.body.appendChild(panel);
        panel.querySelector('.csh-cart-close').addEventListener('click', togglePanel);
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
            if (!confirm('Clear all cart items? Already-submitted items stay in the change set.')) return;
            var s = await storageGet([CART_KEY]);
            var all = s[CART_KEY] || {};
            if (all[changeSetId]) {
                all[changeSetId].items = [];
                await saveCart(all);
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

    var renderQueued = false;
    function renderPanel() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(async function () {
            renderQueued = false;
            var panel = ensurePanel();
            var changeSetId = currentChangeSetId();
            if (!changeSetId) { panel.style.display = 'none'; return; }
            var { cart } = await getCart(changeSetId);
            var items = cart.items || [];
            if (items.length === 0) {
                panel.style.display = 'none';
                return;
            }
            panel.style.display = '';
            var byType = {};
            var counts = { staged: 0, submitting: 0, done: 0, failed: 0 };
            items.forEach(function (it) {
                (byType[it.type] = byType[it.type] || []).push(it);
                counts[it.status] = (counts[it.status] || 0) + 1;
            });
            var body = panel.querySelector('.csh-cart-body');
            var html = '<div class="csh-cart-counts">' +
                '<span class="chip chip-staged">' + counts.staged + ' staged</span>' +
                (counts.submitting ? '<span class="chip chip-submitting">' + counts.submitting + ' submitting</span>' : '') +
                (counts.done ? '<span class="chip chip-done">' + counts.done + ' added</span>' : '') +
                (counts.failed ? '<span class="chip chip-failed">' + counts.failed + ' failed</span>' : '') +
                '</div>';
            Object.keys(byType).sort().forEach(function (type) {
                var list = byType[type];
                // Summary shows a preview of the first few names so the user
                // can scan the cart without having to expand every group.
                var previewNames = list
                    .slice(0, 3)
                    .map(function (it) { return bestDisplayName(it); })
                    .join(', ');
                if (list.length > 3) previewNames += ', +' + (list.length - 3) + ' more';

                html += '<details class="csh-cart-group" open>' +
                        '<summary>' +
                          '<span class="csh-cart-group-type">' + escapeHtml(type) + '</span> ' +
                          '<span class="csh-cart-type-count">(' + list.length + ')</span>' +
                          '<div class="csh-cart-group-preview" title="' + escapeAttr(previewNames) + '">' +
                            escapeHtml(previewNames) +
                          '</div>' +
                        '</summary>' +
                        '<ul>';
                list.slice(0, 50).forEach(function (it) {
                    var primary = bestDisplayName(it);
                    // Secondary row: the alternative name (fullName vs short name)
                    // only when they differ — e.g. CustomField "Account.MyField"
                    // as primary with short name "MyField" as secondary.
                    var secondary = '';
                    if (it.fullName && it.name && it.fullName !== it.name && primary === it.fullName) {
                        secondary = it.name;
                    } else if (it.fullName && it.name && it.fullName !== it.name && primary === it.name) {
                        secondary = it.fullName;
                    }
                    html += '<li class="csh-cart-item status-' + it.status + '" data-uid="' + escapeAttr(it.uid) + '"' +
                              ' title="' + escapeAttr(primary + (secondary ? '\n' + secondary : '')) + '">' +
                              '<div class="csh-cart-item-text">' +
                                '<div class="csh-cart-item-name">' + escapeHtml(primary) + '</div>' +
                                (secondary ? '<div class="csh-cart-item-subname">' + escapeHtml(secondary) + '</div>' : '') +
                              '</div>' +
                              '<span class="csh-cart-item-status">' + statusLabel(it) + '</span>' +
                              (it.status === 'staged'
                                ? '<button class="csh-cart-remove" title="Remove">×</button>'
                                : '') +
                            '</li>';
                });
                if (list.length > 50) {
                    html += '<li class="csh-cart-more">… and ' + (list.length - 50) + ' more</li>';
                }
                html += '</ul></details>';
            });
            body.innerHTML = html;
            body.querySelectorAll('.csh-cart-remove').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var li = btn.closest('.csh-cart-item');
                    removeItem(changeSetId, li.getAttribute('data-uid'));
                });
            });
            panel.querySelector('.csh-cart-retry').style.display = counts.failed ? '' : 'none';
            panel.querySelector('.csh-cart-submit').disabled = (counts.staged === 0) || workerRunning;
            panel.querySelector('.csh-cart-submit').textContent = workerRunning
                ? 'Submitting…'
                : 'Submit All (' + counts.staged + ')';
        });
    }

    function statusLabel(it) {
        if (it.status === 'staged') return 'staged';
        if (it.status === 'submitting') return 'submitting…';
        if (it.status === 'done') return 'added ✓';
        if (it.status === 'failed') return 'failed — ' + (it.error || '');
        return it.status;
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
        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== 'local') return;
            if (changes[CART_KEY]) renderPanel();
        });

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
        removeItem: removeItem,
        clearType: clearType,
        runWorker: runWorker,
        retryFailed: retryFailed,
        harvestChecked: harvestChecked,
        restoreFromCart: restoreFromCart,
        getCart: getCart,
        // Phase 6 additions
        listPresets: listPresets,
        savePreset: savePreset,
        loadPreset: loadPreset,
        deletePreset: deletePreset,
        exportCartAsPackageXml: exportCartAsPackageXml,
        importPackageXml: importPackageXml,
        rescanForFullNames: rescanForFullNames
    };
})();
