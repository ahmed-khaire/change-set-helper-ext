// Phase 6 — live deploy progress.
// Rendered off each checkDeployStatus poll. Builds a per-component log
// (successes + failures) incrementally; de-duplicated so the user doesn't
// see the same component twice if Salesforce re-emits it across polls.
//
// Phase tracking (Phase 6 closeouts):
//   Starting… → Retrieving metadata → Queued in target org → In progress →
//   Running tests → Succeeded | Failed | Canceled.
// We start the Retrieve timer from cshResetDeployProgress() and pivot to a
// separate Deploy timer when the 'Done downloading, starting deploy...'
// lifecycle message arrives. Both timers display independently so users can
// see which phase is the bottleneck on slow deploys.
var cshDpStartTime = 0;
var cshDpRetrieveStart = 0;
var cshDpRetrieveElapsedFixed = 0;      // frozen once retrieve phase ends
var cshDpDeployStart = 0;               // 0 until retrieve finishes
var cshDpSeen = null;
var cshDpElapsedTimer = null;
var cshDpPhase = 'Starting…';
var cshDpPackageXmlFiltered = false;    // dedupe the "package.xml pseudo-row"

// Page-side deploy polling state. After background hands us the deploy id
// we poll Salesforce's Metadata REST endpoint directly from the page so
// progress updates aren't gated on the MV3 service worker or offscreen doc
// staying alive. See cshStartPageDeployPoll below.
var cshDpPollTimer = null;
var cshDpPollState = null;              // {deployId, orgId, instanceUrl, accessToken, apiVersion}
var cshDpPollInFlight = false;          // one poll at a time

// Button label tracks the current deploy-mode selector so "Please wait..." →
// reset always returns to a label that matches what will happen on the next
// click. Falls back to "Validate" if the selector isn't rendered yet (before
// cshRenderDeployHelper runs) so callers in error paths don't blow up.
function cshDeployButtonLabel() {
	var mode = $("#deployModeInput :selected").val() || 'validate';
	return mode === 'deploy' ? 'Deploy' : 'Validate';
}

