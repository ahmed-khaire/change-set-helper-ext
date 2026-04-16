//Not currently used...
var getUrlParameter = function getUrlParameter(sParam) {
    var sPageURL = decodeURIComponent(window.location.search.substring(1)),
        sURLVariables = sPageURL.split('&'),
        sParameterName,
        i;

    for (i = 0; i < sURLVariables.length; i++) {
        sParameterName = sURLVariables[i].split('=');

        if (sParameterName[0] === sParam) {
            return sParameterName[1] === undefined ? true : sParameterName[1];
        }
    }
};

function downloadPackage() {
    setDownloading();
    console.log('Downloading package: ' + changename + ' Ensure that this package is uniquely named and contains no weird characters.')
    window.cshSession.ready.then(function (sid) {
    if (!sid) {
        unSetDownloading();
        window.cshToast && window.cshToast.show(
            'Salesforce session not available. Please reload the page.',
            { type: 'error' }
        );
        return;
    }
    chrome.runtime.sendMessage({
            "oauth": "connectToLocal",
            "sessionId": sid,
            "serverUrl": serverUrl
    }, function (response) {
        chrome.runtime.sendMessage({
                'proxyFunction': "downloadLocalMetadata",
                "changename": changename
            },
            function (response) {
                if (response.err) {
                    window.cshToast && window.cshToast.show(
                        'There was a problem downloading the package.\n\n' + (response.err.message || response.err),
                        { type: 'error' }
                    );
                    console.error(response.err);
                    unSetDownloading();
                } else {
                    var zip = new JSZip();
                    zip.loadAsync(response.result.zipFile, {base64: true}).then(
                        function (zip) {
                            unSetDownloading();
                            zip.generateAsync({type: "blob"})
                                .then(function (blob) {
                                    saveAs(blob, changename + ".zip");
                                });
                        });
                }
            });
    } );
    }); // end window.cshSession.ready.then
}

// Download just the package.xml manifest for this change set — not the
// full source ZIP. Reuses the existing retrieve flow in the offscreen doc,
// opens the returned ZIP with JSZip (already loaded on this page), extracts
// the first package.xml entry, and serves just that file.
function exportPackageXmlOnly() {
    var btn = document.getElementById('exportPackageXmlButton');
    if (btn) { btn.value = 'Retrieving…'; btn.disabled = true; }

    window.cshSession.ready.then(function (sid) {
        if (!sid) {
            window.cshToast && window.cshToast.show(
                'Salesforce session not available. Please reload the page.',
                { type: 'error' }
            );
            restoreExportBtn();
            return;
        }
        chrome.runtime.sendMessage({
            'oauth': 'connectToLocal',
            'sessionId': sid,
            'serverUrl': serverUrl
        }, function () {
            chrome.runtime.sendMessage({
                'proxyFunction': 'downloadLocalMetadata',
                'changename': changename
            }, function (response) {
                if (!response || response.err) {
                    window.cshToast && window.cshToast.show(
                        'Retrieve failed: ' + ((response && response.err && response.err.message) || 'unknown error'),
                        { type: 'error' }
                    );
                    restoreExportBtn();
                    return;
                }
                var zip = new JSZip();
                zip.loadAsync(response.result.zipFile, { base64: true }).then(function (z) {
                    // Find the package.xml entry; Salesforce zips usually
                    // place it under unpackaged/package.xml but we'll match
                    // any path ending in /package.xml just in case.
                    var entry = null;
                    Object.keys(z.files).some(function (k) {
                        if (/(^|\/)package\.xml$/i.test(k)) { entry = z.files[k]; return true; }
                        return false;
                    });
                    if (!entry) {
                        window.cshToast && window.cshToast.show(
                            'Could not find package.xml in the retrieved zip.',
                            { type: 'error' }
                        );
                        restoreExportBtn();
                        return;
                    }
                    entry.async('string').then(function (xml) {
                        var stamp = new Date().toISOString().slice(0, 10);
                        var safeName = String(changename || 'changeset').replace(/[^a-zA-Z0-9-_]+/g, '-');
                        var fname = 'package-' + safeName + '-' + stamp + '.xml';
                        var blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
                        saveAs(blob, fname);
                        window.cshToast && window.cshToast.show(
                            'Exported package.xml for "' + changename + '" (' + xml.length + ' chars).',
                            { type: 'success' }
                        );
                        restoreExportBtn();
                    });
                }).catch(function (e) {
                    window.cshToast && window.cshToast.show('Zip parse failed: ' + e.message, { type: 'error' });
                    restoreExportBtn();
                });
            });
        });
    });

    function restoreExportBtn() {
        if (btn) { btn.value = 'Export package.xml'; btn.disabled = false; }
    }
}

