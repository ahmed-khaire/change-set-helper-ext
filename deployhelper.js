// Phase 6 — live deploy progress.
// Rendered off each checkDeployStatus poll. Builds a per-component log
// (successes + failures) incrementally; de-duplicated so the user doesn't
// see the same component twice if Salesforce re-emits it across polls.
var cshDpStartTime = 0;
var cshDpSeen = null;
var cshDpElapsedTimer = null;

function cshResetDeployProgress() {
    cshDpStartTime = Date.now();
    cshDpSeen = {};
    var panel = document.getElementById('csh-deploy-progress');
    if (panel) {
        panel.style.display = '';
        document.getElementById('csh-dp-count').textContent = '0 / 0';
        document.getElementById('csh-dp-tests').textContent = '—';
        document.getElementById('csh-dp-elapsed').textContent = '0s';
        document.getElementById('csh-dp-fill').style.width = '0%';
        document.getElementById('csh-dp-fill').classList.remove('csh-dp-done', 'csh-dp-fail');
        document.getElementById('csh-dp-log').innerHTML = '';
        panel.querySelector('.csh-dp-ok').textContent = '0 succeeded';
        panel.querySelector('.csh-dp-fail').textContent = '0 failed';
        panel.querySelector('.csh-dp-ok').classList.remove('csh-dp-count-nonzero');
        panel.querySelector('.csh-dp-fail').classList.remove('csh-dp-count-nonzero');
    }
    if (cshDpElapsedTimer) clearInterval(cshDpElapsedTimer);
    cshDpElapsedTimer = setInterval(function () {
        var el = document.getElementById('csh-dp-elapsed');
        if (!el) return;
        var s = Math.floor((Date.now() - cshDpStartTime) / 1000);
        el.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    }, 1000);
}

function cshFinishDeployProgress(resultStatus) {
    if (cshDpElapsedTimer) { clearInterval(cshDpElapsedTimer); cshDpElapsedTimer = null; }
    var fill = document.getElementById('csh-dp-fill');
    if (!fill) return;
    fill.style.width = '100%';
    fill.classList.add(resultStatus === 'Succeeded' ? 'csh-dp-done' : 'csh-dp-fail');
}

