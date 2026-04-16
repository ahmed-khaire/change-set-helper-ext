// ---------------------------------------------------------------------------
// Change Set Helper — shared runtime
// Loaded BEFORE every page-specific script (changeset.js, deployhelper.js, etc.)
// so we have a single place to do jQuery isolation, toast UI, and API-version
// discovery.
// ---------------------------------------------------------------------------

// 1) jQuery isolation.
//    Even though content scripts live in their own "isolated world" and do not
//    normally leak jQuery into Salesforce's page context, calling noConflict
//    here is cheap defensive hardening: it guarantees we never clobber a $ /
//    jQuery that some other well-intentioned extension also injected.
//    We re-attach to window so every script that loads after us still sees $.
if (typeof window !== 'undefined' && window.jQuery && typeof window.jQuery.noConflict === 'function') {
    try {
        var __cshJQ = window.jQuery.noConflict(true);
        window.$ = __cshJQ;
        window.jQuery = __cshJQ;
        window.cshJQ = __cshJQ;
    } catch (e) {
        // If noConflict is unavailable for any reason, fall back to whatever $ is present.
        console.warn('Change Set Helper: jQuery.noConflict failed, continuing with default $', e);
    }
}

// 2) Session context.
//    Fast path: read sid from document.cookie (works when the org has
//    HttpOnly off). Fallback path: ask the service worker to read via
//    chrome.cookies.get, which sees HttpOnly cookies. Callers that run
//    synchronously (the legacy `if (sessionId) { ... }` gates) use the
//    fast-path value; anything that kicks off network work should await
//    window.cshSession.ready to catch the async-resolved value.
var sessionId = (function () {
    var m = document.cookie.match('sid=([^;]*)');
    return m ? m[1] : null;
})();
var serverUrl = window.location.protocol + '//' + window.location.host;

window.cshSession = (function () {
    // Auth ladder:
    //   1. document.cookie    (fast path, works when HttpOnly is off)
    //   2. chrome.cookies.get (Phase 2.4, works even with HttpOnly on)
    //   3. OAuth access token (Phase 4, runs when cookies are unavailable)
    // Every Promise step resolves to an auth value (sid OR accessToken) or
    // null when nothing is usable; final `null` triggers the content script's
    // "Sign in via OAuth" banner.
    var state = {
        mode: sessionId ? 'sid' : null,
        instanceUrl: serverUrl,
        oauthRefreshed: false
    };

    function askBackgroundForCookie() {
        return new Promise(function (resolve) {
            if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
            chrome.runtime.sendMessage(
                { type: 'getSessionCookie', url: window.location.href },
                function (response) {
                    if (chrome.runtime.lastError) {
                        console.warn('cshSession: background fallback failed:', chrome.runtime.lastError.message);
                        return resolve(null);
                    }
                    if (response && response.sid) {
                        sessionId = response.sid;
                        state.mode = 'sid';
                        return resolve(response.sid);
                    }
                    resolve(null);
                }
            );
        });
    }

    function askBackgroundForOauthToken() {
        return new Promise(function (resolve) {
            if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
            chrome.runtime.sendMessage(
                { type: 'cshAuthGetToken', host: serverUrl },
                function (response) {
                    if (chrome.runtime.lastError) {
                        console.warn('cshSession: OAuth fallback errored:', chrome.runtime.lastError.message);
                        return resolve(null);
                    }
                    if (response && response.ok && response.accessToken) {
                        sessionId = response.accessToken;
                        state.mode = 'oauth';
                        state.instanceUrl = response.instanceUrl || serverUrl;
                        state.oauthRefreshed = !!response.refreshed;
                        return resolve(response.accessToken);
                    }
                    resolve(null);
                }
            );
        });
    }

    var readyPromise = sessionId
        ? Promise.resolve(sessionId)
        : askBackgroundForCookie().then(function (cookieSid) {
            if (cookieSid) return cookieSid;
            return askBackgroundForOauthToken();
        });

    return {
        ready: readyPromise,
        // Returns the current session value synchronously; may be null until
        // ready resolves. Works for sid and OAuth access-token modes alike.
        current: function () { return sessionId; },
        // 'sid' | 'oauth' | null — tells downstream connect() calls which
        // JSforce configuration to use (sessionId+serverUrl vs accessToken+instanceUrl).
        mode: function () { return state.mode; },
        instanceUrl: function () { return state.instanceUrl; }
    };
})();

