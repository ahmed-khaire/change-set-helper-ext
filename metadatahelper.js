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
    chrome.runtime.sendMessage({
            "oauth": "connectToLocal",
            "sessionId": sessionId,
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
}

function setDownloading() {
    $("#downloadButton").val("Downloading... please wait");
    $("#downloadButton").prop('disabled', true);
}

function unSetDownloading() {
    $("#downloadButton").val("Download metadata");
    $("#downloadButton").prop('disabled', false);
}

if (!sessionId) {
    $('.bDescription').append('<span style="background-color:yellow"><strong><br/> <br/>Sorry, currently for the Change Set Helper to work, please UNSET the Require HTTPOnly Attribute checkbox in Security -> Session Settings. Then logout and back in again.  </strong></span>')
} else {
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
    )

    $("#downloadButton").click(downloadPackage);
    var changename = $('h2.pageDescription').text();
}


