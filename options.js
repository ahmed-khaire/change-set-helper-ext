// ---------------------------------------------------------------------------
// Change Set Helper — Options page
//   - API version preference
//   - Connected App OAuth diagnostic: runs a full code + PKCE flow against
//     Salesforce so you can verify the connected app returns refresh_token
//     BEFORE we commit to wiring the real PKCE auth fallback.
// ---------------------------------------------------------------------------

var DEFAULT_CLIENT_ID = '3MVG97quAmFZJfVzlPO9kMeS90FBVJuF7x_gWYYRdhK9UAMWuk9WVaCMTqKAUEf2u4ge.OhGG_2vYl.EO3e.i';

// -------------------------------------------------------------- API version
function save_options(e) {
    if (e) e.preventDefault();
    var salesforceApiVersion = document.getElementById('salesforceApiVersion').value;
    chrome.storage.sync.set({ salesforceApiVersion: salesforceApiVersion }, function () {
        var status = document.getElementById('status');
        status.textContent = 'Saved.';
        setTimeout(function () { status.textContent = ''; }, 900);
    });
    return false;
}

function restore_options() {
    chrome.storage.sync.get(['salesforceApiVersion', 'cshOauthClientId'], function (items) {
        var versionPattern = new RegExp('^[0-9][0-9]\\.0$');
        var apiversion = versionPattern.test(items.salesforceApiVersion) ? items.salesforceApiVersion : '60.0';
        document.getElementById('salesforceApiVersion').value = apiversion;

        var savedId = items.cshOauthClientId || DEFAULT_CLIENT_ID;
        document.getElementById('diagClientId').value = savedId;
        document.getElementById('defaultClientIdHint').textContent =
            savedId === DEFAULT_CLIENT_ID
                ? 'Using the default client id baked into the extension.'
                : 'Using a saved custom client id (differs from the default).';
    });
}

// -------------------------------------------------------------- Helpers
function byId(id) { return document.getElementById(id); }