// Phase 4: cshAuth — thin wrapper over the service worker's OAuth helpers.
//   login()    -> launches PKCE flow, stores {accessToken, refreshToken}
//   logout()   -> clears stored tokens for this host
//   getAccessToken({forceRefresh}) -> returns fresh access token (may refresh)
// All round-trip to chrome.runtime.sendMessage so interactive browser
// auth (chrome.identity.launchWebAuthFlow) happens in the correct context.
window.cshAuth = (function () {
    function callBackground(payload) {
        return new Promise(function (resolve) {
            if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return resolve({ ok: false, error: 'No chrome.runtime' });
            chrome.runtime.sendMessage(payload, function (response) {
                if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
                resolve(response || { ok: false, error: 'No response' });
            });
        });
    }

    async function login() {
        var resp = await callBackground({ type: 'cshAuthLogin', host: serverUrl });
        if (resp && resp.ok && resp.accessToken) {
            sessionId = resp.accessToken; // propagate so legacy readers see it
        }
        return resp;
    }

    async function logout() {
        var resp = await callBackground({ type: 'cshAuthLogout', host: serverUrl });
        return resp;
    }

    async function getAccessToken(opts) {
        opts = opts || {};
        var resp = await callBackground({
            type: 'cshAuthGetToken',
            host: serverUrl,
            forceRefresh: !!opts.forceRefresh
        });
        return resp;
    }

    return {
        login: login,
        logout: logout,
        getAccessToken: getAccessToken
    };
})();

// 3) Lightweight SLDS-styled toast, used in place of alert().
//    window.cshToast.show(message, { type: 'error' | 'warning' | 'success' | 'info', duration })
(function () {
    var COLOURS = {
        error:   { bg: '#ba0517', fg: '#ffffff', border: '#8e0916' },
        warning: { bg: '#fe9339', fg: '#1b1b1b', border: '#d5721c' },
        success: { bg: '#2e844a', fg: '#ffffff', border: '#22633a' },
        info:    { bg: '#0176d3', fg: '#ffffff', border: '#014486' }
    };

    function ensureStage() {
        var stage = document.getElementById('csh-toast-stage');
        if (!stage) {
            stage = document.createElement('div');
            stage.id = 'csh-toast-stage';
            stage.style.cssText = [
                'position:fixed',
                'top:16px',
                'right:16px',
                'z-index:2147483646',
                'display:flex',
                'flex-direction:column',
                'gap:8px',
                'pointer-events:none',
                'max-width:min(480px, 90vw)'
            ].join(';');
            document.body.appendChild(stage);
        }
        return stage;
    }

    function show(message, opts) {
        opts = opts || {};
        var type = COLOURS[opts.type] ? opts.type : 'info';
        var palette = COLOURS[type];
        var duration = typeof opts.duration === 'number' ? opts.duration : (type === 'error' ? 0 : 6000);

        var stage = ensureStage();
        var toast = document.createElement('div');
        toast.style.cssText = [
            'background:' + palette.bg,
            'color:' + palette.fg,
            'border:1px solid ' + palette.border,
            'border-radius:4px',
            'padding:12px 14px',
            'font:13px/1.4 "Salesforce Sans", Arial, sans-serif',
            'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
            'display:flex',
            'align-items:flex-start',
            'gap:10px',
            'pointer-events:auto',
            'opacity:0',
            'transform:translateY(-4px)',
            'transition:opacity 160ms ease, transform 160ms ease'
        ].join(';');

        var icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.style.cssText = 'flex:0 0 auto;font-weight:700;line-height:1;padding-top:1px;';
        icon.textContent = type === 'error' ? '⛔' : type === 'warning' ? '⚠️' : type === 'success' ? '✔' : 'ℹ';

        var body = document.createElement('div');
        body.style.cssText = 'flex:1 1 auto;white-space:pre-wrap;word-break:break-word;';
        body.textContent = String(message);

        var close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '×';
        close.style.cssText = [
            'flex:0 0 auto',
            'background:transparent',
            'border:0',
            'color:inherit',
            'font-size:18px',
            'line-height:1',
            'cursor:pointer',
            'padding:0 4px'
        ].join(';');

        toast.appendChild(icon);
        toast.appendChild(body);
        toast.appendChild(close);
        stage.appendChild(toast);

        requestAnimationFrame(function () {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        function dismiss() {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-4px)';
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 180);
        }

        close.addEventListener('click', dismiss);
        if (duration > 0) setTimeout(dismiss, duration);
        return { dismiss: dismiss };
    }

    window.cshToast = { show: show };
})();

