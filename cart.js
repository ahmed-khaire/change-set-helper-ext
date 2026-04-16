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
        return $.trim($row.children('td').eq(0).text()) ||
               $.trim($row.children('td').eq(1).text()) ||
               '(unnamed)';
    }

    function harvestChecked() {
        var out = [];
        findRowCheckboxes().each(function () {
            if (!this.checked) return;
            var id = idForRow(this);
            if (!id) return;
            out.push({ id: id, name: nameForRow(this) });
        });
        return out;
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
    var workerRunning = false;
    async function runWorker(changeSetId) {
        if (workerRunning) return;
        workerRunning = true;
        try {
            while (true) {
                var { cart } = await getCart(changeSetId);
                var staged = cart.items.filter(function (it) { return it.status === 'staged'; });
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
        return panel;
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
                html += '<details class="csh-cart-group" open>' +
                        '<summary>' + escapeHtml(type) + ' <span class="csh-cart-type-count">(' + list.length + ')</span></summary>' +
                        '<ul>';
                list.slice(0, 50).forEach(function (it) {
                    html += '<li class="csh-cart-item status-' + it.status + '" data-uid="' + escapeAttr(it.uid) + '">' +
                              '<span class="csh-cart-item-name">' + escapeHtml(it.name) + '</span>' +
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

        installTypeSwitchGuard(opts.currentType);
        renderPanel();

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
        getCart: getCart
    };
})();
