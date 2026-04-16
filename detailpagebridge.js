// ---------------------------------------------------------------------------
// Change Set Helper — Detail page MAIN-world bridge.
//
// Registered with "world": "MAIN" in manifest.json so this script loads
// directly into the page's JavaScript context — bypassing the CSP that
// refuses inline <script textContent="..."> injection. Here we have access
// to Salesforce's page-context globals: confirmRemoveComponent,
// deleteComponent, A4J, and the actual DOM elements / event handlers.
//
// Why we click the link rather than calling deleteComponent(cid) directly:
//   The native Remove link's onclick is:
//     confirmRemoveComponent(cid);
//     if (window != window.top) { form.action += '?' or '&' }  // iframe fix
//     A4J.AJAX.Submit(form, event, {...});
//     return false;
//
//   Calling deleteComponent(cid) alone passes `null` as the A4J event
//   argument. On some RichFaces builds that causes A4J to fall back to a
//   synchronous form.submit() which triggers a full page reload instead of
//   a partial AJAX update — which is exactly the bug the user hit (first
//   item deletes, page hard-reloads, nothing else happens). Clicking the
//   actual anchor element fires the real onclick with a real event, the
//   iframe fix runs, A4J takes the AJAX path, and no navigation happens.
//
// Payload
//   request  : { __cshBulk: true, cmd: 'delete', linkId: <anchor id>, mid: <id> }
//   request  : { __cshBulk: true, cmd: 'bulk-end', mid: <id> }
//   request  : { __cshBulk: true, cmd: 'ping', mid: <id> }
//   response : { __cshBulk: true, source: 'page', mid: <id>, ok, ...extras }
// ---------------------------------------------------------------------------

(function () {
    'use strict';

    // Override confirmRemoveComponent once while a bulk run is in flight so
    // each link.click() doesn't spawn a dialog. Restored via 'bulk-end'.
    var _origConfirmRemove = null;
    function silenceConfirm() {
        if (_origConfirmRemove !== null) return;
        if (typeof window.confirmRemoveComponent === 'function') {
            _origConfirmRemove = window.confirmRemoveComponent;
            window.confirmRemoveComponent = function () { /* no-op during bulk */ };
            console.log('[CSH bridge] confirmRemoveComponent silenced');
        }
    }
    function restoreConfirm() {
        if (_origConfirmRemove !== null) {
            window.confirmRemoveComponent = _origConfirmRemove;
            _origConfirmRemove = null;
            console.log('[CSH bridge] confirmRemoveComponent restored');
        }
    }

    window.addEventListener('message', function (ev) {
        var data = ev.data;
        if (!data || data.__cshBulk !== true || data.source === 'page') return;

        function reply(payload) {
            window.postMessage(
                Object.assign({ __cshBulk: true, source: 'page', mid: data.mid }, payload),
                '*'
            );
        }

        try {
            if (data.cmd === 'delete') {
                silenceConfirm();
                var link = document.getElementById(data.linkId);
                if (!link) {
                    throw new Error('remove link not in current DOM (may be on a different page): ' + data.linkId);
                }
                console.log('[CSH bridge] clicking', data.linkId);
                link.click();
                reply({ ok: true });
                return;
            }

            if (data.cmd === 'bulk-end') {
                restoreConfirm();
                reply({ ok: true });
                return;
            }

            if (data.cmd === 'ping') {
                reply({
                    ok: true,
                    isMainWorld: true,
                    isTopFrame: window === window.top,
                    hasDeleteComponent: typeof deleteComponent === 'function',
                    hasConfirmRemoveComponent: typeof confirmRemoveComponent === 'function',
                    hasA4J: typeof A4J !== 'undefined',
                    url: location.href.slice(0, 220)
                });
                return;
            }

            reply({ ok: false, error: 'unknown cmd: ' + data.cmd });
        } catch (err) {
            reply({ ok: false, error: err && err.message ? err.message : String(err) });
        }
    });

    // Expose a Console-callable diagnostic from MAIN world so the user can
    // paste `cshDetailDiag()` into DevTools without switching execution
    // context. Returns a plain object of health checks; no promises / no
    // postMessage roundtrip needed — it's just a function on window.
    window.cshDetailDiag = function () {
        return {
            isMainWorld: true,
            isTopFrame: window === window.top,
            hasDeleteComponent: typeof deleteComponent === 'function',
            hasConfirmRemoveComponent: typeof confirmRemoveComponent === 'function',
            hasA4J: typeof A4J !== 'undefined',
            hasRowForms: document.querySelectorAll('form[id*="detail_form"]').length,
            removeLinksOnPage: document.querySelectorAll('a[id*="removeLink"]').length,
            bulkSilenced: _origConfirmRemove !== null,
            url: location.href.slice(0, 220)
        };
    };

    console.log('[CSH bridge] MAIN-world bridge installed on', location.href.slice(0, 120));
})();
