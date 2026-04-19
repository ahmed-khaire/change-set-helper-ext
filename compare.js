$(document).ready(function () {

	var subStr = window.location.search.match("item=(.*)");
	var compareItem = decodeURIComponent(subStr[1]);
	window.document.title = "COMPARING ------ " + compareItem + " ------  This Org < -- > Other Org"
	$('#compare').mergely({
		width: 'auto',
		height: 'auto',
		ignorews: true,
		cmsettings: { readOnly: false, lineNumbers: true },
		lhs: function(setValue) {
			setValue('Loading...');
		},
		rhs: function(setValue) {
			setValue('Loading...');
		}
	});

	// --- Progress panel -----------------------------------------------------
	// Track which side has resolved (lhs = this-org retrieve, rhs = other-org
	// retrieve) so the elapsed timer keeps running until both land. If either
	// side errors the panel shows the error inline instead of crashing the
	// whole popup like the old code did with innerHTML on a jQuery object.
	var progress = {
		start: Date.now(),
		lhs: 'working',
		rhs: 'working',
		tipShownAt: 30000, // surface the "setup → retrieve status" tip after 30s
		timer: null
	};
	function updateProgressPanel() {
		var phases = 'This org: ' + progress.lhs + ' · Other org: ' + progress.rhs;
		$('.csh-compare-progress-phase').text(phases);
		var elapsed = Math.floor((Date.now() - progress.start) / 1000);
		var label = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's';
		$('.csh-compare-progress-elapsed').text('Elapsed: ' + label);
		if ((Date.now() - progress.start) > progress.tipShownAt) {
			$('.csh-compare-progress-tip').show();
		}
		if (progress.lhs !== 'working' && progress.rhs !== 'working') {
			clearInterval(progress.timer);
			// Auto-hide the panel after both sides have finished (success or
			// error) so the diff takes the whole window. Errors stay visible
			// long enough for the user to read them.
			var anyError = progress.lhs === 'error' || progress.rhs === 'error';
			setTimeout(function () {
				$('#csh-compare-progress').fadeOut(300);
			}, anyError ? 4000 : 600);
		}
	}
	progress.timer = setInterval(updateProgressPanel, 500);
	$('#csh-compare-cancel').on('click', function () {
		window.close();
	});

	chrome.runtime.onMessage.addListener(
		  function(request, sender, sendResponse) {
			 if (request.err){
				 // Reflect the error in the panel and stop the elapsed timer;
				 // don't rely on $().innerHTML (which doesn't exist on jQuery
				 // collections) — the legacy code silently threw here.
				 var sideKey = request.setSide || 'lhs';
				 progress[sideKey] = 'error';
				 $('.csh-compare-progress-phase').append(
					 '<div style="color:#c23934;margin-top:4px;">' + sideKey.toUpperCase() + ' failed: ' +
					 String(request.err).replace(/[<>&"']/g, function (c) {
						 return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
					 }) + '</div>'
				 );
				 updateProgressPanel();
				 return false;
			 }
			 if (request.setSide) {
				 if (compareItem  && compareItem!=request.compareItem) {
					return false;
				 }

				var zip = new JSZip();
				zip.loadAsync(request.content.zipFile, {base64: true}).then(function (zip) {
					// Gather candidate files first, skip directory entries and
					// package.xml (we never diff the manifest). Sorting by name
					// guarantees a deterministic render order so both sides
					// line up and re-runs produce identical output.
					var filenames = Object.keys(zip.files).filter(function (name) {
						if (zip.files[name].dir) return false;
						if (name.endsWith('package.xml')) return false;
						return true;
					}).sort();

					if (filenames.length === 0) {
						// Retrieve succeeded but the item isn't present in
						// this org. Tell the user explicitly — the old code
						// left the pane stuck on "Loading..." which looked
						// like a broken request.
						$('#compare').mergely(request.setSide, '(not found in this org)');
						progress[request.setSide] = 'done';
						updateProgressPanel();
						return;
					}

					// Read every file as raw bytes so we can detect binary
					// content. Reading as 'string' on a binary payload (e.g.
					// StaticResource body, images in bundles) produced UTF-16
					// gibberish that filled mergely with noise.
					return Promise.all(filenames.map(function (name) {
						return zip.files[name].async('uint8array').then(function (bytes) {
							return { name: name, bytes: bytes };
						});
					})).then(function (entries) {
						var out = '';
						entries.forEach(function (e) {
							var short = e.name.substring(e.name.lastIndexOf('/') + 1);
							out += '\r\n--------------------------  ' + short + '  ----------------------------\r\n';

							// Null-byte sniff on the first 4KB. Any NUL
							// almost certainly means binary (text metadata
							// has none). Image / zip / font bytes get a
							// placeholder instead of corrupting the diff.
							var sample = Math.min(e.bytes.length, 4096);
							var isBinary = false;
							for (var i = 0; i < sample; i++) {
								if (e.bytes[i] === 0) { isBinary = true; break; }
							}
							if (isBinary) {
								out += '[binary file: ' + e.bytes.length + ' bytes — diff skipped]\r\n';
								return;
							}
							try {
								out += new TextDecoder('utf-8').decode(e.bytes);
							} catch (_) {
								out += '[could not decode ' + short + ' as UTF-8]\r\n';
							}
						});
						// One mergely write per side, after all reads — no
						// race, no partial-write flicker.
						$('#compare').mergely(request.setSide, out);
						progress[request.setSide] = 'done';
						updateProgressPanel();
					});
				}).catch(function (e) {
					progress[request.setSide] = 'error';
					$('.csh-compare-progress-phase').append(
						'<div style="color:#c23934;margin-top:4px;">' + request.setSide.toUpperCase() + ' unzip failed: ' + (e && e.message ? e.message : String(e)) + '</div>'
					);
					updateProgressPanel();
				});
				return false;
			}

	});
});