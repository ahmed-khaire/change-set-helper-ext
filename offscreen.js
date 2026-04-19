// Offscreen document for JSforce operations (has access to XMLHttpRequest)

var CSH_APIVERSION = "60.0";
const versionPattern = RegExp('^[0-9][0-9]\.0$');

const POLLTIMEOUT = 20*60*1000; // 20 minutes
const POLLINTERVAL = 5000; //5 seconds

var connDeploy = {conn: null, username: null};
var connLocal = {conn: null, username: null};
var connLocalOauth = {conn: null, username: null};

// Wait for window to load before initializing
console.log('Offscreen.js script loaded');

// Function to initialize
function initializeOffscreen() {
    console.log('Offscreen document initializing...');

    // Wait for jsforce to be available
    if (typeof jsforce === 'undefined') {
        console.error('JSforce library not loaded!');
        // Try again after a short delay
        setTimeout(initializeOffscreen, 100);
        return;
    } else {
        console.log('JSforce library loaded successfully, version:', jsforce.VERSION || 'unknown');
    }

    // Initialize chrome.storage API calls after Chrome APIs are ready.
    // Same priority ladder as background.js: sync user pref > local auto > 60.0.
    var offscreenIsUserPref = false;
    try {
        if (chrome && chrome.storage && chrome.storage.sync) {
            chrome.storage.sync.get(['salesforceApiVersion'], function (items) {
                if (chrome.runtime.lastError) {
                    console.log('Could not read sync storage:', chrome.runtime.lastError.message);
                    return;
                }
                if (items && items.salesforceApiVersion && versionPattern.test(items.salesforceApiVersion)) {
                    CSH_APIVERSION = items.salesforceApiVersion;
                    offscreenIsUserPref = true;
                    console.log('Offscreen - API Version:', CSH_APIVERSION, '(user pref)');
                    return;
                }
                chrome.storage.local.get(['cshResolvedApiVersion'], function (local) {
                    if (local && local.cshResolvedApiVersion && versionPattern.test(local.cshResolvedApiVersion)) {
                        CSH_APIVERSION = local.cshResolvedApiVersion;
                        console.log('Offscreen - API Version:', CSH_APIVERSION, '(auto)');
                    }
                });
            });

            chrome.storage.onChanged.addListener(function (changes, areaName) {
                if (areaName === 'sync' && changes.salesforceApiVersion) {
                    if (versionPattern.test(changes.salesforceApiVersion.newValue)) {
                        CSH_APIVERSION = changes.salesforceApiVersion.newValue;
                        offscreenIsUserPref = true;
                        console.log('Offscreen - API Version changed:', CSH_APIVERSION, '(user pref)');
                    }
                    return;
                }
                if (areaName === 'local' && changes.cshResolvedApiVersion && !offscreenIsUserPref) {
                    if (versionPattern.test(changes.cshResolvedApiVersion.newValue)) {
                        CSH_APIVERSION = changes.cshResolvedApiVersion.newValue;
                        console.log('Offscreen - API Version changed:', CSH_APIVERSION, '(auto)');
                    }
                }
            });

            console.log('Chrome storage API initialized successfully');
        } else {
            console.log('Chrome storage API not available, using default API version:', CSH_APIVERSION);
        }
    } catch (err) {
        console.log('Error initializing storage API:', err.message, '- using default API version:', CSH_APIVERSION);
    }

    // Notify service worker that we're ready
    setTimeout(() => {
        chrome.runtime.sendMessage({action: 'offscreenReady'}).then(() => {
            console.log('Notified service worker that offscreen is ready');
        }).catch(err => {
            console.log('Could not notify service worker:', err.message);
        });
    }, 100);
}

// Initialize when document is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeOffscreen);
} else {
    // Document already loaded
    initializeOffscreen();
}

