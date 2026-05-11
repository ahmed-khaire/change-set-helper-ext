// ---------------------------------------------------------------------------
// Change Set Helper — Components view (?tab=PackageComponents)
//
// Enhances Salesforce's Change Set Components tab with:
//  - Progressive background fetch of every paginated page so the user sees
//    and can filter the whole change set, not just page 1. Live counter
//    "1,247 / 3,200 components loaded" updates as pages arrive.
//  - Selection column + toolbar for bulk remove. Scraped Del-link URLs are
//    replayed via fetch(); confirm-page flow is handled transparently so
//    the user sees progress, not a bunch of popup redirects.
//  - Single DataTable across all rows — existing search / type dropdown /
//    parent-object dropdown work against the full set even while more
//    rows are streaming in.
// ---------------------------------------------------------------------------

(function () {
    'use strict';

    var changeSetTable = null;
    var totalLoadedRows = 0;
    var totalExpectedRows = null; // populated once we scrape "N-M of X" footer
    var fetchCancelled = false;
    var selectionCount = 0;
    var CONCURRENCY = 4;

    // Inject a banner so the user knows they're on the enhanced view.
    $('.apexp').first().before(
        '<p class="csh-cv-note">NOTE: You are in the package view page. ' +
        'Use the checkboxes below to <strong>bulk-remove components</strong>. ' +
        'Return to the Change Set page to Add or Upload.</p>'
    );

    // -----------------------------------------------------------------------
    // 1) Selection column — insert a leftmost checkbox column before
    //    DataTable is initialised so the column is first-class in the table
    //    (filterable, orderable-off, participates in row.add for new pages).
    // -----------------------------------------------------------------------
    function injectSelectionColumn() {
        var headerRow = $('table.list tr.headerRow').first();
        if (headerRow.length) {
            headerRow.prepend('<th class="csh-cv-select-col"><input type="checkbox" class="csh-cv-select-all" title="Select all visible rows"></th>');
        }
        $('table.list tr.dataRow').each(function () {
            var delLink = findDelLink(this);
            var cid = idFromDelLink(delLink);
            $(this).prepend(
                '<td class="csh-cv-select-col">' +
                  '<input type="checkbox" class="csh-cv-select-row"' +
                    ' data-del-href="' + escapeAttr(delLink || '') + '"' +
                    ' data-cid="' + escapeAttr(cid || '') + '">' +
                '</td>'
            );
        });
    }

    // The first <a> in the row whose text starts with "Del" is the delete
    // action. Salesforce sometimes decorates with icons or title attributes,
    // so we check text and known href patterns.
    function findDelLink(rowEl) {
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

    function idFromDelLink(href) {
        if (!href) return null;
        var m = href.match(/[?&]cid=([^&]+)/i);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function absoluteUrl(href) {
        try { return new URL(href, location.href).href; } catch (_) { return href; }
    }

    // -----------------------------------------------------------------------
    // 2) DataTable setup — adds one leading column (our checkbox) to the
    //    existing column list from the legacy changeview.js. Column indices
    //    shift by 1.
    // -----------------------------------------------------------------------
    function setupTable() {
        injectSelectionColumn();

        var changeSetHead = $('<thead></thead>').prependTo('table.list').append($('table.list tr:first'));
        // Generate footer cells to match new column count (was 7, now 8).
        var colCount = $('table.list thead tr').children().length;
        var footerCells = '';
        for (var i = 0; i < colCount; i++) footerCells += '<td></td>';
        changeSetHead.after('<tfoot><tr>' + footerCells + '</tr></tfoot>');

        changeSetTable = $('table.list').DataTable({
            paging: false,
            dom: 'lrti',
            deferRender: true,
            order: [[3, 'asc']], // name column, now shifted by +1 after injection
            columns: [
                { searchable: false, orderable: false }, // 0: our select checkbox
                { searchable: false, orderable: false }, // 1: original native checkbox
                { searchable: false, orderable: false }, // 2: original blank
                null,                                     // 3: name
                null,                                     // 4: parent object
                null,                                     // 5: type
                { visible: false },                      // 6: included by
                { visible: false }                       // 7: owned by
            ],
            initComplete: function () {
                this.api().columns().every(function () {
                    var column = this;
                    var idx = column.index();
                    // Name (3) — text search
                    if (idx === 3) {
                        $('<input type="text" class="csh-cv-search" placeholder="Search name…">')
                            .appendTo($(column.footer()))
                            .on('keyup change', function () {
                                column.search($(this).val()).draw();
                            });
                    }
                    // Parent Object (4) and Type (5) — dropdown filter
                    if (idx === 4 || idx === 5) {
                        var sel = $('<select class="csh-cv-search"><option value=""></option></select>')
                            .appendTo($(column.footer()))
                            .on('change', function () {
                                var v = $.fn.dataTable.util.escapeRegex($(this).val());
                                column.search(v ? '^' + v + '$' : '', true, false).draw();
                            });
                        column.data().unique().sort().each(function (d) {
                            sel.append('<option value="' + escapeAttr(d) + '">' + escapeHtml(d) + '</option>');
                        });
                    }
                });
            }
        });

        totalLoadedRows = $('table.list tr.dataRow').length;
        totalExpectedRows = scrapeTotalRowCount() || totalLoadedRows;
    }

    // Salesforce lists a "1-25 of 3,200" counter somewhere in the toolbar.
    // If we can scrape it we know how far we need to walk pagination.
    function scrapeTotalRowCount() {
        var text = $('body').text();
        var m = text.match(/of\s+(\d[\d,]*)\s*\)/);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        m = text.match(/\((\d[\d,]*)\s+items?\s+total\)/i);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        return null;
    }

    // -----------------------------------------------------------------------
    // 3) Progressive background pagination.
    //
    // Strategy: scrape a "Next Page" link from Salesforce's own pagination
    // controls; fetch the URL; parse the response; append its data rows to
    // our existing table + DataTable; recurse until no "Next Page" exists or
    // we've seen the total count.
    // -----------------------------------------------------------------------
    var progressEl = null;
    function ensureProgressPill() {
        if (progressEl) return progressEl;
        progressEl = document.createElement('div');
        progressEl.className = 'csh-cv-progress';
        progressEl.innerHTML =
            '<div class="csh-cv-progress-body">' +
              '<div class="csh-cv-progress-label">Loading components…</div>' +
              '<div class="csh-cv-progress-bar"><div class="csh-cv-progress-fill"></div></div>' +
              '<button type="button" class="csh-cv-progress-cancel">Cancel</button>' +
            '</div>';
        document.body.appendChild(progressEl);
        progressEl.querySelector('.csh-cv-progress-cancel').addEventListener('click', function () {
            fetchCancelled = true;
            hideProgress(400);
        });
        return progressEl;
    }

    function updateProgress() {
        ensureProgressPill();
        var label = progressEl.querySelector('.csh-cv-progress-label');
        var fill = progressEl.querySelector('.csh-cv-progress-fill');
        var pct = totalExpectedRows && totalExpectedRows > 0
            ? Math.min(100, Math.round((totalLoadedRows / totalExpectedRows) * 100))
            : 0;
        label.textContent = 'Loading components… ' +
            totalLoadedRows.toLocaleString() +
            (totalExpectedRows ? (' / ' + totalExpectedRows.toLocaleString() + ' (' + pct + '%)') : '');
        fill.style.width = pct + '%';
    }

    function hideProgress(delay) {
        if (!progressEl) return;
        setTimeout(function () {
            if (progressEl && progressEl.parentNode) progressEl.parentNode.removeChild(progressEl);
            progressEl = null;
        }, delay || 1200);
    }

    async function startProgressivePagination() {
        var nextHref = findNextPageHref();
        if (!nextHref) {
            // All rows already visible — no pagination.
            console.log('changeview: no next page to fetch; full list is', totalLoadedRows, 'rows');
            return;
        }
        ensureProgressPill();
        updateProgress();
        var safetyMax = 200; // cap at 200 pages to avoid infinite loops on a broken scrape
        while (nextHref && !fetchCancelled && safetyMax-- > 0) {
            try {
                var resp = await fetch(nextHref, { credentials: 'include' });
                if (!resp.ok) { console.warn('changeview: page fetch failed', resp.status); break; }
                var html = await resp.text();
                var rows = parseRowsFromHtml(html);
                appendRows(rows);
                nextHref = findNextPageHrefInHtml(html);
                updateProgress();
            } catch (err) {
                console.error('changeview: pagination error', err);
                break;
            }
        }
        // Refresh dropdown filters so newly-added parent objects / types appear.
        if (changeSetTable) refreshFooterFilters();
        updateProgress();
        hideProgress(1800);
        if (totalExpectedRows == null || totalLoadedRows >= totalExpectedRows) {
            window.cshToast && window.cshToast.show(
                'All ' + totalLoadedRows.toLocaleString() + ' components loaded. Filter / remove freely.',
                { type: 'success', duration: 4000 }
            );
        }
    }

    function findNextPageHref() {
        // Salesforce paginators use "Next Page" link text or an onclick-driven
        // arrow. Prefer a real href if present; else null (we stop).
        var link = $('a').filter(function () {
            return /^next\s*(page|›)?$/i.test($.trim($(this).text()));
        }).first();
        if (link.length) return absoluteUrl(link.attr('href'));
        return null;
    }

    function findNextPageHrefInHtml(html) {
        // Same idea but against a fetched HTML string.
        try {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var anchors = doc.querySelectorAll('a');
            for (var i = 0; i < anchors.length; i++) {
                var txt = (anchors[i].textContent || '').trim();
                if (/^next\s*(page|›)?$/i.test(txt) && anchors[i].href) {
                    return new URL(anchors[i].getAttribute('href'), location.href).href;
                }
            }
        } catch (_) {}
        return null;
    }

    function parseRowsFromHtml(html) {
        try {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            return Array.from(doc.querySelectorAll('table.list tr.dataRow'));
        } catch (_) { return []; }
    }

    function appendRows(rowNodes) {
        if (!rowNodes.length || !changeSetTable) return;
        rowNodes.forEach(function (rowNode) {
            var delLink = findDelLink(rowNode);
            var cid = idFromDelLink(delLink);
            // Prepend our selection cell to match the first-column shape.
            var selTd = document.createElement('td');
            selTd.className = 'csh-cv-select-col';
            selTd.innerHTML = '<input type="checkbox" class="csh-cv-select-row"' +
                ' data-del-href="' + escapeAttr(delLink || '') + '"' +
                ' data-cid="' + escapeAttr(cid || '') + '">';
            rowNode.insertBefore(selTd, rowNode.firstChild);
            // Let DataTables re-ingest the row so it participates in sort/filter.
            try {
                changeSetTable.row.add(rowNode);
            } catch (e) { console.warn('changeview: row.add failed', e); }
            totalLoadedRows++;
        });
        changeSetTable.draw(false);
    }

    function refreshFooterFilters() {
        if (!changeSetTable) return;
        [4, 5].forEach(function (colIdx) {
            var column = changeSetTable.column(colIdx);
            var $sel = $(column.footer()).find('select');
            if (!$sel.length) return;
            var currentVal = $sel.val();
            $sel.find('option').remove().end().append('<option value=""></option>');
            column.data().unique().sort().each(function (d) {
                $sel.append('<option value="' + escapeAttr(d) + '">' + escapeHtml(d) + '</option>');
            });
            if (currentVal) $sel.val(currentVal);
        });
    }

    // -----------------------------------------------------------------------
    // 4) Selection helpers + toolbar.
    // -----------------------------------------------------------------------
    function installToolbar() {
        var toolbar = $(
            '<div class="csh-cv-toolbar">' +
              '<span class="csh-cv-toolbar-label">Bulk:</span>' +
              '<button type="button" class="csh-cv-select-filtered">Select all filtered</button>' +
              '<button type="button" class="csh-cv-select-none">Clear selection</button>' +
              '<span class="csh-cv-selection-count">0 selected</span>' +
              '<button type="button" class="csh-cv-remove" disabled>Remove selected</button>' +
            '</div>'
        );
        toolbar.insertBefore($('table.list').closest('.list, .apexp, .bPageBlock').first());
        if (toolbar.prev().length === 0) toolbar.prependTo('body'); // pathological fallback

        // Event delegation so the handlers work for rows added by
        // progressive pagination too.
        $(document).on('change', '.csh-cv-select-all', function () {
            var checked = this.checked;
            // Applies to FILTERED visible rows so the user selects what they
            // see, not hidden rows.
            if (!changeSetTable) return;
            changeSetTable.rows({ search: 'applied' }).nodes().each(function (rowNode) {
                var cb = rowNode.querySelector('.csh-cv-select-row');
                if (cb) cb.checked = checked;
            });
            updateSelectionCount();
        });
        $(document).on('change', '.csh-cv-select-row', function () {
            updateSelectionCount();
        });
        $(document).on('click', '.csh-cv-select-filtered', function () {
            changeSetTable.rows({ search: 'applied' }).nodes().each(function (rowNode) {
                var cb = rowNode.querySelector('.csh-cv-select-row');
                if (cb && !cb.disabled) cb.checked = true;
            });
            updateSelectionCount();
        });
        $(document).on('click', '.csh-cv-select-none', function () {
            $('.csh-cv-select-row').prop('checked', false);
            $('.csh-cv-select-all').prop('checked', false);
            updateSelectionCount();
        });
        $(document).on('click', '.csh-cv-remove', handleRemoveSelected);
    }

    function collectSelectedCheckboxes() {
        return Array.from(document.querySelectorAll('.csh-cv-select-row:checked'))
            .filter(function (cb) { return cb.getAttribute('data-del-href'); });
    }

    function updateSelectionCount() {
        selectionCount = collectSelectedCheckboxes().length;
        $('.csh-cv-selection-count').text(selectionCount + ' selected');
        $('.csh-cv-remove').prop('disabled', selectionCount === 0);
    }

    // -----------------------------------------------------------------------
    // 5) Remove worker.
    //
    // Salesforce's "Del" link lands on a confirm page with a form that must
    // be POSTed to complete the removal (CSRF-like ViewState fields in the
    // form prevent simple GET-bypass). Flow:
    //   1. fetch(delHref, GET, credentials: include)
    //   2. if response contains a <form> with inputs that look like the
    //      confirmation, build a body from every hidden input + the submit
    //      button's name/value, and POST it back.
    //   3. on success, remove the row from DataTable + DOM.
    //
    // Concurrency capped at 4 to avoid flooding Salesforce. Progress + errors
    // surfaced through a dedicated modal.
    // -----------------------------------------------------------------------
    async function handleRemoveSelected() {
        var targets = collectSelectedCheckboxes();
        if (targets.length === 0) return;
        if (!confirm('Remove ' + targets.length + ' component(s) from this change set? This cannot be undone.')) return;

        showRemoveModal(targets.length);

        var queue = targets.slice();
        var done = 0, failed = 0;
        var failures = [];

        async function worker() {
            while (queue.length && !fetchCancelled) {
                var cb = queue.shift();
                var delHref = cb.getAttribute('data-del-href');
                var cid = cb.getAttribute('data-cid') || '(unknown)';
                var row = cb.closest('tr');
                var nameCell = row ? row.querySelectorAll('td')[3] : null; // shifted by +1 for our select col
                var displayName = nameCell ? (nameCell.textContent || '').trim() : cid;
                try {
                    await removeOneComponent(absoluteUrl(delHref));
                    if (row) {
                        try { changeSetTable.row(row).remove().draw(false); }
                        catch (_) { $(row).remove(); }
                    }
                    done++;
                    appendRemoveLog('✓ ' + displayName, 'ok');
                } catch (err) {
                    failed++;
                    failures.push({ name: displayName, error: err.message });
                    appendRemoveLog('✗ ' + displayName + ' — ' + err.message, 'fail');
                }
                updateRemoveProgress(done + failed, targets.length);
            }
        }
        var workers = [];
        for (var i = 0; i < Math.min(CONCURRENCY, targets.length); i++) workers.push(worker());
        await Promise.all(workers);

        finishRemoveModal(done, failed, failures);
        updateSelectionCount();
    }

    async function removeOneComponent(delHref) {
        // Step 1 — GET confirm page.
        var r = await fetch(delHref, { credentials: 'include', redirect: 'follow' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' on confirm page');
        var html = await r.text();

        // Some Salesforce flows show an OK/Cancel JS alert but no form — if
        // the response already landed back on a list page (no confirm form),
        // treat as done.
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var forms = doc.querySelectorAll('form');
        if (forms.length === 0) return; // direct success

        // Step 2 — pick the likely confirm form: the one whose action is
        // the same URL (relative) or clearly the deletion endpoint.
        var form = null;
        for (var i = 0; i < forms.length; i++) {
            var f = forms[i];
            var action = (f.getAttribute('action') || '').toLowerCase();
            if (/remove|delete|listremove|listcomponentremove/.test(action) ||
                f.querySelector('input[type="submit"][name*="ave" i]') ||  // "save", "submit", "approve"
                f.querySelector('input[type="submit"][value*="OK" i]')) {
                form = f;
                break;
            }
        }
        // Fall back to the first form if heuristics fail.
        if (!form) form = forms[0];

        var action = absoluteUrl(form.getAttribute('action') || delHref);
        var method = (form.getAttribute('method') || 'POST').toUpperCase();
        var body = new URLSearchParams();
        form.querySelectorAll('input[type="hidden"], input[type="text"]').forEach(function (inp) {
            if (inp.name) body.append(inp.name, inp.value);
        });
        var submit = form.querySelector('input[type="submit"][name]');
        if (submit) body.append(submit.name, submit.value);

        // Step 3 — POST confirmation.
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

    // -----------------------------------------------------------------------
    // 6) Remove modal UI.
    // -----------------------------------------------------------------------
    function showRemoveModal(total) {
        var modal = document.createElement('div');
        modal.className = 'csh-cv-modal';
        modal.innerHTML =
            '<div class="csh-cv-modal-body">' +
              '<h3>Removing components…</h3>' +
              '<div class="csh-cv-modal-bar"><div class="csh-cv-modal-fill"></div></div>' +
              '<div class="csh-cv-modal-count">0 / ' + total + '</div>' +
              '<div class="csh-cv-modal-log"></div>' +
              '<div class="csh-cv-modal-actions">' +
                '<button type="button" class="csh-cv-modal-cancel">Cancel</button>' +
                '<button type="button" class="csh-cv-modal-close" style="display:none">Close</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(modal);
        modal.querySelector('.csh-cv-modal-cancel').addEventListener('click', function () {
            fetchCancelled = true;
        });
        modal.querySelector('.csh-cv-modal-close').addEventListener('click', function () {
            modal.remove();
            fetchCancelled = false;
        });
    }

    function appendRemoveLog(text, kind) {
        var log = document.querySelector('.csh-cv-modal-log');
        if (!log) return;
        var div = document.createElement('div');
        div.className = 'csh-cv-log-entry ' + (kind || '');
        div.textContent = text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    function updateRemoveProgress(done, total) {
        var count = document.querySelector('.csh-cv-modal-count');
        var fill = document.querySelector('.csh-cv-modal-fill');
        if (count) count.textContent = done + ' / ' + total;
        if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    }

    function finishRemoveModal(done, failed, failures) {
        var h3 = document.querySelector('.csh-cv-modal h3');
        var cancel = document.querySelector('.csh-cv-modal-cancel');
        var close = document.querySelector('.csh-cv-modal-close');
        if (h3) h3.textContent = failed === 0
            ? 'Removed ' + done + ' component(s) ✓'
            : 'Removed ' + done + ', ' + failed + ' failed';
        if (cancel) cancel.style.display = 'none';
        if (close) close.style.display = '';
        window.cshToast && window.cshToast.show(
            failed === 0
                ? 'Removed ' + done + ' component(s).'
                : 'Removed ' + done + ' • ' + failed + ' failed. See modal for details.',
            { type: failed === 0 ? 'success' : 'warning', duration: 6000 }
        );
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    setupTable();
    installToolbar();
    updateSelectionCount();
    // Kick off pagination in the background; the user can immediately filter
    // and select while pages stream in.
    startProgressivePagination();
})();
