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

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function showInstructions(opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var existing = document.getElementById('csh-oauth-instructions');
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            var previousFocus = document.activeElement;
            var modal = document.createElement('div');
            modal.id = 'csh-oauth-instructions';
            modal.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(8,7,7,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
            modal.innerHTML =
                '<div role="dialog" aria-modal="true" aria-labelledby="csh-oauth-title" style="background:#fff;color:#181818;width:min(640px,100%);max-height:90vh;overflow:auto;border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,.28);font:13px/1.45 Arial,sans-serif;">' +
                  '<div style="padding:16px 18px;border-bottom:1px solid #dddbda;">' +
                    '<h2 id="csh-oauth-title" style="margin:0;font-size:18px;color:#032d60;">Connect Change Set Helper to Salesforce</h2>' +
                  '</div>' +
                  '<div style="padding:16px 18px;">' +
                    '<p style="margin:0 0 12px;">' + escapeHtml(opts.message || 'The extension needs OAuth access to call Salesforce APIs for metadata, compare, validation, deployment, and cache refresh.') + '</p>' +
                    '<div style="display:grid;gap:10px;margin-top:12px;">' +
                      '<div style="border:1px solid #dddbda;border-radius:6px;padding:12px;">' +
                        '<strong>Option 1: Use the extension connected app</strong>' +
                        '<p style="margin:6px 0 0;color:#444;">Fastest setup. You will be redirected to Salesforce and asked to approve the connected app used by this extension. Change-set and metadata data is loaded and processed locally in your browser; the extension does not save that data to any external system.</p>' +
                      '</div>' +
                      '<div style="border:1px solid #dddbda;border-radius:6px;padding:12px;">' +
                        '<strong>Option 2: Use your own connected app</strong>' +
                        '<p style="margin:6px 0 8px;color:#444;">Recommended for orgs that require admin-owned OAuth apps.</p>' +
                        '<ol style="margin:0 0 0 18px;padding:0;color:#444;">' +
                          '<li>In Salesforce, go to <strong>Setup &gt; App Manager &gt; New Connected App</strong>.</li>' +
                          '<li>Enable <strong>OAuth Settings</strong> and paste the callback URL from this extension&apos;s Options page.</li>' +
                          '<li>Add OAuth scopes: <strong>Manage user data via APIs (api)</strong>, <strong>Access the identity URL service</strong>, and <strong>Perform requests at any time (refresh_token, offline_access)</strong>.</li>' +
                          '<li>For browser-extension PKCE flow, leave client-secret requirements unchecked and enable PKCE if your org supports it.</li>' +
                          '<li>Save the connected app, copy its <strong>Consumer Key</strong>, paste it in Options, then return here and sign in.</li>' +
                        '</ol>' +
                      '</div>' +
                    '</div>' +
                  '</div>' +
                  '<div style="padding:12px 18px;border-top:1px solid #dddbda;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">' +
                    '<button type="button" class="csh-oauth-cancel" style="padding:7px 14px;border:1px solid #c9c9c9;background:#fff;border-radius:4px;cursor:pointer;">Cancel</button>' +
                    '<button type="button" class="csh-oauth-options" style="padding:7px 14px;border:1px solid #0176d3;background:#fff;color:#0176d3;border-radius:4px;cursor:pointer;">Configure My Own App</button>' +
                    '<button type="button" class="csh-oauth-default" style="padding:7px 14px;border:1px solid #0176d3;background:#0176d3;color:#fff;border-radius:4px;cursor:pointer;">Use Extension App</button>' +
                  '</div>' +
                '</div>';
            function focusableElements() {
                return Array.prototype.slice.call(modal.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                )).filter(function (el) {
                    return !el.disabled && el.offsetParent !== null;
                });
            }
            function close(value) {
                document.removeEventListener('keydown', onKeyDown, true);
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                if (previousFocus && previousFocus.focus) {
                    try { previousFocus.focus(); } catch (_) {}
                }
                resolve(value);
            }
            function onKeyDown(ev) {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    close('cancel');
                    return;
                }
                if (ev.key !== 'Tab') return;
                var focusables = focusableElements();
                if (!focusables.length) return;
                var first = focusables[0];
                var last = focusables[focusables.length - 1];
                if (ev.shiftKey && document.activeElement === first) {
                    ev.preventDefault();
                    last.focus();
                } else if (!ev.shiftKey && document.activeElement === last) {
                    ev.preventDefault();
                    first.focus();
                }
            }
            modal.addEventListener('click', function (ev) {
                if (ev.target === modal) close('cancel');
            });
            document.addEventListener('keydown', onKeyDown, true);
            modal.querySelector('.csh-oauth-cancel').addEventListener('click', function () { close('cancel'); });
            modal.querySelector('.csh-oauth-default').addEventListener('click', function () { close('default'); });
            modal.querySelector('.csh-oauth-options').addEventListener('click', function () {
                try {
                    window.open(chrome.runtime.getURL('pages/options.html'), '_blank');
                } catch (_) {
                    window.open('/pages/options.html', '_blank');
                }
                close('options');
            });
            document.body.appendChild(modal);
            modal.querySelector('.csh-oauth-default').focus();
        });
    }

    return {
        login: login,
        logout: logout,
        getAccessToken: getAccessToken,
        showInstructions: showInstructions
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

// 3a2) Downloads.
//
//      Blob-anchor downloads (a[download] + click) are broken inside the
//      Lightning Setup iframe: without a real user gesture Chrome treats the
//      blob navigation as a POPUP — it lands in Salesforce's queued "Open
//      this page?" prompt and, even when allowed, opens the raw blob in a tab
//      instead of saving. With a gesture the file does save, but Chrome
//      ignores the anchor's download attribute in this context and names the
//      file after the blob UUID. Routing through chrome.downloads in the
//      service worker sidesteps all of it: no gesture requirement, no popup
//      blocker, correct filename.
window.cshDownload = function (filename, data, mime) {
    return new Promise(function (resolve, reject) {
        var blob = (typeof Blob !== 'undefined' && data instanceof Blob)
            ? data
            : new Blob([data], { type: mime || 'application/octet-stream' });
        // The payload crosses one runtime message as base64 (~4/3 expansion)
        // against Chrome's 64MiB message ceiling. Guard well below it — a
        // clear error beats an opaque messaging failure. Bigger exports need
        // a chunked/offscreen path, not a bigger limit here.
        var MAX_BYTES = 40 * 1024 * 1024;
        if (blob.size > MAX_BYTES) {
            reject(new Error('Export is ' + Math.round(blob.size / 1048576) +
                ' MB — larger than the ' + Math.round(MAX_BYTES / 1048576) +
                ' MB download limit.'));
            return;
        }
        var fr = new FileReader();
        fr.onerror = function () { reject(fr.error || new Error('Could not read export data')); };
        fr.onload = function () {
            try {
                chrome.runtime.sendMessage(
                    { type: 'cshDownload', filename: filename, url: fr.result },
                    function (resp) {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else if (!resp || !resp.ok) {
                            reject(new Error((resp && resp.error) || 'Download failed'));
                        } else {
                            resolve(resp.downloadId);
                        }
                    }
                );
            } catch (e) { reject(e); }
        };
        // data: URL keeps the payload self-contained across the message —
        // the service worker cannot resolve a content script's blob: URL.
        fr.readAsDataURL(blob);
    });
};

// 3b) In-page confirm/alert dialogs.
//
//     Chrome 92+ ignores window.confirm/alert/prompt called from a cross-origin
//     iframe: the call returns immediately (confirm -> false) and only logs a
//     console warning. In Lightning, Setup renders the Visualforce change-set
//     pages inside exactly such an iframe (shell on *.lightning.force.com, frame
//     on *--c.vf.force.com / *.my.salesforce-setup.com), so every action written
//     as `if (!confirm(...)) return;` became a silent no-op — the "button does
//     nothing" reports. In Classic the same code sits in the top frame and works,
//     which is why this never showed up in testing.
//
//     These replacements are real DOM, so they work in any frame. Styles are
//     inline on purpose: css/cart.css (which carries .csh-modal-scrim) is not
//     loaded in the changeview.js content-script context, and a dialog that
//     silently renders unstyled would be its own failure mode.
(function () {
    // Max int32. Must sit above the extension's OWN overlays too, not just
    // Salesforce's: the cart panel is 2147483644 (css/cart.css) and the existing
    // modals are 2147483645/2147483646 (cart.css, changeset.css). At a lower
    // value a cart-triggered dialog renders beneath the cart panel, leaving the
    // panel clickable above the scrim.
    var Z = 2147483647;

    function buildButton(label, kind) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        var bg = kind === 'danger' ? '#ba0517' : kind === 'primary' ? '#0176d3' : '#ffffff';
        var fg = kind === 'ghost' ? '#0176d3' : '#ffffff';
        var border = kind === 'ghost' ? '#c9c9c9' : bg;
        b.style.cssText = [
            'background:' + bg,
            'color:' + fg,
            'border:1px solid ' + border,
            'border-radius:4px',
            'padding:7px 16px',
            'font:13px/1.2 "Salesforce Sans", Arial, sans-serif',
            'cursor:pointer',
            'min-width:72px'
        ].join(';');
        return b;
    }

    // Only one dialog may be open at a time. Native confirm() blocked the JS
    // thread, so double-clicking a destructive button was impossible; an async
    // dialog removes that protection. Two open dialogs is not merely untidy —
    // both register a document-level keydown listener, and stopPropagation()
    // does not stop other listeners on the same node, so a single Escape or
    // Enter resolves BOTH, which on the deploy path means two deploys.
    var activeDialog = null;
    var uidSeq = 0;

    // Shared shell. `buttons` is [{label, kind, value}]; resolves with the
    // clicked button's value. escValue is what Escape / scrim-click resolves to.
    function open(opts) {
        var message = String(opts.message == null ? '' : opts.message);
        var title = opts.title || 'Change Set Helper';
        var buttons = opts.buttons || [];
        var escValue = opts.escValue;

        // A second request is refused, not queued and not merged. Returning the
        // active dialog's promise would make one confirmation approve both
        // callers — exactly the double-action this guard exists to prevent — so
        // the loser resolves as if it had been cancelled.
        if (activeDialog) {
            try {
                if (activeDialog.focusFirst) activeDialog.focusFirst();
            } catch (_) {}
            return Promise.resolve(escValue);
        }

        return new Promise(function (resolve) {
            var settled = false;
            var previousFocus = document.activeElement;
            var seq = ++uidSeq;

            function finish(value) {
                if (settled) return;
                settled = true;
                if (activeDialog && activeDialog.seq === seq) activeDialog = null;
                document.removeEventListener('keydown', onKey, true);
                if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
                // Return focus where the user left it so a keyboard user isn't
                // dumped back at the top of the document.
                try {
                    if (previousFocus && previousFocus.focus) previousFocus.focus();
                } catch (_) {}
                resolve(value);
            }

            var scrim = document.createElement('div');
            scrim.style.cssText = [
                'position:fixed', 'inset:0', 'top:0', 'right:0', 'bottom:0', 'left:0',
                'background:rgba(0,0,0,0.45)',
                'z-index:' + Z,
                'display:flex', 'align-items:center', 'justify-content:center',
                // Scrollable so a dialog taller than a short iframe viewport can
                // still be reached rather than being clipped with its buttons
                // off-screen.
                'overflow:auto',
                'padding:20px'
            ].join(';');

            var titleId = 'csh-dlg-t' + seq;
            var msgId = 'csh-dlg-m' + seq;
            var box = document.createElement('div');
            box.setAttribute('role', 'alertdialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-labelledby', titleId);
            box.setAttribute('aria-describedby', msgId);
            box.style.cssText = [
                'background:#ffffff', 'color:#080707',
                'border-radius:6px',
                'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
                // border-box or the 22px side padding is added OUTSIDE width:100%
                // and the box overflows a narrow iframe.
                'box-sizing:border-box',
                'max-width:520px', 'width:100%',
                'max-height:80vh', 'overflow:auto',
                'padding:20px 22px',
                'font:14px/1.45 "Salesforce Sans", Arial, sans-serif'
            ].join(';');

            var h = document.createElement('h3');
            h.id = titleId;
            h.textContent = title;
            h.style.cssText = 'margin:0 0 10px;font-size:17px;font-weight:700;';

            // textContent, never innerHTML — messages interpolate org-controlled
            // values (component names, change set labels, org usernames).
            var p = document.createElement('div');
            p.id = msgId;
            p.textContent = message;
            p.style.cssText = 'margin:0 0 18px;white-space:pre-wrap;word-break:break-word;';

            var actions = document.createElement('div');
            actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';

            var firstDefault = null;
            buttons.forEach(function (spec) {
                var b = buildButton(spec.label, spec.kind);
                b.addEventListener('click', function () { finish(spec.value); });
                if (spec.isDefault && !firstDefault) firstDefault = b;
                actions.appendChild(b);
            });

            box.appendChild(h);
            box.appendChild(p);
            // Optional text field (prompt replacement). Sits between the
            // message and the actions so tab order reads naturally.
            if (opts.field) box.appendChild(opts.field);
            box.appendChild(actions);
            scrim.appendChild(box);

            scrim.addEventListener('click', function (ev) {
                if (ev.target === scrim) finish(escValue);
            });

            // Tab-cycle targets, in visual order.
            function focusables() {
                var list = [];
                if (opts.field) list.push(opts.field);
                Array.prototype.forEach.call(actions.children, function (el) {
                    if (!el.disabled) list.push(el);
                });
                return list;
            }

            function focusFirst() {
                var f = focusables()[0];
                if (f) { try { f.focus(); } catch (_) {} }
            }

            function onKey(ev) {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    finish(escValue);
                    return;
                }
                if (ev.key === 'Enter' && firstDefault) {
                    // Let Enter inside a textarea behave normally if one is ever
                    // added; a single-line input has no competing behaviour.
                    ev.preventDefault();
                    ev.stopPropagation();
                    firstDefault.click();
                    return;
                }
                if (ev.key !== 'Tab') return;
                // Focus trap: aria-modal is a promise to assistive tech that the
                // rest of the page is inert, so Tab must not reach the
                // background controls sitting behind the scrim.
                var list = focusables();
                if (!list.length) return;
                var first = list[0];
                var last = list[list.length - 1];
                var active = document.activeElement;
                if (!box.contains(active)) {
                    ev.preventDefault();
                    try { (ev.shiftKey ? last : first).focus(); } catch (_) {}
                    return;
                }
                if (!ev.shiftKey && active === last) {
                    ev.preventDefault();
                    try { first.focus(); } catch (_) {}
                } else if (ev.shiftKey && active === first) {
                    ev.preventDefault();
                    try { last.focus(); } catch (_) {}
                }
            }
            // Capture phase: Salesforce's own key handlers are aggressive and
            // would otherwise swallow Escape/Tab before it reaches us.
            document.addEventListener('keydown', onKey, true);

            activeDialog = { seq: seq, focusFirst: focusFirst };

            // If anything below throws, the singleton flag must not stay set —
            // a stuck flag would refuse every future dialog and turn every
            // destructive action into a permanent silent no-op, which is the
            // exact failure this whole change set exists to remove.
            try {
                (document.body || document.documentElement).appendChild(scrim);
                // Focus the field when there is one — the user's next action is
                // typing, not clicking. Enter still activates the default button
                // via the keydown handler above.
                var toFocus = opts.field || firstDefault;
                if (toFocus) {
                    try { toFocus.focus(); } catch (_) {}
                }
            } catch (e) {
                console.error('Change Set Helper: could not open dialog', e);
                finish(escValue);
            }
        });
    }

    // Drop-in for window.confirm. Resolves true/false; NEVER throws, so callers
    // can always `if (!await cshDialog.confirm(...)) return;`.
    function confirmDialog(message, opts) {
        opts = opts || {};
        return open({
            message: message,
            title: opts.title || 'Confirm',
            escValue: false,
            buttons: [
                {
                    label: opts.confirmLabel || 'OK',
                    kind: opts.destructive ? 'danger' : 'primary',
                    value: true,
                    isDefault: true
                },
                { label: opts.cancelLabel || 'Cancel', kind: 'ghost', value: false }
            ]
        });
    }

    // Drop-in for window.alert.
    function alertDialog(message, opts) {
        opts = opts || {};
        return open({
            message: message,
            title: opts.title || 'Change Set Helper',
            escValue: undefined,
            buttons: [{ label: 'OK', kind: 'primary', value: undefined, isDefault: true }]
        }).then(function () {});
    }

    // Drop-in for window.prompt. Resolves the trimmed string, or null if the
    // user cancelled — same contract callers already branch on.
    function promptDialog(message, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var input = document.createElement('input');
            input.type = 'text';
            input.value = opts.defaultValue || '';
            input.style.cssText = [
                'width:100%', 'box-sizing:border-box',
                'margin:0 0 18px', 'padding:7px 9px',
                'border:1px solid #c9c9c9', 'border-radius:4px',
                'font:14px/1.4 "Salesforce Sans", Arial, sans-serif'
            ].join(';');
            open({
                message: message,
                title: opts.title || 'Change Set Helper',
                escValue: null,
                field: input,
                buttons: [
                    { label: opts.confirmLabel || 'Save', kind: 'primary', value: 'submit', isDefault: true },
                    { label: 'Cancel', kind: 'ghost', value: null }
                ]
            }).then(function (v) {
                if (v !== 'submit') { resolve(null); return; }
                var val = String(input.value || '').trim();
                resolve(val || null);
            });
        });
    }

    window.cshDialog = {
        confirm: confirmDialog,
        alert: alertDialog,
        prompt: promptDialog,
        open: open
    };
})();

