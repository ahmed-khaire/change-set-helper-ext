// Manifest V3 service worker
// JSforce operations are handled in offscreen.html/offscreen.js due to XMLHttpRequest requirement

var CSH_APIVERSION = "66.0";
var CSH_APIVERSION_IS_USER_PREF = false;
const versionPattern = RegExp('^[0-9][0-9]\.0$');

// Priority:
//   1. chrome.storage.sync.salesforceApiVersion  — user-set from options page
//   2. chrome.storage.local.cshResolvedApiVersion — auto-discovered by common.js
//   3. fallback "66.0" (Spring '26)
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

// Tracks which saved org the current deploy connection points at. Used to
// hand a fresh {instanceUrl, accessToken, apiVersion, orgId} bundle to the
// page after deploy kickoff so the page can poll Salesforce's Metadata REST
// API directly (bypassing the SW + offscreen doc, both of which suspend on
// long deploys and stall the phase label). Set in cshConnectDeployOrg.
// Mirrored to chrome.storage.session so it survives SW restarts between
// "Connect" and "Go…" — otherwise we'd fail handoff with "No active deploy
// org" despite the offscreen doc still holding a live jsforce connection.
var cshActiveDeployOrgId = null;

function cshSetActiveDeployOrgId(orgId) {
    cshActiveDeployOrgId = orgId;
    try { chrome.storage.session.set({ cshActiveDeployOrgId: orgId }); } catch (_) {}
}
// Restore on SW startup.
try {
    chrome.storage.session.get(['cshActiveDeployOrgId'], function (items) {
        if (items && items.cshActiveDeployOrgId) {
            cshActiveDeployOrgId = items.cshActiveDeployOrgId;
        }
    });
} catch (_) { /* session storage may not be available in older Chrome */ }

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

// Normalize a user-supplied My Domain string into a canonical origin. Accepts
// "yourorg.my.salesforce.com", "https://yourorg.my.salesforce.com", or the
// same with trailing slashes/paths. Returns null if the input is obviously
// malformed so the caller can refuse rather than producing a bad URL.
function cshNormalizeHost(raw) {
    if (!raw) return null;
    var host = String(raw).trim();
    if (!host) return null;
    if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
    try {
        var u = new URL(host);
        return u.protocol + '//' + u.host;
    } catch (_) { return null; }
}

// Auth URLs are built lazily per request so the latest cshClientId is used.
// environment ∈ {'sandbox', 'prod', 'mydomain'}; customHost applies only to
// 'mydomain' and must be an https origin.
function buildAuthUrl(environment, customHost) {
    var host;
    if (environment === 'mydomain') {
        host = cshNormalizeHost(customHost);
        if (!host) host = 'https://login.salesforce.com'; // safe fallback
    } else if (environment === 'prod') {
        host = 'https://login.salesforce.com';
    } else {
        host = 'https://test.salesforce.com';
    }
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
    // Hold the service worker awake for the duration of the OAuth popup.
    // Users can take 30s+ to enter credentials / clear a 2FA prompt; without
    // keep-alive the MV3 SW can idle and lose the pending launchWebAuthFlow
    // callback, leaving the user stranded with a stale "Signing in..." button.
    startKeepAlive();
    try {
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
    } finally {
        stopKeepAlive();
    }
}

// ---------------------------------------------------------------------------
// Saved-orgs registry — Phase 6 multi-org auth.
//
// The Validate Helper and Compare flow used to require fresh OAuth on every
// visit because the deploy connection lived only in the offscreen document.
// Users working across multiple target orgs had to re-authenticate each time
// they switched change sets.
//
// We now persist per-org credentials (access + refresh token, instance URL,
// identity) in chrome.storage.local keyed by host+username, plus a
// per-change-set "last used org" map so the Validate Helper can auto-select
// the org the user most recently deployed this change set to. Refresh tokens
// let us mint fresh access tokens without a popup until the refresh itself
// expires or is revoked.
// ---------------------------------------------------------------------------
var SAVED_ORGS_KEY = 'cshSavedOrgs';
var ORG_USAGE_KEY = 'cshOrgUsage';

