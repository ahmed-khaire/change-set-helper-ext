// ---------------------------------------------------------------------------
// Change Set Helper — Detail page MAIN-world bridge.
//
// Registered in manifest.json with `"world": "MAIN"` so Chrome loads this
// script into the page's JavaScript context, where `deleteComponent`,
// `confirmRemoveComponent`, and `A4J.AJAX.Submit` are defined. Our isolated-
// world content script (detailcomponents.js) can't call those globals
// directly, and inline <script> injection is refused by Salesforce's CSP.
//
// The bridge is a single `message` listener. When our isolated-world script
// postMessages a delete command, this bridge invokes deleteComponent and
// responds with the original message id so the requester can correlate.
//
// Payloads
//   request  : { __cshBulk: true, cmd: 'delete', cid: <componentId>, mid: <id> }
//   response : { __cshBulk: true, source: 'page', mid: <id>, ok: bool, error?: string }
//
// This script runs on every load of the Outbound Change Set Detail page —
// including nested frames per the manifest's all_frames: true — which matches
// where our isolated content script runs so their windows coincide.
// ---------------------------------------------------------------------------

(function () {
    'use strict';

    window.addEventListener('message', function (ev) {
        var data = ev.data;
        if (!data || data.__cshBulk !== true || data.source === 'page') return;

        var mid = data.mid;
        function reply(payload) {
            // source:'page' prevents this listener from re-triggering on its own
            // replies (every reply goes through the same message event stream).
            window.postMessage(Object.assign({ __cshBulk: true, source: 'page', mid: mid }, payload), '*');
        }

        try {
            if (data.cmd === 'delete') {
                if (typeof deleteComponent !== 'function') {
                    throw new Error('deleteComponent is not defined in this frame');
                }
                // deleteComponent(cid) triggers an A4J AJAX partial page update.
                // Return immediately — our isolated-world caller uses a
                // MutationObserver on the row to know when the update landed.
                deleteComponent(data.cid);
                reply({ ok: true });
                return;
            }
            // Unknown cmd — respond with an error so the caller doesn't hang.
            reply({ ok: false, error: 'unknown cmd: ' + data.cmd });
        } catch (err) {
            reply({ ok: false, error: err && err.message ? err.message : String(err) });
        }
    });
})();
