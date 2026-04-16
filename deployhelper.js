if (sessionId) {

	$('.bDescription').append(`
    <div class='apexp'>
	<div class="bPageBlock brandSecondaryBrd apexDefaultPageBlock secondaryPalette">

	<div class='pbHeader'>

	<table border="0" cellpadding="0" cellspacing="0">
	<tbody><tr>
	<td class="pbTitle"><h2 class="mainTitle">Validate Helper (Updated!)</h2></td>
	<td class="pbButton" id="loginSection">

	<input value="Login" class="btn" name="deployLogin" id="deployLogin" title="Login to org OAuth required" type="button" />
	to
	<select id='loginEnv' name='Login Environment'>
		<option value='sandbox'>Sandbox</option>
		<option value='prod'>Prod/Dev</option>
	</select>

	</td>
    <td class="pbButton" id="validateSection">
        <select id='testLevelInput' name='Test Level'>
    		<option value=''>Default test level</option>
    		<option value='NoTestRun'>NoTestRun</option>
    		<option value='RunLocalTests'>RunLocalTests</option>
    		<option value='RunAllTestsInOrg'>RunAllTestsInOrg</option>
    	</select>

        <input value="Go..." class="btn" name="deployTest" id="deployTest" title="Go.." type="button" />

        <span id="loggedInUsername"></span> (<a id="logoutLink" href="#">Logout</a>)
    </td>
	</tr>
	</tbody>
	</table>

    <div id="deployResults">
        <div class="pbButton" id="currentDeployButtons">
            <input value="" name="currentDeployId" id="currentDeployId" title="Current Deploy ID:" type="hidden" />
            <input value="Quick Deploy" class="btn" name="quickDeploy" id="quickDeploy" title="Quick Deploy" type="button" />
            <input value="Cancel Deploy" class="btn" name="cancelDeploy" id="cancelDeploy" title="Cancel Deploy" type="button" />
        </div>
        <div id="deployContent">
        </div>
        <div>
            <pre id="json-renderer"></pre>
        </div>
	</div>

	</div>  
`);
}


function testDeploy() {
	var checkOnly = true;
	if (!checkOnly) {
		var isContinue = confirm("This will deploy the change set.  Are you sure?")
		if (!isContinue) return;
	}

	var testLevel = $("#testLevelInput :selected").val();

	var opts = {
		checkOnly: checkOnly,
		ignoreWarnings: false,
		performRetrieve: false,
		rollbackOnError: true,
		singlePackage: false
	}

	if (testLevel) {
		opts.testLevel = testLevel;
	}

	console.log(opts);
	$('#deployTest').val ("Please wait...");
	$('#deployTest').prop('disabled',true);
	$('#deployContent').html('Getting ' + changename +  ' metadata...');
	$('#quickDeploy').hide();
	$('#cancelDeploy').hide();
	$('#json-renderer').jsonViewer();

	var port = chrome.runtime.connect({name: "deployHandler"});

	port.postMessage({'proxyFunction': "deploy", 'opts': opts, "changename": changename, "sessionId":sessionId, "serverUrl":serverUrl});
	port.onMessage.addListener(function(msg) {
		console.log('Listining!');
		console.log(msg);
		var result = msg.result;
		var response = msg.response;
		var err = msg.err;
		if (err) {
			console.error(err);
			$('#json-renderer').jsonViewer(err);
			$('#deployContent').html('Status: ERROR');
			$('#cancelDeploy').hide();

			$('#deployContent').html('<pre><code>' + JSON.stringify(err, null, 2) + '</code></pre>')

		} else if(response !=null) {
			//Then this is in progress...
			$('#json-renderer').jsonViewer(response);
			$('#deployContent').html('Status: ' + result.state );
			$('#currentDeployId').val(result.id);
			$('#cancelDeploy').show();
		} else {
			//we're done!!
			$('#json-renderer').jsonViewer(result);
			$('#deployContent').html('Status: ' + result.status);
			$('#deployTest').prop('disabled',false);
			$('#cancelDeploy').hide();
			$('#deployTest').val("Go...");

			if (result.status == 'Succeeded') {
				$('#currentDeployId').val(result.id);
				$('#quickDeploy').show();
			}
			port.disconnect();
		}

	});
}



