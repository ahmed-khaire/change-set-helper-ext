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

    // Column indices resolved by scanning the header row once the table is
    // found. Keyed by header text lowercased; -1 if that header isn't present.
    // Indices are measured AFTER our select column is inserted (so the Action
    // column is typically 1, Name is 2, Type is somewhere after).
    var colIndex = { action: -1, name: -1, parent: -1, type: -1, fullName: -1 };

    // Selection state persisted across A4J partial refreshes, pagination,
    // and sort changes. Keyed by the component's Salesforce Id so it survives
    // any DOM mutation. value = { cid, name, type, linkId }. linkId is the
    // Visualforce-generated id of the Remove <a> on THE CURRENT page — we
    // refresh it on every annotateRow so whatever page the user is on, we
    // always have a valid click target for visible selected rows.
    var selectedItems = new Map();

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
        resolveColumnIndices(table);
        injectToolbar(table);
        populateFilterDropdowns(table);
        observeTableChanges(table);
        wireDelegatedEvents(table);
        applyFilters(table); // populates the "N components" counter
        console.log('detailcomponents: initialized on', table);
    }

    // Scan the header row once to locate Name / Parent Object / Type / Full
    // Name columns by their rendered label. Indices are 0-based and already
    // account for the select column we inserted at position 0. Missing
    // columns stay at -1 and the corresponding filter / search path becomes
    // a no-op (e.g. flows that don't expose a Parent Object column).
    function resolveColumnIndices(table) {
        var header = table.querySelector('tr.headerRow');
        if (!header) return;
        var cells = header.children;
        colIndex = { action: -1, name: -1, parent: -1, type: -1, fullName: -1 };
        for (var i = 0; i < cells.length; i++) {
            var text = ($.trim ? $.trim(cells[i].textContent) : (cells[i].textContent || '').trim()).toLowerCase();
            if (text === 'action' && colIndex.action === -1) colIndex.action = i;
            else if (text === 'name' && colIndex.name === -1) colIndex.name = i;
            else if (text === 'parent object' && colIndex.parent === -1) colIndex.parent = i;
            else if (text === 'type' && colIndex.type === -1) colIndex.type = i;
            else if ((text === 'api name' || text === 'full name') && colIndex.fullName === -1) colIndex.fullName = i;
        }
        console.log('detailcomponents: colIndex =', JSON.stringify(colIndex));
    }

    // -----------------------------------------------------------------------
    // Page-context bridge is a separate MAIN-world content script
    // (detailpagebridge.js) declared alongside this file in the manifest.
    // That runs in the page's JavaScript context where deleteComponent is
    // defined; inline <script> injection is refused by Salesforce's CSP.
    //
    // Here in the ISOLATED world we just install the reply listener so we
    // can correlate the bridge's postMessage responses with our pending
    // promises via the shared message id.
    // -----------------------------------------------------------------------
    function injectPageBridge() {
        if (pageBridgeInjected) return;
        pageBridgeInjected = true;
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
        var removeLink = row.querySelector(REMOVE_LINK_SEL);
        var cid = extractComponentIdFromLink(removeLink);
        var linkId = removeLink ? removeLink.id : '';
        var nameCell = row.querySelectorAll('td')[1]; // 0=Remove action, 1=Name (pre-inject indices)
        var displayName = nameCell ? (nameCell.textContent || '').trim() : (cid || '(unknown)');

        // Refresh the linkId in the selection map if this row corresponds
        // to a previously-selected component. The linkId is an in-page
        // Visualforce id that can change when A4J redraws or the user pages.
        if (cid && selectedItems.has(cid) && linkId) {
            var existing = selectedItems.get(cid);
            existing.linkId = linkId;
            existing.name = existing.name || displayName;
        }

        if (row.querySelector('.csh-dc-select-col')) {
            // Row already has a select column (from a previous annotate pass);
            // just make sure its checked state reflects the current selection.
            var cbExisting = row.querySelector('.csh-dc-select-row');
            if (cbExisting && cid) {
                cbExisting.checked = selectedItems.has(cid);
                cbExisting.setAttribute('data-link-id', linkId);
            }
            return;
        }

        var td = document.createElement('td');
        td.className = 'csh-dc-select-col';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'csh-dc-select-row';
        cb.setAttribute('data-cid', cid || '');
        cb.setAttribute('data-name', displayName);
        cb.setAttribute('data-link-id', linkId);
        if (!cid) cb.disabled = true;
        // Re-tick if previously selected.
        if (cid && selectedItems.has(cid)) cb.checked = true;
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
            '<div class="csh-dc-filter-row">' +
              '<input type="search" class="csh-dc-search" placeholder="Search name or full name…" aria-label="Search components">' +
              '<select class="csh-dc-filter-type"><option value="">All types</option></select>' +
              '<select class="csh-dc-filter-parent"><option value="">All parent objects</option></select>' +
              '<span class="csh-dc-visible-count"></span>' +
            '</div>' +
            '<div class="csh-dc-action-row">' +
              '<span class="csh-dc-label">Bulk:</span>' +
              '<button type="button" class="csh-dc-select-all-btn">Select visible</button>' +
              '<button type="button" class="csh-dc-select-none-btn">Clear selection</button>' +
              '<span class="csh-dc-count">0 selected</span>' +
              '<button type="button" class="csh-dc-remove-btn" disabled>Remove selected</button>' +
            '</div>';
        table.parentNode.insertBefore(toolbar, table);
    }

    // Populate the Type + Parent Object dropdowns with the unique values
    // currently in the table. Safe to call repeatedly; preserves the user's
    // current selection if the value still exists after a refresh.
    function populateFilterDropdowns(table) {
        var typeSel = document.querySelector('.csh-dc-filter-type');
        var parentSel = document.querySelector('.csh-dc-filter-parent');
        if (!typeSel && !parentSel) return;

        var rows = table.querySelectorAll('tr.dataRow');
        var types = new Set(), parents = new Set();
        rows.forEach(function (row) {
            var cells = row.children;
            if (colIndex.type >= 0 && cells[colIndex.type]) {
                var t = (cells[colIndex.type].textContent || '').trim();
                if (t) types.add(t);
            }
            if (colIndex.parent >= 0 && cells[colIndex.parent]) {
                var p = (cells[colIndex.parent].textContent || '').trim();
                if (p) parents.add(p);
            }
        });

        rebuildSelect(typeSel, 'All types', types);
        rebuildSelect(parentSel, 'All parent objects', parents);

        // Hide the parent filter entirely when no parents are available (e.g.
        // a change set with only ApexClasses has no parent objects).
        if (parentSel) {
            parentSel.style.display = parents.size === 0 ? 'none' : '';
        }
    }

    function rebuildSelect(sel, allLabel, values) {
        if (!sel) return;
        var current = sel.value;
        sel.innerHTML = '';
        var allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = allLabel;
        sel.appendChild(allOpt);
        Array.from(values).sort().forEach(function (v) {
            var o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            sel.appendChild(o);
        });
        // Preserve previous selection if still valid
        if (current && values.has(current)) sel.value = current;
    }

    // Filter rows in place via style.display. No DataTable here — A4J partial
    // refreshes overwrite table state, so using the native DOM as the source
    // of truth keeps us compatible.
    function applyFilters(table) {
        var q = ((document.querySelector('.csh-dc-search') || {}).value || '').trim().toLowerCase();
        var typeF = ((document.querySelector('.csh-dc-filter-type') || {}).value || '').trim();
        var parentF = ((document.querySelector('.csh-dc-filter-parent') || {}).value || '').trim();

        var rows = table.querySelectorAll('tr.dataRow');
        var visible = 0;
        rows.forEach(function (row) {
            var match = true;
            var cells = row.children;

            if (q) {
                // Search covers the whole row's text so users can find by
                // name, API name, type, or parent without thinking about
                // which column. Excludes the select col by skipping cells[0].
                var hay = '';
                for (var i = 1; i < cells.length; i++) hay += ' ' + (cells[i].textContent || '');
                if (hay.toLowerCase().indexOf(q) === -1) match = false;
            }

            if (match && typeF && colIndex.type >= 0) {
                var t = (cells[colIndex.type] && cells[colIndex.type].textContent || '').trim();
                if (t !== typeF) match = false;
            }

            if (match && parentF && colIndex.parent >= 0) {
                var p = (cells[colIndex.parent] && cells[colIndex.parent].textContent || '').trim();
                if (p !== parentF) match = false;
            }

            row.style.display = match ? '' : 'none';
            if (match) visible++;
        });

        var counter = document.querySelector('.csh-dc-visible-count');
        if (counter) {
            counter.textContent = visible === rows.length
                ? rows.length + ' components'
                : visible + ' of ' + rows.length + ' visible';
        }
    }

    // -----------------------------------------------------------------------
    // Event wiring (delegated so rows added later by A4J refreshes work too).
    // -----------------------------------------------------------------------
    function wireDelegatedEvents(table) {
        document.addEventListener('change', function (ev) {
            var t = ev.target;
            if (t.classList.contains('csh-dc-select-all')) {
                // Header checkbox — only ticks currently-visible rows. Updates
                // the central selectedItems map so state persists across
                // A4J refreshes / pagination.
                var checked = t.checked;
                visibleSelectCheckboxes().forEach(function (cb) {
                    cb.checked = checked;
                    updateSelectionForCheckbox(cb);
                });
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-select-row')) {
                updateSelectionForCheckbox(t);
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-filter-type') ||
                       t.classList.contains('csh-dc-filter-parent')) {
                applyFilters(table);
                updateSelectionCount();
            }
        });

        // 'input' event fires on every keystroke / clear for <input type="search">
        document.addEventListener('input', function (ev) {
            if (ev.target.classList.contains('csh-dc-search')) {
                applyFilters(table);
                updateSelectionCount();
            }
        });

        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (t.classList.contains('csh-dc-select-all-btn')) {
                // Select visible — does NOT tick rows hidden by the filter
                visibleSelectCheckboxes().forEach(function (cb) {
                    cb.checked = true;
                    updateSelectionForCheckbox(cb);
                });
                var allCb = document.querySelector('.csh-dc-select-all');
                if (allCb) allCb.checked = true;
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-select-none-btn')) {
                document.querySelectorAll('.csh-dc-select-row, .csh-dc-select-all').forEach(function (cb) { cb.checked = false; });
                selectedItems.clear();
                updateSelectionCount();
            } else if (t.classList.contains('csh-dc-remove-btn')) {
                handleRemoveSelected();
            }
        });
    }

    function visibleSelectCheckboxes() {
        return Array.from(document.querySelectorAll('.csh-dc-select-row:not([disabled])'))
            .filter(function (cb) {
                var row = cb.closest('tr');
                return row && row.style.display !== 'none';
            });
    }

    // Syncs the central selectedItems map with the state of a single
    // checkbox element. Checked -> add/update entry. Unchecked -> remove.
    // Entry carries (cid, name, type, linkId) so handleRemoveSelected can
    // fire the right page-context click regardless of what page the user
    // is on when they hit Remove.
    function updateSelectionForCheckbox(cb) {
        var cid = cb.getAttribute('data-cid');
        if (!cid) return;
        if (cb.checked) {
            var row = cb.closest('tr');
            var cells = row ? row.children : null;
            var type = (cells && colIndex.type >= 0 && cells[colIndex.type])
                ? (cells[colIndex.type].textContent || '').trim()
                : '';
            selectedItems.set(cid, {
                cid: cid,
                name: cb.getAttribute('data-name') || cid,
                type: type,
                linkId: cb.getAttribute('data-link-id') || ''
            });
        } else {
            selectedItems.delete(cid);
        }
    }

    function updateSelectionCount() {
        var count = selectedItems.size;
        var countEl = document.querySelector('.csh-dc-count');
        if (countEl) countEl.textContent = count + ' selected';
        var btn = document.querySelector('.csh-dc-remove-btn');
        if (btn) btn.disabled = count === 0;
    }

    // -----------------------------------------------------------------------
    // A4J renders partial-updates by replacing chunks of the table. We need
    // to re-annotate any newly-inserted rows so they get our select column.
    // -----------------------------------------------------------------------
    function observeTableChanges(table) {
        var refreshPending = false;
        function scheduleRefresh() {
            if (refreshPending) return;
            refreshPending = true;
            // Coalesce bursts of A4J updates into a single dropdown rebuild
            // so we don't thrash when a bulk remove finishes.
            setTimeout(function () {
                refreshPending = false;
                resolveColumnIndices(table);
                populateFilterDropdowns(table);
                applyFilters(table);
            }, 80);
        }

        var observer = new MutationObserver(function (mutations) {
            var sawRowMutation = false;
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    if (node.matches && node.matches('tr.dataRow')) {
                        annotateRow(node);
                        sawRowMutation = true;
                    }
                    if (node.querySelectorAll) {
                        var nested = node.querySelectorAll('tr.dataRow');
                        if (nested.length) sawRowMutation = true;
                        nested.forEach(annotateRow);
                    }
                });
                m.removedNodes.forEach(function (node) {
                    if (node && node.nodeType === 1 && node.matches && node.matches('tr.dataRow')) {
                        sawRowMutation = true;
                    }
                });
            });
            if (sawRowMutation) scheduleRefresh();
            updateSelectionCount();
        });
        observer.observe(table, { childList: true, subtree: true });
    }

    // -----------------------------------------------------------------------
    // Bulk remove worker — sequential deletes with progress modal.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Tooling API bulk remove.
    //
    // Salesforce's Tooling API exposes every change-set member as a
    // `PackageMember` record linking the OutboundChangeSet's underlying
    // MetadataPackage (0A2 / 033 id) to the component (SubjectId = cid).
    // DELETE on that PackageMember removes the component from the change
    // set cleanly — no A4J dance, no synthetic click, no page navigation.
    //
    // Flow:
    //   1. Scrape the MetadataPackage id (033-prefix) from any Add-link in
    //      the page; we fall back to the URL's id= param (0A2-prefix) if
    //      nothing else is available.
    //   2. Query PackageMember for Id + SubjectId WHERE Package = <id>
    //      AND SubjectId IN (<selected cids>).
    //   3. Parallelise DELETE calls (5 at a time) for speed on big
    //      selections.
    //   4. On success, reload the page so Salesforce's own UI reflects the
    //      new state.
    // -----------------------------------------------------------------------
    var TOOLING_PARALLEL = 5;

    function currentApiVersion() {
        if (window.cshApiVersion && window.cshApiVersion.resolved) return window.cshApiVersion.resolved;
        if (window.cshApiVersion && window.cshApiVersion.fallback) return window.cshApiVersion.fallback;
        return '62.0';
    }

    function currentSession() {
        if (window.cshSession && typeof window.cshSession.current === 'function') {
            return window.cshSession.current();
        }
        // Fallback to the document cookie directly.
        var m = document.cookie.match('sid=([^;]*)');
        return m ? m[1] : null;
    }

    // Returns the 033-prefix package id (or the 0A2-prefix change-set id as
    // a fallback), whichever we can find on the rendered page. Tooling API's
    // PackageMember.Package field accepts the underlying MetadataPackage id,
    // which Salesforce lists in Add-link hrefs / onclicks.
    function findPackageId() {
        var scanned = new Set();
        var candidates = document.querySelectorAll('a[href], a[onclick], input[onclick]');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var text = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
            var matches = text.match(/(?:^|[?&])id=([0-9a-zA-Z]{15,18})/g) || [];
            for (var j = 0; j < matches.length; j++) {
                var m = matches[j].match(/id=([0-9a-zA-Z]{15,18})/);
                if (m && m[1]) scanned.add(m[1]);
            }
        }
        // Prefer 033-prefix MetadataPackage id; fall back to 0A2-prefix if that's all there is.
        var ids = Array.from(scanned);
        var pkg033 = ids.find(function (id) { return id.indexOf('033') === 0; });
        if (pkg033) return pkg033;
        var pkg0A2 = ids.find(function (id) { return id.indexOf('0A2') === 0; });
        if (pkg0A2) return pkg0A2;
        // Last-resort: the URL id= param (usually 0A2).
        var u = new URL(location.href);
        return u.searchParams.get('id');
    }

    async function toolingQueryPackageMembers(packageId, subjectIds) {
        var session = currentSession();
        if (!session) throw new Error('no Salesforce session cookie (is HttpOnly blocking?)');
        var version = currentApiVersion();
        var origin = location.origin;
        // Query in chunks to avoid hitting the URL-length limit on big
        // selections (SOQL IN (...) can get long).
        var out = {};
        var CHUNK = 150;
        for (var i = 0; i < subjectIds.length; i += CHUNK) {
            var chunk = subjectIds.slice(i, i + CHUNK);
            var soql = "SELECT Id, SubjectId FROM PackageMember WHERE Package = '" + packageId +
                       "' AND SubjectId IN ('" + chunk.join("','") + "')";
            var url = origin + '/services/data/v' + version + '/tooling/query/?q=' + encodeURIComponent(soql);
            var res = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Authorization': 'Bearer ' + session,
                    'Accept': 'application/json'
                }
            });
            if (!res.ok) {
                var text = await res.text().catch(function () { return ''; });
                throw new Error('PackageMember query failed (HTTP ' + res.status + '): ' + text.slice(0, 240));
            }
            var json = await res.json();
            (json.records || []).forEach(function (r) { out[r.SubjectId] = r.Id; });
        }
        return out;
    }

    async function toolingDeletePackageMember(memberId) {
        var session = currentSession();
        if (!session) throw new Error('no Salesforce session');
        var version = currentApiVersion();
        var url = location.origin + '/services/data/v' + version + '/tooling/sobjects/PackageMember/' + memberId;
        var res = await fetch(url, {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Authorization': 'Bearer ' + session }
        });
        if (!res.ok) {
            var text = await res.text().catch(function () { return ''; });
            throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200));
        }
        return true;
    }

    async function handleRemoveSelected() {
        var items = Array.from(selectedItems.values());
        if (items.length === 0) return;
        if (!confirm('Remove ' + items.length + ' component(s) from this change set? This cannot be undone.')) return;

        bulkCancelled = false;
        showProgressModal(items.length);
        console.log('[CSH] bulk remove starting via Tooling API for', items.length, 'component(s)');

        var packageId = findPackageId();
        if (!packageId) {
            appendLog('✗ Could not determine change-set package id from the page.', 'fail');
            finishProgressModal(0, items.length);
            return;
        }
        console.log('[CSH] packageId =', packageId);

        // Step 1: resolve SubjectId (cid) -> PackageMember.Id.
        var subjectIds = items.map(function (i) { return i.cid; });
        var idMap;
        try {
            idMap = await toolingQueryPackageMembers(packageId, subjectIds);
            console.log('[CSH] resolved', Object.keys(idMap).length, 'of', subjectIds.length, 'PackageMember ids');
        } catch (err) {
            appendLog('✗ Tooling API query failed: ' + err.message, 'fail');
            finishProgressModal(0, items.length);
            return;
        }

        // Step 2: parallel DELETE with bounded concurrency.
        var done = 0, failed = 0;
        var queue = items.slice();

        async function worker() {
            while (queue.length && !bulkCancelled) {
                var item = queue.shift();
                var memberId = idMap[item.cid];
                if (!memberId) {
                    failed++;
                    appendLog('✗ ' + item.name + ' — PackageMember not found (may already be removed)', 'fail');
                    updateProgress(done + failed, items.length);
                    continue;
                }
                try {
                    await toolingDeletePackageMember(memberId);
                    done++;
                    selectedItems.delete(item.cid);
                    appendLog('✓ ' + item.name, 'ok');
                } catch (err) {
                    failed++;
                    appendLog('✗ ' + item.name + ' — ' + err.message, 'fail');
                }
                updateProgress(done + failed, items.length);
            }
        }

        var workers = [];
        for (var w = 0; w < Math.min(TOOLING_PARALLEL, items.length); w++) workers.push(worker());
        await Promise.all(workers);

        finishProgressModal(done, failed);
        updateSelectionCount();

        // Reload after a short pause so the user sees the final modal state
        // (success counts) before Salesforce's own view refreshes.
        if (done > 0) {
            setTimeout(function () { location.reload(); }, 1200);
        }
    }

    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // Console-callable diagnostic. Reports the resolved packageId, API
    // version, and whether cshSession is returning a token.
    window.cshDetailDiag = function () {
        return {
            packageId: findPackageId(),
            urlIdParam: new URL(location.href).searchParams.get('id'),
            apiVersion: currentApiVersion(),
            hasSession: !!currentSession(),
            sessionPrefix: currentSession() ? (currentSession().slice(0, 15) + '…') : null,
            selectedCount: selectedItems.size,
            removeLinksOnPage: document.querySelectorAll('a[id*="removeLink"]').length
        };
    };

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