function cshFormatElapsed(ms) {
    if (!ms || ms < 0) return '0s';
    var s = Math.floor(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function cshSetDpPhase(label) {
    cshDpPhase = label;
    var el = document.getElementById('csh-dp-phase');
    if (el) el.textContent = label;
}

// Map a jsforce checkDeployStatus state string to a user-facing phase label.
// We keep the SF status verbatim for final outcomes (Succeeded / Failed /
// Canceled / SucceededPartial) so users can search docs or Slack for it.
function cshPhaseForStatus(status, result) {
    if (!status) return 'In progress';
    if (status === 'Succeeded' || status === 'SucceededPartial') return status;
    if (status === 'Failed' || status === 'Canceled' || status === 'Canceling') return status;
    // "InProgress" with test numbers climbing means we're in the test phase.
    if (status === 'InProgress' && result && (result.numberTestsTotal || 0) > 0) {
        return 'Running tests';
    }
    if (status === 'Pending') return 'Queued in target org';
    return status;
}

function cshMarkRetrieveDone() {
    if (cshDpDeployStart) return;
    cshDpRetrieveElapsedFixed = Date.now() - cshDpRetrieveStart;
    cshDpDeployStart = Date.now();
    var rEl = document.getElementById('csh-dp-retrieve-elapsed');
    if (rEl) rEl.textContent = cshFormatElapsed(cshDpRetrieveElapsedFixed);
}

// Open Setup → Deployment Status for the given deploy id on the Validate
// Helper's own Salesforce host (window.serverUrl is set by common.js).
function cshDeploymentStatusUrl(deployId) {
    var host = (window.serverUrl || location.origin).replace(/\/+$/, '');
    // AsyncDeployResult detail page in Setup lists validations & deploys.
    return host + '/lightning/setup/DeployStatus/page?address=' +
        encodeURIComponent('/changemgmt/monitorDeploymentsDetails.apexp?asyncId=' + deployId);
}

// -------------------------------------------------------------------------
// Page-side deploy polling (option c).
//
// Why: the SW → offscreen → jsforce poll loop was unreliable past ~5 minutes.
// The SW's keep-alive is a workaround (not a guarantee) and the offscreen
// doc gets torn down by its inactivity timer, which surfaced to the user as
// either (a) phase stuck at "Queued in target org" forever, or (b) the
// "A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received" error.
//
// The page context is stable for the deploy's lifetime — the user is sitting
// on the Change Set Detail page watching the progress panel — so setInterval
// + fetch is the simplest reliable path. host_permissions in manifest.json
// already cover every Salesforce domain, so cross-org fetches aren't blocked
// by CORS for content-script code.
// -------------------------------------------------------------------------

function cshStopPageDeployPoll() {
    if (cshDpPollTimer) {
        clearInterval(cshDpPollTimer);
        cshDpPollTimer = null;
    }
    cshDpPollInFlight = false;
}

function cshStartPageDeployPoll(handoff) {
    cshStopPageDeployPoll();
    cshDpPollState = {
        deployId: handoff.deployId,
        orgId: handoff.orgId,
        instanceUrl: String(handoff.instanceUrl || '').replace(/\/+$/, ''),
        accessToken: handoff.accessToken,
        apiVersion: handoff.apiVersion || '66.0'
    };
    $('#currentDeployId').val(handoff.deployId);
    $('#cancelDeploy').show();

    // Kick off the first poll immediately so users see "Pending" / "In
    // progress" within a second of handoff rather than waiting a full
    // interval. setInterval then keeps ticking every 5s.
    cshPollDeployOnce();
    cshDpPollTimer = setInterval(cshPollDeployOnce, 5000);
}

async function cshPollDeployOnce() {
    if (cshDpPollInFlight || !cshDpPollState) return;
    cshDpPollInFlight = true;
    var s = cshDpPollState;
    var url = s.instanceUrl + '/services/data/v' + s.apiVersion +
        '/metadata/deployRequest/' + encodeURIComponent(s.deployId) +
        '?includeDetails=true';
    try {
        var resp = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + s.accessToken,
                'Accept': 'application/json'
            }
        });
        if (resp.status === 401) {
            // Access token expired mid-deploy. Ask the SW to refresh using
            // the saved refresh token, retry on next tick. If the refresh
            // token itself is dead, surface a re-auth prompt and stop polling.
            var refreshed = await cshRequestFreshDeployToken(s.orgId);
            if (!refreshed) {
                cshStopPageDeployPoll();
                cshFinishDeployProgress('Failed');
                $('#deployContent').html('Status: Session expired — please sign in again.');
                return;
            }
            s.accessToken = refreshed.accessToken;
            s.instanceUrl = String(refreshed.instanceUrl || s.instanceUrl).replace(/\/+$/, '');
            return; // next interval tick will retry
        }
        if (!resp.ok) {
            // Transient server error — log and let the next tick retry.
            // Only surface persistent errors if they exceed POLLTIMEOUT.
            console.warn('[CSH deploy] poll http', resp.status, 'retrying');
            return;
        }
        var body = await resp.json();
        // REST endpoint wraps the deploy state in `deployResult`. Shape
        // matches jsforce's checkDeployStatus output (same underlying API).
        var dr = body.deployResult || body;
        $('#json-renderer').jsonViewer(dr);
        cshUpdateJsonBadge(dr);
        cshBindJsonCopy();
        $('#deployContent').html('Status: ' + (dr.status || 'In progress'));
        cshRenderDeployProgress(dr);
        if (dr.done) {
            cshStopPageDeployPoll();
            $('#deployTest').prop('disabled', false).val(cshDeployButtonLabel());
            $('#cancelDeploy').hide();
            cshFinishDeployProgress(dr.status);
            // Quick Deploy only applies to a successful VALIDATION — it
            // reuses the validated zip to do the real deploy without a
            // re-retrieve. If this was already a direct deploy (checkOnly
            // false) the change set is live in the target org and Quick
            // Deploy would re-execute it redundantly. `dr.checkOnly` is
            // reported by the REST endpoint verbatim from the async result.
            if (dr.status === 'Succeeded' && dr.checkOnly) {
                $('#currentDeployId').val(dr.id);
                $('#quickDeploy').show();
            }
        }
    } catch (err) {
        console.warn('[CSH deploy] poll threw — retrying next tick', err);
    } finally {
        cshDpPollInFlight = false;
    }
}

function cshRequestFreshDeployToken(orgId) {
    return new Promise(function (resolve) {
        chrome.runtime.sendMessage({
            type: 'cshGetDeployToken',
            orgId: orgId
        }, function (resp) {
            if (!resp || !resp.ok) {
                if (resp && resp.needsReauth) {
                    window.cshToast && window.cshToast.show(
                        'Session expired for target org. Please sign in again.',
                        { type: 'error' }
                    );
                }
                resolve(null);
                return;
            }
            resolve({ accessToken: resp.accessToken, instanceUrl: resp.instanceUrl });
        });
    });
}