async function handleImportPackageXmlFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
        if (!window.cshCart || !window.cshCart.importPackageXml) {
            throw new Error('Cart module not loaded on this page');
        }
        var text = await file.text();
        var added = await window.cshCart.importPackageXml(text);
        window.cshToast && window.cshToast.show(
            'Imported ' + added + ' item(s) from ' + file.name + '. ' +
            'Open the Add Components page to resolve and commit them to the change set.',
            { type: 'success', duration: 7000 }
        );
    } catch (e) {
        window.cshToast && window.cshToast.show('Import failed: ' + e.message, { type: 'error' });
    }
    ev.target.value = '';
}

function setDownloading() {
    $("#downloadButton").val("Downloading... please wait");
    $("#downloadButton").prop('disabled', true);
}

function unSetDownloading() {
    $("#downloadButton").val("Download metadata");
    $("#downloadButton").prop('disabled', false);
}

var changename;

function cshRenderMetadataHelper() {
    $('.bDescription').append(`
    <div class='apexp'>
	<div class="bPageBlock brandSecondaryBrd apexDefaultPageBlock secondaryPalette">

	<div class='pbHeader'>

	<table border="0" cellpadding="0" cellspacing="0">
	<tbody><tr>
	<td class="pbTitle"><h2 class="mainTitle">Metadata Helper</h2></td>
	<td class="pbButton">
        <input id="downloadButton" value="Download metadata (zip)" class="btn" name="downloadall" title="Download this change set's full metadata as a zip" type="button" />
        <input id="exportPackageXmlButton" value="Export package.xml" class="btn" title="Download just the change set's package.xml manifest (no source files)" type="button" />
        <input id="importPackageXmlButton" value="Import package.xml → cart" class="btn" title="Load a package.xml into the cart; visit Add Components to commit" type="button" />
        <input id="importPackageXmlFile" type="file" accept=".xml,application/xml" style="display:none" />
	</td>
	</tr>
	</tbody>
	</table>
	</div>  `
    );
    $("#downloadButton").click(downloadPackage);
    $("#exportPackageXmlButton").click(exportPackageXmlOnly);
    $("#importPackageXmlButton").click(function () { $("#importPackageXmlFile").trigger('click'); });
    $("#importPackageXmlFile").on('change', handleImportPackageXmlFile);
    changename = $('h2.pageDescription').text();

    // Initialise the cart module so window.cshCart.importPackageXml is
    // available on this page too. cart.js is idempotent — calling init with
    // only a changeSetId (no currentType) registers the cart panel and
    // storage listeners; no checkbox auto-save is installed because the
    // detail page doesn't render the component selection table.
    if (window.cshCart && window.cshCart.init) {
        var csId = $('#id').val() || (location.search.match(/[?&]id=([^&]+)/) || [])[1] || null;
        if (csId) {
            window.cshCart.init({ changeSetId: csId }).catch(function (e) {
                console.warn('cshCart.init on detail page failed:', e && e.message);
            });
        }
    }
}

(function () {
    function renderFallbackWarning() {
        var banner = $(
            '<div id="csh-signin-banner-md" style="background:#fff5d6;border:1px solid #d1c083;border-radius:4px;padding:12px 14px;margin:10px 0;display:flex;gap:10px;align-items:center;">' +
            '<div style="flex:1 1 auto;">' +
              '<strong>Change Set Helper needs to sign in.</strong><br/>' +
              'Your Salesforce session cookie is not readable. Sign in via OAuth to enable the metadata download.' +
            '</div>' +
            '<button id="csh-signin-btn-md" style="flex:0 0 auto;padding:8px 14px;background:#0176d3;color:#fff;border:0;border-radius:3px;cursor:pointer;font:inherit;font-weight:600;">Sign in via OAuth</button>' +
            '</div>'
        );
        $('.bDescription').append(banner);
        banner.find('#csh-signin-btn-md').on('click', async function () {
            var btn = $(this);
            btn.prop('disabled', true).text('Opening popup…');
            var resp = window.cshAuth ? await window.cshAuth.login() : null;
            if (resp && resp.ok && resp.accessToken) {
                setTimeout(function () { location.reload(); }, 600);
            } else {
                btn.prop('disabled', false).text('Sign in via OAuth');
                window.cshToast && window.cshToast.show(
                    'Sign in failed: ' + ((resp && resp.error) || 'unknown error'),
                    { type: 'error' }
                );
            }
        });
    }

    if (window.cshSession && window.cshSession.ready) {
        window.cshSession.ready.then(function (sid) {
            if (sid) cshRenderMetadataHelper();
            else renderFallbackWarning();
        });
    } else if (sessionId) {
        cshRenderMetadataHelper();
    } else {
        renderFallbackWarning();
    }
})();


