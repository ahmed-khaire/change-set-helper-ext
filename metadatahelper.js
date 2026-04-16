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
        <input id="downloadButton" value="Download metadata" class="btn" name="downloadall" title="Download all items in changeset for use in ant" type="button" />
	&nbsp; Download metadata as zip package.
	</td>
	</tr>
	</tbody>
	</table>
	</div>  `
    );
    $("#downloadButton").click(downloadPackage);
    changename = $('h2.pageDescription').text();
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


