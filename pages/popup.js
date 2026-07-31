// Popup logic — currently just the optional "downloads" permission grant.
//
// The downloads permission is OPTIONAL on purpose: making it required would
// trip Chrome's "Manage your downloads" warning and disable every installed
// copy on update until each user re-approves. Instead, exports fall back to a
// plain anchor download (works, but Chrome names the file after the blob UUID
// inside Lightning's Setup frame) until the user grants the permission here —
// one click, once, and chrome.downloads takes over with proper filenames.
//
// chrome.permissions.request must run from a user gesture in an extension
// page, which is exactly what a popup button click is.
(function () {
    'use strict';

    var btn = document.getElementById('enableDownloads');
    var status = document.getElementById('downloadsStatus');

    function render(granted) {
        if (granted) {
            btn.style.display = 'none';
            status.textContent = '✓ Named downloads are enabled.';
            status.className = 'ok';
        } else {
            btn.style.display = '';
            status.textContent = 'Exports currently save with a generic filename. ' +
                'Enable this once and exports keep their real names (csh-….csv, package-….xml).';
            status.className = '';
        }
    }

    chrome.permissions.contains({ permissions: ['downloads'] }, render);

    btn.addEventListener('click', function () {
        chrome.permissions.request({ permissions: ['downloads'] }, function (granted) {
            if (chrome.runtime.lastError) {
                status.textContent = 'Could not request the permission: ' +
                    chrome.runtime.lastError.message;
                return;
            }
            render(granted);
        });
    });
})();