function cshRenderDeployProgress(result) {
    if (!result) return;
    var panel = document.getElementById('csh-deploy-progress');
    if (!panel) return;

    var completed = result.numberComponentsDeployed || 0;
    var total = result.numberComponentsTotal || 0;
    var testsCompleted = result.numberTestsCompleted || 0;
    var testsTotal = result.numberTestsTotal || 0;
    var pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    document.getElementById('csh-dp-count').textContent = completed + ' / ' + total + ' (' + pct + '%)';
    document.getElementById('csh-dp-tests').textContent = testsTotal > 0 ? (testsCompleted + ' / ' + testsTotal) : '—';
    document.getElementById('csh-dp-fill').style.width = Math.max(2, pct) + '%';

    var details = result.details || {};
    var successes = details.componentSuccesses || [];
    var failures = details.componentFailures || [];
    if (!Array.isArray(successes)) successes = [successes];
    if (!Array.isArray(failures)) failures = [failures];

    var okCount = 0, failCount = 0;
    var logEl = document.getElementById('csh-dp-log');
    var onlyFail = document.getElementById('csh-dp-only-fail') && document.getElementById('csh-dp-only-fail').checked;

    function render(c, isSuccess) {
        var fullName = c.fullName || c.apexClassName || c.name || '(unknown)';
        var ctype = c.componentType || c.type || '';
        // package.xml entries appear in successes with an empty componentType —
        // don't count them as real components
        if (isSuccess && !ctype && fullName === 'package.xml') return;
        if (isSuccess) okCount++; else failCount++;
        var key = (isSuccess ? 'ok|' : 'fail|') + ctype + '|' + fullName;
        if (cshDpSeen[key]) return;

        // Salesforce can retry within a single deploy: a component that
        // failed on poll N may succeed on poll N+1. When a success arrives
        // for a component we previously flagged as failed, supersede the
        // failure: remove its DOM row and forget the key so the summary
        // counter stays honest.
        if (isSuccess) {
            var failKey = 'fail|' + ctype + '|' + fullName;
            if (cshDpSeen[failKey]) {
                var prior = logEl.querySelector('[data-csh-dp-key="' + cssEscape(failKey) + '"]');
                if (prior && prior.parentNode) prior.parentNode.removeChild(prior);
                delete cshDpSeen[failKey];
            }
        }

        cshDpSeen[key] = true;
        var entry = document.createElement('div');
        entry.className = 'csh-dp-entry ' + (isSuccess ? 'ok' : 'fail');
        entry.setAttribute('data-csh-dp-key', key);
        if (onlyFail && isSuccess) entry.style.display = 'none';
        var prefix = isSuccess ? '✓' : '✗';
        var label = (ctype ? '[' + ctype + '] ' : '') + fullName;
        var problem = c.problem || c.problemType || '';
        var line = c.lineNumber ? (' (line ' + c.lineNumber + ')') : '';
        entry.textContent = prefix + ' ' + label + (problem ? ' — ' + problem + line : '');
        logEl.appendChild(entry);
    }

    function cssEscape(s) {
        return String(s).replace(/["\\]/g, '\\$&');
    }

    successes.forEach(function (c) { render(c, true); });
    failures.forEach(function (c) { render(c, false); });

    // Count current totals, even for entries already seen on prior polls
    var seenOk = 0, seenFail = 0;
    Object.keys(cshDpSeen).forEach(function (k) {
        if (k.indexOf('ok|') === 0) seenOk++;
        else seenFail++;
    });
    var okEl = panel.querySelector('.csh-dp-ok');
    var failEl = panel.querySelector('.csh-dp-fail');
    okEl.textContent = seenOk + ' succeeded';
    failEl.textContent = seenFail + ' failed';
    okEl.classList.toggle('csh-dp-count-nonzero', seenOk > 0);
    failEl.classList.toggle('csh-dp-count-nonzero', seenFail > 0);

    logEl.scrollTop = logEl.scrollHeight;
}

function cshRenderDeployHelper() {
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
		<option value='mydomain'>My Domain URL…</option>
	</select>
	<input type='text' id='loginMyDomain' placeholder='https://yourorg.my.salesforce.com' style='display:none;margin-left:6px;padding:3px 6px;min-width:260px;' />

	</td>
    <td class="pbButton" id="validateSection">
        <select id='testLevelInput' name='Test Level'>
    		<option value=''>Default test level</option>
    		<option value='NoTestRun'>NoTestRun</option>
    		<option value='RunLocalTests'>RunLocalTests</option>
    		<option value='RunAllTestsInOrg'>RunAllTestsInOrg</option>
    		<option value='RunSpecifiedTests'>RunSpecifiedTests</option>
    	</select>

        <textarea id='specifiedTestsInput' rows='2' cols='46' style='display:none;vertical-align:middle;margin-left:6px;font-family:Menlo,Consolas,monospace;'
            placeholder='Test class names (comma- or space-separated): MyTest, MyOtherTest'></textarea>

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

        <!-- Phase 6 live progress panel -->
        <div id="csh-deploy-progress" style="display:none">
            <div class="csh-dp-summary">
                <span class="csh-dp-label">Components:</span>
                <span id="csh-dp-count">0 / 0</span>
                <span class="csh-dp-label">Tests:</span>
                <span id="csh-dp-tests">—</span>
                <span class="csh-dp-label">Elapsed:</span>
                <span id="csh-dp-elapsed">0s</span>
            </div>
            <div class="csh-dp-barwrap">
                <div id="csh-dp-fill" class="csh-dp-fill"></div>
            </div>
            <div class="csh-dp-summary csh-dp-counts">
                <span class="csh-dp-ok">0 succeeded</span>
                <span class="csh-dp-fail">0 failed</span>
            </div>
            <div class="csh-dp-toolbar">
                <label><input type="checkbox" id="csh-dp-only-fail"> Show only failures</label>
            </div>
            <div id="csh-dp-log" class="csh-dp-log"></div>
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
		// RunSpecifiedTests requires a non-empty runTests array alongside
		// the test level. We parse the textarea on whitespace OR commas so
		// the user can paste either "TestA, TestB" or a newline-separated
		// list copied from a spreadsheet.
		if (testLevel === 'RunSpecifiedTests') {
			var tests = ($('#specifiedTestsInput').val() || '')
				.split(/[\s,]+/)
				.map(function (s) { return s.trim(); })
				.filter(Boolean);
			if (tests.length === 0) {
				window.cshToast && window.cshToast.show(
					'RunSpecifiedTests requires at least one test class name.',
					{ type: 'error' }
				);
				return;
			}
			opts.runTests = tests;
		}
	}

	console.log(opts);
	$('#deployTest').val ("Please wait...");
	$('#deployTest').prop('disabled',true);
	$('#deployContent').html('Getting ' + changename +  ' metadata...');
	$('#quickDeploy').hide();
	$('#cancelDeploy').hide();
	$('#json-renderer').jsonViewer();
	cshResetDeployProgress();

	var sid = (window.cshSession && window.cshSession.current && window.cshSession.current()) || sessionId;
	var port = chrome.runtime.connect({name: "deployHandler"});

	port.postMessage({'proxyFunction': "deploy", 'opts': opts, "changename": changename, "sessionId":sid, "serverUrl":serverUrl});
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
			cshRenderDeployProgress(response);
		} else {
			//we're done!!
			$('#json-renderer').jsonViewer(result);
			$('#deployContent').html('Status: ' + result.status);
			$('#deployTest').prop('disabled',false);
			$('#cancelDeploy').hide();
			$('#deployTest').val("Go...");
			cshRenderDeployProgress(result);
			cshFinishDeployProgress(result.status);

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
	var customHost = null;
	if (env === 'mydomain') {
		customHost = $.trim($('#loginMyDomain').val() || '');
		if (!customHost) {
			window.cshToast && window.cshToast.show(
				'Enter a My Domain URL (e.g. https://yourorg.my.salesforce.com) before clicking Login.',
				{ type: 'error' }
			);
			return;
		}
	}
	chrome.runtime.sendMessage({
		'oauth': 'connectToDeploy',
		'environment': env,
		'customHost': customHost
	}, function(response) {
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
		cshResetDeployProgress();

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
				cshRenderDeployProgress(response);

				$('#currentDeployId').val(result.id);
				$('#cancelDeploy').show();
			} else {
				//we're done!!
				$('#json-renderer').jsonViewer(result);
				$('#deployContent').html('Status: Completed');
				$('#deployTest').prop('disabled', false);
				$('#cancelDeploy').hide();
				$('#deployTest').val("Go...");
				cshRenderDeployProgress(result);
				cshFinishDeployProgress(result.status);
				port.disconnect();
			}
		});
	}

}