function cshReadJsonKey(key) {
    return new Promise(function (resolve) {
        chrome.storage.local.get([key], function (items) {
            resolve((items && items[key]) || {});
        });
    });
}

function cshWriteJsonKey(key, val) {
    return new Promise(function (resolve) {
        chrome.storage.local.set({ [key]: val }, function () { resolve(); });
    });
}

function cshMakeOrgId(host, username) {
    return (host || '').toLowerCase() + '|' + (username || '').toLowerCase();
}

async function cshListSavedOrgs() {
    var all = await cshReadJsonKey(SAVED_ORGS_KEY);
    var ids = Object.keys(all);
    return ids.map(function (id) {
        return Object.assign({ orgId: id }, all[id]);
    }).sort(function (a, b) {
        return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    });
}

async function cshGetSavedOrg(orgId) {
    if (!orgId) return null;
    var all = await cshReadJsonKey(SAVED_ORGS_KEY);
    return all[orgId] || null;
}

async function cshSaveOrg(orgRecord) {
    var id = orgRecord.orgId || cshMakeOrgId(orgRecord.host, orgRecord.username);
    var all = await cshReadJsonKey(SAVED_ORGS_KEY);
    var prev = all[id] || {};
    // Preserve fields from prior record that the caller didn't supply (e.g.
    // refreshToken when only the access token was rotated).
    all[id] = Object.assign({}, prev, orgRecord, {
        orgId: id,
        lastUsedAt: orgRecord.lastUsedAt || Date.now()
    });
    await cshWriteJsonKey(SAVED_ORGS_KEY, all);
    return id;
}

async function cshDeleteSavedOrg(orgId) {
    var all = await cshReadJsonKey(SAVED_ORGS_KEY);
    if (!all[orgId]) return false;
    delete all[orgId];
    await cshWriteJsonKey(SAVED_ORGS_KEY, all);
    // Also clear any change-set usage pointers that referenced it, so the
    // Validate Helper doesn't dangle a "last used" id that no longer exists.
    var usage = await cshReadJsonKey(ORG_USAGE_KEY);
    var changed = false;
    Object.keys(usage).forEach(function (csId) {
        if (usage[csId] && usage[csId].lastOrgId === orgId) {
            delete usage[csId];
            changed = true;
        }
    });
    if (changed) await cshWriteJsonKey(ORG_USAGE_KEY, usage);
    return true;
}

async function cshGetLastOrgForChangeSet(changeSetId) {
    if (!changeSetId) return null;
    var usage = await cshReadJsonKey(ORG_USAGE_KEY);
    return (usage[changeSetId] && usage[changeSetId].lastOrgId) || null;
}

async function cshSetLastOrgForChangeSet(changeSetId, orgId) {
    if (!changeSetId || !orgId) return;
    var usage = await cshReadJsonKey(ORG_USAGE_KEY);
    usage[changeSetId] = { lastOrgId: orgId, lastUsedAt: Date.now() };
    await cshWriteJsonKey(ORG_USAGE_KEY, usage);
}