// Handle messages from service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Offscreen received:', request.action);

    switch(request.action) {
        case 'setLocalConn':
            setLocalConn(
                request.authValue || request.sessionId,
                request.serverUrl,
                request.authMode || 'sid',
                request.instanceUrl || request.serverUrl
            );
            sendResponse({success: true});
            break;

        case 'connectToOrg':
            connectToOrg(request.environment, request.connType, request.instanceUrl, request.accessToken)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({error: err.message}));
            return true; // Keep channel open for async response

        case 'listMetadata':
            listMetadata(request.connType, request.types)
                .then(results => sendResponse({results: results}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'describeMetadata':
            describeMetadata(request.connType)
                .then(results => sendResponse({results: results}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'queryTooling':
            queryTooling(request.connType, request.soql)
                .then(records => sendResponse({records: records}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'downloadMetadata':
            downloadMetadata(request.connType, request.changename)
                .then(result => sendResponse({result: result}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'retrieveMetadata':
            retrieveMetadata(request.connType, request.opts)
                .then(zipData => sendResponse({zipData: zipData}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'deploy':
            deployToSF(request.zipData, request.opts)
                .then(result => sendResponse({result: result}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'quickDeploy':
            quickDeployToSF(request.deployId)
                .then(result => sendResponse({result: result}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'cancelDeploy':
            cancelDeployment(request.deployId)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'checkDeployStatus':
            checkDeployStatus(request.deployId)
                .then(result => sendResponse({result: result}))
                .catch(err => sendResponse({error: err.message}));
            return true;

        case 'getDeployUsername':
            sendResponse({username: connDeploy.username});
            break;

        case 'deployLogout':
            connDeploy.conn = null;
            connDeploy.username = null;
            sendResponse({success: true});
            break;
    }
});

function setLocalConn(authValue, serverUrl, authMode, instanceUrl) {
    // Two accepted auth shapes:
    //   authMode = 'sid'   -> serverUrl + sessionId  (from browser cookie)
    //   authMode = 'oauth' -> instanceUrl + accessToken  (from PKCE login)
    var opts = { 'version': CSH_APIVERSION };
    if (authMode === 'oauth') {
        opts.instanceUrl = instanceUrl || serverUrl;
        opts.accessToken = authValue;
    } else {
        opts.serverUrl = serverUrl;
        opts.sessionId = authValue;
    }
    connLocal.conn = new jsforce.Connection(opts);
    connLocal.conn.metadata.pollTimeout = POLLTIMEOUT;
    connLocal.conn.metadata.pollInterval = POLLINTERVAL;
    console.log('setLocalConn: authMode =', authMode || 'sid', ', host =', (opts.instanceUrl || opts.serverUrl));
}

async function connectToOrg(environment, connType, instanceUrl, accessToken) {
    const conn = new jsforce.Connection({
        instanceUrl: instanceUrl,
        accessToken: accessToken,
        'version': CSH_APIVERSION
    });
    conn.metadata.pollTimeout = POLLTIMEOUT;
    conn.metadata.pollInterval = POLLINTERVAL;

    try {
        const res = await conn.chatter.resource('/users/me').retrieve();
        const username = res.username;

        if (connType === 'deploy') {
            connDeploy.conn = conn;
            connDeploy.username = username;
        } else if (connType === 'local') {
            connLocal.conn = conn;
            connLocal.username = username;
        } else if (connType === 'localOauth') {
            connLocalOauth.conn = conn;
            connLocalOauth.username = username;
        }

        return {username: username};
    } catch (err) {
        throw new Error('Failed to connect: ' + err.message);
    }
}

async function listMetadata(connType, types) {
    const conn = connType === 'deploy' ? connDeploy.conn : connLocal.conn;

    if (!conn) {
        throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
        conn.metadata.list(types, CSH_APIVERSION, function(err, results) {
            if (err) {
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
}

async function queryTooling(connType, soql) {
    const conn = connType === 'deploy' ? connDeploy.conn : connLocal.conn;
    if (!conn) throw new Error('Not connected');
    // JSforce's tooling.query() returns only the first 2000 records by default
    // on a one-shot call (standard Salesforce SOQL batch size). For orgs with
    // >2000 Apex classes / LWC bundles, we MUST walk queryMore chains or the
    // extension silently drops records from the table. The loop below follows
    // nextRecordsUrl / done:false until Salesforce says all records are in.
    var all = [];
    var res = await new Promise((resolve, reject) => {
        conn.tooling.query(soql, function (err, r) {
            if (err) return reject(err);
            resolve(r);
        });
    });
    if (res && Array.isArray(res.records)) all = all.concat(res.records);
    while (res && res.done === false && res.nextRecordsUrl) {
        res = await new Promise((resolve, reject) => {
            conn.tooling.queryMore(res.nextRecordsUrl, function (err, r) {
                if (err) return reject(err);
                resolve(r);
            });
        });
        if (res && Array.isArray(res.records)) all = all.concat(res.records);
    }
    console.log('queryTooling:', all.length, 'record(s) fetched for', soql.slice(0, 60) + '...');
    return all;
}

async function describeMetadata(connType) {
    const conn = connType === 'deploy' ? connDeploy.conn : connLocal.conn;

    if (!conn) {
        throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
        conn.metadata.describe(CSH_APIVERSION, function(err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

// Accumulate retrieve-stream chunks and encode base64 once at the end.
// The previous implementation did `zipData += data.toString('base64')` per
// chunk which is O(n²) memory-wise in V8 (each += reallocates the growing
// string) AND produced corrupt base64 when a chunk boundary did not land on
// a 3-byte boundary (each per-chunk encode pads with `=`, embedding padding
// bytes inside the stream). We delegate concatenation to whatever Buffer
// constructor the stream chunks belong to — jsforce bundles its own Buffer
// polyfill internally and does not expose it as a global, but each chunk
// carries a reference to the same class via .constructor.
function cshConsumeZipStream(stream) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        stream.on('data', function (chunk) { chunks.push(chunk); });
        stream.on('end', function () {
            try {
                if (!chunks.length) { resolve(''); return; }
                var BufCtor = chunks[0].constructor;
                resolve(BufCtor.concat(chunks).toString('base64'));
            } catch (e) {
                reject(e);
            }
        });
        stream.on('error', function (err) { reject(err); });
    });
}

async function downloadMetadata(connType, changename) {
    const conn = connType === 'deploy' ? connDeploy.conn : connLocal.conn;

    if (!conn) {
        throw new Error('Not connected');
    }

    const zipStream = conn.metadata.retrieve({
        singlePackage: false,
        apiVersion: CSH_APIVERSION,
        packageNames: [changename]
    }).stream();
    const zipData = await cshConsumeZipStream(zipStream);
    return { zipFile: zipData };
}

async function retrieveMetadata(connType, opts) {
    const conn = connType === 'local' ? connLocal.conn : connDeploy.conn;

    if (!conn) {
        throw new Error('Not connected');
    }

    const zipStream = conn.metadata.retrieve(opts).stream();
    return await cshConsumeZipStream(zipStream);
}

// Convert a base64 string to a Blob without loading through atob in one shot
// for very large payloads. Chunked decode keeps memory manageable.
function cshBase64ToBlob(base64, contentType) {
    var binaryString = atob(base64);
    var len = binaryString.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: contentType || 'application/zip' });
}

// Kick off a deploy via the Metadata REST API directly so we can return the
// deploy id to the caller immediately. The old path used jsforce's
// metadata.deploy() and waited on its 'progress' event, which only fires
// after jsforce's internal poll tick — holding the Chrome message channel
// open long enough that it would close mid-validate. REST POST returns the
// id in the response body, so sendResponse fires in < 1s regardless of how
// long the deploy itself takes.
async function deployToSF(zipData, opts) {
    if (!connDeploy.conn) {
        throw new Error('Not connected to deploy org');
    }
    if (!connDeploy.conn.accessToken || !connDeploy.conn.instanceUrl) {
        throw new Error('Deploy connection missing accessToken/instanceUrl');
    }

    var url = connDeploy.conn.instanceUrl +
        '/services/data/v' + CSH_APIVERSION + '/metadata/deployRequest';

    // Build the multipart body by hand. Browser FormData appends a default
    // filename="blob" to the JSON part, which the Metadata REST endpoint
    // rejects with INVALID_MULTIPART_REQUEST. Salesforce expects the
    // entity_content part to carry NO filename.
    var boundary = 'cshBoundary_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    var jsonPart = JSON.stringify({ deployOptions: opts || {} });

    // Decode base64 zip into bytes without a Blob round-trip so we can stitch
    // raw bytes into the multipart body.
    var binaryString = atob(zipData);
    var zipLen = binaryString.length;
    var zipBytes = new Uint8Array(zipLen);
    for (var i = 0; i < zipLen; i++) zipBytes[i] = binaryString.charCodeAt(i);

    var header =
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="entity_content"\r\n' +
        'Content-Type: application/json\r\n\r\n' +
        jsonPart + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="deploy.zip"\r\n' +
        'Content-Type: application/zip\r\n\r\n';
    var footer = '\r\n--' + boundary + '--\r\n';

    var enc = new TextEncoder();
    var headerBytes = enc.encode(header);
    var footerBytes = enc.encode(footer);
    var body = new Uint8Array(headerBytes.length + zipBytes.length + footerBytes.length);
    body.set(headerBytes, 0);
    body.set(zipBytes, headerBytes.length);
    body.set(footerBytes, headerBytes.length + zipBytes.length);

    var resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + connDeploy.conn.accessToken,
            'Content-Type': 'multipart/form-data; boundary="' + boundary + '"'
        },
        body: body
    });
    var text = await resp.text();
    if (!resp.ok) {
        throw new Error('Deploy REST POST failed: ' + resp.status + ' ' + text);
    }
    var body;
    try { body = JSON.parse(text); } catch (e) {
        throw new Error('Deploy REST POST returned non-JSON: ' + text);
    }
    if (!body || !body.id) {
        throw new Error('Deploy REST POST missing id: ' + text);
    }
    return { id: body.id, state: body.state || 'Queued' };
}

// Quick deploy — same approach: POST the validated deploy id and return the
// new deploy request id immediately.
async function quickDeployToSF(deployId) {
    if (!connDeploy.conn) {
        throw new Error('Not connected to deploy org');
    }
    if (!connDeploy.conn.accessToken || !connDeploy.conn.instanceUrl) {
        throw new Error('Deploy connection missing accessToken/instanceUrl');
    }

    var url = connDeploy.conn.instanceUrl +
        '/services/data/v' + CSH_APIVERSION + '/metadata/deployRequest';

    var resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + connDeploy.conn.accessToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ validatedDeployRequestId: deployId })
    });
    var text = await resp.text();
    if (!resp.ok) {
        throw new Error('Quick deploy REST POST failed: ' + resp.status + ' ' + text);
    }
    var body;
    try { body = JSON.parse(text); } catch (e) {
        throw new Error('Quick deploy REST POST returned non-JSON: ' + text);
    }
    if (!body || !body.id) {
        throw new Error('Quick deploy REST POST missing id: ' + text);
    }
    return { id: body.id, state: body.state || 'Queued' };
}

async function cancelDeployment(deployId) {
    if (!connDeploy.conn) {
        throw new Error('Not connected to deploy org');
    }

    return new Promise((resolve, reject) => {
        connDeploy.conn.metadata.cancelDeploy(deployId, function(err, response) {
            if (err) {
                reject(err);
            } else {
                resolve({response: response});
            }
        });
    });
}

async function checkDeployStatus(deployId) {
    if (!connDeploy.conn) {
        throw new Error('Not connected to deploy org');
    }

    return new Promise((resolve, reject) => {
        connDeploy.conn.metadata.checkDeployStatus(deployId, true, function(err, result) {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

console.log('Offscreen document ready for JSforce operations');