(function () {
	function wireDeployHelper() {
		cshRenderDeployHelper();
		$("#deployLogin").click(deployLogin);
		$("#deployTest").click(testDeploy);
		$("#logoutLink").click(deployLogout);
		$("#cancelDeploy").click(cancelDeploy);
		$("#quickDeploy").click(quickDeploy);

		$("#validateSection").hide();
		$("#quickDeploy").hide();
		$("#cancelDeploy").hide();

		// Progress panel "show only failures" toggle — re-apply visibility
		// without re-rendering so long logs stay snappy.
		$(document).on('change', '#csh-dp-only-fail', function () {
			var onlyFail = this.checked;
			$('#csh-dp-log .csh-dp-entry').each(function () {
				if (onlyFail && $(this).hasClass('ok')) $(this).hide();
				else $(this).show();
			});
		});

		// Reveal the test-class textarea only when RunSpecifiedTests is picked.
		$(document).on('change', '#testLevelInput', function () {
			if ($(this).val() === 'RunSpecifiedTests') $('#specifiedTestsInput').show();
			else $('#specifiedTestsInput').hide();
		});

		// Reveal the My Domain URL input only when that option is picked.
		$(document).on('change', '#loginEnv', function () {
			if ($(this).val() === 'mydomain') $('#loginMyDomain').show();
			else $('#loginMyDomain').hide();
		});
	}

	if (window.cshSession && window.cshSession.ready) {
		window.cshSession.ready.then(function (sid) {
			if (sid) wireDeployHelper();
		});
	} else if (sessionId) {
		wireDeployHelper();
	}
})();