function cshResetDeployProgress() {
    cshDpStartTime = Date.now();
    cshDpRetrieveStart = Date.now();
    cshDpRetrieveElapsedFixed = 0;
    cshDpDeployStart = 0;
    cshDpSeen = {};
    cshDpPackageXmlFiltered = false;
    cshSetDpPhase('Retrieving metadata');
    var panel = document.getElementById('csh-deploy-progress');
    if (panel) {
        panel.style.display = '';
        document.getElementById('csh-dp-count').textContent = '0 / 0';
        document.getElementById('csh-dp-tests').textContent = '—';
        document.getElementById('csh-dp-elapsed').textContent = '0s';
        document.getElementById('csh-dp-retrieve-elapsed').textContent = '0s';
        document.getElementById('csh-dp-deploy-elapsed').textContent = '—';
        document.getElementById('csh-dp-fill').style.width = '0%';
        document.getElementById('csh-dp-fill').classList.remove('csh-dp-done', 'csh-dp-fail');
        document.getElementById('csh-dp-log').innerHTML = '';
        panel.querySelector('.csh-dp-ok').textContent = '0 succeeded';
        panel.querySelector('.csh-dp-fail').textContent = '0 failed';
        panel.querySelector('.csh-dp-ok').classList.remove('csh-dp-count-nonzero');
        panel.querySelector('.csh-dp-fail').classList.remove('csh-dp-count-nonzero');
        var link = document.getElementById('csh-dp-setup-link');
        if (link) { link.style.display = 'none'; link.removeAttribute('href'); }
    }
    if (cshDpElapsedTimer) clearInterval(cshDpElapsedTimer);
    cshDpElapsedTimer = setInterval(function () {
        var total = document.getElementById('csh-dp-elapsed');
        var ret = document.getElementById('csh-dp-retrieve-elapsed');
        var dep = document.getElementById('csh-dp-deploy-elapsed');
        if (total) total.textContent = cshFormatElapsed(Date.now() - cshDpStartTime);
        if (ret) {
            // Freeze the retrieve counter once retrieve finishes; keep it live
            // until then so users know the SW is still working.
            ret.textContent = cshFormatElapsed(
                cshDpRetrieveElapsedFixed || (Date.now() - cshDpRetrieveStart)
            );
        }
        if (dep) {
            dep.textContent = cshDpDeployStart
                ? cshFormatElapsed(Date.now() - cshDpDeployStart)
                : '—';
        }
    }, 1000);
}

function cshFinishDeployProgress(resultStatus) {
    if (cshDpElapsedTimer) { clearInterval(cshDpElapsedTimer); cshDpElapsedTimer = null; }
    var fill = document.getElementById('csh-dp-fill');
    if (!fill) return;
    fill.style.width = '100%';
    fill.classList.add(resultStatus === 'Succeeded' ? 'csh-dp-done' : 'csh-dp-fail');
    cshSetDpPhase(resultStatus || cshDpPhase);
}

// Refresh the <details> summary badge for the raw JSON panel. The panel
// stays collapsed by default so it doesn't dominate the UI; the badge tells
// the user at a glance what's inside (status + id) so they can decide
// whether to expand.
function cshUpdateJsonBadge(result) {
    var badge = document.getElementById('csh-json-badge');
    if (!badge) return;
    if (!result) {
        badge.textContent = 'empty';
        badge.className = 'csh-json-badge';
        return;
    }
    if (typeof result === 'string') {
        badge.textContent = 'error';
        badge.className = 'csh-json-badge fail';
        return;
    }
    var status = result.status || result.state || 'in progress';
    var idFragment = result.id ? (' · ' + result.id) : '';
    badge.textContent = status + idFragment;
    badge.className = 'csh-json-badge';
    var s = String(status).toLowerCase();
    if (s === 'succeeded') badge.classList.add('ok');
    else if (s === 'failed' || s === 'canceled' || s === 'canceling' || s.indexOf('error') >= 0) badge.classList.add('fail');
    else if (s === 'succeededpartial') badge.classList.add('warn');
}

// Wire the Copy JSON button once. Uses the live content of #json-renderer
// so it always reflects the most recent poll. Falls back to a text-selection
// approach if the async Clipboard API isn't available.
function cshBindJsonCopy() {
    var btn = document.getElementById('csh-json-copy');
    if (!btn || btn.dataset.cshBound === '1') return;
    btn.dataset.cshBound = '1';
    btn.addEventListener('click', function () {
        var pre = document.getElementById('json-renderer');
        var text = pre ? pre.textContent : '';
        if (!text) { btn.textContent = 'Nothing to copy'; setTimeout(function () { btn.textContent = 'Copy JSON'; }, 1200); return; }
        var done = function () {
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = 'Copy JSON'; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { done(); });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
            done();
        }
    });
}

