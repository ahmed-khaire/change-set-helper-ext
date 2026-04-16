// Manifest V3 service worker
// JSforce operations are handled in offscreen.html/offscreen.js due to XMLHttpRequest requirement

var CSH_APIVERSION = "60.0";
var CSH_APIVERSION_IS_USER_PREF = false;
const versionPattern = RegExp('^[0-9][0-9]\.0$');

// Priority:
//   1. chrome.storage.sync.salesforceApiVersion  — user-set from options page
//   2. chrome.storage.local.cshResolvedApiVersion — auto-discovered by common.js
//   3. fallback "60.0"
function applyApiVersion(value, isUserPref) {
    if (value && versionPattern.test(value)) {
        CSH_APIVERSION = value;
        CSH_APIVERSION_IS_USER_PREF = !!isUserPref;
        console.log('Service Worker - API Version:', CSH_APIVERSION, isUserPref ? '(user pref)' : '(auto)');
    }
}

chrome.storage.sync.get(['salesforceApiVersion'], function (items) {
    if (items && items.salesforceApiVersion) {
        applyApiVersion(items.salesforceApiVersion, true);
        return;
    }
    // No user pref — fall back to the auto-detected value if one is cached.
    chrome.storage.local.get(['cshResolvedApiVersion'], function (local) {
        if (local && local.cshResolvedApiVersion) {
            applyApiVersion(local.cshResolvedApiVersion, false);
        }
    });
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'sync' && changes.salesforceApiVersion) {
        applyApiVersion(changes.salesforceApiVersion.newValue, true);
        return;
    }
    if (areaName === 'local' && changes.cshResolvedApiVersion && !CSH_APIVERSION_IS_USER_PREF) {
        applyApiVersion(changes.cshResolvedApiVersion.newValue, false);
    }
});

const POLLTIMEOUT = 20*60*1000; // 20 minutes
const POLLINTERVAL = 5000; //5 seconds

// Connected App Consumer Key. Default is the self-hosted Connected App
// deployed to the Change Set Helper dev org (Metadata API; see
// sfdx-connected-app/). Users can override via Options → Connected App
// OAuth Diagnostic → "Save this client id", which writes to
// chrome.storage.sync.cshOauthClientId. Reads below pick up overrides live.
var CSH_DEFAULT_CLIENT_ID = '3MVG9rZjd7MXFdLiCOqMK.NJroKkk0E3Tj9yOfX3AeoqECaiXLKStAihsbnJFls44Ff70OVH4kbgYyihQZPTF';
var cshClientId = CSH_DEFAULT_CLIENT_ID;

chrome.storage.sync.get(['cshOauthClientId'], function (items) {
    if (items && items.cshOauthClientId) {
        cshClientId = items.cshOauthClientId;
        console.log('Service Worker - OAuth client id: user override');
    } else {
        console.log('Service Worker - OAuth client id: default');
    }
});

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.cshOauthClientId) {
        cshClientId = changes.cshOauthClientId.newValue || CSH_DEFAULT_CLIENT_ID;
        console.log('Service Worker - OAuth client id changed:',
            changes.cshOauthClientId.newValue ? 'user override' : 'default');
    }
});

var redirectUri = chrome.identity.getRedirectURL("sfdc");

// Auth URLs are built lazily per request so the latest cshClientId is used.
function buildAuthUrl(environment) {
    var host = environment === 'prod'
        ? 'https://login.salesforce.com'
        : 'https://test.salesforce.com';
    return host + '/services/oauth2/authorize' +
        '?display=page' +
        '&prompt=select_account' +
        '&response_type=token' +
        '&client_id=' + encodeURIComponent(cshClientId) +
        '&redirect_uri=' + encodeURIComponent(redirectUri);
}

// ---------------------------------------------------------------------------
// OAuth code + PKCE helpers — Phase 4 refresh-token auth fallback.
//
// Data path: when the content script's cshSession.ready cannot obtain a sid
// via document.cookie or chrome.cookies.get, it asks the service worker for
// an OAuth access token. We look up a stored {access_token, refresh_token}
// per host in chrome.storage.local, refresh if stale, and either return the
// token or a 'needs-login' signal so the content script can show a
// "Sign in via OAuth" button which triggers cshAuthLogin.
// ---------------------------------------------------------------------------