// 4) Dynamic Salesforce API version discovery.
//    Hits /services/data/ on the current host and picks the highest supported
//    version. Cached per-host in chrome.storage.local for 24h so we don't
//    round-trip every page load. Falls back to stored sync pref, then to 66.0.
(function () {
    var FALLBACK = '66.0';
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
    }).catch(function () { /* ignore — background falls back to 66.0 */ });
})();

// 5) ID mapping cache: 0A2 (outbound change set) ↔ 033 (metadata package).
//    Captured on the Add page (where both ids are visible — 0A2 in the
//    retURL parameter, 033 in <input id="id"> and the URL) and consumed
//    on the Detail page (where only the 0A2 is in the URL and resolving
//    the 033 otherwise requires loading the Add page in a hidden iframe —
//    which Salesforce often refuses to render).
//
//    Persisted in chrome.storage.local so the mapping survives across
//    tabs and sessions. Mappings never expire; the 0A2/033 pair is stable
//    for the lifetime of the change set.
(function () {
    var KEY = 'cshIdMap';
    function readMap() {
        return new Promise(function (resolve) {
            if (!chrome.storage || !chrome.storage.local) return resolve({});
            chrome.storage.local.get([KEY], function (items) {
                resolve((items && items[KEY]) || {});
            });
        });
    }
    function writeMap(map) {
        return new Promise(function (resolve) {
            if (!chrome.storage || !chrome.storage.local) return resolve();
            chrome.storage.local.set({ [KEY]: map }, function () { resolve(); });
        });
    }
    // The same 0A2 id reaches us as 15 or 18 chars depending on which page
    // scraped it (URL param vs retURL vs anchor href), so canonicalize keys
    // to the 15-char prefix — otherwise the Add page can write a mapping the
    // Detail page then misses.
    function keyFor(changeSetId) {
        return String(changeSetId).slice(0, 15);
    }
    async function getPackageId(changeSetId) {
        if (!changeSetId) return null;
        var map = await readMap();
        // Legacy entries may sit under the un-normalized (18-char) key.
        return map[keyFor(changeSetId)] || map[changeSetId] || null;
    }
    async function putMapping(changeSetId, packageId) {
        if (!changeSetId || !packageId) return;
        var map = await readMap();
        if (map[keyFor(changeSetId)] === packageId) return;
        map[keyFor(changeSetId)] = packageId;
        await writeMap(map);
    }
    window.cshIdMap = { getPackageId: getPackageId, putMapping: putMapping };
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
            // First pass: exact xmlName / childXmlNames match (fast, common).
            for (var i = 0; i < describeData.metadataObjects.length; i++) {
                var mo = describeData.metadataObjects[i];
                if (mo && mo.xmlName === uiName) return uiName;
                if (mo && Array.isArray(mo.childXmlNames)) {
                    for (var j = 0; j < mo.childXmlNames.length; j++) {
                        if (mo.childXmlNames[j] === uiName) return uiName;
                    }
                }
            }
            // Fallback: Salesforce's change-set picker occasionally sends a
            // display label ("Custom Metadata Type", "Auth. Provider",
            // "S-Control", "Auto-Response Rule") in #entityType instead of
            // the API name. Normalize by stripping every non-word character
            // and tolerate trailing "Type"/"Types" and singular/plural s
            // mismatches so new types Salesforce adds in label form resolve
            // automatically against describeMetadata without needing an
            // override-map entry.
            var normalized = String(uiName).replace(/[^A-Za-z0-9]/g, '');
            if (!normalized) return null;
            var candidates = [normalized];
            if (/Types?$/.test(normalized)) {
                candidates.push(normalized.replace(/Types?$/, ''));
            }
            for (var k = 0; k < describeData.metadataObjects.length; k++) {
                var mo2 = describeData.metadataObjects[k];
                if (!mo2 || !mo2.xmlName) continue;
                for (var c = 0; c < candidates.length; c++) {
                    var cand = candidates[c];
                    if (mo2.xmlName === cand) return mo2.xmlName;
                    // Tolerate "Rule"/"Rules", "Setting"/"Settings" style
                    // pluralization drift between label and xmlName either way.
                    if (mo2.xmlName === cand + 's') return mo2.xmlName;
                    if (mo2.xmlName + 's' === cand) return mo2.xmlName;
                }
                // Also walk childXmlNames with the same tolerances — covers
                // nested types (CustomField, ValidationRule, FieldSet, …).
                if (Array.isArray(mo2.childXmlNames)) {
                    for (var cx = 0; cx < mo2.childXmlNames.length; cx++) {
                        var child = mo2.childXmlNames[cx];
                        if (!child) continue;
                        for (var c2 = 0; c2 < candidates.length; c2++) {
                            var cand2 = candidates[c2];
                            if (child === cand2) return child;
                            if (child === cand2 + 's') return child;
                            if (child + 's' === cand2) return child;
                        }
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
