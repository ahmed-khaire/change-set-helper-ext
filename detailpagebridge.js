// ---------------------------------------------------------------------------
// Change Set Helper — Detail page MAIN-world bridge (diagnostic ping only).
//
// The bulk-remove flow on outboundChangeSetDetailPage USED to go through
// this bridge, clicking the per-row A4J Remove anchor then the confirmation
// modal's OK button. That approach hit an unkillable full-page reload after
// every delete (the A4J onclick path calls back into the form and triggers
// a native form submit that no combination of type=button + submit-blocker
// + form.submit override could prevent).
//
// Current bulk-remove path: detailcomponents.js issues classic-view Del
// URLs via fetch() directly — no UI, no bridge needed. This bridge survives
// only for the `ping` diagnostic so `cshDetailDiag()` still reports MAIN-
// world status.
// ---------------------------------------------------------------------------

(function () {
    'use strict';

    var OK_BUTTON_ID = 'simpleDialog0button0';

    window.addEventListener('message', function (ev) {
        var data = ev.data;
        if (!data || data.__cshBulk !== true || data.source === 'page') return;

        function reply(payload) {
            window.postMessage(
                Object.assign({ __cshBulk: true, source: 'page', mid: data.mid }, payload),
                '*'
            );
        }

        if (data.cmd === 'ping') {
            reply({
                ok: true,
                isMainWorld: true,
                isTopFrame: window === window.top,
                hasA4J: typeof A4J !== 'undefined',
                hasOkButton: !!document.getElementById(OK_BUTTON_ID),
                removeLinksOnPage: document.querySelectorAll('a[id*="removeLink"]').length,
                url: location.href.slice(0, 220)
            });
            return;
        }

        reply({ ok: false, error: 'unknown cmd: ' + data.cmd });
    });

    window.cshDetailDiag = function () {
        return {
            isMainWorld: true,
            isTopFrame: window === window.top,
            hasA4J: typeof A4J !== 'undefined',
            hasOkButton: !!document.getElementById(OK_BUTTON_ID),
            removeLinksOnPage: document.querySelectorAll('a[id*="removeLink"]').length,
            url: location.href.slice(0, 220)
        };
    };

    console.log('[CSH bridge] MAIN-world bridge installed on', location.href.slice(0, 120));
})();