var TOKEN_STORE_KEY = 'cshOauthTokens';
var TOKEN_STALE_MS = 90 * 60 * 1000; // 90 min — Salesforce access tokens usually live 1-2h

function cshB64Url(bytes) {
    var str = '';
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function cshGeneratePkce() {
    var rand = new Uint8Array(32);
    crypto.getRandomValues(rand);
    var verifier = cshB64Url(rand);
    var hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    var challenge = cshB64Url(new Uint8Array(hash));
    return { verifier: verifier, challenge: challenge };
}

function cshReadTokens() {
    return new Promise(function (resolve) {
        chrome.storage.local.get([TOKEN_STORE_KEY], function (items) {
            resolve((items && items[TOKEN_STORE_KEY]) || {});
        });
    });
}

function cshWriteTokens(all) {
    return new Promise(function (resolve) {
        chrome.storage.local.set({ [TOKEN_STORE_KEY]: all }, function () { resolve(); });
    });
}

async function cshGetTokenForHost(host) {
    var all = await cshReadTokens();
    return all[host] || null;
}

async function cshSaveTokenForHost(host, token) {
    var all = await cshReadTokens();
    all[host] = Object.assign({}, token, { host: host, savedAt: Date.now() });
    await cshWriteTokens(all);
}

async function cshClearTokenForHost(host) {
    var all = await cshReadTokens();
    delete all[host];
    await cshWriteTokens(all);
}

function cshHostFromUrl(urlStr) {
    try {
        var u = new URL(urlStr);
        return u.protocol + '//' + u.host;
    } catch (_) { return null; }
}

async function cshExchangeCodeForToken(host, code, codeVerifier) {
    var body = new URLSearchParams();
    body.append('grant_type', 'authorization_code');
    body.append('code', code);
    body.append('redirect_uri', redirectUri);
    body.append('client_id', cshClientId);
    body.append('code_verifier', codeVerifier);
    var resp = await fetch(host + '/services/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    var json = await resp.json();
    if (!resp.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || 'Token exchange failed (HTTP ' + resp.status + ')');
    }
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || null,
        instanceUrl: json.instance_url || host,
        issuedAt: parseInt(json.issued_at, 10) || Date.now(),
        scope: json.scope || ''
    };
}

async function cshRefreshAccessToken(host, refreshToken) {
    var body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('client_id', cshClientId);
    body.append('refresh_token', refreshToken);
    var resp = await fetch(host + '/services/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    var json = await resp.json();
    if (!resp.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || 'Refresh failed (HTTP ' + resp.status + ')');
    }
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || refreshToken, // Salesforce may or may not rotate
        instanceUrl: json.instance_url || host,
        issuedAt: parseInt(json.issued_at, 10) || Date.now(),
        scope: json.scope || ''
    };
}

async function cshRunOauthLogin(host) {
    var pkce = await cshGeneratePkce();
    var state = Math.random().toString(36).slice(2);
    var authUrl = host + '/services/oauth2/authorize' +
        '?response_type=code' +
        '&client_id=' + encodeURIComponent(cshClientId) +
        '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&scope=' + encodeURIComponent('api refresh_token id') +
        '&code_challenge=' + encodeURIComponent(pkce.challenge) +
        '&code_challenge_method=S256' +
        '&state=' + state;
    var redirectUrl = await new Promise(function (resolve, reject) {
        chrome.identity.launchWebAuthFlow(
            { url: authUrl, interactive: true },
            function (url) {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                if (!url) return reject(new Error('No redirect URL returned'));
                resolve(url);
            }
        );
    });
    var u = new URL(redirectUrl);
    var params = new URLSearchParams(u.search);
    if (params.get('error')) {
        throw new Error(params.get('error') + (params.get('error_description') ? ': ' + params.get('error_description') : ''));
    }
    var code = params.get('code');
    if (!code) throw new Error('No authorization code in redirect');
    if (params.get('state') !== state) throw new Error('OAuth state mismatch — aborting');
    return await cshExchangeCodeForToken(host, code, pkce.verifier);
}

