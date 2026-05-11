// ---------------------------------------------------------------------------
// Change Set Helper - shared IndexedDB cache
//
// This is the unified local metadata store used across Add Components,
// Change Set Details, and future Compare flows. It is deliberately best-effort:
// feature code should write through to it, but user actions must not depend on
// IndexedDB being available.
// ---------------------------------------------------------------------------
(function () {
    'use strict';

    var DB_NAME = 'cshIndexedCache';
    var DB_VERSION = 1;
    var dbPromise = null;
    var ORG_ID_MAP_KEY = 'cshOrgIdByOrigin';
    var resolvedOrgIds = {};
    var orgIdMapPromise = null;

    function canonicalOrgOrigin(value) {
        var raw = value || location.origin || location.host || 'unknown';
        try {
            var url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(location.protocol + '//' + raw);
            var host = url.host.toLowerCase();
            host = host.replace(/\.salesforce-setup\.com$/i, '.salesforce.com');
            host = host.replace(/\.lightning\.force\.com$/i, '.my.salesforce.com');
            return url.protocol + '//' + host;
        } catch (_) {
            return String(raw)
                .replace(/\.salesforce-setup\.com/i, '.salesforce.com')
                .replace(/\.lightning\.force\.com/i, '.my.salesforce.com');
        }
    }

    function orgId(opts) {
        opts = opts || {};
        var fallbackServerUrl = (typeof serverUrl !== 'undefined') ? serverUrl : location.origin;
        var origin = canonicalOrgOrigin(
            (window.cshSession && window.cshSession.instanceUrl && window.cshSession.instanceUrl()) ||
            fallbackServerUrl || location.origin || location.host || 'unknown'
        );
        return opts.orgId || resolvedOrgIds[origin] || origin;
    }

    function loadResolvedOrgIds() {
        if (orgIdMapPromise) return orgIdMapPromise;
        orgIdMapPromise = new Promise(function (resolve) {
        try {
            if (!chrome || !chrome.storage || !chrome.storage.local) {
                resolve(resolvedOrgIds);
                return;
            }
            chrome.storage.local.get([ORG_ID_MAP_KEY], function (items) {
                if (chrome.runtime && chrome.runtime.lastError) {
                    resolve(resolvedOrgIds);
                    return;
                }
                resolvedOrgIds = (items && items[ORG_ID_MAP_KEY]) || {};
                resolve(resolvedOrgIds);
            });
        } catch (_) {
            resolve(resolvedOrgIds);
        }
        });
        return orgIdMapPromise;
    }

    async function rememberOrgId(orgIdValue, originValue) {
        if (!orgIdValue) return null;
        var origin = canonicalOrgOrigin(originValue || (typeof serverUrl !== 'undefined' ? serverUrl : location.origin));
        resolvedOrgIds[origin] = orgIdValue;
        try {
            if (chrome && chrome.storage && chrome.storage.local) {
                await new Promise(function (resolve) {
                    chrome.storage.local.get([ORG_ID_MAP_KEY], function (items) {
                        var map = (items && items[ORG_ID_MAP_KEY]) || {};
                        map[origin] = orgIdValue;
                        chrome.storage.local.set({ [ORG_ID_MAP_KEY]: map }, resolve);
                    });
                });
            }
        } catch (_) {}
        return orgIdValue;
    }

    function id15(id) {
        return id ? String(id).slice(0, 15) : '';
    }

    function componentKey(org, type, id, fullName) {
        return [org, type || '', id15(id) || fullName || ''].join('::');
    }

    function changeSetKey(org, changeSetId) {
        return [org, changeSetId || ''].join('::');
    }

    function memberKey(org, changeSetId, type, id, fullName) {
        return [changeSetKey(org, changeSetId), type || '', id15(id) || fullName || ''].join('::');
    }

    function requestToPromise(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('IndexedDB request failed')); };
        });
    }

    function txDone(tx) {
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
            tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
        });
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB is not available'));
                return;
            }
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('orgs')) {
                    db.createObjectStore('orgs', { keyPath: 'orgId' });
                }
                if (!db.objectStoreNames.contains('components')) {
                    var components = db.createObjectStore('components', { keyPath: 'key' });
                    components.createIndex('orgIdType', ['orgId', 'type'], { unique: false });
                    components.createIndex('orgIdTypeFullName', ['orgId', 'type', 'fullName'], { unique: false });
                    components.createIndex('lastSeenAt', 'lastSeenAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('changeSets')) {
                    var changeSets = db.createObjectStore('changeSets', { keyPath: 'key' });
                    changeSets.createIndex('orgId', 'orgId', { unique: false });
                    changeSets.createIndex('packageId', 'packageId', { unique: false });
                }
                if (!db.objectStoreNames.contains('changeSetMembers')) {
                    var members = db.createObjectStore('changeSetMembers', { keyPath: 'key' });
                    members.createIndex('changeSetKey', 'changeSetKey', { unique: false });
                    members.createIndex('status', 'status', { unique: false });
                    members.createIndex('componentKey', 'componentKey', { unique: false });
                }
                if (!db.objectStoreNames.contains('metadataSnapshots')) {
                    var snapshots = db.createObjectStore('metadataSnapshots', { keyPath: 'key' });
                    snapshots.createIndex('componentKey', 'componentKey', { unique: false });
                    snapshots.createIndex('retrievedAt', 'retrievedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('syncJobs')) {
                    db.createObjectStore('syncJobs', { keyPath: 'key' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
        });
        return dbPromise;
    }

    async function upsertOrg(record) {
        await loadResolvedOrgIds();
        var db = await openDb();
        var now = Date.now();
        var org = Object.assign({
            orgId: orgId(record),
            instanceUrl: (typeof serverUrl !== 'undefined' ? serverUrl : location.origin) || location.origin,
            host: location.host,
            lastSeenAt: now
        }, record || {});
        var tx = db.transaction(['orgs'], 'readwrite');
        tx.objectStore('orgs').put(org);
        await txDone(tx);
        return org;
    }

    async function upsertComponents(records, opts) {
        opts = opts || {};
        if (!records || !records.length) return 0;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        var tx = db.transaction(['components'], 'readwrite');
        var store = tx.objectStore('components');
        var count = 0;
        records.forEach(function (rec) {
            if (!rec) return;
            var type = rec.type || rec.metadataType || opts.type;
            var id = rec.id || rec.salesforceId;
            var fullName = rec.fullName || rec.name;
            if (!type || (!id && !fullName)) return;
            var row = {
                key: componentKey(org, type, id, fullName),
                orgId: org,
                type: type,
                id: id15(id) || null,
                name: rec.name || fullName || id || '',
                fullName: fullName || rec.name || id || '',
                namespacePrefix: rec.namespacePrefix || rec.namespace || null,
                manageableState: rec.manageableState || null,
                lastModifiedDate: rec.lastModifiedDate || null,
                lastModifiedByName: rec.lastModifiedByName || rec.lastModifiedBy || null,
                createdDate: rec.createdDate || null,
                createdByName: rec.createdByName || null,
                source: opts.source || rec.source || 'unknown',
                lastSeenAt: now
            };
            store.put(row);
            count++;
        });
        await txDone(tx);
        return count;
    }

    async function getComponentsByType(type, opts) {
        opts = opts || {};
        if (!type) return [];
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var tx = db.transaction(['components'], 'readonly');
        var idx = tx.objectStore('components').index('orgIdType');
        var rows = await requestToPromise(idx.getAll([org, type]));
        await txDone(tx);
        return rows || [];
    }

    async function upsertChangeSets(records, opts) {
        opts = opts || {};
        if (!records || !records.length) return 0;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        var existing = {};
        var readTx = db.transaction(['changeSets'], 'readonly');
        var currentRows = await requestToPromise(readTx.objectStore('changeSets').getAll());
        await txDone(readTx);
        (currentRows || []).forEach(function (row) {
            if (row && row.key) existing[row.key] = row;
        });
        var tx = db.transaction(['changeSets'], 'readwrite');
        var store = tx.objectStore('changeSets');
        var count = 0;
        records.forEach(function (rec) {
            if (!rec || !rec.changeSetId) return;
            var key = changeSetKey(org, rec.changeSetId);
            var prior = existing[key] || {};
            store.put(Object.assign({}, prior, {
                key: changeSetKey(org, rec.changeSetId),
                orgId: org,
                changeSetId: rec.changeSetId,
                packageId: rec.packageId || prior.packageId || null,
                name: rec.name || '',
                source: opts.source || rec.source || 'unknown',
                lastSeenAt: now
            }, rec));
            count++;
        });
        await txDone(tx);
        return count;
    }

    async function getChangeSet(changeSetId, opts) {
        opts = opts || {};
        if (!changeSetId) return null;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var tx = db.transaction(['changeSets'], 'readonly');
        var row = await requestToPromise(tx.objectStore('changeSets').get(changeSetKey(org, changeSetId)));
        await txDone(tx);
        return row || null;
    }

    async function markChangeSetsUsed(changeSetIds, opts) {
        opts = opts || {};
        if (!Array.isArray(changeSetIds)) changeSetIds = [changeSetIds];
        changeSetIds = changeSetIds.filter(Boolean);
        if (!changeSetIds.length) return 0;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        var existing = {};
        var readTx = db.transaction(['changeSets'], 'readonly');
        var currentRows = await requestToPromise(readTx.objectStore('changeSets').getAll());
        await txDone(readTx);
        (currentRows || []).forEach(function (row) {
            if (row && row.key) existing[row.key] = row;
        });

        var tx = db.transaction(['changeSets'], 'readwrite');
        var store = tx.objectStore('changeSets');
        changeSetIds.forEach(function (csId) {
            var key = changeSetKey(org, csId);
            var row = existing[key] || {
                key: key,
                orgId: org,
                changeSetId: csId,
                packageId: null,
                name: '',
                source: opts.source || 'change-set-use',
                lastSeenAt: now
            };
            row.lastUsedAt = now;
            row.source = opts.source || row.source || 'change-set-use';
            row.updatedAt = now;
            store.put(row);
        });
        await txDone(tx);
        return changeSetIds.length;
    }

    async function upsertChangeSetMembers(changeSetIds, items, opts) {
        opts = opts || {};
        if (!Array.isArray(changeSetIds)) changeSetIds = [changeSetIds];
        changeSetIds = changeSetIds.filter(Boolean);
        if (!changeSetIds.length || !items || !items.length) return 0;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        var tx = db.transaction(['components', 'changeSetMembers'], 'readwrite');
        var componentStore = tx.objectStore('components');
        var memberStore = tx.objectStore('changeSetMembers');
        var count = 0;
        var presentByChangeSet = {};

        changeSetIds.forEach(function (csId) {
            presentByChangeSet[changeSetKey(org, csId)] = {};
        });

        items.forEach(function (item) {
            if (!item || !item.type || (!item.id && !item.fullName && !item.name)) return;
            var id = item.id || item.salesforceId;
            var fullName = item.fullName || (item.extra && item.extra.fullName) || item.name || id;
            var cKey = componentKey(org, item.type, id, fullName);
            componentStore.put({
                key: cKey,
                orgId: org,
                type: item.type,
                id: id15(id) || null,
                name: item.name || fullName || id || '',
                fullName: fullName || item.name || id || '',
                lastModifiedDate: item.lastModifiedDate || null,
                lastModifiedByName: item.lastModifiedByName || null,
                source: opts.source || item.source || 'change-set-sync',
                lastSeenAt: now
            });
            changeSetIds.forEach(function (csId) {
                var csKey = changeSetKey(org, csId);
                var mKey = memberKey(org, csId, item.type, id, fullName);
                presentByChangeSet[csKey][mKey] = true;
                memberStore.put({
                    key: mKey,
                    orgId: org,
                    changeSetKey: csKey,
                    changeSetId: csId,
                    componentKey: cKey,
                    type: item.type,
                    componentId: id15(id) || null,
                    fullName: fullName || null,
                    name: item.name || fullName || id || '',
                    status: opts.status || 'present',
                    removeHref: item.removeHref || (item.extra && item.extra.removeHref) || null,
                    source: opts.source || item.source || 'change-set-sync',
                    lastSeenAt: now
                });
                count++;
            });
        });

        await txDone(tx);

        if (opts.authoritative) {
            await markMissingMembersRemoved(changeSetIds, presentByChangeSet, opts);
        }
        return count;
    }

    async function getChangeSetMembers(changeSetId, opts) {
        opts = opts || {};
        if (!changeSetId) return [];
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var csKey = changeSetKey(org, changeSetId);
        var tx = db.transaction(['changeSetMembers'], 'readonly');
        var idx = tx.objectStore('changeSetMembers').index('changeSetKey');
        var rows = await requestToPromise(idx.getAll(csKey));
        await txDone(tx);
        if (opts.status) {
            rows = rows.filter(function (row) { return row.status === opts.status; });
        }
        return rows || [];
    }

    async function deleteChangeSetMembers(changeSetIds, opts) {
        opts = opts || {};
        if (!Array.isArray(changeSetIds)) changeSetIds = [changeSetIds];
        changeSetIds = changeSetIds.filter(Boolean);
        if (!changeSetIds.length) return 0;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var deleted = 0;
        for (var i = 0; i < changeSetIds.length; i++) {
            var csKey = changeSetKey(org, changeSetIds[i]);
            var readTx = db.transaction(['changeSetMembers'], 'readonly');
            var idx = readTx.objectStore('changeSetMembers').index('changeSetKey');
            var rows = await requestToPromise(idx.getAll(csKey));
            await txDone(readTx);
            if (!rows.length) continue;
            var tx = db.transaction(['changeSetMembers'], 'readwrite');
            var store = tx.objectStore('changeSetMembers');
            rows.forEach(function (row) {
                store.delete(row.key);
                deleted++;
            });
            await txDone(tx);
        }
        return deleted;
    }

    async function deleteSyncJob(key) {
        if (!key) return;
        var db = await openDb();
        var tx = db.transaction(['syncJobs'], 'readwrite');
        tx.objectStore('syncJobs').delete(key);
        await txDone(tx);
    }

    async function markMissingMembersRemoved(changeSetIds, presentByChangeSet, opts) {
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        for (var i = 0; i < changeSetIds.length; i++) {
            var csKey = changeSetKey(org, changeSetIds[i]);
            var readTx = db.transaction(['changeSetMembers'], 'readonly');
            var idx = readTx.objectStore('changeSetMembers').index('changeSetKey');
            var rows = await requestToPromise(idx.getAll(csKey));
            await txDone(readTx);
            var tx = db.transaction(['changeSetMembers'], 'readwrite');
            var store = tx.objectStore('changeSetMembers');
            rows.forEach(function (row) {
                if (row.status !== 'present') return;
                if (presentByChangeSet[csKey] && presentByChangeSet[csKey][row.key]) return;
                row.status = 'removed';
                row.removedAt = now;
                row.source = opts.source || row.source || 'authoritative-sync';
                store.put(row);
            });
            await txDone(tx);
        }
    }

    async function markMembers(changeSetId, items, status, opts) {
        opts = Object.assign({}, opts || {}, { status: status || 'present' });
        return upsertChangeSetMembers([changeSetId], items, opts);
    }

    async function upsertMetadataSnapshot(snapshot, opts) {
        opts = opts || {};
        if (!snapshot || (!snapshot.id && !snapshot.fullName) || !snapshot.type) return null;
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        var cKey = componentKey(org, snapshot.type, snapshot.id, snapshot.fullName);
        var key = [cKey, snapshot.side || opts.side || 'local'].join('::');
        var tx = db.transaction(['metadataSnapshots'], 'readwrite');
        tx.objectStore('metadataSnapshots').put(Object.assign({}, snapshot, {
            key: key,
            orgId: org,
            componentKey: cKey,
            retrievedAt: now,
            source: opts.source || snapshot.source || 'metadata-retrieve'
        }));
        await txDone(tx);
        return key;
    }

    async function getSyncJob(key) {
        if (!key) return null;
        var db = await openDb();
        var tx = db.transaction(['syncJobs'], 'readonly');
        var row = await requestToPromise(tx.objectStore('syncJobs').get(key));
        await txDone(tx);
        return row || null;
    }

    async function putSyncJob(key, patch) {
        if (!key) return null;
        var db = await openDb();
        var existing = await getSyncJob(key);
        var tx = db.transaction(['syncJobs'], 'readwrite');
        var store = tx.objectStore('syncJobs');
        var row = Object.assign({}, existing || { key: key, createdAt: Date.now() }, patch || {}, {
            key: key,
            updatedAt: Date.now()
        });
        store.put(row);
        await txDone(tx);
        return row;
    }

    async function shouldRunSyncJob(key, freshMs, runningTtlMs) {
        var now = Date.now();
        var job = await getSyncJob(key);
        if (job && job.status === 'running' && job.startedAt && (now - job.startedAt) < runningTtlMs) {
            return { run: false, reason: 'running', job: job };
        }
        if (job && job.status === 'completed' && job.completedAt && (now - job.completedAt) < freshMs) {
            return { run: false, reason: 'fresh', job: job };
        }
        await putSyncJob(key, { status: 'running', startedAt: now, error: null });
        return { run: true, job: await getSyncJob(key) };
    }

    async function prune(opts) {
        opts = opts || {};
        await loadResolvedOrgIds();
        var db = await openDb();
        var org = orgId(opts);
        var now = Date.now();
        var snapshotCutoff = now - (opts.snapshotMaxAgeMs || 7 * 24 * 60 * 60 * 1000);
        var componentCutoff = now - (opts.componentMaxAgeMs || 30 * 24 * 60 * 60 * 1000);
        var changeSetCutoff = now - (opts.changeSetMaxUnusedMs || 30 * 24 * 60 * 60 * 1000);
        var jobCutoff = now - (opts.jobMaxAgeMs || 7 * 24 * 60 * 60 * 1000);
        var counts = { metadataSnapshots: 0, components: 0, changeSetMembers: 0, syncJobs: 0 };
        function matchesOrg(row) {
            return opts.allOrgs || (row && row.orgId === org);
        }
        function jobMatchesOrg(job) {
            return opts.allOrgs || (job && job.key && job.key.indexOf('::' + org + '::') !== -1);
        }

        var referencedComponents = {};
        var memberTx = db.transaction(['changeSetMembers'], 'readonly');
        await new Promise(function (resolve, reject) {
            var req = memberTx.objectStore('changeSetMembers').openCursor();
            req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
            req.onsuccess = function () {
                var cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                var member = cursor.value;
                if (matchesOrg(member) && member.componentKey) {
                    referencedComponents[member.componentKey] = (referencedComponents[member.componentKey] || 0) + 1;
                }
                cursor.continue();
            };
        });
        await txDone(memberTx);

        function unreferenceComponent(componentKey) {
            if (componentKey && referencedComponents[componentKey]) {
                referencedComponents[componentKey]--;
                if (referencedComponents[componentKey] <= 0) {
                    delete referencedComponents[componentKey];
                }
            }
        }

        var jobsToDelete = [];
        var staleChangeSetKeys = {};
        var changeSetReadTx = db.transaction(['changeSets'], 'readonly');
        var staleChangeSetUpdates = [];
        await new Promise(function (resolve, reject) {
            var req = changeSetReadTx.objectStore('changeSets').openCursor();
            req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
            req.onsuccess = function () {
                var cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                var cs = cursor.value;
                if (matchesOrg(cs)) {
                    var lastUsed = cs.lastUsedAt || cs.lastOpenedAt || cs.lastSeenAt || 0;
                    if (lastUsed && lastUsed < changeSetCutoff) {
                        staleChangeSetKeys[cs.key] = true;
                        jobsToDelete.push('change-set-members::' + cs.orgId + '::' + cs.changeSetId);
                        if (cs.packageId) {
                            staleChangeSetKeys[changeSetKey(cs.orgId, cs.packageId)] = true;
                            jobsToDelete.push('change-set-members::' + cs.orgId + '::' + cs.packageId);
                        }
                        cs.memberCacheClearedAt = now;
                        cs.updatedAt = now;
                        staleChangeSetUpdates.push(cs);
                    }
                }
                cursor.continue();
            };
        });
        await txDone(changeSetReadTx);
        if (staleChangeSetUpdates.length) {
            var changeSetTx = db.transaction(['changeSets'], 'readwrite');
            var changeSetStore = changeSetTx.objectStore('changeSets');
            staleChangeSetUpdates.forEach(function (cs) { changeSetStore.put(cs); });
            await txDone(changeSetTx);
        }

        if (Object.keys(staleChangeSetKeys).length) {
            var staleMemberTx = db.transaction(['changeSetMembers'], 'readwrite');
            await new Promise(function (resolve, reject) {
                var req = staleMemberTx.objectStore('changeSetMembers').openCursor();
                req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
                req.onsuccess = function () {
                    var cursor = req.result;
                    if (!cursor) {
                        resolve();
                        return;
                    }
                    var member = cursor.value;
                    if (matchesOrg(member) && staleChangeSetKeys[member.changeSetKey]) {
                        cursor.delete();
                        counts.changeSetMembers++;
                        unreferenceComponent(member.componentKey);
                    }
                    cursor.continue();
                };
            });
            await txDone(staleMemberTx);
        }

        var snapshotTx = db.transaction(['metadataSnapshots'], 'readwrite');
        var snapshotIdx = snapshotTx.objectStore('metadataSnapshots').index('retrievedAt');
        await new Promise(function (resolve, reject) {
            var req = snapshotIdx.openCursor(IDBKeyRange.upperBound(snapshotCutoff));
            req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
            req.onsuccess = function () {
                var cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                if (matchesOrg(cursor.value)) {
                    cursor.delete();
                    counts.metadataSnapshots++;
                }
                cursor.continue();
            };
        });
        await txDone(snapshotTx);

        var componentTx = db.transaction(['components'], 'readwrite');
        var componentIdx = componentTx.objectStore('components').index('lastSeenAt');
        await new Promise(function (resolve, reject) {
            var req = componentIdx.openCursor(IDBKeyRange.upperBound(componentCutoff));
            req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
            req.onsuccess = function () {
                var cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                var value = cursor.value;
                if (matchesOrg(value) && !referencedComponents[value.key]) {
                    cursor.delete();
                    counts.components++;
                }
                cursor.continue();
            };
        });
        await txDone(componentTx);

        var jobsTx = db.transaction(['syncJobs'], 'readonly');
        await new Promise(function (resolve, reject) {
            var req = jobsTx.objectStore('syncJobs').openCursor();
            req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
            req.onsuccess = function () {
                var cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                var job = cursor.value;
                if (job && job.key && jobMatchesOrg(job)) {
                    var staleTime = job.completedAt || job.failedAt || job.updatedAt || job.createdAt || 0;
                    if (staleTime && staleTime < jobCutoff && job.status !== 'running') {
                        jobsToDelete.push(job.key);
                    }
                }
                cursor.continue();
            };
        });
        await txDone(jobsTx);
        if (jobsToDelete.length) {
            var deleteJobsTx = db.transaction(['syncJobs'], 'readwrite');
            var jobStore = deleteJobsTx.objectStore('syncJobs');
            jobsToDelete.forEach(function (key) {
                jobStore.delete(key);
                counts.syncJobs++;
            });
            await txDone(deleteJobsTx);
        }

        return counts;
    }

    window.cshDb = {
        open: openDb,
        ready: loadResolvedOrgIds,
        orgId: orgId,
        rememberOrgId: rememberOrgId,
        upsertOrg: upsertOrg,
        upsertComponents: upsertComponents,
        getComponentsByType: getComponentsByType,
        upsertChangeSets: upsertChangeSets,
        getChangeSet: getChangeSet,
        markChangeSetsUsed: markChangeSetsUsed,
        upsertChangeSetMembers: upsertChangeSetMembers,
        getChangeSetMembers: getChangeSetMembers,
        deleteChangeSetMembers: deleteChangeSetMembers,
        markMembers: markMembers,
        upsertMetadataSnapshot: upsertMetadataSnapshot,
        getSyncJob: getSyncJob,
        putSyncJob: putSyncJob,
        deleteSyncJob: deleteSyncJob,
        shouldRunSyncJob: shouldRunSyncJob,
        prune: prune
    };
    loadResolvedOrgIds();
})();