// Fetch the org's identity (username, user id, org id) using the access
// token we just minted. We prefer /services/oauth2/userinfo because it's the
// canonical endpoint; if the Connected App policy disables it, we fall back
// to chatter /users/me which only needs the `api` scope.
async function cshFetchOrgIdentity(instanceUrl, accessToken) {
    try {
        var resp = await fetch(instanceUrl + '/services/oauth2/userinfo', {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        if (resp.ok) {
            var json = await resp.json();
            return {
                username: json.preferred_username || json.email || json.sub || json.user_id,
                userId: json.user_id || json.sub || null,
                organizationId: json.organization_id || null,
                displayName: json.name || json.preferred_username || ''
            };
        }
    } catch (_) { /* fall through */ }
    var resp2 = await fetch(instanceUrl + '/services/data/v' + CSH_APIVERSION + '/chatter/users/me', {
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
    });
    if (!resp2.ok) throw new Error('Identity lookup failed (HTTP ' + resp2.status + ')');
    var j = await resp2.json();
    return {
        username: j.username || (j.user && j.user.username) || null,
        userId: j.id || null,
        organizationId: null,
        displayName: j.displayName || j.name || ''
    };
}

// Turn a Validate-Helper "environment" + customHost into the OAuth auth host.
function cshAuthHostForEnv(environment, customHost) {
    if (environment === 'mydomain') {
        return cshNormalizeHost(customHost) || 'https://login.salesforce.com';
    }
    if (environment === 'prod') return 'https://login.salesforce.com';
    return 'https://test.salesforce.com';
}

function cshEnvLabel(environment) {
    if (environment === 'prod') return 'Production';
    if (environment === 'mydomain') return 'My Domain';
    return 'Sandbox';
}

// Connect the deploy connection either to a previously-saved org (refresh
// the access token if stale, then hand it to the offscreen document) or to a
// newly-authorized org via PKCE. The UI calls this with { orgId } on reuse
// and { environment, customHost } on "Add a new org".
async function cshConnectDeployOrg(request) {
    if (request && request.orgId) {
        var org = await cshGetSavedOrg(request.orgId);
        if (!org) throw new Error('Saved org not found — please add it again.');
        var token = org.accessToken;
        var stale = Date.now() - (org.issuedAt || org.lastUsedAt || 0) > TOKEN_STALE_MS;
        if (org.refreshToken && (stale || request.forceRefresh)) {
            try {
                var refreshed = await cshRefreshAccessToken(org.host, org.refreshToken);
                token = refreshed.accessToken;
                await cshSaveOrg({
                    orgId: org.orgId,
                    host: org.host,
                    username: org.username,
                    userId: org.userId,
                    organizationId: org.organizationId,
                    displayName: org.displayName,
                    envLabel: org.envLabel,
                    instanceUrl: refreshed.instanceUrl || org.instanceUrl,
                    accessToken: refreshed.accessToken,
                    refreshToken: refreshed.refreshToken,
                    issuedAt: refreshed.issuedAt,
                    scope: refreshed.scope || org.scope
                });
                org.instanceUrl = refreshed.instanceUrl || org.instanceUrl;
            } catch (err) {
                // Refresh failed — tell the caller to re-authorize.
                var e = new Error('Session for ' + (org.username || org.host) + ' expired. Please re-authorize.');
                e.code = 'needs-reauth';
                throw e;
            }
        }
        var offRes = await sendToOffscreen({
            action: 'connectToOrg',
            connType: 'deploy',
            instanceUrl: org.instanceUrl,
            accessToken: token
        });
        if (offRes && offRes.error) throw new Error(offRes.error);
        await cshSaveOrg({ orgId: org.orgId, host: org.host, username: org.username, lastUsedAt: Date.now() });
        if (request.changeSetId) await cshSetLastOrgForChangeSet(request.changeSetId, org.orgId);
        cshSetActiveDeployOrgId(org.orgId);
        return {
            ok: true,
            orgId: org.orgId,
            username: (offRes && offRes.username) || org.username,
            instanceUrl: org.instanceUrl,
            host: org.host,
            envLabel: org.envLabel || ''
        };
    }

    // New-org path: PKCE login + identity fetch + save + connect offscreen.
    var host = cshAuthHostForEnv(request && request.environment, request && request.customHost);
    var tokens = await cshRunOauthLogin(host);
    var ident = {};
    try {
        ident = await cshFetchOrgIdentity(tokens.instanceUrl, tokens.accessToken);
    } catch (e) {
        // Identity fetch shouldn't block the login — fall back to the host
        // as the visible label. Users will see the org listed but with an
        // empty username; we'll refresh the identity on next successful use.
        console.warn('cshFetchOrgIdentity failed:', e.message);
    }
    var username = ident.username || 'unknown';
    var record = {
        host: host,
        username: username,
        userId: ident.userId || null,
        organizationId: ident.organizationId || null,
        displayName: ident.displayName || '',
        envLabel: cshEnvLabel(request && request.environment),
        instanceUrl: tokens.instanceUrl,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        issuedAt: tokens.issuedAt,
        scope: tokens.scope
    };
    var orgId = await cshSaveOrg(record);
    var offRes = await sendToOffscreen({
        action: 'connectToOrg',
        connType: 'deploy',
        instanceUrl: tokens.instanceUrl,
        accessToken: tokens.accessToken
    });
    if (offRes && offRes.error) throw new Error(offRes.error);
    if (request && request.changeSetId) {
        await cshSetLastOrgForChangeSet(request.changeSetId, orgId);
    }
    cshSetActiveDeployOrgId(orgId);
    return {
        ok: true,
        orgId: orgId,
        username: (offRes && offRes.username) || username,
        instanceUrl: tokens.instanceUrl,
        host: host,
        envLabel: record.envLabel,
        freshlyLoggedIn: true
    };
}

// Return a fresh {accessToken, instanceUrl} bundle for the given saved org,
// refreshing via OAuth if the stored access token is stale. Called by the
// page's deploy poller on 401 (token expired mid-deploy) and once on
// handoff so the page always starts with a usable token.
async function cshGetFreshDeployToken(orgId) {
    var org = await cshGetSavedOrg(orgId);
    if (!org) throw new Error('Saved org not found');
    var token = org.accessToken;
    var instanceUrl = org.instanceUrl;
    var stale = Date.now() - (org.issuedAt || 0) > TOKEN_STALE_MS;
    if (org.refreshToken && stale) {
        var refreshed = await cshRefreshAccessToken(org.host, org.refreshToken);
        token = refreshed.accessToken;
        instanceUrl = refreshed.instanceUrl || instanceUrl;
        await cshSaveOrg({
            orgId: org.orgId,
            host: org.host,
            username: org.username,
            instanceUrl: instanceUrl,
            accessToken: token,
            refreshToken: refreshed.refreshToken,
            issuedAt: refreshed.issuedAt,
            scope: refreshed.scope || org.scope
        });
    }
    return { accessToken: token, instanceUrl: instanceUrl };
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
let offscreenPendingCount = 0; // in-flight sendToOffscreen calls
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

// Reset inactivity timer - close offscreen after period of no use.
// Skips scheduling while any sendToOffscreen call is still awaiting a
// response: a single long-running retrieve/deploy can easily exceed 5 min
// without any new messages, and if the timer fires mid-op the offscreen doc
// gets torn down and the in-flight sendResponse never fires — surfacing as
// "A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received".
function resetOffscreenInactivityTimer() {
    if (offscreenInactivityTimer) {
        clearTimeout(offscreenInactivityTimer);
        offscreenInactivityTimer = null;
    }
    if (offscreenPendingCount > 0) return;
    offscreenInactivityTimer = setTimeout(() => {
        if (offscreenPendingCount > 0) return; // last-ditch safety
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
    // Track in-flight ops so resetOffscreenInactivityTimer won't schedule a
    // close while we're still waiting on this call. Without this a long
    // retrieve / deploy that exceeds OFFSCREEN_INACTIVITY_TIMEOUT gets its
    // own message listener torn down mid-response.
    offscreenPendingCount++;
    try {
        await setupOffscreenDocument('offscreen.html');
        resetOffscreenInactivityTimer();

        if (!offscreenReady) {
            // Wait for offscreen document to fully load and JSforce to initialize
            await new Promise(resolve => setTimeout(resolve, 500));
            offscreenReady = true;
        }

        return await new Promise((resolve, reject) => {
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
    } finally {
        offscreenPendingCount = Math.max(0, offscreenPendingCount - 1);
        // Re-arm the timer now that this op is done; if another op is still
        // pending, resetOffscreenInactivityTimer bails out and the
        // already-running op's completion will re-arm later.
        resetOffscreenInactivityTimer();
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

    // Saved-orgs registry: list / pick / delete / get-last-for-change-set.
    if (request.type == "cshListSavedOrgs") {
        (async function () {
            try {
                var orgs = await cshListSavedOrgs();
                var lastForCs = request.changeSetId
                    ? await cshGetLastOrgForChangeSet(request.changeSetId)
                    : null;
                // Omit secrets from the list response — the UI only needs
                // identity-ish fields to render the dropdown.
                var safe = orgs.map(function (o) {
                    return {
                        orgId: o.orgId,
                        host: o.host,
                        username: o.username,
                        displayName: o.displayName || '',
                        envLabel: o.envLabel || '',
                        instanceUrl: o.instanceUrl,
                        lastUsedAt: o.lastUsedAt || 0,
                        hasRefreshToken: !!o.refreshToken
                    };
                });
                sendResponse({ ok: true, orgs: safe, lastOrgIdForChangeSet: lastForCs });
            } catch (err) {
                sendResponse({ ok: false, error: err.message });
            }
        })();
        return true;
    }

    if (request.type == "cshDeleteSavedOrg") {
        (async function () {
            try {
                var removed = await cshDeleteSavedOrg(request.orgId);
                sendResponse({ ok: true, removed: removed });
            } catch (err) {
                sendResponse({ ok: false, error: err.message });
            }
        })();
        return true;
    }

    if (request.type == "cshSetLastOrgForChangeSet") {
        (async function () {
            try {
                await cshSetLastOrgForChangeSet(request.changeSetId, request.orgId);
                sendResponse({ ok: true });
            } catch (err) {
                sendResponse({ ok: false, error: err.message });
            }
        })();
        return true;
    }

    // Page-side deploy poller asks for a fresh token when its current one 401s.
    // We refresh via the saved refresh token (if stale) and return the new
    // {accessToken, instanceUrl}. If the refresh token itself is revoked,
    // needsReauth=true tells the page to surface the re-login flow.
    if (request.type == "cshGetDeployToken") {
        (async function () {
            try {
                var fresh = await cshGetFreshDeployToken(request.orgId);
                sendResponse({ ok: true, accessToken: fresh.accessToken, instanceUrl: fresh.instanceUrl });
            } catch (err) {
                console.error('cshGetDeployToken failed:', err);
                sendResponse({
                    ok: false,
                    needsReauth: /invalid_grant|expired access\/refresh token|revoked|inactive/i.test(err.message || ''),
                    error: err.message || String(err)
                });
            }
        })();
        return true;
    }

    if (request.type == "cshClassicFetch") {
        // Content-script proxy for credentialed GETs of classic Salesforce
        // pages. Content scripts running on *.my.salesforce-setup.com can't
        // fetch *.my.salesforce.com with credentials: the two domains are
        // different eTLDs under the public suffix list, so the browser blocks
        // the cross-origin cookie request and the content-script fetch throws
        // "Failed to fetch". The service worker has host_permissions for both
        // domains, so it can cross the boundary and send the sid cookie for
        // the target origin. Used by cart.js syncFromChangeSetView to scrape
        // /<id>?tab=PackageComponents on Setup-domain orgs.
        (async function () {
            try {
                if (!request.url) {
                    sendResponse({ ok: false, error: 'cshClassicFetch: url required' });
                    return;
                }
                var resp = await fetch(request.url, {
                    method: 'GET',
                    credentials: 'include',
                    // X-Requested-With avoids Salesforce interstitials that
                    // sometimes wrap plain browser navigations; the classic
                    // component list page returns the same HTML either way.
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                var text = await resp.text();
                sendResponse({
                    ok: resp.ok,
                    status: resp.status,
                    finalUrl: resp.url,
                    text: text
                });
            } catch (err) {
                console.error('cshClassicFetch failed:', err);
                sendResponse({ ok: false, error: err.message || String(err) });
            }
        })();
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
        // Legacy callers pass just { environment, customHost }. New callers
        // pass { orgId } to reuse a saved org, or { environment, customHost,
        // changeSetId } to add a new one and remember it for that change set.
        (async function () {
            try {
                var res = await cshConnectDeployOrg({
                    orgId: request.orgId || null,
                    environment: request.environment || 'sandbox',
                    customHost: request.customHost || null,
                    changeSetId: request.changeSetId || null,
                    forceRefresh: !!request.forceRefresh
                });
                sendResponse({
                    oauth: 'response',
                    ok: true,
                    orgId: res.orgId,
                    username: res.username,
                    instanceUrl: res.instanceUrl,
                    host: res.host,
                    envLabel: res.envLabel,
                    freshlyLoggedIn: !!res.freshlyLoggedIn
                });
            } catch (err) {
                console.error('connectToDeploy failed:', err);
                sendResponse({
                    oauth: 'response',
                    ok: false,
                    needsReauth: err && err.code === 'needs-reauth',
                    error: err && err.message ? err.message : String(err)
                });
            }
        })();
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

    if (request.proxyFunction == "queryToolingLocal") {
        sendToOffscreen({
            action: 'queryTooling',
            connType: 'local',
            soql: request.soql
        }).then(response => {
            sendResponse({err: response.error || null, records: response.records});
        }).catch(err => {
            console.error('Error in queryToolingLocal:', err);
            sendResponse({err: err.message, records: null});
        });
        return true;
    }

    if (request.proxyFunction == "queryToolingDeploy") {
        sendToOffscreen({
            action: 'queryTooling',
            connType: 'deploy',
            soql: request.soql
        }).then(response => {
            sendResponse({err: response.error || null, records: response.records});
        }).catch(err => {
            console.error('Error in queryToolingDeploy:', err);
            sendResponse({err: err.message, records: null});
        });
        return true;
    }

    if (request.proxyFunction == "querySoqlLocal") {
        sendToOffscreen({
            action: 'querySoql',
            connType: 'local',
            soql: request.soql
        }).then(response => {
            sendResponse({err: response.error || null, records: response.records});
        }).catch(err => {
            console.error('Error in querySoqlLocal:', err);
            sendResponse({err: err.message, records: null});
        });
        return true;
    }

    if (request.proxyFunction == "querySoqlDeploy") {
        sendToOffscreen({
            action: 'querySoql',
            connType: 'deploy',
            soql: request.soql
        }).then(response => {
            sendResponse({err: response.error || null, records: response.records});
        }).catch(err => {
            console.error('Error in querySoqlDeploy:', err);
            sendResponse({err: err.message, records: null});
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
        compareContents(request.entityType, request.itemName, request.localOrg, request.targetOrg);
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

function connectToLocalOauth(sendResponse) {
    connectToOrg(sendResponse, 'sandbox', 'local');
}

function connectToOrg(sendResponse, environment, connType, customHost) {
    var auth_url = buildAuthUrl(environment, customHost);

    // Keep the service worker alive while the user interacts with the OAuth
    // popup. 30-second idle timers in MV3 can otherwise drop the pending
    // callback if the user pauses for 2FA / password managers / SSO flows.
    startKeepAlive();
    chrome.identity.launchWebAuthFlow({'url': auth_url, 'interactive': true}, async function (redirect_url) {
        try {
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
        } finally {
            stopKeepAlive();
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
    const deployResponse = await sendToOffscreen({
        action: 'deploy',
        zipData: zipData,
        opts: opts
    });

    if (deployResponse.error) {
        port.postMessage({result: null, response: null, err: deployResponse.error});
        return;
    }
    await cshHandoffDeployToPage(port, deployResponse.result.id);
}

// Hand the deploy over to the page so it can poll Salesforce's Metadata REST
// API directly. The SW → offscreen → jsforce polling loop was unreliable
// past the MV3 service-worker suspension window and the offscreen doc's
// 5-minute inactivity timer; the page is the stablest context in the system
// and setInterval works there without any keep-alive gymnastics.
async function cshHandoffDeployToPage(port, deployId) {
    try {
        var orgId = cshActiveDeployOrgId;
        if (!orgId) {
            port.postMessage({result: null, response: null, err: 'No active deploy org — please sign in again.'});
            return;
        }
        var fresh = await cshGetFreshDeployToken(orgId);
        port.postMessage({
            handoff: {
                deployId: deployId,
                orgId: orgId,
                instanceUrl: fresh.instanceUrl,
                accessToken: fresh.accessToken,
                apiVersion: CSH_APIVERSION
            }
        });
    } catch (err) {
        console.error('cshHandoffDeployToPage failed:', err);
        port.postMessage({result: null, response: null, err: err.message || String(err)});
    }
}

async function pollDeployStatus(port, deployId) {
    // setInterval in an MV3 service worker dies when the worker suspends —
    // a common outcome on long-running deploys, which leaves the client UI
    // stuck at "starting deploy...". An awaited while-loop keeps the deploy()
    // caller's Promise pending, which combines with keep-alive and the open
    // port to hold the SW through the whole poll cycle.
    console.log('[CSH deploy] pollDeployStatus started for id=' + deployId);
    const startTime = Date.now();
    let tick = 0;
    while (true) {
        await new Promise(function (r) { setTimeout(r, POLLINTERVAL); });
        tick++;
        try {
            const statusResponse = await sendToOffscreen({
                action: 'checkDeployStatus',
                deployId: deployId
            });

            if (statusResponse.error) {
                console.log('[CSH deploy] poll tick=' + tick + ' error:', statusResponse.error);
                port.postMessage({result: null, response: null, err: statusResponse.error});
                return;
            }

            console.log('[CSH deploy] poll tick=' + tick +
                ' status=' + statusResponse.result.status +
                ' done=' + statusResponse.result.done);

            port.postMessage({
                result: {id: deployId, state: statusResponse.result.status},
                response: statusResponse.result,
                err: null
            });

            if (statusResponse.result.done) {
                port.postMessage({response: null, err: null, result: statusResponse.result});
                return;
            }

            if (Date.now() - startTime > POLLTIMEOUT) {
                port.postMessage({result: null, response: null, err: 'Deploy timeout'});
                return;
            }
        } catch (err) {
            console.log('[CSH deploy] poll tick=' + tick + ' threw:', err);
            try { port.postMessage({result: null, response: null, err: err.toString()}); }
            catch (_) { /* port disconnected — nothing to do */ }
            return;
        }
    }
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
            await cshHandoffDeployToPage(port, response.result.id);
        }
    } catch (err) {
        console.error(err);
        port.postMessage({result: null, response: null, err: err.toString()});
    }
}

function compareContents(type, item, localOrg, targetOrg) {
    // Encode every piece — item names can contain &, #, space, ? or / (e.g.
    // "FolderA/MyReport"); org labels are hostnames/usernames and usually
    // safe but encoding them keeps the URL parser honest if a label ever
    // includes a space or symbol. The popup decodes with decodeURIComponent.
    var url = "compare.html?item=" + encodeURIComponent(item);
    if (localOrg) url += "&localOrg=" + encodeURIComponent(localOrg);
    if (targetOrg) url += "&targetOrg=" + encodeURIComponent(targetOrg);
    chrome.windows.create({'url': url, 'type': "popup", "focused": false},
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