// Keep service worker alive during long-running operations
let keepAliveInterval = null;

function startKeepAlive() {
    if (!keepAliveInterval) {
        keepAliveInterval = setInterval(() => {
            chrome.runtime.getPlatformInfo(() => {
                // Just checking to keep service worker alive
            });
        }, 20000); // Every 20 seconds
    }
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// Offscreen document management
let creating; // A global promise to avoid concurrency issues
let offscreenReady = false;
let offscreenInactivityTimer = null;
const OFFSCREEN_INACTIVITY_TIMEOUT = 5 * 60 * 1000; // Close after 5 minutes of inactivity

// Close offscreen document to free memory
async function closeOffscreenDocument() {
    try {
        // Clear the timer
        if (offscreenInactivityTimer) {
            clearTimeout(offscreenInactivityTimer);
            offscreenInactivityTimer = null;
        }

        // Check if any offscreen documents exist
        if (chrome.runtime.getContexts) {
            const existingContexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT']
            });

            if (existingContexts.length > 0) {
                console.log('Closing offscreen document to free memory');
                await chrome.offscreen.closeDocument();
                offscreenReady = false;
                console.log('Offscreen document closed successfully');
            } else {
                console.log('No offscreen document to close');
            }
        }
    } catch (err) {
        console.log('Error closing offscreen document:', err.message);
    }
}

// Reset inactivity timer - close offscreen after period of no use
function resetOffscreenInactivityTimer() {
    if (offscreenInactivityTimer) {
        clearTimeout(offscreenInactivityTimer);
    }

    offscreenInactivityTimer = setTimeout(() => {
        console.log('Offscreen document inactive for', OFFSCREEN_INACTIVITY_TIMEOUT / 1000, 'seconds - closing to save memory');
        closeOffscreenDocument();
    }, OFFSCREEN_INACTIVITY_TIMEOUT);
}

//offscreen.html
async function setupOffscreenDocument(path) {
    try {
        // Check if offscreen API is available
        if (!chrome.offscreen) {
            throw new Error('chrome.offscreen API not available. Chrome 109+ required.');
        }

        const offscreenUrl = chrome.runtime.getURL(path);
        console.log('Setting up offscreen document:', offscreenUrl);

        // Check if offscreen document already exists
        let existingContexts = [];
        if (chrome.runtime.getContexts) {
            existingContexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [offscreenUrl]
            });
        }

        if (existingContexts.length > 0) {
            console.log('Offscreen document already exists');
            return;
        }

        if (creating) {
            console.log('Waiting for existing creation promise...');
            await creating;
        } else {
            console.log('Creating new offscreen document...');
            creating = chrome.offscreen.createDocument({
                url: path,
                reasons: ['DOM_SCRAPING'], // Using DOM_SCRAPING as it allows XMLHttpRequest
                justification: 'JSforce library requires XMLHttpRequest for Salesforce API communication'
            });
            await creating;
            creating = null;
            console.log('Offscreen document created successfully');

            // Start inactivity timer
            resetOffscreenInactivityTimer();
        }
    } catch (err) {
        console.error('Failed to create offscreen document:', err);
        console.error('Error details:', {
            name: err.name,
            message: err.message,
            stack: err.stack
        });
        creating = null;
        throw err;
    }
}

async function sendToOffscreen(message) {
    try {
        await setupOffscreenDocument('offscreen.html');

        // Reset inactivity timer on each API call
        resetOffscreenInactivityTimer();

        // Only wait for JSforce on first load
        if (!offscreenReady) {
            // Wait for offscreen document to fully load and JSforce to initialize
            await new Promise(resolve => setTimeout(resolve, 500));
            offscreenReady = true;
        }

        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('sendMessage error:', chrome.runtime.lastError.message);
                    console.error('Message was:', message);
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
    } catch (err) {
        console.error('sendToOffscreen failed:', err);
        throw err;
    }
}