function cshRenderDeployProgress(result) {
    if (!result) return;
    var panel = document.getElementById('csh-deploy-progress');
    if (!panel) return;

    // Drive the phase label off the current SF status so the header keeps
    // in step with the pollable state (Pending → InProgress → Running tests
    // → final). We only advance phases forward; if the retrieve timer is
    // still live we leave "Retrieving metadata" alone so test arrival isn't
    // mislabeled during the retrieve.
    if (result.status) {
        var nextPhase = cshPhaseForStatus(result.status, result);
        if (cshDpDeployStart || result.status !== 'InProgress' || nextPhase !== 'In progress') {
            cshSetDpPhase(nextPhase);
        }
    }

    // Salesforce counts package.xml as a component in numberComponentsTotal
    // and emits a matching pseudo-row in componentSuccesses. Filter both out
    // of the display so "42 / 42 (100%)" matches what the user actually
    // shipped. We decrement total exactly once per deploy (after a poll
    // where we've seen the pseudo-row in successes).
    var details = result.details || {};
    var successes = details.componentSuccesses || [];
    var failures = details.componentFailures || [];
    if (!Array.isArray(successes)) successes = [successes];
    if (!Array.isArray(failures)) failures = [failures];

    if (!cshDpPackageXmlFiltered) {
        for (var i = 0; i < successes.length; i++) {
            var s = successes[i];
            var sType = s.componentType || s.type || '';
            var sName = s.fullName || s.name || '';
            if (!sType && sName === 'package.xml') {
                cshDpPackageXmlFiltered = true;
                break;
            }
        }
    }

    var completed = result.numberComponentsDeployed || 0;
    var total = result.numberComponentsTotal || 0;
    if (cshDpPackageXmlFiltered && total > 0) total -= 1;
    if (cshDpPackageXmlFiltered && completed > 0 && completed >= total) completed = total;
    var testsCompleted = result.numberTestsCompleted || 0;
    var testsTotal = result.numberTestsTotal || 0;
    var pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    document.getElementById('csh-dp-count').textContent = completed + ' / ' + total + ' (' + pct + '%)';
    var testErrors = result.numberTestErrors || 0;
    var testsLabel = testsTotal > 0
        ? (testsCompleted + ' / ' + testsTotal + (testErrors > 0 ? ' (' + testErrors + ' failed)' : ''))
        : '—';
    document.getElementById('csh-dp-tests').textContent = testsLabel;
    document.getElementById('csh-dp-fill').style.width = Math.max(2, pct) + '%';

    // Wire the Setup → Deployment Status deep link once we have a deploy id.
    // Visible only for Failed / Canceled / SucceededPartial so users click
    // through when they need Salesforce's built-in details (test traces,
    // retries). Succeeded deploys don't need the link.
    var setupLink = document.getElementById('csh-dp-setup-link');
    if (setupLink && result.id) {
        var failTerminal = result.status === 'Failed' || result.status === 'Canceled' ||
            result.status === 'Canceling' || result.status === 'SucceededPartial';
        if (failTerminal) {
            setupLink.href = cshDeploymentStatusUrl(result.id);
            setupLink.style.display = '';
        }
    }

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

    // Test method failures (runTestResult.failures). These arrive with a
    // class/method/message/stackTrace shape that doesn't match component
    // failures, so we render them with their own prefix and inline the
    // stack trace below the message for quick triage.
    var testResult = details.runTestResult || {};
    var testFailures = testResult.failures || [];
    if (!Array.isArray(testFailures)) testFailures = [testFailures];
    testFailures.forEach(function (t) {
        var className = t.name || '';
        var methodName = t.methodName || '';
        var key = 'testfail|' + className + '|' + methodName;
        if (cshDpSeen[key]) return;
        cshDpSeen[key] = true;
        var entry = document.createElement('div');
        entry.className = 'csh-dp-entry fail';
        entry.setAttribute('data-csh-dp-key', key);
        var head = document.createElement('div');
        var label = '[Test] ' + className + (methodName ? '.' + methodName : '');
        var msg = t.message ? ' — ' + t.message : '';
        head.textContent = '✗ ' + label + msg;
        entry.appendChild(head);
        if (t.stackTrace) {
            var stack = document.createElement('pre');
            stack.className = 'csh-dp-stack';
            stack.textContent = t.stackTrace;
            entry.appendChild(stack);
        }
        logEl.appendChild(entry);
    });

    // Code coverage warnings (< 75% on a class/trigger). This is frequently
    // the *only* reason a validate comes back Failed with zero component or
    // test errors — surfacing it here tells the user exactly which class to
    // add coverage for, without making them bounce to Setup.
    var covWarnings = testResult.codeCoverageWarnings || [];
    if (!Array.isArray(covWarnings)) covWarnings = [covWarnings];
    covWarnings.forEach(function (w) {
        var wName = w.name || '(unknown)';
        var key = 'covwarn|' + wName;
        if (cshDpSeen[key]) return;
        cshDpSeen[key] = true;
        var entry = document.createElement('div');
        entry.className = 'csh-dp-entry warn';
        entry.setAttribute('data-csh-dp-key', key);
        entry.textContent = '⚠ [Coverage] ' + wName + ' — ' + (w.message || 'coverage below threshold');
        if (onlyFail) { /* coverage warnings are fail-adjacent; always show */ }
        logEl.appendChild(entry);
    });

    // Top-level errorMessage (fatal deploy error that short-circuited the
    // job before any component or test ran — e.g., invalid package.xml).
    if (result.errorMessage) {
        var errKey = 'err|' + result.errorMessage;
        if (!cshDpSeen[errKey]) {
            cshDpSeen[errKey] = true;
            var entry = document.createElement('div');
            entry.className = 'csh-dp-entry fail';
            entry.setAttribute('data-csh-dp-key', errKey);
            entry.textContent = '✗ ' + result.errorMessage;
            logEl.appendChild(entry);
        }
    }

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
	<td class="pbTitle"><h2 class="mainTitle">Validate &amp; Deploy</h2></td>
	<td class="pbButton" id="loginSection">

	<!-- Saved-orgs picker: shown when the user has connected at least one
	     org previously. "Connect" reuses a refresh token, so there's no
	     popup unless the refresh has been revoked. -->
	<span id="savedOrgsGroup" style="display:none;">
		<select id="savedOrgsSelect" title="Target org" style="max-width:320px;vertical-align:middle;"></select>
		<input value="Connect" class="btn" id="savedOrgConnect" type="button" title="Connect using this org's saved credentials" />
		<button id="savedOrgDelete" type="button" title="Forget this saved org" style="margin-left:4px;padding:2px 8px;border:1px solid #c9c9c9;background:#fff;border-radius:3px;cursor:pointer;">✕</button>
		<a href="#" id="addAnotherOrgLink" style="margin-left:8px;font-size:12px;">+ Add another org</a>
	</span>

	<!-- Add-an-org form: shown standalone when no saved orgs exist, or
	     revealed by "+ Add another org" when saved orgs do exist. -->
	<span id="newOrgGroup">
		<input value="Login" class="btn" name="deployLogin" id="deployLogin" title="Login to org OAuth required" type="button" />
		to
		<select id='loginEnv' name='Login Environment'>
			<option value='sandbox'>Sandbox</option>
			<option value='prod'>Prod/Dev</option>
			<option value='mydomain'>My Domain URL…</option>
		</select>
		<input type='text' id='loginMyDomain' placeholder='https://yourorg.my.salesforce.com' style='display:none;margin-left:6px;padding:3px 6px;min-width:260px;' />
		<a href="#" id="backToSavedOrgsLink" style="display:none;margin-left:8px;font-size:12px;">Back to saved orgs</a>
	</span>

	</td>
    <td class="pbButton" id="validateSection">
        <select id='deployModeInput' name='Deploy Mode' title='Validate checks deployability without applying changes. Deploy applies the change set to the target org.'>
    		<option value='validate'>Validate only</option>
    		<option value='deploy'>Deploy to target</option>
    	</select>

        <select id='testLevelInput' name='Test Level'>
    		<option value=''>Default test level</option>
    		<option value='NoTestRun'>NoTestRun</option>
    		<option value='RunLocalTests'>RunLocalTests</option>
    		<option value='RunAllTestsInOrg'>RunAllTestsInOrg</option>
    		<option value='RunSpecifiedTests'>RunSpecifiedTests</option>
    	</select>

        <textarea id='specifiedTestsInput' rows='2' cols='46' style='display:none;vertical-align:middle;margin-left:6px;font-family:Menlo,Consolas,monospace;'
            placeholder='Test class names (comma- or space-separated): MyTest, MyOtherTest'></textarea>

        <input value="Validate" class="btn" name="deployTest" id="deployTest" title="Run the selected action against the connected target org." type="button" />

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
            <div class="csh-dp-summary csh-dp-phasebar">
                <span class="csh-dp-label">Phase:</span>
                <span id="csh-dp-phase" class="csh-dp-phase">Starting…</span>
                <span class="csh-dp-label">Retrieve:</span>
                <span id="csh-dp-retrieve-elapsed">0s</span>
                <span class="csh-dp-label">Deploy:</span>
                <span id="csh-dp-deploy-elapsed">—</span>
            </div>
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
                <a id="csh-dp-setup-link" href="#" target="_blank" rel="noopener" style="display:none;margin-left:auto;">View in Setup → Deployment Status</a>
            </div>
            <div class="csh-dp-toolbar">
                <label><input type="checkbox" id="csh-dp-only-fail"> Show only failures</label>
            </div>
            <div id="csh-dp-log" class="csh-dp-log"></div>
        </div>

        <details id="csh-json-details" class="csh-json-details" style="display:none">
            <summary>
                <span class="csh-json-label">Raw deploy result</span>
                <span id="csh-json-badge" class="csh-json-badge">empty</span>
                <span class="csh-json-hint">(click to expand)</span>
            </summary>
            <div class="csh-json-body">
                <div class="csh-json-toolbar">
                    <button type="button" id="csh-json-copy" class="csh-json-btn">Copy JSON</button>
                </div>
                <pre id="json-renderer"></pre>
            </div>
        </details>
	</div>

	</div>  
`);
}


function testDeploy() {
	// Mode controls whether this is a dry-run (checkOnly=true) or an actual
	// deploy that applies the change set in the target org (checkOnly=false).
	// The direct-deploy path lands changes irreversibly — hence the strong
	// confirmation prompt that names the target org, the change set, and the
	// test level so the user sees exactly what they're about to do.
	var mode = $("#deployModeInput :selected").val() || 'validate';
	var checkOnly = mode !== 'deploy';
	if (!checkOnly) {
		var targetOrg = $.trim($("#loggedInUsername").text()) || 'the connected org';
		var testLevelForPrompt = $("#testLevelInput :selected").val() || 'default';
		var msg = 'Deploy "' + changename + '" to ' + targetOrg + '?\n\n' +
			'Test level: ' + testLevelForPrompt + '\n\n' +
			'This WILL apply the change set to the target org. Salesforce ' +
			'does not support rollback of a succeeded deploy — you can only ' +
			'undo it by deploying the previous state. Continue?';
		if (!confirm(msg)) return;
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
	cshUpdateJsonBadge(null);
	cshBindJsonCopy();
	var jsonDetails = document.getElementById('csh-json-details');
	if (jsonDetails) { jsonDetails.open = false; jsonDetails.style.display = ''; }
	cshResetDeployProgress();

	var sid = (window.cshSession && window.cshSession.current && window.cshSession.current()) || sessionId;
	var port = chrome.runtime.connect({name: "deployHandler"});

	port.postMessage({'proxyFunction': "deploy", 'opts': opts, "changename": changename, "sessionId":sid, "serverUrl":serverUrl});
	port.onMessage.addListener(function(msg) {
		console.log('Listining!');
		console.log(msg);
		var response = msg.response;
		var err = msg.err;
		if (err) {
			console.error(err);
			$('#json-renderer').jsonViewer(err);
			cshUpdateJsonBadge(typeof err === 'string' ? err : (err && err.message) || 'error');
			cshBindJsonCopy();
			$('#cancelDeploy').hide();
			$('#deployContent').html('<pre><code>' + JSON.stringify(err, null, 2) + '</code></pre>');
			cshStopPageDeployPoll();
			cshFinishDeployProgress('Failed');
			$('#deployTest').prop('disabled', false).val(cshDeployButtonLabel());
			port.disconnect();
		} else if (msg.handoff) {
			// Background finished the retrieve + deploy kickoff and handed
			// us the access token. From here the page polls Salesforce
			// directly — no more SW / offscreen in the loop. Disconnect the
			// port so the keep-alive can wind down.
			cshStartPageDeployPoll(msg.handoff);
			port.disconnect();
		} else if (typeof response === 'string') {
			// Lifecycle strings from background.js deploy(): 'Downloading
			// metadata...' and 'Done downloading, starting deploy...'. The
			// handoff message arrives right after the second one.
			$('#deployContent').text('Status: ' + response);
			if (/^Done downloading/i.test(response)) {
				cshMarkRetrieveDone();
				cshSetDpPhase('Queued in target org');
			}
		}
	});
}



// -------------------------------------------------------------------------
// Saved-orgs UI for the Validate Helper.
//
// The Validate Helper used to force a full OAuth popup on every page load
// because the deploy connection lived only in the offscreen-document memory
// and vanished whenever the MV3 service worker idled out. Users working
// across multiple target orgs also had to remember which sandbox they were
// deploying to and re-enter credentials for each one.
//
// The new backend (see cshConnectDeployOrg in background.js) persists a
// {accessToken, refreshToken, host, username, instanceUrl, envLabel} record
// per org and a per-change-set "last used org" pointer. This UI surfaces
// that state as a dropdown: the most recent org for this change set is
// pre-selected, one Connect click transparently refreshes the token and
// connects. The classic Login-to-new-org path is still available under
// "+ Add another org" for first-time use.
// -------------------------------------------------------------------------

function cshDeployHelperChangeSetId() {
	return $('#id').val() ||
		((location.search.match(/[?&]id=([^&]+)/) || [])[1] || null);
}

function cshFormatLastUsed(ts) {
	if (!ts) return '';
	var diff = Date.now() - ts;
	var m = Math.floor(diff / 60000);
	if (m < 1) return 'just now';
	if (m < 60) return m + 'm ago';
	var h = Math.floor(m / 60);
	if (h < 24) return h + 'h ago';
	var d = Math.floor(h / 24);
	return d + 'd ago';
}

function cshRenderSavedOrgsDropdown(orgs, preselectOrgId) {
	var $sel = $('#savedOrgsSelect').empty();
	if (!orgs || !orgs.length) {
		$('#savedOrgsGroup').hide();
		$('#newOrgGroup').show();
		$('#backToSavedOrgsLink').hide();
		return null;
	}
	orgs.forEach(function (o) {
		// Pull the bare hostname out of the saved host URL so the dropdown
		// stays readable when the username is long.
		var hostShort = (o.host || '').replace(/^https?:\/\//, '');
		var label = (o.username || 'unknown') + '  —  ' + hostShort +
			(o.envLabel ? ' · ' + o.envLabel : '') +
			(o.lastUsedAt ? '  (' + cshFormatLastUsed(o.lastUsedAt) + ')' : '');
		var $opt = $('<option></option>').val(o.orgId).text(label);
		$opt.data('org', o);
		$sel.append($opt);
	});
	var ids = orgs.map(function (o) { return o.orgId; });
	var chosen = (preselectOrgId && ids.indexOf(preselectOrgId) >= 0)
		? preselectOrgId
		: ids[0];
	$sel.val(chosen);
	$('#savedOrgsGroup').show();
	$('#newOrgGroup').hide();
	$('#backToSavedOrgsLink').show();
	return chosen;
}

function cshLoadSavedOrgs() {
	return new Promise(function (resolve) {
		chrome.runtime.sendMessage({
			type: 'cshListSavedOrgs',
			changeSetId: cshDeployHelperChangeSetId()
		}, function (resp) {
			if (!resp || !resp.ok) {
				console.warn('cshListSavedOrgs failed:', resp && resp.error);
				resolve({ orgs: [], lastOrgIdForChangeSet: null });
				return;
			}
			resolve({
				orgs: resp.orgs || [],
				lastOrgIdForChangeSet: resp.lastOrgIdForChangeSet || null
			});
		});
	});
}

async function cshRefreshSavedOrgsUI() {
	var { orgs, lastOrgIdForChangeSet } = await cshLoadSavedOrgs();
	cshRenderSavedOrgsDropdown(orgs, lastOrgIdForChangeSet);
}

function cshOnConnectSavedOrg() {
	var orgId = $('#savedOrgsSelect').val();
	if (!orgId) return;
	var $btn = $('#savedOrgConnect');
	var originalLabel = $btn.val();
	$btn.prop('disabled', true).val('Connecting…');
	chrome.runtime.sendMessage({
		oauth: 'connectToDeploy',
		orgId: orgId,
		changeSetId: cshDeployHelperChangeSetId()
	}, function (response) {
		$btn.prop('disabled', false).val(originalLabel);
		if (!response || !response.ok) {
			var msg = (response && response.error) || 'Unknown error';
			if (response && response.needsReauth) {
				// Refresh token was revoked / expired. Invite the user to
				// re-OAuth for this org without deleting the saved record —
				// the re-auth will update the stored refresh token in place.
				var selOpt = $('#savedOrgsSelect option:selected');
				var orgData = selOpt.data('org') || {};
				var host = orgData.host || '';
				// Always re-auth against the org's stored host so My Domain
				// sandboxes land back on their own login page (not the
				// generic test.salesforce.com). Production login.salesforce
				// .com is still the standard prod endpoint.
				var env;
				if (/^https?:\/\/login\.salesforce\.com/i.test(host)) {
					env = 'prod';
				} else if (/^https?:\/\/test\.salesforce\.com/i.test(host)) {
					env = 'sandbox';
				} else {
					env = 'mydomain';
				}
				window.cshToast && window.cshToast.show(
					msg + ' — re-authorizing…',
					{ type: 'info' }
				);
				cshStartNewOrgLogin(env, host);
				return;
			}
			window.cshToast && window.cshToast.show(
				'Connect failed: ' + msg,
				{ type: 'error' }
			);
			return;
		}
		$("#loginSection").hide();
		$("#loggedInUsername").html(response.username || '');
		$("#validateSection").show();
	});
}

function cshOnDeleteSavedOrg() {
	var orgId = $('#savedOrgsSelect').val();
	if (!orgId) return;
	var $sel = $('#savedOrgsSelect');
	var label = $sel.find('option:selected').text();
	if (!confirm('Forget saved org?\n\n' + label + '\n\nYou will be asked to sign in again next time you use it.')) {
		return;
	}
	chrome.runtime.sendMessage({
		type: 'cshDeleteSavedOrg',
		orgId: orgId
	}, function (resp) {
		if (!resp || !resp.ok) {
			window.cshToast && window.cshToast.show(
				'Could not forget org: ' + ((resp && resp.error) || 'unknown error'),
				{ type: 'error' }
			);
			return;
		}
		cshRefreshSavedOrgsUI();
	});
}

// Launch the OAuth popup for a new (or re-authorized) org. customHost is
// only used when env === 'mydomain'.
function cshStartNewOrgLogin(env, customHost) {
	chrome.runtime.sendMessage({
		oauth: 'connectToDeploy',
		environment: env,
		customHost: customHost || null,
		changeSetId: cshDeployHelperChangeSetId()
	}, function (response) {
		if (!response || !response.ok) {
			var err = (response && response.error) || 'Unknown error';
			console.log('Problem logging in:', err);
			window.cshToast && window.cshToast.show('Problem logging in: ' + err, { type: 'error' });
			return;
		}
		$("#loginSection").hide();
		$("#loggedInUsername").html(response.username || '');
		$("#validateSection").show();
		// Keep the saved-orgs list fresh for the next page visit; don't
		// block UI on this.
		cshRefreshSavedOrgsUI().catch(function () {});
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
	cshStartNewOrgLogin(env, customHost);
}

// Initial login-state check — invoked from wireDeployHelper() so the DOM is
// guaranteed to exist when the callback fires. If the offscreen document
// still has an active deploy connection (service worker survived since the
// last login), we skip the login UI; otherwise we render the saved-orgs
// dropdown.
function cshDeployHelperInitLoginState() {
	chrome.runtime.sendMessage({'proxyFunction': 'getDeployUsername'}, function(username) {
		if (username) {
			$("#loginSection").hide();
			$("#loggedInUsername").html(username);
			$("#validateSection").show();
			return;
		}
		cshRefreshSavedOrgsUI().catch(function (e) {
			console.warn('cshRefreshSavedOrgsUI failed:', e && e.message);
		});
	});
}



function deployLogin() {
	console.log('Initiating login');
	oauthLogin();
}

function deployLogout() {
	chrome.runtime.sendMessage({'oauth': 'deployLogout'}, function(response) {
		console.log(response);
			//do nothing else
	});

	// Stop any page-side deploy poll from continuing to hit a stale token.
	cshStopPageDeployPoll();

	$('#deployContent').html();
	$('#quickDeploy').hide();
	$('#json-renderer').jsonViewer();
	var jsonDetailsLo = document.getElementById('csh-json-details');
	if (jsonDetailsLo) { jsonDetailsLo.open = false; jsonDetailsLo.style.display = 'none'; }
	$("#loginSection").show();
	$("#validateSection").hide();
	// Re-render saved orgs in case this is a multi-org workflow.
	cshRefreshSavedOrgsUI().catch(function () {});

}


function cancelDeploy() {
    var currentId = $("#currentDeployId").val();
    // Try the page-side REST cancel first (works even if the SW suspended
    // during a long deploy). Fall back to the legacy SW path if we don't
    // have poll state yet — covers the race where Cancel is clicked
    // between port handoff and the first REST poll.
    if (cshDpPollState && cshDpPollState.accessToken) {
        var s = cshDpPollState;
        var url = s.instanceUrl + '/services/data/v' + s.apiVersion +
            '/metadata/deployRequest/' + encodeURIComponent(currentId);
        fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': 'Bearer ' + s.accessToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ deployResult: { status: 'Canceling' } })
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            $('#deployContent').html('Status: Cancelling...');
            cshSetDpPhase('Canceling');
            // Keep the poller running — it will see status='Canceled' and
            // fire cshFinishDeployProgress on the next tick.
        }).catch(function (err) {
            console.error('Cancel failed:', err);
            $('#deployContent').html('Status: Cancel failed — ' + (err.message || err));
        });
        return;
    }
	chrome.runtime.sendMessage({'proxyFunction': 'cancelDeploy', 'currentId': currentId}, function(response) {
			$('#cancelDeploy').hide();
			if (response.err) {
    			console.error(response.err);
    			$('#json-renderer').jsonViewer(response.err);
    			cshUpdateJsonBadge(response.err && response.err.message ? response.err.message : 'error');
    			cshBindJsonCopy();
    			$('#deployContent').html('Status: ERROR');
    		} else {
                $('#deployContent').html('Status: Cancelling...');
                $('#json-renderer').jsonViewer(response.response);
                cshUpdateJsonBadge(response.response);
                cshBindJsonCopy();
                cshSetDpPhase('Canceling');
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
		cshUpdateJsonBadge(null);
		cshBindJsonCopy();
		var jsonDetailsQ = document.getElementById('csh-json-details');
		if (jsonDetailsQ) { jsonDetailsQ.open = false; jsonDetailsQ.style.display = ''; }
		$('#quickDeploy').hide();
		cshResetDeployProgress();
		// Quick deploy skips the retrieve phase entirely — pivot the timer
		// pair so the Retrieve counter stays at 0s and the Deploy timer
		// runs for the full duration.
		cshMarkRetrieveDone();
		cshSetDpPhase('Queued in target org');

		var port = chrome.runtime.connect({name: "quickDeployHandler"});
		port.postMessage({'proxyFunction': "quickDeploy", "currentId": currentId});
		port.onMessage.addListener(function (msg) {
			console.log('Listining!');
			console.log(msg);
			var err = msg.err;
			if (err) {
				console.debug(err);
				$('#json-renderer').jsonViewer(err);
				cshUpdateJsonBadge(typeof err === 'string' ? err : (err && err.message) || 'error');
				cshBindJsonCopy();
				$('#deployContent').html('Status: ERROR  ');
				$('#cancelDeploy').hide();
				cshStopPageDeployPoll();
				cshFinishDeployProgress('Failed');
				$('#deployTest').prop('disabled', false).val(cshDeployButtonLabel());
				port.disconnect();
			} else if (msg.handoff) {
				// Hand off to the page poller (same as validate flow).
				cshStartPageDeployPoll(msg.handoff);
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
		$("#savedOrgConnect").click(cshOnConnectSavedOrg);
		$("#savedOrgDelete").click(cshOnDeleteSavedOrg);
		$("#addAnotherOrgLink").click(function (ev) {
			ev.preventDefault();
			$('#savedOrgsGroup').hide();
			$('#newOrgGroup').show();
			$('#backToSavedOrgsLink').show();
		});
		$("#backToSavedOrgsLink").click(function (ev) {
			ev.preventDefault();
			$('#newOrgGroup').hide();
			$('#savedOrgsGroup').show();
		});

		// Run login-state check now that DOM is guaranteed to exist.
		cshDeployHelperInitLoginState();

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

		// Keep the button label in sync with the deploy-mode selector. Picking
		// "Deploy to target" flips the button to "Deploy" so the user is never
		// a click away from an irreversible deploy with a misleading label.
		// Also paint the button red in deploy mode as a visual tripwire.
		$(document).on('change', '#deployModeInput', function () {
			var $btn = $('#deployTest');
			// Only swap the label when the button is idle — if a run is in
			// progress the button says "Please wait..." and must stay that way.
			if (!$btn.prop('disabled')) $btn.val(cshDeployButtonLabel());
			if ($(this).val() === 'deploy') $btn.addClass('csh-deploy-live');
			else $btn.removeClass('csh-deploy-live');
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

