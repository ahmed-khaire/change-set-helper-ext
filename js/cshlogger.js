// Change Set Helper console gate.
//
// Release default: console.log/warn/info/debug are muted.
// Development opt-in:
//   chrome.storage.local.set({ cshDevLogs: true })
//   localStorage.setItem('cshDevLogs', '1')
//   ?cshDevLogs=1 on extension pages/content-script pages

// Drop 'unload' listener registrations before the vendored libraries load.
//
// Salesforce serves Setup pages with `Permissions-Policy: unload=()` (part of
// Chrome's unload-handler deprecation), so every addEventListener('unload')
// is rejected and logged as a "Permissions policy violation" on the
// extension's error page. Two of our vendored libraries register one anyway:
// jQuery's Sizzle (an ancient IE memory-leak workaround in setDocument) and
// jsforce's event registry — both legacy cleanup that page teardown performs
// regardless, so losing the listeners changes nothing in Chrome. This file is
// the first script in every content-script context, and the shim only affects
// this extension's isolated world; the page's own listeners are untouched.
// 'beforeunload' and 'pagehide' pass through unmodified — cart.js relies on
// 'beforeunload' for its last-chance storage write.
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.addEventListener) return;
    try {
        var originalAdd = window.addEventListener.bind(window);
        window.addEventListener = function (type, listener, options) {
            // Exact match: DOM event types are case-sensitive and the policy
            // only governs the literal 'unload' type.
            if (type === 'unload') return undefined;
            return originalAdd(type, listener, options);
        };
    } catch (_) { /* shim is best-effort; violations are harmless noise */ }
})();

(function () {
    'use strict';

    var root = typeof globalThis !== 'undefined' ? globalThis : window;
    var originalConsole = root.console || {};
    var original = {};
    ['log', 'warn', 'info', 'debug'].forEach(function (level) {
        original[level] = typeof originalConsole[level] === 'function'
            ? originalConsole[level].bind(originalConsole)
            : function () {};
    });

    var enabled = false;

    function readLocalStorageFlag() {
        try {
            if (!root.localStorage) return false;
            var value = root.localStorage.getItem('cshDevLogs');
            return value === '1' || value === 'true' || value === 'yes';
        } catch (_) {
            return false;
        }
    }

    function readUrlFlag() {
        try {
            if (!root.location || !root.location.search) return false;
            return /(?:[?&])cshDevLogs=(?:1|true|yes)(?:&|$)/i.test(root.location.search);
        } catch (_) {
            return false;
        }
    }

    function apply() {
        if (!root.console) root.console = originalConsole;
        ['log', 'warn', 'info', 'debug'].forEach(function (level) {
            root.console[level] = enabled ? original[level] : function () {};
        });
    }

    function setEnabled(next) {
        enabled = !!next;
        apply();
    }

    setEnabled(readLocalStorageFlag() || readUrlFlag());

    try {
        if (root.chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['cshDevLogs'], function (items) {
                if (chrome.runtime && chrome.runtime.lastError) return;
                setEnabled(!!(items && items.cshDevLogs) || readLocalStorageFlag() || readUrlFlag());
            });
            if (chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener(function (changes, areaName) {
                    if (areaName === 'local' && changes.cshDevLogs) {
                        setEnabled(!!changes.cshDevLogs.newValue || readLocalStorageFlag() || readUrlFlag());
                    }
                });
            }
        }
    } catch (_) {}

    root.cshLogger = {
        setEnabled: setEnabled,
        isEnabled: function () { return enabled; },
        original: original
    };
})();
