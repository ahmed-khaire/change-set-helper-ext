// ---------------------------------------------------------------------------
// Change Set Helper — Detail Page Components block.
//
// The modern Outbound Change Set Detail page renders its components table
// INLINE on /changemgmt/outboundChangeSetDetailPage.apexp. Selection,
// filtering, and the bulk-Remove toolbar are all overlaid on that native
// table.
//
// Bulk remove: we do NOT use the page's own A4J Remove link flow — clicking
// it triggers a confirmation modal whose OK button always ends up firing a
// native form submit and reloading the whole page, defeating the batch.
// Instead we discover the classic components view (/<033id>?tab=
// PackageComponents), build a {cid -> Del-URL} map from it, and POST each
// row's confirm form via fetch — same pattern as changeview.js. The row is
// then purged from the detail-page DOM locally because we bypassed A4J so
// no partial refresh would fire.
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

    // Bulk remove is disabled while we work out a reliable delete path that
    // doesn't full-page-reload (A4J) and doesn't depend on being able to
    // resolve the 033 MetadataPackage id from the detail page (classic Del
    // URL). Search + filters still ship; only the selection column and the
    // "Remove selected" toolbar row are hidden.
    var BULK_REMOVE_ENABLED = false;

    function setupPage(table) {
        injectPageBridge();
        if (BULK_REMOVE_ENABLED) injectSelectionColumn(table);
        resolveColumnIndices(table);
        injectToolbar(table);
        populateFilterDropdowns(table);
        observeTableChanges(table);
        wireDelegatedEvents(table);
        applyFilters(table); // populates the "N components" counter
        backgroundSyncCart(table);
        console.log('detailcomponents: initialized on', table);
    }

    // -----------------------------------------------------------------------
    // Background cart sync
    //   Two-phase reconciliation between the local cart and the server-side
    //   change set membership.
    //
    //   Phase 1 (non-authoritative): walks the rendered Visualforce table
    //   and syncs just those rows. This is fast, needs no network, and
    //   captures the `fullName` column (only present here, not on the
    //   classic components view). Promotes staged/failed rows to 'done'
    //   and inserts new done rows; never prunes.
    //
    //   Phase 2 (authoritative): fetches every page of the classic
    //   /<033id>?tab=PackageComponents view and passes the full membership
    //   list to cshCart.syncItemsFromServer({ authoritative: true }). Any
    //   stale 'done' cart row not in that list is pruned — this is what
    //   clears ghosts from prior sessions where items were removed from
    //   the change set externally. 'staged'/'submitting'/'failed' rows are
    //   preserved across the prune.
    //
    //   Errors are logged but never thrown — the user's page works fine
    //   without sync. If phase 2 fails (Salesforce returns HTML we can't
    //   parse, the 033 id can't be resolved, etc.), phase 1 has already
    //   synced the visible rows so the cart isn't worse off than before.
    // -----------------------------------------------------------------------
    function extractSyncItems(table) {
        var items = [];
        var rows = table.querySelectorAll('tr.dataRow');
        rows.forEach(function (row) {
            var cid = extractComponentIdFromLink(row.querySelector(REMOVE_LINK_SEL));
            if (!cid) return;
            var cells = row.children;
            // Pre-injection indices: when bulk-remove is enabled the select
            // col sits at [0] and colIndex accounts for that; when disabled
            // colIndex tracks the unmodified table. Either way colIndex is
            // the single source of truth.
            var nameCell = colIndex.name >= 0 ? cells[colIndex.name] : null;
            var typeCell = colIndex.type >= 0 ? cells[colIndex.type] : null;
            var fullNameCell = colIndex.fullName >= 0 ? cells[colIndex.fullName] : null;
            var name = nameCell ? (nameCell.textContent || '').trim() : '';
            var type = typeCell ? (typeCell.textContent || '').trim() : '';
            var fullName = fullNameCell ? (fullNameCell.textContent || '').trim() : '';
            if (!type) return;
            var item = { id: cid, type: type, name: name || cid };
            if (fullName) item.extra = { fullName: fullName };
            items.push(item);
        });
        return items;
    }

    function urlChangeSetId() {
        var m = location.search.match(/[?&]id=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    // Walks the classic /<033id>?tab=PackageComponents view across every
    // paginated page and returns a complete list of change-set members.
    // Mirrors buildDelHrefMap's pagination loop but captures (id, type,
    // name) rather than Del URLs. rowsperpage=5000 normally returns the
    // whole change set in a single page; the next-page loop is here as
    // safety for very large sets.
    async function fetchAllChangeSetComponents(csId) {
        var urlId = new URLSearchParams(location.search).get('id');
        if (!urlId) throw new Error('No change-set id in URL');
        var packageId = await resolvePackageId(urlId);
        if (!packageId) {
            throw new Error('Could not resolve 033 MetadataPackage id for authoritative sync');
        }
        var items = [];
        var nextUrl = absoluteUrl('/' + packageId + '?tab=PackageComponents&rowsperpage=5000');
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
                if (pageNum === 1) {
                    throw new Error('No table.list on classic components view (' + r.url + ')');
                }
                break;
            }
            // The classic view has different header names than the
            // Visualforce detail page; resolve per-page rather than reusing
            // this file's colIndex (which tracks the detail page DOM).
            // Package Components view labels the name column "Component
            // Name"; Outbound Change Set view labels it "Name".
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
            var dropped = { noCid: 0, noType: 0 };
            rows.forEach(function (row) {
                // Prefer Del link (its ?cid= query is the canonical component
                // id). If no Del link — e.g., Package Components view has no
                // remove affordance — fall back to SF-id-shaped anchor hrefs,
                // preferring the Name column cell so we don't pick up any
                // Parent Object / Included By cross-reference.
                var cid = null;
                var href = findDelLinkInRow(row);
                if (href) {
                    var m = href.match(/[?&]cid=([^&]+)/i);
                    if (m) cid = decodeURIComponent(m[1]);
                }
                if (!cid) cid = findCidInRowAnchors(row, packageId, idx.name);
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
            console.log('[CSH] authoritative sync page', pageNum,
                ': rows=', rows.length,
                'kept=', rows.length - dropped.noCid - dropped.noType,
                'dropped=', dropped, 'headerIdx=', idx);
            var nextHref = findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        return items;
    }

    async function backgroundSyncCart(table) {
        if (!window.cshCart || !window.cshCart.syncItemsFromServer) return;
        var csId = urlChangeSetId();
        if (!csId) return;
        var setSync = window.cshCart.setSyncState || function () {};
        var visible = extractSyncItems(table);
        setSync('syncing', '(' + visible.length + ')');
        try {
            // Phase 1: fast sync of visible rows. Skipped when the
            // rendered table is empty (e.g. the user is on a filter view
            // that hides everything) — phase 2 handles the ground truth.
            if (visible.length) {
                var p1 = await window.cshCart.syncItemsFromServer(csId, visible);
                console.log('[CSH] background sync (visible): inserted=' + p1.inserted +
                    ' promoted=' + p1.promoted + ' kept=' + p1.kept +
                    ' (scanned=' + visible.length + ')');
            }
            // Phase 2: authoritative paginated fetch.
            var all = await fetchAllChangeSetComponents(csId);
            // Write to both cart keys: the 0A2 outbound change-set id used
            // by this Detail page and the 033 MetadataPackage id used by
            // the Add page. Historically these were two divergent storage
            // entries for the same change set; this convergence keeps them
            // aligned so the Add page's cart card matches reality once the
            // user navigates over.
            var keys = [csId];
            if (packageIdCache && packageIdCache !== csId) keys.push(packageIdCache);
            for (var i = 0; i < keys.length; i++) {
                var p2 = await window.cshCart.syncItemsFromServer(keys[i], all, { authoritative: true });
                console.log('[CSH] background sync (authoritative) key=' + keys[i] +
                    ': inserted=' + p2.inserted + ' promoted=' + p2.promoted +
                    ' kept=' + p2.kept + ' pruned=' + (p2.pruned || 0) +
                    ' (scanned=' + all.length + ')');
            }
            setSync('idle');
        } catch (e) {
            console.warn('[CSH] authoritative sync failed:', e && e.message);
            setSync('error', (e && e.message) || 'Sync failed');
        }
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
            if (d.ok) pending.resolve(d);
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
        var actionRow = BULK_REMOVE_ENABLED
            ? '<div class="csh-dc-action-row">' +
                '<span class="csh-dc-label">Bulk:</span>' +
                '<button type="button" class="csh-dc-select-all-btn">Select visible</button>' +
                '<button type="button" class="csh-dc-select-none-btn">Clear selection</button>' +
                '<span class="csh-dc-count">0 selected</span>' +
                '<button type="button" class="csh-dc-remove-btn" disabled>Remove selected</button>' +
              '</div>'
            : '';
        toolbar.innerHTML =
            '<div class="csh-dc-filter-row">' +
              '<input type="search" class="csh-dc-search" placeholder="Search name or full name…" aria-label="Search components">' +
              '<select class="csh-dc-filter-type"><option value="">All types</option></select>' +
              '<select class="csh-dc-filter-parent"><option value="">All parent objects</option></select>' +
              '<span class="csh-dc-visible-count"></span>' +
            '</div>' +
            actionRow;
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
                        if (BULK_REMOVE_ENABLED) annotateRow(node);
                        sawRowMutation = true;
                    }
                    if (node.querySelectorAll) {
                        var nested = node.querySelectorAll('tr.dataRow');
                        if (nested.length) sawRowMutation = true;
                        if (BULK_REMOVE_ENABLED) nested.forEach(annotateRow);
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
    // Bulk remove — fetch-based, classic Del URL path. NO A4J, NO page reloads.
    //
    // The A4J path on outboundChangeSetDetailPage.apexp does a two-stage flow
    // (click Remove link → click modal OK) that unavoidably full-page-reloads
    // after each delete. The classic components view (/<csId>?tab=
    // PackageComponents) has per-row "Del" links pointing at a real URL whose
    // confirm form can be POSTed via fetch — same pattern changeview.js uses.
    //
    // URL construction mirrors changeset.js:230, which already builds
    // "/<id>?tab=PackageComponents&rowsperpage=5000" from the change-set id
    // to power the "View change set" button on the add page. Salesforce
    // accepts either the 0A2 outbound-change-set id or the 033 metadata-
    // package id as the prefix on that path.
    //
    // Flow on first bulk remove:
    //   1. Fetch /<csId>?tab=PackageComponents&rowsperpage=5000 (paginated),
    //      parse every row's Del <a> href, build a { cid -> absolute delHref }
    //      map. Cached for the session.
    //   2. Per selected cid: GET delHref, extract the hidden form fields + OK
    //      submit from the confirm page, POST them back → server deletes.
    //   3. Remove the row from the visible detail-page DOM so the UI tracks
    //      the new server state (we bypassed A4J so no partial refresh fires).
    //
    // Exposed as window.cshChangeSetOps for cart.js and future callers.
    // -----------------------------------------------------------------------
    var CONCURRENCY = 4;
    var delHrefCache = null; // Map<cid, absolute delHref>

    function cssEscape(s) {
        return String(s).replace(/["\\]/g, '\\$&');
    }

    function findRowForCid(cid) {
        var cb = document.querySelector('.csh-dc-select-row[data-cid="' + cssEscape(cid) + '"]');
        if (cb) return cb.closest('tr.dataRow');
        var links = document.querySelectorAll(REMOVE_LINK_SEL);
        for (var i = 0; i < links.length; i++) {
            if (extractComponentIdFromLink(links[i]) === cid) return links[i].closest('tr.dataRow');
        }
        return null;
    }

    function absoluteUrl(href) {
        try { return new URL(href, location.href).href; } catch (_) { return href; }
    }

    function findDelLinkInRow(rowEl) {
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

    // Fallback when the classic Package Components view has no Del link —
    // extracts a 15/18-char Salesforce id from anchor hrefs in the row,
    // preferring the Name column and skipping any anchor that points back at
    // the enclosing package's own id.
    function findCidInRowAnchors(rowEl, packageId, preferredCellIdx) {
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

    function findNextPageHrefInDoc(doc) {
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

    // Salesforce only accepts the 033 MetadataPackage id on /<id>?tab=
    // PackageComponents — the 0A2 outbound-change-set id redirects right
    // back to the Visualforce detail page and the classic table never
    // renders. The Add page (/p/mfpkg/AddToPackage...) accepts the 0A2 in
    // its URL and exposes the matching 033 as $('#id').val() once rendered,
    // which is exactly what changeset.js:230 reads to build its "View
    // change set" button. We load the Add page in a hidden same-origin
    // iframe, poll until #id populates, then tear the iframe down.
    var PACKAGE_ID_RE = /^033[A-Za-z0-9]{12,15}$/;
    var packageIdCache = null;

    function loadAddPageInIframe(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;';
            iframe.src = url;
            var settled = false;
            var pollTimer = null;
            function cleanup() {
                if (pollTimer) clearInterval(pollTimer);
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }
            function finish(value, err) {
                if (settled) return;
                settled = true;
                cleanup();
                err ? reject(err) : resolve(value);
            }
            var timeoutHandle = setTimeout(function () {
                finish(null, new Error('Add page iframe timed out after ' + timeoutMs + 'ms'));
            }, timeoutMs);
            var dumpedOnce = false;
            function dumpIframeState(doc, reason) {
                if (dumpedOnce) return;
                dumpedOnce = true;
                try {
                    var allIdInputs = Array.from(doc.querySelectorAll('input[id="id"], input[name="id"]'))
                        .map(function (el) { return { id: el.id, name: el.name, value: el.value }; });
                    var any033 = (doc.body && doc.body.innerHTML || '').match(/033[A-Za-z0-9]{12,15}/);
                    console.log('[CSH] Add-page iframe dump (' + reason + '):',
                        'href=', doc.location && doc.location.href,
                        'idInputs=', allIdInputs,
                        'first-033-in-body=', any033 && any033[0]);
                } catch (e) {
                    console.warn('[CSH] Add-page iframe dump failed:', e);
                }
            }
            iframe.addEventListener('load', function () {
                var tries = 0;
                pollTimer = setInterval(function () {
                    tries++;
                    try {
                        var doc = iframe.contentDocument;
                        if (!doc) return;
                        // Try the jQuery-visible element first, then any 033 reachable from inputs or raw HTML.
                        var input = doc.getElementById('id');
                        var val = input && input.value;
                        if (val && PACKAGE_ID_RE.test(val)) {
                            clearTimeout(timeoutHandle);
                            finish(val);
                            return;
                        }
                        // Fallback: scan every input for a 033 value — SF has changed the field name across releases.
                        var alt = Array.from(doc.querySelectorAll('input')).find(function (el) {
                            return el.value && PACKAGE_ID_RE.test(el.value);
                        });
                        if (alt) {
                            clearTimeout(timeoutHandle);
                            finish(alt.value);
                            return;
                        }
                        // After ~2s of no match, dump state once so we can see what's actually on the page.
                        if (tries === 20) dumpIframeState(doc, 'still-empty-after-2s');
                    } catch (err) {
                        clearTimeout(timeoutHandle);
                        finish(null, err);
                    }
                }, 100);
            });
            iframe.addEventListener('error', function () {
                clearTimeout(timeoutHandle);
                finish(null, new Error('Add page iframe failed to load'));
            });
            document.body.appendChild(iframe);
        });
    }

    async function resolvePackageId(csId) {
        if (packageIdCache) return packageIdCache;
        // Optimistic: some flows already have #id populated on the current page.
        var fromDom = ($('#id').val && $('#id').val()) || null;
        if (fromDom && PACKAGE_ID_RE.test(fromDom)) {
            packageIdCache = fromDom;
            console.log('[CSH] packageId from #id on current page:', packageIdCache);
            return packageIdCache;
        }
        // Cached mapping written by changeset.js the first time the user
        // visits the Add page. The 0A2/033 pair is stable for the lifetime
        // of the change set, so a hit here lets us skip the iframe path
        // entirely. Salesforce often refuses to render the Add page inside
        // a hidden iframe, so this is the reliable path once the user has
        // touched the Add page even once.
        if (window.cshIdMap) {
            try {
                var cached = await window.cshIdMap.getPackageId(csId);
                if (cached && PACKAGE_ID_RE.test(cached)) {
                    packageIdCache = cached;
                    console.log('[CSH] packageId from cshIdMap cache:', packageIdCache);
                    return packageIdCache;
                }
            } catch (e) {
                console.warn('[CSH] cshIdMap.getPackageId failed:', e && e.message);
            }
        }
        var addPageUrls = [
            '/p/mfpkg/AddToPackageFromChangeMgmtUi?id=' + encodeURIComponent(csId),
            '/p/mfpkg/AddToPackageUi?id=' + encodeURIComponent(csId)
        ];
        for (var i = 0; i < addPageUrls.length; i++) {
            try {
                var val = await loadAddPageInIframe(addPageUrls[i], 15000);
                if (val) {
                    packageIdCache = val;
                    console.log('[CSH] packageId from Add page iframe (' + addPageUrls[i] + '):', packageIdCache);
                    return packageIdCache;
                }
            } catch (err) {
                console.warn('[CSH] Add page fetch failed:', addPageUrls[i], err);
            }
        }
        return null;
    }

    async function buildDelHrefMap() {
        if (delHrefCache) return delHrefCache;
        var urlId = new URLSearchParams(location.search).get('id');
        if (!urlId) throw new Error('No change-set id in URL');
        var csId = await resolvePackageId(urlId);
        if (!csId) {
            throw new Error('Could not resolve the 033 MetadataPackage id for this change set. ' +
                            'Fetched /p/mfpkg/AddToPackageUi?id=' + urlId + ' but no <input id="id"> was present.');
        }
        console.log('[CSH] buildDelHrefMap using id:', csId);
        var map = new Map();
        var nextUrl = absoluteUrl('/' + csId + '?tab=PackageComponents&rowsperpage=5000');
        var safety = 200;
        var pageNum = 0;
        while (nextUrl && safety-- > 0) {
            pageNum++;
            var r = await fetch(nextUrl, { credentials: 'include' });
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching classic components view');
            var html = await r.text();
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var rows = doc.querySelectorAll('table.list tr.dataRow');
            console.log('[CSH] components page', pageNum, ': finalUrl=', r.url, 'rows=', rows.length);
            if (pageNum === 1 && rows.length === 0) {
                // URL didn't land on the classic components view. Log enough
                // to diagnose whether we got the Lightning page, a redirect,
                // or something else entirely.
                console.warn('[CSH] first page has no table.list rows. Title:',
                    (doc.querySelector('title') || {}).textContent,
                    'html snippet:', html.slice(0, 500));
            }
            rows.forEach(function (row) {
                var href = findDelLinkInRow(row);
                if (!href) return;
                var m = href.match(/[?&]cid=([^&]+)/i);
                if (!m) return;
                map.set(decodeURIComponent(m[1]), new URL(href, nextUrl).href);
            });
            var nextHref = findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        console.log('[CSH] buildDelHrefMap built', map.size, 'entries');
        delHrefCache = map;
        return map;
    }

    // GET the Del URL → parse confirm form → POST the form back. Matches
    // changeview.js's removeOneComponent (classic SF delete flow).
    async function deleteViaDelHref(delHref) {
        var r = await fetch(delHref, { credentials: 'include', redirect: 'follow' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' on confirm page');
        var html = await r.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var forms = doc.querySelectorAll('form');
        if (forms.length === 0) return; // already done
        var form = null;
        for (var i = 0; i < forms.length; i++) {
            var f = forms[i];
            var action = (f.getAttribute('action') || '').toLowerCase();
            if (/remove|delete|listremove|listcomponentremove/.test(action) ||
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
        var r2 = await fetch(action, {
            method: method,
            credentials: 'include',
            redirect: 'follow',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        if (!r2.ok && !(r2.status >= 300 && r2.status < 400)) {
            throw new Error('HTTP ' + r2.status + ' on confirm POST');
        }
    }

    async function removeOne(cid) {
        var map = await buildDelHrefMap();
        var href = map.get(cid);
        if (!href) {
            // Cache might be stale (new components added since build). Retry
            // once with a fresh map.
            delHrefCache = null;
            map = await buildDelHrefMap();
            href = map.get(cid);
            if (!href) {
                throw new Error('Del URL not found for ' + cid + ' in classic components view');
            }
        }
        await deleteViaDelHref(href);
        // Manually purge the row — we bypassed A4J so no partial refresh fired.
        var row = findRowForCid(cid);
        if (row && row.parentNode) row.parentNode.removeChild(row);
    }

    // Public API: parallel bulk remove via fetch. No A4J races so we can
    // run CONCURRENCY workers. onItem/onProgress fire per attempt; cancel()
    // polled between picks.
    async function removeManyByIds(cids, opts) {
        opts = opts || {};
        if (!Array.isArray(cids) || cids.length === 0) {
            return { done: 0, failed: 0, errors: [] };
        }
        // Warm the map up-front so errors surface before we start firing
        // concurrent workers (prevents a thundering herd of identical
        // packageId lookups).
        try {
            await buildDelHrefMap();
        } catch (err) {
            console.error('[CSH] buildDelHrefMap failed:', err);
            var errs = cids.map(function (c) { return { cid: c, message: err.message }; });
            if (opts.onItem) cids.forEach(function (c) { opts.onItem(c, false, err); });
            if (opts.onProgress) opts.onProgress(0, cids.length, cids.length);
            return { done: 0, failed: cids.length, errors: errs };
        }

        var queue = cids.slice();
        var done = 0, failed = 0;
        var errors = [];
        async function worker() {
            while (queue.length) {
                if (opts.cancel && opts.cancel()) return;
                var cid = queue.shift();
                try {
                    await removeOne(cid);
                    done++;
                    if (opts.onItem) opts.onItem(cid, true, null);
                } catch (err) {
                    failed++;
                    errors.push({ cid: cid, message: err.message });
                    if (opts.onItem) opts.onItem(cid, false, err);
                }
                if (opts.onProgress) opts.onProgress(done, failed, cids.length);
            }
        }
        var workers = [];
        for (var i = 0; i < Math.min(CONCURRENCY, cids.length); i++) workers.push(worker());
        await Promise.all(workers);
        return { done: done, failed: failed, errors: errors };
    }

    window.cshChangeSetOps = {
        isAvailable: function () {
            return document.querySelectorAll(REMOVE_LINK_SEL).length > 0;
        },
        removeById: async function (cid) {
            var result = await removeManyByIds([cid]);
            if (result.failed) {
                throw new Error((result.errors[0] && result.errors[0].message) || 'remove failed');
            }
        },
        removeManyByIds: removeManyByIds
    };

    async function handleRemoveSelected() {
        var items = Array.from(selectedItems.values());
        if (items.length === 0) return;
        if (!confirm('Remove ' + items.length + ' component(s) from this change set? This cannot be undone.')) return;

        bulkCancelled = false;
        showProgressModal(items.length);
        console.log('[CSH] bulk remove starting via classic Del URL fetch for', items.length, 'component(s)');

        var byCid = {};
        items.forEach(function (it) { byCid[it.cid] = it; });

        var result = await window.cshChangeSetOps.removeManyByIds(
            items.map(function (i) { return i.cid; }),
            {
                cancel: function () { return bulkCancelled; },
                onItem: function (cid, ok, err) {
                    var name = (byCid[cid] && byCid[cid].name) || cid;
                    if (ok) {
                        selectedItems.delete(cid);
                        appendLog('✓ ' + name, 'ok');
                    } else {
                        appendLog('✗ ' + name + ' — ' + (err && err.message || 'unknown'), 'fail');
                    }
                },
                onProgress: function (done, failed, total) {
                    updateProgress(done + failed, total);
                }
            }
        );

        finishProgressModal(result.done, result.failed);
        updateSelectionCount();
    }

    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // Diagnostic ping — round-trips to the MAIN-world bridge to confirm the
    // bridge is installed. Used for manual debugging; not on the delete path.
    function sendBridgePing() {
        return new Promise(function (resolve, reject) {
            var mid = 'csh-ping-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            pendingDeletes[mid] = { resolve: resolve, reject: reject };
            setTimeout(function () {
                if (pendingDeletes[mid]) {
                    delete pendingDeletes[mid];
                    reject(new Error('bridge ping timeout'));
                }
            }, 3000);
            window.postMessage({ __cshBulk: true, cmd: 'ping', mid: mid }, '*');
        });
    }

    window.cshDetailDiag = function () {
        return sendBridgePing().then(function (r) {
            return Object.assign({}, r, {
                selectedCount: selectedItems.size,
                removeLinksOnPage: document.querySelectorAll(REMOVE_LINK_SEL).length,
                delHrefCacheSize: delHrefCache ? delHrefCache.size : 0
            });
        }, function (err) {
            return {
                bridgeError: err.message,
                selectedCount: selectedItems.size,
                removeLinksOnPage: document.querySelectorAll(REMOVE_LINK_SEL).length,
                delHrefCacheSize: delHrefCache ? delHrefCache.size : 0
            };
        });
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