function base64url(bytes) {
    var str = '';
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkce() {
    var rand = new Uint8Array(32);
    crypto.getRandomValues(rand);
    var verifier = base64url(rand);
    var hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    var challenge = base64url(new Uint8Array(hash));
    return { verifier: verifier, challenge: challenge };
}

function getRedirectUri() {
    // chrome.identity.getRedirectURL appends the provided "path" after the
    // chromiumapp.org host; we've used "sfdc" everywhere else in the extension.
    return chrome.identity.getRedirectURL('sfdc');
}

function getAuthorizationHost(kind, myDomain) {
    if (kind === 'prod') return 'https://login.salesforce.com';
    if (kind === 'sandbox') return 'https://test.salesforce.com';
    if (kind === 'mydomain') {
        var m = (myDomain || '').trim();
        if (!m) return null;
        if (!/^https?:\/\//i.test(m)) m = 'https://' + m;
        return m.replace(/\/+$/, '');
    }
    return null;
}

function renderResult(html) {
    byId('diagResults').innerHTML = html;
}

function resultLine(ok, message, extra) {
    var cls = ok === true ? 'check-pass'
            : ok === false ? 'check-fail'
            : 'check-info';
    var icon = ok === true ? '✓' : ok === false ? '✗' : '·';
    return '<div class="' + cls + '">' + icon + ' ' + escapeHtml(message) + '</div>' +
           (extra ? '<div class="muted" style="margin-left:14px">' + extra + '</div>' : '');
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function advice(body) {
    return '<div class="advice">' + body + '</div>';
}

// -------------------------------------------------------------- Diagnostic flow
async function runDiagnostic() {
    var clientId = byId('diagClientId').value.trim();
    var envKind = byId('diagEnvKind').value;
    var myDomain = byId('diagMyDomain').value;
    var authHost = getAuthorizationHost(envKind, myDomain);
    var redirectUri = getRedirectUri();

    var lines = [];
    lines.push('<h3>Diagnostic results</h3>');

    if (!clientId) {
        lines.push(resultLine(false, 'No client id supplied'));
        renderResult(lines.join(''));
        return;
    }
    if (!authHost) {
        lines.push(resultLine(false, 'No authorization host — enter a My Domain URL or pick another environment'));
        renderResult(lines.join(''));
        return;
    }

    lines.push(resultLine(null, 'Client ID: ' + clientId.slice(0, 18) + '…'));
    lines.push(resultLine(null, 'Authorization host: ' + authHost));
    lines.push(resultLine(null, 'Redirect URI (must be in Connected App): ' + redirectUri));
    renderResult(lines.join(''));

    // PKCE
    var pkce;
    try {
        pkce = await generatePkce();
        lines.push(resultLine(true, 'PKCE verifier + challenge generated'));
    } catch (err) {
        lines.push(resultLine(false, 'PKCE generation failed: ' + err.message));
        renderResult(lines.join(''));
        return;
    }

    // Authorization request
    var state = Math.random().toString(36).slice(2);
    var authUrl = authHost + '/services/oauth2/authorize' +
        '?response_type=code' +
        '&client_id=' + encodeURIComponent(clientId) +
        '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&scope=' + encodeURIComponent('api refresh_token id') +
        '&code_challenge=' + encodeURIComponent(pkce.challenge) +
        '&code_challenge_method=S256' +
        '&state=' + state;
    lines.push(resultLine(null, 'Authorization URL built'));
    lines.push(
        '<details style="margin-left:14px"><summary class="muted">Show full authorization URL</summary>' +
        '<pre style="max-height:160px">' + escapeHtml(authUrl) + '</pre>' +
        '<p><button type="button" class="secondary" id="openAuthUrlBtn">Open this URL in a new tab (bypasses the popup)</button> ' +
        '<span class="muted">— use this if the popup shows \"Authorization page could not be loaded\"; you\'ll see the real Salesforce error.</span></p>' +
        '</details>'
    );
    renderResult(lines.join(''));
    var openBtn = byId('openAuthUrlBtn');
    if (openBtn) openBtn.addEventListener('click', function () { window.open(authUrl, '_blank'); });

    var redirectResult;
    try {
        redirectResult = await new Promise(function (resolve, reject) {
            chrome.identity.launchWebAuthFlow(
                { url: authUrl, interactive: true },
                function (redirected) {
                    if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                    if (!redirected) return reject(new Error('No redirect URL returned'));
                    resolve(redirected);
                }
            );
        });
    } catch (err) {
        lines.push(resultLine(false, 'launchWebAuthFlow failed: ' + err.message));
        if (/Authorization page could not be loaded/i.test(err.message)) {
            lines.push(advice(
                '<strong>Salesforce refused to render the authorize page.</strong> This is NOT a redirect mismatch — ' +
                'it means the initial request to <code>/services/oauth2/authorize</code> failed before any redirect could happen. ' +
                'Common causes, in order of likelihood:' +
                '<ol>' +
                '<li><strong>Invalid <code>client_id</code></strong> — the Consumer Key is wrong or the connected app was deleted. ' +
                'Copy it fresh from Setup → App Manager → [your app] → View → Manage Consumer Details.</li>' +
                '<li><strong>Wrong environment</strong> — a connected app defined in a Sandbox is <em>not</em> reachable via ' +
                '<code>login.salesforce.com</code>. Try <em>Sandbox</em> or the My Domain URL instead.</li>' +
                '<li><strong>Callback URL not registered</strong> — add <code>' + escapeHtml(redirectUri) + '</code> to the ' +
                'connected app\'s Callback URL list and wait 5–10 minutes for propagation.</li>' +
                '<li><strong>Connected app is not yet available</strong> — Salesforce can take 2–10 minutes after ' +
                'creating / editing a connected app before <code>/services/oauth2/authorize</code> recognises it.</li>' +
                '<li><strong>Scope <code>refresh_token</code> not selected</strong> on the connected app — requesting ' +
                'a scope the app doesn\'t support can 400 before the page renders.</li>' +
                '</ol>' +
                'Click <em>Open this URL in a new tab</em> above — Salesforce\'s own error page will tell you exactly which of these applies.'
            ));
        } else if (/redirect_uri_mismatch/i.test(err.message) ||
                   /redirect/i.test(err.message)) {
            lines.push(advice(
                'The Connected App does not accept our redirect URL. Add <code>' +
                escapeHtml(redirectUri) + '</code> to the connected app\'s Callback URL list ' +
                '(Setup → App Manager → [your app] → Edit → Callback URL).'
            ));
        } else if (/User did not approve|canceled|user_cancelled/i.test(err.message)) {
            lines.push(advice('You closed the auth popup before finishing. Re-run the test and complete the login.'));
        }
        renderResult(lines.join(''));
        return;
    }

    // Parse the redirect
    var urlObj;
    try { urlObj = new URL(redirectResult); } catch (_) { urlObj = null; }
    var params = urlObj ? new URLSearchParams(urlObj.search) : new URLSearchParams();
    var code = params.get('code');
    var returnedState = params.get('state');
    var authError = params.get('error');
    var authErrorDesc = params.get('error_description');

    if (authError) {
        lines.push(resultLine(false, 'Authorization failed: ' + authError));
        if (authErrorDesc) lines.push(resultLine(null, authErrorDesc));
        if (authError === 'invalid_client_id') {
            lines.push(advice(
                'Salesforce does not recognise the client id. Double-check the Consumer Key ' +
                'in Setup → App Manager → [your app] → View → Manage Consumer Details.'
            ));
        }
        renderResult(lines.join(''));
        return;
    }
    if (returnedState !== state) {
        lines.push(resultLine(false, 'State mismatch — possible CSRF. Aborting.'));
        renderResult(lines.join(''));
        return;
    }
    if (!code) {
        lines.push(resultLine(false, 'No authorization code in redirect URL'));
        renderResult(lines.join(''));
        return;
    }
    lines.push(resultLine(true, 'Authorization code received'));
    renderResult(lines.join(''));

    // Token exchange
    var tokenUrl = authHost + '/services/oauth2/token';
    var body = new URLSearchParams();
    body.append('grant_type', 'authorization_code');
    body.append('code', code);
    body.append('redirect_uri', redirectUri);
    body.append('client_id', clientId);
    body.append('code_verifier', pkce.verifier);

    var tokenJson;
    try {
        var resp = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
        tokenJson = await resp.json();
        if (!resp.ok) {
            lines.push(resultLine(false, 'Token exchange returned HTTP ' + resp.status));
            if (tokenJson && tokenJson.error) {
                lines.push(resultLine(null, tokenJson.error + (tokenJson.error_description ? ': ' + tokenJson.error_description : '')));
                interpretTokenError(lines, tokenJson);
            }
            renderResult(lines.join(''));
            return;
        }
        lines.push(resultLine(true, 'Token exchange succeeded (HTTP 200)'));
    } catch (err) {
        lines.push(resultLine(false, 'Token exchange network error: ' + err.message));
        renderResult(lines.join(''));
        return;
    }

    // Inspect token response
    if (tokenJson.access_token) {
        lines.push(resultLine(true, 'access_token returned (' + tokenJson.access_token.length + ' chars)'));
    } else {
        lines.push(resultLine(false, 'No access_token in response'));
    }
    if (tokenJson.refresh_token) {
        lines.push(resultLine(true, 'refresh_token returned — connected app is configured for long-lived sessions ✓'));
    } else {
        lines.push(resultLine(false, 'No refresh_token returned'));
        lines.push(advice(
            'Add <strong>Perform requests at any time (refresh_token, offline_access)</strong> ' +
            'to the connected app\'s <em>Selected OAuth Scopes</em>. ' +
            'Setup → App Manager → [your app] → Edit → Selected OAuth Scopes. ' +
            'Then wait up to 10 minutes and re-run this test.'
        ));
    }
    if (tokenJson.instance_url) {
        lines.push(resultLine(true, 'instance_url: ' + tokenJson.instance_url));
    } else {
        lines.push(resultLine(false, 'No instance_url — unusual; check the Salesforce org\'s API version support'));
    }
    if (tokenJson.scope) {
        lines.push(resultLine(null, 'scopes granted: ' + tokenJson.scope));
        if (!/refresh_token/.test(tokenJson.scope) && !/offline_access/.test(tokenJson.scope)) {
            lines.push(advice(
                'The granted scopes do not include <code>refresh_token</code>. ' +
                'The <em>user</em> may have deselected it during consent, or the connected app ' +
                'scope list doesn\'t offer it. Re-check the connected app\'s Selected OAuth Scopes.'
            ));
        }
    }
    if (tokenJson.id) {
        lines.push(resultLine(null, 'identity URL: ' + tokenJson.id));
    }

    // Show the save button when we got a usable access_token
    if (tokenJson.access_token) {
        byId('saveClientId').style.display = '';
    }

    renderResult(lines.join(''));
}

function interpretTokenError(lines, tokenJson) {
    var code = tokenJson.error;
    if (code === 'invalid_grant') {
        lines.push(advice(
            'Salesforce rejected the authorization code. Common causes: ' +
            '<ul>' +
            '<li>The <em>code_verifier</em> doesn\'t match the <em>code_challenge</em> — not an issue with this page\'s flow.</li>' +
            '<li>The Connected App has <strong>Require Secret for Web Server Flow</strong> CHECKED. ' +
            'Uncheck it — browser extensions cannot hold a client secret.</li>' +
            '<li>The Connected App has <strong>Require Proof Key for Code Exchange (PKCE)</strong> unchecked ' +
            'AND a secret is required. Either enable PKCE, or uncheck the secret requirement.</li>' +
            '</ul>'
        ));
    } else if (code === 'unsupported_grant_type') {
        lines.push(advice(
            '<code>authorization_code</code> grant not enabled. ' +
            'In App Manager → [your app] → Edit, ensure OAuth Settings are enabled and the ' +
            'connected app is accessible via OAuth (not just the SAML side).'
        ));
    } else if (code === 'redirect_uri_mismatch') {
        lines.push(advice(
            'The Callback URL in the connected app does not include <code>' +
            escapeHtml(getRedirectUri()) + '</code>. Add it to the Callback URL list and wait 10 minutes for propagation.'
        ));
    } else if (code === 'invalid_client_id') {
        lines.push(advice(
            'The Consumer Key (client id) is wrong or the connected app has been deleted.'
        ));
    }
}

// -------------------------------------------------------------- Wiring
function wireDiagnostic() {
    byId('redirectUriHint').textContent = getRedirectUri();
    byId('defaultClientIdHint').setAttribute('title', 'Default: ' + DEFAULT_CLIENT_ID);

    byId('diagEnvKind').addEventListener('change', function () {
        byId('diagMyDomain').style.display = this.value === 'mydomain' ? '' : 'none';
    });
    byId('resetClientId').addEventListener('click', function () {
        byId('diagClientId').value = DEFAULT_CLIENT_ID;
    });
    byId('runDiag').addEventListener('click', function () {
        byId('saveClientId').style.display = 'none';
        runDiagnostic().catch(function (e) {
            renderResult('<div class="check-fail">Unexpected error: ' + escapeHtml(e.message) + '</div>');
        });
    });
    byId('saveClientId').addEventListener('click', function () {
        var id = byId('diagClientId').value.trim();
        chrome.storage.sync.set({ cshOauthClientId: id }, function () {
            var btn = byId('saveClientId');
            btn.textContent = 'Saved ✓';
            setTimeout(function () { btn.textContent = 'Save this client id'; }, 1600);
        });
    });
}

// -------------------------------------------------------------- Boot
document.addEventListener('DOMContentLoaded', function () {
    restore_options();
    wireDiagnostic();
    var form = document.getElementById('form');
    if (form) form.onsubmit = save_options;
});