// Port-based handlers for long-running operations
chrome.runtime.onConnect.addListener(function (port) {
    if (port.name == "deployHandler") {
        startKeepAlive();
        port.onMessage.addListener(async function (request) {
            if (request.proxyFunction == "deploy") {
                await deploy(port, request.opts, request.changename, request.sessionId, request.serverUrl);
            }
        });
        port.onDisconnect.addListener(() => {
            stopKeepAlive();
        });
    }

    if (port.name == "quickDeployHandler") {
        startKeepAlive();
        port.onMessage.addListener(async function (request) {
            if (request.proxyFunction == "quickDeploy") {
                await quickDeploy(port, request.currentId);
            }
        });
        port.onDisconnect.addListener(() => {
            stopKeepAlive();
        });
    }
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    // Listen for offscreen document ready signal
    if (request.action === 'offscreenReady') {
        console.log('Offscreen document signaled ready!');
        offscreenReady = true;
        return false;
    }

    // Handle OAuth requests (these stay in service worker as chrome.identity works here)
    if (request.oauth == "request") {
        getSfdcOauth2(sendResponse, request.environment);
        return true;
    }

    if (request.type == "cshAuthLogin") {
        var loginHost = request.host || cshHostFromUrl(sender && sender.tab && sender.tab.url);
        if (!loginHost) {
            sendResponse({ ok: false, error: 'Unknown target host for OAuth login' });
            return false;
        }
        cshRunOauthLogin(loginHost)
            .then(function (tokens) {
                return cshSaveTokenForHost(loginHost, tokens).then(function () {
                    sendResponse({
                        ok: true,
                        accessToken: tokens.accessToken,
                        instanceUrl: tokens.instanceUrl,
                        hasRefreshToken: !!tokens.refreshToken,
                        scope: tokens.scope
                    });
                });
            })
            .catch(function (err) {
                console.error('cshAuthLogin failed:', err);
                sendResponse({ ok: false, error: err.message });
            });
        return true;
    }

    if (request.type == "cshAuthGetToken") {
        var getHost = request.host || cshHostFromUrl(sender && sender.tab && sender.tab.url);
        if (!getHost) {
            sendResponse({ ok: false, reason: 'no-host' });
            return false;
        }
        (async function () {
            try {
                var stored = await cshGetTokenForHost(getHost);
                if (!stored) { sendResponse({ ok: false, reason: 'no-token' }); return; }
                var age = Date.now() - (stored.issuedAt || stored.savedAt || 0);
                // If we have a refresh token and the access token is stale
                // (or the caller explicitly asked for a fresh one), refresh.
                if (stored.refreshToken && (age > TOKEN_STALE_MS || request.forceRefresh)) {
                    try {
                        var refreshed = await cshRefreshAccessToken(getHost, stored.refreshToken);
                        await cshSaveTokenForHost(getHost, refreshed);
                        sendResponse({
                            ok: true,
                            accessToken: refreshed.accessToken,
                            instanceUrl: refreshed.instanceUrl,
                            refreshed: true
                        });
                        return;
                    } catch (e) {
                        console.warn('cshAuthGetToken: refresh failed, returning stored token', e.message);
                        // Fall through to the stored (possibly stale) token;
                        // the caller will surface "please sign in again" if SF 401s.
                    }
                }
                sendResponse({
                    ok: true,
                    accessToken: stored.accessToken,
                    instanceUrl: stored.instanceUrl,
                    refreshed: false,
                    ageMs: age
                });
            } catch (err) {
                sendResponse({ ok: false, error: err.message });
            }
        })();
        return true;
    }

    if (request.type == "cshAuthLogout") {
        var logoutHost = request.host || cshHostFromUrl(sender && sender.tab && sender.tab.url);
        if (!logoutHost) {
            sendResponse({ ok: false, reason: 'no-host' });
            return false;
        }
        cshClearTokenForHost(logoutHost).then(function () { sendResponse({ ok: true }); });
        return true;
    }

    if (request.type == "cshCartSubmit") {
        // Cart worker batch submission: POST to the native Add-Components
        // endpoint using the scraped form shape, with our chosen ids replacing
        // the user's checkbox selections. fetch() from the service worker
        // includes cookies for any origin we have host_permissions for.
        (async function () {
            try {
                var shape = request.formShape;
                var ids = request.ids || [];
                if (!shape || !shape.action) {
                    sendResponse({ ok: false, error: 'No form shape available' });
                    return;
                }
                var body = new URLSearchParams();
                Object.keys(shape.hidden || {}).forEach(function (k) {
                    body.append(k, shape.hidden[k]);
                });
                // The Salesforce form names its row checkboxes `ids`; appending
                // one entry per selected id produces the same POST shape as a
                // real user tick.
                ids.forEach(function (id) { body.append('ids', id); });
                // Include the submit button's own name/value so the server-side
                // handler treats it as a Save (not a filter / search submission).
                if (shape.submitName) body.append(shape.submitName, shape.submitValue || 'Save');

                var resp = await fetch(shape.action, {
                    method: shape.method || 'POST',
                    credentials: 'include',
                    body: body.toString(),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        // Hint the server this is an async submission; Salesforce
                        // tolerates it and it avoids full HTML shells in some cases.
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                // Successful add-to-change-set usually returns a 302 redirect
                // to the Outbound Change Set detail page. fetch follows redirects
                // by default; a 200 on the detail URL is our success signal.
                if (resp.ok || (resp.status >= 300 && resp.status < 400)) {
                    sendResponse({ ok: true, finalUrl: resp.url });
                    return;
                }
                var text = await resp.text().catch(function () { return ''; });
                sendResponse({
                    ok: false,
                    error: 'HTTP ' + resp.status + (text ? ': ' + text.slice(0, 240) : '')
                });
            } catch (err) {
                console.error('cshCartSubmit failed:', err);
                sendResponse({ ok: false, error: err.message || String(err) });
            }
        })();
        return true;
    }

    if (request.type == "getSessionCookie") {
        // HttpOnly-cookie fallback: content scripts can't read the sid cookie
        // directly when the org has "Require HttpOnly attribute" enabled, but
        // the cookies API can. We search the most common Salesforce cookie
        // stores and return the first hit. Falls back silently to null.
        (async function () {
            try {
                var url = request.url || (sender && sender.tab && sender.tab.url);
                if (!url) {
                    sendResponse({ sid: null, reason: 'no-url' });
                    return;
                }
                var storeId = sender && sender.tab && sender.tab.cookieStoreId;
                var getOpts = storeId
                    ? { url: url, name: 'sid', storeId: storeId }
                    : { url: url, name: 'sid' };
                chrome.cookies.get(getOpts, function (cookie) {
                    if (chrome.runtime.lastError || !cookie || !cookie.value) {
                        sendResponse({ sid: null, reason: 'not-found' });
                        return;
                    }
                    sendResponse({ sid: cookie.value });
                });
            } catch (err) {
                console.error('getSessionCookie failed:', err);
                sendResponse({ sid: null, reason: 'exception', error: err.message });
            }
        })();
        return true;
    }

    if (request.oauth == "connectToDeploy") {
        connectToDeploy(sendResponse, request.environment);
        return true;
    }

    if (request.oauth == "connectToLocal") {
        setLocalConn(
            sendResponse,
            request.sessionId,
            request.serverUrl,
            request.authMode || 'sid',
            request.instanceUrl || request.serverUrl
        );
        return true;
    }

    if (request.oauth == "connectToLocalOauth") {
        connectToLocalOauth(sendResponse);
        return true;
    }

    if (request.oauth == "deployLogout") {
        sendToOffscreen({action: 'deployLogout'}).then(() => {
            sendResponse({success: true});
        }).catch(err => {
            console.error('Error in deployLogout:', err);
            sendResponse({success: false, error: err.message});
        });
        return true;
    }

    // Proxy metadata operations to offscreen document
    if (request.proxyFunction == "listDeployMetaData") {
        sendToOffscreen({
            action: 'listMetadata',
            connType: 'deploy',
            types: request.proxydata
        }).then(response => {
            sendResponse({err: response.error || null, results: response.results});
        }).catch(err => {
            console.error('Error in listDeployMetaData:', err);
            sendResponse({err: err.message, results: null});
        });
        return true;
    }

    if (request.proxyFunction == "listLocalMetaData") {
        sendToOffscreen({
            action: 'listMetadata',
            connType: 'local',
            types: request.proxydata
        }).then(response => {
            sendResponse({err: response.error || null, results: response.results});
        }).catch(err => {
            console.error('Error in listLocalMetaData:', err);
            sendResponse({err: err.message, results: null});
        });
        return true;
    }

    if (request.proxyFunction == "describeLocalMetadata") {
        sendToOffscreen({
            action: 'describeMetadata',
            connType: 'local'
        }).then(response => {
            sendResponse({err: response.error || null, results: response.results});
        }).catch(err => {
            console.error('Error in describeLocalMetadata:', err);
            sendResponse({err: err.message, results: null});
        });
        return true;
    }

    if (request.proxyFunction == "downloadLocalMetadata") {
        sendToOffscreen({
            action: 'downloadMetadata',
            connType: 'local',
            changename: request.changename
        }).then(response => {
            if (response.error) {
                sendResponse({err: response.error});
            } else {
                sendResponse({result: response.result});
            }
        }).catch(err => {
            console.error('Error in downloadLocalMetadata:', err);
            sendResponse({err: err.message});
        });
        return true;
    }

    if (request.proxyFunction == "getDeployUsername") {
        sendToOffscreen({action: 'getDeployUsername'}).then(response => {
            sendResponse(response.username);
        }).catch(err => {
            console.error('Error in getDeployUsername:', err);
            sendResponse(null);
        });
        return true;
    }

    if (request.proxyFunction == "compareContents") {
        compareContents(request.entityType, request.itemName);
        return false;
    }

    if (request.proxyFunction == "cancelDeploy") {
        sendToOffscreen({
            action: 'cancelDeploy',
            deployId: request.currentId
        }).then(response => {
            sendResponse({result: null, response: response.response, err: response.error});
        }).catch(err => {
            console.error('Error in cancelDeploy:', err);
            sendResponse({result: null, response: null, err: err.message});
        });
        return true;
    }
});

async function setLocalConn(sendResponse, authValue, serverUrl, authMode, instanceUrl) {
    try {
        await sendToOffscreen({
            action: 'setLocalConn',
            sessionId: authValue,       // kept for legacy — offscreen decides by authMode
            authValue: authValue,
            authMode: authMode || 'sid',
            serverUrl: serverUrl,
            instanceUrl: instanceUrl || serverUrl
        });
        sendResponse();
    } catch (err) {
        console.error('Error in setLocalConn:', err);
        sendResponse({error: err.message});
    }
}

function connectToDeploy(sendResponse, environment) {
    connectToOrg(sendResponse, environment, 'deploy');
}

function connectToLocalOauth(sendResponse) {
    connectToOrg(sendResponse, 'sandbox', 'local');
}

function connectToOrg(sendResponse, environment, connType) {
    var auth_url = buildAuthUrl(environment);

    chrome.identity.launchWebAuthFlow({'url': auth_url, 'interactive': true}, async function (redirect_url) {
        if (chrome.runtime.lastError) {
            console.log(chrome.runtime.lastError.message);
            sendResponse({'oauth': 'response', 'error': chrome.runtime.lastError.message});
            return;
        }

        try {
            var oauthtoken = getAccessToken(redirect_url);
            var instanceUrl = getInstanceUrl(redirect_url);

            // Send credentials to offscreen document to create connection
            const response = await sendToOffscreen({
                action: 'connectToOrg',
                environment: environment,
                connType: connType,
                instanceUrl: instanceUrl,
                accessToken: oauthtoken
            });

            if (response.error) {
                sendResponse({'oauth': 'response', 'error': response.error});
            } else {
                sendResponse({'oauth': 'response', 'username': response.username});
            }
        } catch (err) {
            console.error('Error in connectToOrg:', err);
            sendResponse({'oauth': 'response', 'error': err.message});
        }
    });
}

function getAccessToken(url) {
    var subStr = url.match("#access_token=(.*?)&");
    return (decodeURIComponent(subStr[1]));
}

function getInstanceUrl(url) {
    var subStr = url.match("instance_url=(.*?)&");
    return (decodeURIComponent(subStr[1]));
}

async function deploy(port, opts, changename, sessionId, serverUrl) {
    try {
        // First set up local connection
        await sendToOffscreen({
            action: 'setLocalConn',
            sessionId: sessionId,
            serverUrl: serverUrl
        });

        port.postMessage({response: 'Downloading metadata...'});

        // Retrieve metadata
        const retrieveResponse = await sendToOffscreen({
            action: 'retrieveMetadata',
            connType: 'local',
            opts: {
                singlePackage: false,
                packageNames: [changename]
            }
        });

        if (retrieveResponse.error) {
            port.postMessage({response: 'Error', err: retrieveResponse.error});
            return;
        }

        port.postMessage({response: 'Done downloading, starting deploy...'});

        // Deploy to target org - this will be handled via polling
        await deployToSF(retrieveResponse.zipData, port, opts);

    } catch (err) {
        console.error(err);
        port.postMessage({response: 'Error', err: err.toString()});
    }
}

async function deployToSF(zipData, port, opts) {
    // Set up polling for deploy status
    const deployResponse = await sendToOffscreen({
        action: 'deploy',
        zipData: zipData,
        opts: opts
    });

    if (deployResponse.error) {
        port.postMessage({result: null, response: null, err: deployResponse.error});
    } else {
        // Deploy initiated, start polling for status
        await pollDeployStatus(port, deployResponse.result.id);
    }
}

async function pollDeployStatus(port, deployId) {
    const startTime = Date.now();
    const pollInterval = setInterval(async () => {
        try {
            const statusResponse = await sendToOffscreen({
                action: 'checkDeployStatus',
                deployId: deployId
            });

            if (statusResponse.error) {
                clearInterval(pollInterval);
                port.postMessage({result: null, response: null, err: statusResponse.error});
                return;
            }

            port.postMessage({
                result: {id: deployId, state: statusResponse.result.status},
                response: statusResponse.result,
                err: null
            });

            // Check if deploy is complete
            if (statusResponse.result.done) {
                clearInterval(pollInterval);
                port.postMessage({response: null, err: null, result: statusResponse.result});
            }

            // Timeout check
            if (Date.now() - startTime > POLLTIMEOUT) {
                clearInterval(pollInterval);
                port.postMessage({result: null, response: null, err: 'Deploy timeout'});
            }
        } catch (err) {
            clearInterval(pollInterval);
            port.postMessage({result: null, response: null, err: err.toString()});
        }
    }, POLLINTERVAL);
}

async function quickDeploy(port, currentId) {
    try {
        const response = await sendToOffscreen({
            action: 'quickDeploy',
            deployId: currentId
        });

        if (response.error) {
            port.postMessage({result: null, response: null, err: response.error});
        } else {
            // Quick deploy initiated, start polling
            await pollDeployStatus(port, response.result.id);
        }
    } catch (err) {
        console.error(err);
        port.postMessage({result: null, response: null, err: err.toString()});
    }
}

function compareContents(type, item) {
    chrome.windows.create({'url': "compare.html?item=" + item, 'type': "popup", "focused": false},
        async function (newWin) {
            await getContents(type, item, 'local', "lhs");
            await getContents(type, item, 'deploy', "rhs");
        });
}

async function getContents(type, item, connType, side) {
    try {
        const response = await sendToOffscreen({
            action: 'retrieveMetadata',
            connType: connType,
            opts: {
                apiVersion: CSH_APIVERSION,
                singlePackage: false,
                unpackaged: {
                    types: [{name: type, members: [item]}]
                }
            }
        });

        if (response.error) {
            chrome.runtime.sendMessage({'setSide': side, 'err': response.error});
        } else {
            chrome.runtime.sendMessage({
                'setSide': side,
                'content': {zipFile: response.zipData},
                'compareItem': item
            });
        }
    } catch (err) {
        console.error(err);
        chrome.runtime.sendMessage({'setSide': side, 'err': err.toString()});
    }
}

console.log('Service worker ready');
setupOffscreenDocument('offscreen.html');
