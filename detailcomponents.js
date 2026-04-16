// ---------------------------------------------------------------------------
// Change Set Helper — Detail Page Components block (Phase 7, corrected)
//
// The modern Outbound Change Set Detail page renders its components table
// INLINE on /changemgmt/outboundChangeSetDetailPage.apexp, not on a separate
// ?tab=PackageComponents URL like older Salesforce versions. The "Remove"
// action is a Visualforce actionLink whose onclick fires
// confirmRemoveComponent(cid) -> deleteComponent(cid) -> A4J.AJAX.Submit()
// against the page's form. Since content scripts run in an isolated world,
// we can't call deleteComponent() directly; we inject a tiny bridge script
// into the page context that listens for postMessage commands and invokes
// deleteComponent on our behalf, reporting success/failure back.
//
// Each A4J submit rewrites the form's ViewState, so parallel deletes would
// race. Removes MUST be sequential. A MutationObserver watches the DOM for
// the row to disappear (confirming the partial refresh landed) before we
// dispatch the next delete.
// ---------------------------------------------------------------------------

(function () {
    'use strict';

    var COMPONENTS_TABLE_SEL = 'table.list';
    var REMOVE_LINK_SEL = 'a[id*="removeLink"]';
    var CONFIRM_REGEX = /confirmRemoveComponent\(\s*['"]([^'"]+)['"]\s*\)/;

    var pendingDeletes = {};     // mid -> {resolve, reject}
    var pageBridgeInjected = false;
    var bulkCancelled = false;
    var selectionCount = 0;

    // Wait for the Components table to appear. Salesforce renders this
    // synchronously for most orgs, but some Lightning wrappers delay it
    // behind an AJAX initial load, so poll briefly.
    var pollAttempts = 0;
    var pollTimer = setInterval(function () {
        pollAttempts++;
        var table = document.querySelector(COMPONENTS_TABLE_SEL);
        if (table && table.querySelector(REMOVE_LINK_SEL)) {
            clearInterval(pollTimer);
            setupPage(table);
        } else if (pollAttempts > 40) { // 8 seconds
            clearInterval(pollTimer);
            console.log('detailcomponents: Components table not found after 8s — skipping enhancement.');
        }
    }, 200);

    function setupPage(table) {
        injectPageBridge();
        injectSelectionColumn(table);
        injectToolbar(table);
        observeTableChanges(table);
        wireDelegatedEvents();
        console.log('detailcomponents: initialized on', table);
    }

    // -----------------------------------------------------------------------
    // Page-context bridge. Injected once via a <script> tag whose textContent
    // runs in the page's JS world where deleteComponent is defined. The
    // bridge exposes nothing globally; it listens on window.message for a
    // tagged command and calls deleteComponent, then posts a reply with the
    // original message id.
    // -----------------------------------------------------------------------
    function injectPageBridge() {
        if (pageBridgeInjected) return;
        pageBridgeInjected = true;

        var s = document.createElement('script');
        s.textContent =
            '(function(){' +
              'window.addEventListener("message",function(ev){' +
                'var d=ev.data;' +
                'if(!d||d.__cshBulk!==true||d.source==="page")return;' +
                'try{' +
                  'if(d.cmd==="delete"){' +
                    'if(typeof deleteComponent!=="function")throw new Error("deleteComponent not available");' +
                    'deleteComponent(d.cid);' +
                    'window.postMessage({__cshBulk:true,source:"page",mid:d.mid,ok:true},"*");' +
                  '}' +
                '}catch(err){' +
                  'window.postMessage({__cshBulk:true,source:"page",mid:d.mid,ok:false,error:err.message},"*");' +
                '}' +
              '});' +
            '})();';
        (document.head || document.documentElement).appendChild(s);
        s.remove();

        // Content-script side listener for the bridge's replies.
        window.addEventListener('message', function (ev) {
            var d = ev.data;
            if (!d || d.__cshBulk !== true || d.source !== 'page') return;
            var pending = pendingDeletes[d.mid];
            if (!pending) return;
            delete pendingDeletes[d.mid];
            if (d.ok) pending.resolve();
            else pending.reject(new Error(d.error || 'unknown error'));
        });
    }

    // -----------------------------------------------------------------------
    // Selection column + row annotation.
    // -----------------------------------------------------------------------
    function injectSelectionColumn(table) {
        var headerRow = table.querySelector('tr.headerRow');
        if (headerRow && !headerRow.querySelector('.csh-dc-select-col')) {
            var th = document.createElement('th');
            th.className = 'csh-dc-select-col';
            th.innerHTML = '<input type="checkbox" class="csh-dc-select-all" title="Select all visible rows">';
            headerRow.insertBefore(th, headerRow.firstChild);
        }
        table.querySelectorAll('tr.dataRow').forEach(annotateRow);
    }

    function annotateRow(row) {
        if (row.querySelector('.csh-dc-select-col')) return;
        var removeLink = row.querySelector(REMOVE_LINK_SEL);
        var cid = extractComponentIdFromLink(removeLink);
        var nameCell = row.querySelectorAll('td')[1]; // 0=Remove action, 1=Name
        var displayName = nameCell ? (nameCell.textContent || '').trim() : (cid || '(unknown)');

        var td = document.createElement('td');
        td.className = 'csh-dc-select-col';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'csh-dc-select-row';
        cb.setAttribute('data-cid', cid || '');
        cb.setAttribute('data-name', displayName);
        if (!cid) cb.disabled = true;
        td.appendChild(cb);
        row.insertBefore(td, row.firstChild);
    }

    function extractComponentIdFromLink(link) {
        if (!link) return null;
        var onclick = link.getAttribute('onclick') || '';
        var m = onclick.match(CONFIRM_REGEX);
        return m ? m[1] : null;
    }

    // -----------------------------------------------------------------------
    // Toolbar.
    // -----------------------------------------------------------------------
    function injectToolbar(table) {
        if (document.querySelector('.csh-dc-toolbar')) return;
        var toolbar = document.createElement('div');
        toolbar.className = 'csh-dc-toolbar';
        toolbar.innerHTML =
            '<span class="csh-dc-label">Bulk:</span>' +
            '<button type="button" class="csh-dc-select-all-btn">Select all</button>' +
            '<button type="button" class="csh-dc-select-none-btn">Clear</button>' +
            '<span class="csh-dc-count">0 selected</span>' +
            '<button type="button" class="csh-dc-remove-btn" disabled>Remove selected</button>';
        table.parentNode.insertBefore(toolbar, table);
    }

    // -----------------------------------------------------------------------
    // Event wiring (delegated so rows added later by A4J refreshes work too).
    // -----------------------------------------------------------------------
    function wireDelegatedEvents() {
        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (t.classList.contains('csh-dc-select-all')) {
                var checked = t.checked;
                document.querySelectorAll('.csh-dc-select-row:not([disabled])').forEach(function (cb) { cb.checked = checked; });
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-select-row')) {
                updateSelectionCount();
            }
        });

        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (t.classList.contains('csh-dc-select-all-btn')) {
                document.querySelectorAll('.csh-dc-select-row:not([disabled])').forEach(function (cb) { cb.checked = true; });
                var allCb = document.querySelector('.csh-dc-select-all');
                if (allCb) allCb.checked = true;
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-select-none-btn')) {
                document.querySelectorAll('.csh-dc-select-row, .csh-dc-select-all').forEach(function (cb) { cb.checked = false; });
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-remove-btn')) {
                handleRemoveSelected();
            }
        });
    }

    function updateSelectionCount() {
        selectionCount = document.querySelectorAll('.csh-dc-select-row:checked').length;
        var countEl = document.querySelector('.csh-dc-count');
        if (countEl) countEl.textContent = selectionCount + ' selected';
        var btn = document.querySelector('.csh-dc-remove-btn');
        if (btn) btn.disabled = selectionCount === 0;
    }

    // -----------------------------------------------------------------------
    // A4J renders partial-updates by replacing chunks of the table. We need
    // to re-annotate any newly-inserted rows so they get our select column.
    // -----------------------------------------------------------------------
    function observeTableChanges(table) {
        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    if (node.matches && node.matches('tr.dataRow')) annotateRow(node);
                    if (node.querySelectorAll) {
                        node.querySelectorAll('tr.dataRow').forEach(annotateRow);
                    }
                });
            });
            updateSelectionCount();
        });
        observer.observe(table, { childList: true, subtree: true });
    }

    // -----------------------------------------------------------------------
    // Bulk remove worker — sequential deletes with progress modal.
    // -----------------------------------------------------------------------
    async function handleRemoveSelected() {
        var checkboxes = Array.from(document.querySelectorAll('.csh-dc-select-row:checked'));
        if (checkboxes.length === 0) return;
        if (!confirm('Remove ' + checkboxes.length + ' component(s) from this change set? This cannot be undone.')) return;

        bulkCancelled = false;
        showProgressModal(checkboxes.length);

        var done = 0, failed = 0;
        for (var i = 0; i < checkboxes.length; i++) {
            if (bulkCancelled) break;
            var cb = checkboxes[i];
            var cid = cb.getAttribute('data-cid');
            var name = cb.getAttribute('data-name') || cid;
            var row = cb.closest('tr');

            try {
                if (!cid) throw new Error('No component ID on this row');
                await requestDelete(cid);
                await waitForRowRemoval(row);
                done++;
                appendLog('✓ ' + name, 'ok');
            } catch (err) {
                failed++;
                appendLog('✗ ' + name + ' — ' + err.message, 'fail');
            }
            updateProgress(done + failed, checkboxes.length);
        }

        finishProgressModal(done, failed);
        updateSelectionCount();
    }

    function requestDelete(cid) {
        return new Promise(function (resolve, reject) {
            var mid = 'csh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            pendingDeletes[mid] = { resolve: resolve, reject: reject };
            // Safety timeout — if the bridge doesn't reply in 8 s something's
            // wrong and we surface it rather than hanging forever.
            setTimeout(function () {
                if (pendingDeletes[mid]) {
                    delete pendingDeletes[mid];
                    reject(new Error('bridge timeout (is A4J still loaded?)'));
                }
            }, 8000);
            window.postMessage({ __cshBulk: true, cmd: 'delete', cid: cid, mid: mid }, '*');
        });
    }

    function waitForRowRemoval(row) {
        return new Promise(function (resolve) {
            // If the row is already detached (some A4J responses do this on
            // the client before our next microtask), resolve immediately.
            if (!row || !row.isConnected) { resolve(); return; }

            var timeout = setTimeout(function () {
                observer.disconnect();
                // Give up waiting; continue. Next iteration's delete still works;
                // the server state is authoritative.
                resolve();
            }, 10000);

            var observer = new MutationObserver(function () {
                if (!row.isConnected) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    // Small settle delay so the next A4J submit's ViewState
                    // picks up the new state rather than the one mid-swap.
                    setTimeout(resolve, 250);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    // -----------------------------------------------------------------------
    // Progress modal.
    // -----------------------------------------------------------------------
    function showProgressModal(total) {
        // Close any pre-existing modal (shouldn't happen but defensive).
        var existing = document.querySelector('.csh-dc-modal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.className = 'csh-dc-modal';
        modal.innerHTML =
            '<div class="csh-dc-modal-body">' +
              '<h3 class="csh-dc-modal-title">Removing components…</h3>' +
              '<div class="csh-dc-modal-bar"><div class="csh-dc-modal-fill"></div></div>' +
              '<div class="csh-dc-modal-count">0 / ' + total + '</div>' +
              '<div class="csh-dc-modal-log"></div>' +
              '<div class="csh-dc-modal-actions">' +
                '<button type="button" class="csh-dc-modal-cancel">Cancel</button>' +
                '<button type="button" class="csh-dc-modal-close" style="display:none">Close</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(modal);

        modal.querySelector('.csh-dc-modal-cancel').addEventListener('click', function () {
            bulkCancelled = true;
        });
        modal.querySelector('.csh-dc-modal-close').addEventListener('click', function () {
            modal.remove();
        });
    }

    function appendLog(text, kind) {
        var log = document.querySelector('.csh-dc-modal-log');
        if (!log) return;
        var entry = document.createElement('div');
        entry.className = 'csh-dc-log-entry ' + (kind || '');
        entry.textContent = text;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
    }

    function updateProgress(done, total) {
        var count = document.querySelector('.csh-dc-modal-count');
        var fill = document.querySelector('.csh-dc-modal-fill');
        if (count) count.textContent = done + ' / ' + total;
        if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    }

    function finishProgressModal(done, failed) {
        var title = document.querySelector('.csh-dc-modal-title');
        var cancel = document.querySelector('.csh-dc-modal-cancel');
        var close = document.querySelector('.csh-dc-modal-close');
        if (title) title.textContent = failed === 0
            ? 'Removed ' + done + ' component(s) ✓'
            : 'Removed ' + done + ', ' + failed + ' failed';
        if (cancel) cancel.style.display = 'none';
        if (close) close.style.display = '';
        if (window.cshToast) {
            window.cshToast.show(
                failed === 0
                    ? 'Removed ' + done + ' component(s).'
                    : 'Removed ' + done + ' • ' + failed + ' failed — see modal.',
                { type: failed === 0 ? 'success' : 'warning', duration: 6000 }
            );
        }
    }
})();
