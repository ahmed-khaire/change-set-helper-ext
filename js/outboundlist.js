// ---------------------------------------------------------------------------
// Change Set Helper - outbound change set list bootstrap
//
// Runs on the Lightning and Classic outbound change set list pages. This is a
// lightweight starting point for background cache warming: it records the org
// and any visible change set links so Detail/Add pages can reuse the same
// IndexedDB identity model.
// ---------------------------------------------------------------------------
(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (document.documentElement.getAttribute('data-csh-outbound-list-loaded')) return;
    document.documentElement.setAttribute('data-csh-outbound-list-loaded', '1');

    var COMMON_METADATA_TYPES = [
        'ApexClass',
        'ApexTrigger',
        'LightningComponentBundle',
        'AuraDefinitionBundle',
        'CustomObject',
        'CustomField',
        'Layout',
        'FlowDefinition',
        'RecordType',
        'ValidationRule',
        'CustomLabel',
        'CustomTab',
        'PermissionSet',
        'Profile',
        'StaticResource',
        'GlobalValueSet',
        'EmailTemplate',
        'Report',
        'Dashboard'
    ];
    var CATALOG_FRESH_MS = 12 * 60 * 60 * 1000;
    var CATALOG_RUNNING_TTL_MS = 45 * 60 * 1000;
    var CHANGE_SET_FRESH_MS = 60 * 60 * 1000;
    var CHANGE_SET_RUNNING_TTL_MS = 30 * 60 * 1000;
    var MAINTENANCE_FRESH_MS = 24 * 60 * 60 * 1000;
    var MAINTENANCE_RUNNING_TTL_MS = 10 * 60 * 1000;
    var PACKAGE_ID_RE = /^033[A-Za-z0-9]{12,15}$/;
    var listRefreshTimer = null;

    function extractChangeSetId(href) {
        if (!href) return null;
        var m = href.match(/0A2[A-Za-z0-9]{12,15}/);
        return m ? m[0] : null;
    }

    function cleanText(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function ensureStatusPanel() {
        var existing = document.getElementById('csh-outbound-sync-status');
        if (existing) return existing;
        var panel = document.createElement('div');
        panel.id = 'csh-outbound-sync-status';
        panel.setAttribute('role', 'status');
        panel.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:16px',
            'z-index:2147483647',
            'max-width:360px',
            'padding:8px 12px',
            'border:1px solid rgba(0,0,0,.18)',
            'border-radius:6px',
            'background:#fff',
            'color:#1f2933',
            'font:12px/1.35 Arial,sans-serif',
            'box-shadow:0 4px 14px rgba(0,0,0,.15)',
            'display:none'
        ].join(';');
        document.documentElement.appendChild(panel);
        return panel;
    }

    function setStatusPanel(message, state) {
        var panel = ensureStatusPanel();
        if (!message) {
            panel.style.display = 'none';
            return;
        }
        panel.textContent = 'CSH cache: ' + message;
        panel.style.display = 'block';
        panel.style.borderColor = state === 'error' ? '#b42318' : (state === 'done' ? '#067647' : 'rgba(0,0,0,.18)');
    }

    function statusContainer(anchor) {
        if (!anchor || !anchor.closest) return null;
        return anchor.closest('tr') ||
            anchor.closest('[role="row"]') ||
            anchor.closest('.slds-hint-parent') ||
            anchor.closest('li') ||
            anchor.parentElement;
    }

    function detectChangeSetStatus(anchor) {
        var row = statusContainer(anchor);
        if (!row) return '';
        var cells = row.querySelectorAll('td, th, [role="gridcell"], [role="cell"], .slds-cell-wrap');
        for (var i = 0; i < cells.length; i++) {
            var text = cleanText(cells[i].textContent);
            if (/^(Open|Closed|Uploaded|Upload In Progress|Failed)$/i.test(text)) {
                return text;
            }
        }
        var rowText = cleanText(row.getAttribute('aria-label') || row.textContent);
        var m = rowText.match(/\bStatus\s*:?\s*(Open|Closed|Uploaded|Upload In Progress|Failed)\b/i);
        if (m) return m[1];
        return '';
    }

    function discoverVisibleChangeSets() {
        var out = [];
        var seen = {};
        document.querySelectorAll('a[href]').forEach(function (a) {
            var href = a.getAttribute('href') || '';
            if (href.indexOf('outboundChangeSetDetailPage') === -1 && href.indexOf('/0A2') === -1) return;
            var id = extractChangeSetId(href);
            if (!id || seen[id]) return;
            seen[id] = true;
            out.push({
                changeSetId: id,
                name: cleanText(a.textContent) || id,
                status: detectChangeSetStatus(a),
                href: new URL(href, location.href).href,
                source: 'outbound-list'
            });
        });
        return out;
    }

    async function seedCache() {
        if (!window.cshDb) return;
        try {
            await window.cshDb.upsertOrg({
                source: 'outbound-list',
                lastVisitedOutboundListAt: Date.now()
            });
            var changeSets = discoverVisibleChangeSets();
            if (changeSets.length) {
                await window.cshDb.upsertChangeSets(changeSets, { source: 'outbound-list' });
                console.log('[CSH] outbound list cached', changeSets.length, 'visible change set(s)');
            } else {
                console.log('[CSH] outbound list cache bootstrap: no visible change set links found yet');
            }
        } catch (e) {
            console.warn('[CSH] outbound list cache bootstrap failed:', e && e.message);
        }
    }

    function scheduleListRefresh(delayMs) {
        clearTimeout(listRefreshTimer);
        listRefreshTimer = setTimeout(function () {
            seedCache();
            syncVisibleChangeSetMemberships();
        }, delayMs == null ? 1500 : delayMs);
    }

    function findListObserverRoot() {
        return document.querySelector('[data-aura-class*="ChangeSet"]') ||
            document.querySelector('.oneContent.active') ||
            document.querySelector('table.list') ||
            document.querySelector('[role="grid"]') ||
            document.querySelector('main') ||
            document.body ||
            document.documentElement;
    }

    function installListObserver() {
        if (!window.MutationObserver || document.documentElement.getAttribute('data-csh-outbound-observing')) return;
        document.documentElement.setAttribute('data-csh-outbound-observing', '1');
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                var targetEl = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
                if (targetEl && targetEl.closest && targetEl.closest('#csh-outbound-sync-status')) continue;
                if ((m.addedNodes && m.addedNodes.length) || m.type === 'characterData') {
                    scheduleListRefresh(1800);
                    return;
                }
            }
        });
        observer.observe(findListObserverRoot(), {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function sendMessage(message) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage(message, function (response) {
                if (chrome.runtime.lastError) {
                    resolve({ err: chrome.runtime.lastError.message });
                    return;
                }
                resolve(response || {});
            });
        });
    }

    async function connectLocalOrg() {
        if (!window.cshSession || !window.cshSession.ready) {
            throw new Error('Salesforce session helper is not available');
        }
        var sid = await window.cshSession.ready;
        if (!sid) throw new Error('Salesforce session not available');
        var resp = await sendMessage({
            oauth: 'connectToLocal',
            sessionId: sid,
            serverUrl: serverUrl,
            authMode: window.cshSession.mode ? window.cshSession.mode() : 'sid',
            instanceUrl: window.cshSession.instanceUrl ? window.cshSession.instanceUrl() : serverUrl
        });
        if (resp && resp.error) throw new Error(resp.error);
        await rememberConnectedOrgId();
    }

    async function rememberConnectedOrgId() {
        if (!window.cshDb || !window.cshDb.rememberOrgId) return;
        try {
            var response = await sendMessage({
                proxyFunction: 'querySoqlLocal',
                soql: 'SELECT Id FROM Organization LIMIT 1'
            });
            var records = response && response.records;
            var orgId = records && records[0] && records[0].Id;
            if (orgId) await window.cshDb.rememberOrgId(orgId, serverUrl);
        } catch (e) {
            console.warn('[CSH] org id mapping update failed:', e && e.message);
        }
    }

    async function listMetadataType(type) {
        var response = await sendMessage({
            proxyFunction: 'listLocalMetaData',
            proxydata: [{ type: type }]
        });
        if (response && response.err) throw new Error(response.err.message || response.err);
        return Array.isArray(response.results) ? response.results : [];
    }

    function appOriginForChangeSetView() {
        var host = location.host || '';
        if (/\.salesforce-setup\.com$/i.test(host)) {
            return location.protocol + '//' + host.replace(/\.salesforce-setup\.com$/i, '.salesforce.com');
        }
        return location.origin;
    }

    async function fetchClassicPage(url) {
        var response = await sendMessage({ type: 'cshClassicFetch', url: url });
        if (response && response.error) throw new Error(response.error);
        if (!response || !response.ok) {
            throw new Error('HTTP ' + ((response && response.status) || 'unknown') + ' fetching ' + url);
        }
        return {
            url: response.finalUrl || url,
            text: response.text || ''
        };
    }

    function findDelHrefInRow(rowEl) {
        var candidates = rowEl.querySelectorAll('a, button');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var txt = (el.textContent || '').trim();
            var title = (el.getAttribute('title') || '').trim();
            var href = el.getAttribute('href') || '';
            var onclick = el.getAttribute('onclick') || '';
            if (/^(del|remove)\b/i.test(txt) || /^(del|remove)\b/i.test(title)) {
                if (/[?&](?:cid|delID)=/i.test(href)) return href;
                var fromOnclick = extractCidUrlFromAttr(onclick);
                if (fromOnclick) return fromOnclick;
            }
            if (/listComponentRemoveForPackage|outboundChangeSetComponentRemove|listComponentRemove|removeComponent|componentRemove|componentDelete|deleteredirect\.jsp/i.test(href)) return href;
        }
        return null;
    }

    function extractCidUrlFromAttr(str) {
        if (!str) return null;
        var m = str.match(/['"]((?:[^'"]+)\?[^'"]*\b(?:cid|delID)=[^'"]+)['"]/i);
        return m ? m[1] : null;
    }

    function extractCidFromDelHref(href) {
        if (!href) return null;
        var m = href.match(/[?&](?:cid|delID)=([^&]+)/i);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function findCidInRowAnchors(rowEl, packageId, preferredCellIdx) {
        var sfIdRe = /^\/?([0-9a-zA-Z]{15}(?:[0-9a-zA-Z]{3})?)(?:[?#\/]|$)/;
        var pkgPrefix = packageId ? packageId.slice(0, 15) : null;
        function extract(anchors) {
            for (var i = 0; i < anchors.length; i++) {
                var href = anchors[i].getAttribute('href') || '';
                var m = href.match(sfIdRe);
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

    async function resolvePackageId(changeSetId) {
        if (window.cshIdMap) {
            var cached = await window.cshIdMap.getPackageId(changeSetId);
            if (cached && PACKAGE_ID_RE.test(cached)) return cached;
        }
        var candidates = [
            new URL('/p/mfpkg/AddToPackageFromChangeMgmtUi?id=' + encodeURIComponent(changeSetId), location.origin).href,
            new URL('/p/mfpkg/AddToPackageUi?id=' + encodeURIComponent(changeSetId), location.origin).href
        ];
        for (var i = 0; i < candidates.length; i++) {
            try {
                var page = await fetchClassicPage(candidates[i]);
                var doc = new DOMParser().parseFromString(page.text, 'text/html');
                var inputs = doc.querySelectorAll('input');
                for (var j = 0; j < inputs.length; j++) {
                    var val = inputs[j].value || '';
                    if (PACKAGE_ID_RE.test(val)) {
                        if (window.cshIdMap) {
                            window.cshIdMap.putMapping(changeSetId, val).catch(function () {});
                        }
                        return val;
                    }
                }
                var bodyMatch = (doc.body && doc.body.innerHTML || '').match(/033[A-Za-z0-9]{12,15}/);
                if (bodyMatch) {
                    if (window.cshIdMap) {
                        window.cshIdMap.putMapping(changeSetId, bodyMatch[0]).catch(function () {});
                    }
                    return bodyMatch[0];
                }
            } catch (e) {
                console.warn('[CSH] package id resolve failed for', changeSetId, e && e.message);
            }
        }
        return null;
    }

    async function fetchChangeSetMembers(changeSetId, packageId) {
        var items = [];
        var nextUrl = new URL('/' + packageId + '?tab=PackageComponents&rowsperpage=5000', appOriginForChangeSetView()).href;
        var safety = 200;
        while (nextUrl && safety-- > 0) {
            var page = await fetchClassicPage(nextUrl);
            var doc = new DOMParser().parseFromString(page.text, 'text/html');
            var table = doc.querySelector('table.list');
            if (!table) {
                if (!items.length) throw new Error('No table.list on Package Components page');
                break;
            }
            var idx = { name: -1, type: -1, fullName: -1 };
            var header = table.querySelector('tr.headerRow');
            if (header) {
                Array.prototype.forEach.call(header.children, function (cell, i) {
                    var text = (cell.textContent || '').trim().toLowerCase();
                    if ((text === 'name' || text === 'component name') && idx.name === -1) idx.name = i;
                    else if (text === 'type' && idx.type === -1) idx.type = i;
                    else if ((text === 'api name' || text === 'full name') && idx.fullName === -1) idx.fullName = i;
                });
            }
            var rows = table.querySelectorAll('tr.dataRow');
            rows.forEach(function (row) {
                var href = findDelHrefInRow(row);
                var cid = href ? extractCidFromDelHref(href) : null;
                if (!cid) cid = findCidInRowAnchors(row, packageId, idx.name);
                if (!cid) return;
                var cells = row.children;
                var type = idx.type >= 0 && cells[idx.type] ? (cells[idx.type].textContent || '').trim() : '';
                if (!type) return;
                var name = idx.name >= 0 && cells[idx.name] ? (cells[idx.name].textContent || '').trim() : '';
                var fullName = idx.fullName >= 0 && cells[idx.fullName] ? (cells[idx.fullName].textContent || '').trim() : '';
                var item = {
                    id: cid,
                    type: type,
                    name: name || fullName || cid,
                    fullName: fullName || undefined,
                    source: 'outbound-list-change-set-sync'
                };
                if (href) item.removeHref = new URL(href, nextUrl).href;
                items.push(item);
            });
            var nextHref = findNextPageHrefInDoc(doc);
            nextUrl = nextHref ? new URL(nextHref, nextUrl).href : null;
        }
        return items;
    }

    async function syncVisibleChangeSetMemberships() {
        if (!window.cshDb) return;
        var allVisible = discoverVisibleChangeSets();
        await clearClosedChangeSetCaches(allVisible);
        var changeSets = allVisible.filter(function (cs) {
            return /^Open$/i.test(cs.status || '');
        });
        if (!changeSets.length) {
            console.log('[CSH] no open change sets visible to warm');
            return;
        }
        var org = window.cshDb.orgId();
        var runnable = [];
        for (var g = 0; g < changeSets.length; g++) {
            var candidate = changeSets[g];
            var candidateJobKey = 'change-set-members::' + org + '::' + candidate.changeSetId;
            var existingJob = await window.cshDb.getSyncJob(candidateJobKey);
            var now = Date.now();
            if (existingJob && existingJob.status === 'running' && existingJob.startedAt && (now - existingJob.startedAt) < CHANGE_SET_RUNNING_TTL_MS) {
                console.log('[CSH] change set membership sync skipped for', candidate.changeSetId, 'running');
                continue;
            }
            if (existingJob && existingJob.status === 'completed' && existingJob.completedAt && (now - existingJob.completedAt) < CHANGE_SET_FRESH_MS) {
                console.log('[CSH] change set membership sync skipped for', candidate.changeSetId, 'fresh');
                continue;
            }
            runnable.push(candidate);
        }
        if (!runnable.length) {
            setStatusPanel('open change set cache is fresh', 'done');
            setTimeout(function () { setStatusPanel(''); }, 2500);
            return;
        }
        setStatusPanel('warming ' + runnable.length + ' open change set(s)');
        await connectLocalOrg();
        org = window.cshDb.orgId();
        for (var i = 0; i < runnable.length; i++) {
            var cs = runnable[i];
            var jobKey = 'change-set-members::' + org + '::' + cs.changeSetId;
            var gate = await window.cshDb.shouldRunSyncJob(jobKey, CHANGE_SET_FRESH_MS, CHANGE_SET_RUNNING_TTL_MS);
            if (!gate.run) {
                console.log('[CSH] change set membership sync skipped for', cs.changeSetId, gate.reason);
                continue;
            }
            try {
                setStatusPanel('warming change set ' + (i + 1) + '/' + runnable.length + ': ' + (cs.name || cs.changeSetId));
                await window.cshDb.putSyncJob(jobKey, {
                    status: 'running',
                    changeSetId: cs.changeSetId,
                    name: cs.name,
                    phase: 'resolving-package'
                });
                var packageId = await resolvePackageId(cs.changeSetId);
                if (!packageId) throw new Error('Could not resolve 033 package id');
                await window.cshDb.upsertChangeSets([Object.assign({}, cs, { packageId: packageId })], { source: 'outbound-list-change-set-sync' });
                setStatusPanel('reading members for ' + (cs.name || cs.changeSetId));
                var members = await fetchChangeSetMembers(cs.changeSetId, packageId);
                await window.cshDb.upsertChangeSetMembers([cs.changeSetId, packageId], members, {
                    authoritative: true,
                    source: 'outbound-list-change-set-sync',
                    status: 'present'
                });
                await window.cshDb.putSyncJob(jobKey, {
                    status: 'completed',
                    completedAt: Date.now(),
                    changeSetId: cs.changeSetId,
                    packageId: packageId,
                    name: cs.name,
                    memberCount: members.length,
                    phase: null,
                    error: null
                });
                console.log('[CSH] cached change set membership for', cs.name || cs.changeSetId, members.length, 'member(s)');
            } catch (e) {
                setStatusPanel('change set warming failed for ' + (cs.name || cs.changeSetId), 'error');
                await window.cshDb.putSyncJob(jobKey, {
                    status: 'failed',
                    failedAt: Date.now(),
                    changeSetId: cs.changeSetId,
                    name: cs.name,
                    error: (e && e.message) || String(e)
                });
                console.warn('[CSH] change set membership sync failed for', cs.changeSetId, e && e.message);
            }
            await new Promise(function (resolve) { setTimeout(resolve, 250); });
        }
        setStatusPanel('open change set cache is ready', 'done');
        setTimeout(function () { setStatusPanel(''); }, 3500);
    }

    async function clearClosedChangeSetCaches(changeSets) {
        if (!window.cshDb || !changeSets || !changeSets.length) return;
        var org = window.cshDb.orgId();
        for (var i = 0; i < changeSets.length; i++) {
            var cs = changeSets[i];
            if (/^Open$/i.test(cs.status || '')) continue;
            // Unknown status can happen on Lightning virtualized lists before
            // cells hydrate. Do not delete cache unless the page explicitly
            // shows a non-open status.
            if (!cs.status) continue;
            try {
                var idsToClear = [cs.changeSetId];
                var stored = await window.cshDb.getChangeSet(cs.changeSetId).catch(function () { return null; });
                if (stored && stored.packageId) idsToClear.push(stored.packageId);
                if (window.cshIdMap) {
                    var mappedPackageId = await window.cshIdMap.getPackageId(cs.changeSetId).catch(function () { return null; });
                    if (mappedPackageId) idsToClear.push(mappedPackageId);
                }
                idsToClear = idsToClear.filter(function (id, idx) {
                    return id && idsToClear.indexOf(id) === idx;
                });
                var deleted = await window.cshDb.deleteChangeSetMembers(idsToClear);
                await window.cshDb.deleteSyncJob('change-set-members::' + org + '::' + cs.changeSetId);
                if (deleted > 0) {
                    setStatusPanel('cleared cache for non-open change set ' + (cs.name || cs.changeSetId), 'done');
                    console.log('[CSH] cleared cached membership for non-open change set',
                        cs.name || cs.changeSetId, '(' + cs.status + '):', deleted, 'row(s)');
                }
            } catch (e) {
                console.warn('[CSH] failed clearing non-open change set cache for',
                    cs.changeSetId, e && e.message);
            }
        }
    }

    async function syncCommonComponentCatalog() {
        if (!window.cshDb) return;
        var org = window.cshDb.orgId();
        var jobKey = 'component-catalog::' + org + '::common-v1';
        var priorJob = await window.cshDb.getSyncJob(jobKey);
        var priorTypeStatus = (priorJob && priorJob.typeStatus) || {};
        var gate = await window.cshDb.shouldRunSyncJob(jobKey, CATALOG_FRESH_MS, CATALOG_RUNNING_TTL_MS);
        if (!gate.run) {
            console.log('[CSH] common component catalog sync skipped:', gate.reason);
            return;
        }

        var totals = { types: 0, components: (priorJob && priorJob.componentCount) || 0, errors: [] };
        var typeStatus = Object.assign({}, priorTypeStatus);
        try {
            setStatusPanel('warming common metadata catalog');
            await connectLocalOrg();
            for (var i = 0; i < COMMON_METADATA_TYPES.length; i++) {
                var type = COMMON_METADATA_TYPES[i];
                if (typeStatus[type] && typeStatus[type].status === 'completed') {
                    totals.types++;
                    continue;
                }
                await window.cshDb.putSyncJob(jobKey, {
                    status: 'running',
                    currentType: type,
                    completedTypes: totals.types,
                    componentCount: totals.components,
                    errors: totals.errors,
                        typeStatus: typeStatus
                    });
                try {
                    setStatusPanel('warming ' + type + ' (' + (i + 1) + '/' + COMMON_METADATA_TYPES.length + ')');
                    var records = await listMetadataType(type);
                    var count = await window.cshDb.upsertComponents(records, {
                        type: type === 'FlowDefinition' ? 'Flow' : type,
                        source: 'outbound-list-common-sync'
                    });
                    typeStatus[type] = {
                        status: 'completed',
                        completedAt: Date.now(),
                        count: count
                    };
                    totals.types++;
                    totals.components += count;
                    console.log('[CSH] cached common metadata type', type, count, 'record(s)');
                } catch (e) {
                    typeStatus[type] = {
                        status: 'failed',
                        failedAt: Date.now(),
                        error: (e && e.message) || String(e)
                    };
                    totals.errors.push({ type: type, error: typeStatus[type].error });
                    console.warn('[CSH] common metadata sync failed for', type + ':', e && e.message);
                }
                // Yield between types so the Salesforce setup page remains responsive.
                await new Promise(function (resolve) { setTimeout(resolve, 150); });
            }
            await window.cshDb.putSyncJob(jobKey, {
                status: totals.errors.length ? 'completed-with-errors' : 'completed',
                completedAt: Date.now(),
                currentType: null,
                completedTypes: totals.types,
                componentCount: totals.components,
                errors: totals.errors,
                typeStatus: typeStatus
            });
            console.log('[CSH] common component catalog sync complete:', totals);
            setStatusPanel('common metadata catalog ready', 'done');
            setTimeout(function () { setStatusPanel(''); }, 3500);
        } catch (e) {
            setStatusPanel('common metadata catalog sync failed', 'error');
            await window.cshDb.putSyncJob(jobKey, {
                status: 'failed',
                failedAt: Date.now(),
                error: (e && e.message) || String(e),
                completedTypes: totals.types,
                componentCount: totals.components,
                errors: totals.errors,
                typeStatus: typeStatus
            });
            console.warn('[CSH] common component catalog sync failed:', e && e.message);
        }
    }

    async function runCacheMaintenance() {
        if (!window.cshDb || !window.cshDb.prune) return;
        var org = window.cshDb.orgId();
        var jobKey = 'maintenance::' + org + '::prune-v1';
        var gate = await window.cshDb.shouldRunSyncJob(jobKey, MAINTENANCE_FRESH_MS, MAINTENANCE_RUNNING_TTL_MS);
        if (!gate.run) return;
        try {
            setStatusPanel('pruning old cache rows');
            var counts = await window.cshDb.prune({ allOrgs: true });
            await window.cshDb.putSyncJob(jobKey, {
                status: 'completed',
                completedAt: Date.now(),
                counts: counts,
                error: null
            });
            if (counts.metadataSnapshots || counts.components || counts.syncJobs) {
                console.log('[CSH] cache maintenance pruned', counts);
            }
            setStatusPanel('cache maintenance complete', 'done');
            setTimeout(function () { setStatusPanel(''); }, 2500);
        } catch (e) {
            await window.cshDb.putSyncJob(jobKey, {
                status: 'failed',
                failedAt: Date.now(),
                error: (e && e.message) || String(e)
            });
            console.warn('[CSH] cache maintenance failed:', e && e.message);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            seedCache();
            installListObserver();
            setTimeout(syncCommonComponentCatalog, 1000);
            setTimeout(syncVisibleChangeSetMemberships, 2500);
            setTimeout(function () { scheduleListRefresh(0); }, 8000);
            setTimeout(runCacheMaintenance, 5000);
        }, { once: true });
    } else {
        seedCache();
        installListObserver();
        setTimeout(syncCommonComponentCatalog, 1000);
        setTimeout(syncVisibleChangeSetMemberships, 2500);
        setTimeout(function () { scheduleListRefresh(0); }, 8000);
        setTimeout(runCacheMaintenance, 5000);
    }
})();