function oauthLogin() {
	var env = $("#loginEnv :selected").val();
	chrome.runtime.sendMessage({'oauth': 'connectToDeploy', 'environment': env}, function(response) {
	  console.log(response);
	 if (response.error) {
		 console.log("Problem logging in: " + response.error);
		 window.cshToast && window.cshToast.show('Problem logging in: ' + response.error, { type: 'error' });
		 //do nothing else
	 } else {
              $("#loginSection").hide();
              $("#loggedInUsername").html(response.username);
              $("#validateSection").show();
	 }
	});
}

chrome.runtime.sendMessage({'proxyFunction': 'getDeployUsername'}, function(username) {
	console.log(username);
	if (username) {
		//Then there is a logged in deploy user
		$("#loginSection").hide();
		$("#loggedInUsername").html(username);
		$("#validateSection").show();
	}
	//do nothing else
});



function deployLogin() {
	console.log('Initiating login');
	oauthLogin();
}

function deployLogout() {
	chrome.runtime.sendMessage({'oauth': 'deployLogout'}, function(response) {
		console.log(response);
			//do nothing else
	});

	$('#deployContent').html();
	$('#quickDeploy').hide();
	$('#json-renderer').jsonViewer();
	$("#loginSection").show();
	$("#validateSection").hide();

}


function cancelDeploy() {
    var currentId = $("#currentDeployId").val();
	chrome.runtime.sendMessage({'proxyFunction': 'cancelDeploy', 'currentId': currentId}, function(response) {
			$('#cancelDeploy').hide();
			if (response.err) {
    			console.error(response.err);
    			$('#json-renderer').jsonViewer(response.err);
    			$('#deployContent').html('Status: ERROR');
    		} else {
                $('#deployContent').html('Status: Cancelling...');
                $('#json-renderer').jsonViewer(response.response);
 			}
    }
    );
}

function quickDeploy() {
	if (confirm('Are you sure?  This will deploy this change')) {
		var currentId = $("#currentDeployId").val();

		console.log("Quick deploy validation id:" + currentId);
		$('#deployContent').html('Initiating quick deploy...');
		$('#json-renderer').jsonViewer();
		$('#quickDeploy').hide();

		var port = chrome.runtime.connect({name: "quickDeployHandler"});
		port.postMessage({'proxyFunction': "quickDeploy", "currentId": currentId});
		port.onMessage.addListener(function (msg) {
			console.log('Listining!');
			console.log(msg);
			var result = msg.result;
			var response = msg.response;
			var err = msg.err;
			if (err) {
				console.debug(err);
				$('#json-renderer').jsonViewer(err);
				$('#deployContent').html('Status: ERROR  ');
				$('#cancelDeploy').hide();

			} else if (response != null) {
				//Then this is in progress...
				console.debug(response);
				console.debug(result);

				$('#json-renderer').jsonViewer(response);
				$('#deployContent').html('Status: ' + result.state);

				$('#currentDeployId').val(result.id);
				$('#cancelDeploy').show();
			} else {
				//we're done!!
				$('#json-renderer').jsonViewer(result);
				$('#deployContent').html('Status: Completed');
				$('#deployTest').prop('disabled', false);
				$('#cancelDeploy').hide();
				$('#deployTest').val("Go...");
				port.disconnect();
			}
		});
	}

}


if (sessionId) {

	$("#deployLogin").click(deployLogin);
	$("#deployTest").click(testDeploy);
	$("#logoutLink").click(deployLogout);
	$("#cancelDeploy").click(cancelDeploy);
	$("#quickDeploy").click(quickDeploy);


	$("#validateSection").hide();
	$("#quickDeploy").hide();
	$("#cancelDeploy").hide();
}