// 4) Dynamic Salesforce API version discovery.
//    Hits /services/data/ on the current host and picks the highest supported
//    version. Cached per-host in chrome.storage.local for 24h so we don't
//    round-trip every page load. Falls back to stored sync pref, then to 60.0.
(function () {
    var FALLBACK = '60.0';
    var CACHE_KEY = 'cshApiVersionCache';
    var CACHE_TTL_MS = 24 * 60 * 60 * 1000;

    function pickHighest(list) {
        if (!Array.isArray(list) || list.length === 0) return null;
        var best = null;
        for (var i = 0; i < list.length; i++) {
            var v = parseFloat(list[i] && list[i].version);
            if (!isNaN(v) && (best === null || v > best)) best = v;
        }
        return best !== null ? best.toFixed(1) : null;
    }

    function readCache(host) {
        return new Promise(function (resolve) {
            if (!chrome.storage || !chrome.storage.local) return resolve(null);
            chrome.storage.local.get([CACHE_KEY], function (items) {
                var cache = items[CACHE_KEY] || {};
                var entry = cache[host];
                if (entry && entry.version && entry.at && (Date.now() - entry.at) < CACHE_TTL_MS) {
                    resolve(entry.version);
                } else {
                    resolve(null);
                }
            });
        });
    }

    function writeCache(host, version) {
        if (!chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.get([CACHE_KEY], function (items) {
            var cache = items[CACHE_KEY] || {};
            cache[host] = { version: version, at: Date.now() };
            chrome.storage.local.set({ [CACHE_KEY]: cache });
        });
    }

    function probe(host) {
        return fetch(host + '/services/data/', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(pickHighest)
            .catch(function () { return null; });
    }

    function readSyncPref() {
        return new Promise(function (resolve) {
            if (!chrome.storage || !chrome.storage.sync) return resolve(null);
            chrome.storage.sync.get(['salesforceApiVersion'], function (items) {
                resolve(items && items.salesforceApiVersion ? items.salesforceApiVersion : null);
            });
        });
    }

    async function resolveApiVersion() {
        var host = serverUrl;
        var cached = await readCache(host);
        if (cached) return cached;

        var probed = await probe(host);
        if (probed) {
            writeCache(host, probed);
            return probed;
        }

        var pref = await readSyncPref();
        return pref || FALLBACK;
    }

    window.cshApiVersion = {
        fallback: FALLBACK,
        resolve: resolveApiVersion
    };

    // Kick off discovery on script load and publish the result so the service
    // worker / offscreen document can pick it up via chrome.storage.local.
    // The user's explicit preference in chrome.storage.sync always wins — we
    // only populate the local cache as a fallback.
    resolveApiVersion().then(function (version) {
        if (!version) return;
        window.cshApiVersion.resolved = version;
        if (!chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.set({ cshResolvedApiVersion: version });
    }).catch(function () { /* ignore — background falls back to 60.0 */ });
})();

// 5) describeMetadata cache + dynamic entity-type resolver.
//    The Salesforce UI enumeration in the Component Type picker drifts between
//    releases — every new release adds types we'd otherwise have to hard-code.
//    Caching the result of `conn.metadata.describe(apiVersion)` lets us answer
//    "is this a valid metadata type" from a live source of truth. We still
//    apply a small override map for types whose UI name differs from the API
//    name (TabSet → CustomApplication, ValidationFormula → ValidationRule …).
(function () {
    var CACHE_KEY = 'cshMetadataDescribe';
    var TTL_MS = 24 * 60 * 60 * 1000;

    function cacheKey(host, apiVersion) {
        return host + '|' + (apiVersion || 'latest');
    }

    function readCache() {
        return new Promise(function (resolve) {
            if (!chrome.storage || !chrome.storage.local) return resolve(null);
            chrome.storage.local.get([CACHE_KEY], function (items) {
                var cache = items[CACHE_KEY] || {};
                var apiVersion = (window.cshApiVersion && window.cshApiVersion.resolved) || 'latest';
                var entry = cache[cacheKey(serverUrl, apiVersion)];
                if (entry && entry.at && (Date.now() - entry.at) < TTL_MS) {
                    resolve(entry.data);
                } else {
                    resolve(null);
                }
            });
        });
    }

    function writeCache(data) {
        if (!chrome.storage || !chrome.storage.local) return;
        var apiVersion = (window.cshApiVersion && window.cshApiVersion.resolved) || 'latest';
        var key = cacheKey(serverUrl, apiVersion);
        chrome.storage.local.get([CACHE_KEY], function (items) {
            var cache = items[CACHE_KEY] || {};
            cache[key] = { at: Date.now(), data: data };
            chrome.storage.local.set({ [CACHE_KEY]: cache });
        });
    }

    function fetchDescribe() {
        return new Promise(function (resolve) {
            if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
            chrome.runtime.sendMessage({ proxyFunction: 'describeLocalMetadata' }, function (response) {
                if (chrome.runtime.lastError) {
                    console.warn('cshMetadata.fetchDescribe: runtime error', chrome.runtime.lastError.message);
                    return resolve(null);
                }
                if (!response || response.err || !response.results) {
                    console.warn('cshMetadata.fetchDescribe: no results', response && response.err);
                    return resolve(null);
                }
                resolve(response.results);
            });
        });
    }

    // Returns the cached describeMetadata result, or null if the cache is cold
    // or expired. Does NOT hit the network — call warmDescribeCache() after a
    // successful JSforce connect to refresh the cache without blocking UI.
    async function getDescribe() {
        return await readCache();
    }

    // Fetches describeMetadata via the offscreen JSforce connection and writes
    // it to cache. Must be called only AFTER connectToLocal has succeeded,
    // otherwise the offscreen document has no connection to use.
    async function warmDescribeCache() {
        var cached = await readCache();
        if (cached) return cached;
        var fresh = await fetchDescribe();
        if (fresh) writeCache(fresh);
        return fresh;
    }

    // Resolve a Salesforce UI entity name (what appears in the #entityType
    // hidden field) to a Metadata API type name.
    //   1. override map: hardcoded translations for UI names that differ from
    //      API names (stable, small).
    //   2. describe identity match: if describe contains a metadataObject
    //      whose xmlName equals the UI name, use that directly. Catches every
    //      new type Salesforce adds without code changes.
    //   Returns null when neither path produces a mapping.
    function resolveEntityType(uiName, describeData, overrideMap) {
        if (!uiName) return null;
        if (overrideMap && Object.prototype.hasOwnProperty.call(overrideMap, uiName)) {
            return overrideMap[uiName];
        }
        if (describeData && Array.isArray(describeData.metadataObjects)) {
            for (var i = 0; i < describeData.metadataObjects.length; i++) {
                var mo = describeData.metadataObjects[i];
                if (mo && mo.xmlName === uiName) return uiName;
                // Fold "children" (e.g. CustomField lives under CustomObject's childXmlNames)
                if (mo && Array.isArray(mo.childXmlNames)) {
                    for (var j = 0; j < mo.childXmlNames.length; j++) {
                        if (mo.childXmlNames[j] === uiName) return uiName;
                    }
                }
            }
        }
        return null;
    }

    window.cshMetadata = {
        getDescribe: getDescribe,
        warmDescribeCache: warmDescribeCache,
        resolveEntityType: resolveEntityType,
        CACHE_KEY: CACHE_KEY,
        TTL_MS: TTL_MS
    };
})();
