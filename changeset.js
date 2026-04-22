var changeSetTable = null;
var typeColumn = null;
var nameColumn = null;
var numCallsInProgress = 0;
var totalComponentCount = 0; // Track total rows loaded for pagination decisions
var isLoadingMorePages = false; // Flag to indicate we're still loading pages in background
var cachedMetadataResults = []; // Store metadata results to reuse during pagination
var cachedMetadataIds = new Set(); // Companion to cachedMetadataResults for O(1) dedup
var dynamicColumns = null; // Store dynamic column configuration based on metadata properties
var resolvedMetadataType = null; // Metadata API type name resolved via override map or describeMetadata cache

// Verbose per-call diagnostic logs. Off in production because on big orgs
// (Custom Fields / Layouts / RecordTypes) processListResults and
// applyMetadataToRows each emit a burst of structured logs — stringification
// cost is non-trivial with DevTools open and the noise drowns useful signal.
// Flip to true while debugging a user report.
var CSH_DEBUG = false;

// Compare functionality column indices (set dynamically after table setup)
var compareColumnIndices = {
    folder: -1,              // Folder column (for folder-based entities)
    lastModifiedDate: -1,    // This org's Last Modified Date
    compareDateMod: -1,      // Compare org's Date Modified
    compareModBy: -1,        // Compare org's Modified By
    fullName: -1             // Full Name (clickable for diff)
};

var entityTypeMap = {
    'TabSet': 'CustomApplication',
    'ApexClass': 'ApexClass',
    'ApexComponent': 'ApexComponent',
    'ApexPage': 'ApexPage',
    'ApexTrigger': 'ApexTrigger',
    'AssignmentRule': 'AssignmentRules',
    'AuraDefinitionBundle': 'AuraDefinitionBundle',
    'AuthProvider': 'AuthProvider',
    'AutoResponseRule': 'AutoResponseRules',
    'CallCenter': 'CallCenter',
    'Community': 'Community',
    'CompactLayout': 'CompactLayout',
    'CorsWhitelistEntry': 'CorsWhitelistOrigin',
    'CustomEntityDefinition': 'CustomObject',
    'CustomFieldDefinition': 'CustomField',
    'CustomObjectCriteriaSharingRule': 'SharingCriteriaRule',
    'CustomReportType': 'ReportType',
    'CustomShareRowCause': 'SharingReason',
    'CustomTabDefinition': 'CustomTab',
    'Dashboard': 'Dashboard',
    'Document': 'Document',
    'EmailTemplate': 'EmailTemplate',
    'FieldSet': 'FieldSet',
    'FlexiPage': 'FlexiPage',
    'FlowDefinition': 'FlowDefinition',
    'Group': 'Group',
    'Layout': 'Layout',
    'LightningComponentBundle': 'LightningComponentBundle',
    'ListView': 'ListView',
    'MatchingRule': 'MatchingRule',
    'NamedCredential': 'NamedCredential',
    'PageComponent': 'HomePageComponent',
    'PermissionSet': 'PermissionSet',
    'PlatformCachePartition': 'PlatformCachePartition',
    'ProcessDefinition': 'ApprovalProcess',
    'Queues': 'Queue',
    'QuickActionDefinition': 'QuickAction',
    'RecordType': 'RecordType',
    'SharedPicklistDefinition': 'GlobalValueSet',
    'SharingSet': 'SharingSet',
    'Site': 'SiteDotCom',
    'StaticResource': 'StaticResource',
    'ValidationFormula': 'ValidationRule',
    'WebLink': 'WebLink',
    'WorkflowRule': 'WorkflowRule',
    'ActionFieldUpdate': 'WorkflowFieldUpdate',
    'ActionTask': 'WorkflowTask',
    'ActionEmail': 'WorkflowAlert',
    'Report': 'Report',
    'ExternalString': 'CustomLabel',
    // Salesforce's Add-to-Change-Set picker sometimes emits the display label
    // (with spaces and a "Type" suffix) instead of the Metadata API xmlName,
    // so describe identity-matching won't resolve these on its own.
    //
    // Custom Metadata Type picker lists __mdt TYPE DEFINITIONS (rows like
    // "My_Config__mdt"), which are surfaced by the Metadata API as CustomObject,
    // not CustomMetadata. CustomMetadata covers records (rows like
    // "My_Config.Row_1") — mapping CMT picker to CustomMetadata made the compare
    // fetch every record from the target org and treat them all as "[target
    // only]" because local rows were keyed to the __mdt types. CSH_POST_FILTERS
    // below trims the full CustomObject list down to just the __mdt entries.
    'Custom Metadata Type': 'CustomObject',
    'Custom Metadata Types': 'CustomObject',
}

// Per-picker post-filter applied to both local getMetaData results and the
// compare-org result set. Used when the resolved Metadata API type is broader
// than what the Salesforce change-set picker actually lists. Without these
// filters the compare org returns every record of the broad type, the local
// table only has rows for the narrow subset, and every extra record lands in
// "[target only]" — misleading the user into thinking their target is
// ahead of source when it just has unrelated records.
//
// Keyed on selectedEntityType (picker value). Each filter takes a record,
// returns true to keep. Callers default to pass-through when no entry exists.
//
// Why suffix tests and not __c-only inclusion: managed-package objects keep
// their __c suffix (e.g. "pkg__Thing__c"), so a __c inclusion list handles
// them correctly, but future custom-object-like types Salesforce may introduce
// without a __c suffix would be dropped. Exclude-list keeps "Custom Object"
// maximally compatible, only dropping the subtypes Salesforce currently has
// distinct pickers for.
var CSH_POST_FILTERS = {
    // "Custom Metadata Type" picker → CustomObject, narrowed to __mdt.
    'Custom Metadata Type': function (rec) {
        return rec && typeof rec.fullName === 'string' && /__mdt$/.test(rec.fullName);
    },
    'Custom Metadata Types': function (rec) {
        return rec && typeof rec.fullName === 'string' && /__mdt$/.test(rec.fullName);
    },
    // "Custom Object" picker → CustomObject, excluding subtypes Salesforce
    // surfaces in their own pickers:
    //   __mdt  Custom Metadata Type
    //   __b    Big Object
    //   __x    External Object
    //   __e    Platform Event
    //   __kav  Knowledge article type
    //   __xo   Salesforce-to-Salesforce external object
    //   __chn  Change Event
    //   __share / __history / __feed  auto-generated system objects
    'CustomEntityDefinition': function (rec) {
        if (!rec || typeof rec.fullName !== 'string') return false;
        return !/__(mdt|b|x|e|kav|xo|chn|share|history|feed)$/i.test(rec.fullName);
    },
    // Covers the case where a Salesforce build emits the API name directly as
    // the picker value (`CustomObject`) rather than the legacy
    // `CustomEntityDefinition`. Same filter so behavior is identical either way.
    'CustomObject': function (rec) {
        if (!rec || typeof rec.fullName !== 'string') return false;
        return !/__(mdt|b|x|e|kav|xo|chn|share|history|feed)$/i.test(rec.fullName);
    }
};

function cshApplyPostFilter(results) {
    var f = CSH_POST_FILTERS[selectedEntityType];
    if (!f || !Array.isArray(results)) return results;
    return results.filter(f);
}

//as Dashboard, Document,
//EmailTemplate, or Report.
var entityFolderMap = {
    'Report': 'ReportFolder',
    'Document': 'DocumentFolder',
    'EmailTemplate': 'EmailFolder',
    'Dashboard': 'DashboardFolder'
}

// Types where Salesforce renders the Label in the Name column and the real
// API identifier lives in the fullName (Parent.Child, Parent-Name, or a
// distinct *__c developer name). Showing a "Developer Name" column makes it
// possible to disambiguate rows that would otherwise look identical — e.g.
// a "Status" field that exists on both Account and Contact, or two "Active"
// record types on different objects. Membership = true means we render the
// extra column; types not listed keep the default layout.
//
// Curated rather than heuristic because (a) Salesforce changes the Name-cell
// contents between releases, and (b) for types like ApexClass the rendered
// Name already IS the API name, so adding the column would just be noise.
var CSH_DEVELOPER_NAME_TYPES = {
    'CustomField': true,
    'ValidationRule': true,
    'RecordType': true,
    'FieldSet': true,
    'CompactLayout': true,
    'Layout': true,
    'WorkflowRule': true,
    'WorkflowFieldUpdate': true,
    'WorkflowAlert': true,
    'WorkflowTask': true,
    'WorkflowOutboundMessage': true,
    'QuickAction': true,
    'ListView': true,
    'CustomObject': true,
    'CustomMetadata': true,
    'CustomLabel': true,
    'SharingRules': true,
    'SharingCriteriaRule': true,
    'SharingOwnerRule': true
};


// Remembered once in setupTable() so every row/column index is computed from
// Salesforce's actual DOM instead of a hard-coded 1-or-2 guess. Lets the
// extension work on entity types where Salesforce renders Name+Type+Parent
// (CustomField, WorkflowFieldUpdate, RecordType, etc.) instead of only Name.
var cshOriginalRowCellCount = null;    // max <td> count per tr.dataRow before we touched the table
var cshOriginalHeaderCount = null;     // <th>+<td> count in tr.headerRow before we touched it

function cshExtraColumnsPerRow() {
    var dyn = (dynamicColumns && dynamicColumns.length > 0) ? dynamicColumns.length : 3;
    return dyn + 4; // dynamic + 4 compare columns
}

// Helper function to add columns to specific rows (avoids freezing with large datasets).
// Two-pass strategy: first find the widest existing row, then pad every row up to
// (widest + extraColumns). Prevents ragged rows when Salesforce renders some rows
// without the Type column (happens for heterogeneous folder-based types).
function addColumnsToRows(rows) {
    if (!rows || rows.length === 0) return;

    var extra = cshExtraColumnsPerRow();
    var widest = 0;
    rows.each(function () {
        var c = $(this).children('td').length;
        if (c > widest) widest = c;
    });
    if (cshOriginalRowCellCount === null) {
        cshOriginalRowCellCount = widest;
    } else if (widest > cshOriginalRowCellCount) {
        cshOriginalRowCellCount = widest;
    }

    var target = cshOriginalRowCellCount + extra;
    rows.each(function () {
        var row = $(this);
        var have = row.children('td').length;
        for (var i = have; i < target; i++) row.append('<td></td>');
    });
}

function setupTable() {
    console.log('========================================');
    console.log('setupTable: Starting table setup');

    typeColumn = $("table.list>tbody>tr.headerRow>th>a:contains('Type')");
    nameColumn = $("table.list>tbody>tr.headerRow>th>a:contains('Name')");

    console.log('setupTable: Type column exists:', typeColumn.length > 0);
    console.log('setupTable: Name column exists:', nameColumn.length > 0);

    // Snapshot the ORIGINAL cell counts before we mutate the table. Every
    // subsequent column-index computation keys off these values, which keeps
    // the extension correct for any entity type Salesforce decides to render —
    // including types that add a parent-object column (CustomField, Workflow*,
    // RecordType, ListView, CompactLayout) and ones that drop the Type column.
    cshOriginalHeaderCount = $("table.list tr.headerRow").children('th,td').length;
    var widestDataRow = 0;
    $("table.list tr.dataRow").each(function () {
        var c = $(this).children('td').length;
        if (c > widestDataRow) widestDataRow = c;
    });
    cshOriginalRowCellCount = widestDataRow;
    console.log('setupTable: original header cells =', cshOriginalHeaderCount,
                ', widest data row =', widestDataRow);

    // Log original header structure
    var originalHeaders = [];
    $("table.list tr.headerRow th, table.list tr.headerRow td").each(function(index) {
        var text = $(this).text().trim();
        var linkText = $(this).find('a').text().trim();
        originalHeaders.push(index + ':' + (linkText || text || 'empty'));
    });
    console.log('Original headers:', originalHeaders.join(' | '));

    // Add header columns dynamically based on metadata properties
    // Note: We don't add an empty Type column when it doesn't exist - we just skip it

    // Add dynamic columns from metadata
    if (dynamicColumns && dynamicColumns.length > 0) {
        console.log('setupTable: Adding', dynamicColumns.length, 'dynamic columns');
        for (var i = 0; i < dynamicColumns.length; i++) {
            $("table.list tr.headerRow").append("<td>" + dynamicColumns[i].headerLabel + "</td>");
            console.log('  - Added column:', dynamicColumns[i].headerLabel);
        }
    } else {
        console.log('setupTable: WARNING - No dynamic columns defined! Using fallback columns.');
        // Fallback to basic columns if metadata not loaded yet
        $("table.list tr.headerRow").append("<td>Full Name</td>");
        $("table.list tr.headerRow").append("<td>Last Modified Date</td>");
        $("table.list tr.headerRow").append("<td>Last Modified By Name</td>");
    }

    // Add compare columns (hidden initially, shown when compare is clicked)
    $("table.list tr.headerRow").append("<td>Folder</td>");  // Hidden, used internally for folder-based entities
    $("table.list tr.headerRow").append("<td class='compareOrgName'>Compare Date Modified</td>");
    $("table.list tr.headerRow").append("<td class='compareOrgName'>Compare Modified By</td>");
    $("table.list tr.headerRow").append("<td>Full Name</td>");  // For diff functionality
    console.log('setupTable: Added 4 compare columns (hidden by default)');

    // Log new header structure
    var newHeaders = [];
    $("table.list tr.headerRow th, table.list tr.headerRow td").each(function(index) {
        var text = $(this).text().trim();
        var linkText = $(this).find('a').text().trim();
        newHeaders.push(index + ':' + (linkText || text || 'empty'));
    });
    console.log('After adding headers:', newHeaders.join(' | '));

    // Add columns only to existing rows (not ALL rows to avoid freeze)
    var existingRows = $("table.list tr.dataRow");
    console.log('setupTable: Found', existingRows.length, 'data rows to update');

    // Log first row BEFORE adding columns
    if (existingRows.length > 0) {
        var firstRowBefore = $(existingRows[0]).find('td').length;
        console.log('First row cell count BEFORE addColumnsToRows:', firstRowBefore);
    }

    addColumnsToRows(existingRows);

    // Log first row AFTER adding columns
    if (existingRows.length > 0) {
        var firstRowAfter = $(existingRows[0]).find('td').length;
        console.log('First row cell count AFTER addColumnsToRows:', firstRowAfter);

        // Log each cell
        var cells = [];
        $(existingRows[0]).find('td').each(function(index) {
            var text = $(this).text().trim();
            cells.push(index + ':' + (text.substring(0, 15) || 'empty'));
        });
        console.log('First row cells:', cells.join(' | '));
    }

    var changeSetHead = $('<thead></thead>').prependTo('table.list').append($('table.list tr:first'));

    // Generate footer with correct number of columns
    var totalColumns = $("table.list thead tr th, table.list thead tr td").length;
    var footerCells = '';
    for (var i = 0; i < totalColumns; i++) {
        footerCells += '<td></td>';
    }
    changeSetHead.after('<tfoot><tr>' + footerCells + '</tr></tfoot>');
    console.log('setupTable: Generated footer with', totalColumns, 'columns');

    console.log('setupTable: Moved header to thead');
    console.log('========================================');

    var gotoloc1 = "'/" + $("#id").val() + "?tab=PackageComponents&rowsperpage=5000'";
    $('input[name="cancel"]')
        .before('<input value="View change set" class="btn" name="viewall" title="View all items in changeset in new window" type="button" onclick="window.open(' + gotoloc1 +',\'_blank\');" />')
        .after(`<br />
		<!-- Saved-orgs picker: populated at load time from the cross-page
		     org registry. Reuses the refresh token stored at last login so
		     the user doesn't have to OAuth again unless it was revoked. -->
		<span id="compareSavedOrgsGroup" style="display:none;">
			<select id="compareSavedOrgsSelect" title="Target org" style="max-width:320px;vertical-align:middle;"></select>
			<input value="Compare with this org" class="btn" id="compareSavedOrgConnect" type="button" />
			<button id="compareSavedOrgDelete" type="button" title="Forget this saved org" style="margin-left:4px;padding:2px 8px;border:1px solid #c9c9c9;background:#fff;border-radius:3px;cursor:pointer;">✕</button>
			<a href="#" id="compareAddAnotherOrgLink" style="margin-left:8px;font-size:12px;">+ Add another org</a>
		</span>
		<span id="compareNewOrgGroup">
			<input value="Compare with org" class="btn compareorg" name="compareorg" id="compareorg"
						title="Compare with another org. A login box will be displayed." type="button" />
			<select id='compareEnv' name='Compare Environment'>
				<option value='sandbox'>Sandbox</option>
				<option value='prod'>Prod/Dev</option>
				<option value='mydomain'>My Domain URL…</option>
			</select>
			<input type='text' id='compareMyDomain' placeholder='https://yourorg.my.salesforce.com' style='display:none;margin-left:6px;padding:3px 6px;min-width:240px;' />
			<a href="#" id="compareBackToSavedOrgsLink" style="display:none;margin-left:8px;font-size:12px;">Back to saved orgs</a>
		</span>
	<span id="loggedInUsername"></span>  <span id="logout">(<a id="logoutLink" href="#">Connect another Org</a>)</span>
	<button type="button" id="csh-compare-refresh" style="display:none;margin-left:8px;padding:2px 10px;border:1px solid #c9c9c9;background:#fff;border-radius:3px;cursor:pointer;font-size:12px;" title="Re-run the compare against the same org. Use this after adding components to the change set or after edits in the target org.">↻ Refresh compare</button>
`);

    $('#editPage').append('<input type="hidden" name="rowsperpage" value="5000" /> ');

    // Populate the saved-orgs dropdown now that its select exists. Safe to
    // call again later (the wiring block also invokes it) — the function
    // just re-reads storage and re-renders the dropdown.
    if (typeof cshCompareRefreshSavedOrgsUI === 'function') {
        cshCompareRefreshSavedOrgsUI().catch(function () {});
    }
}

function convertDate(dateToconvert) {
    var momentDate = new moment(dateToconvert);
    return momentDate.format("DD MMM YYYY");

}

function convertToMoment(stringToconvert) {
    var momentDate = new moment(stringToconvert, "DD MMM YYYY");
    return momentDate;
}

// Convert camelCase to Capital Case (e.g., "lastModifiedDate" -> "Last Modified Date")
function camelCaseToCapitalCase(str) {
    // Handle empty or invalid strings
    if (!str || typeof str !== 'string') return str;

    // Insert space before capital letters and capitalize first letter
    var result = str
        .replace(/([A-Z])/g, ' $1')  // Add space before capitals
        .replace(/^./, function(char) { return char.toUpperCase(); })  // Capitalize first letter
        .trim();

    return result;
}

// Check if a value is a Salesforce ID (15 or 18 character alphanumeric string)
function isSalesforceId(value) {
    if (typeof value !== 'string') return false;

    // Salesforce IDs are either 15 or 18 characters, alphanumeric
    var length = value.length;
    if (length !== 15 && length !== 18) return false;

    // Check if it's alphanumeric (Salesforce IDs don't contain special characters)
    return /^[a-zA-Z0-9]+$/.test(value);
}

// Determine which columns to add dynamically based on metadata properties.
// Accepts either a single record or an array; for an array we union properties
// across all records so heterogeneous results (e.g. managed-package records
// with extra fields) don't silently drop columns that only some rows carry.
function determineMetadataColumns(metadataRecordOrArray) {
    if (!metadataRecordOrArray) {
        console.log('determineMetadataColumns: No metadata record provided');
        return [];
    }

    var records = Array.isArray(metadataRecordOrArray) ? metadataRecordOrArray : [metadataRecordOrArray];
    records = records.filter(function (r) { return r && typeof r === 'object'; });
    if (records.length === 0) {
        console.log('determineMetadataColumns: No usable records');
        return [];
    }

    console.log('========================================');
    console.log('determineMetadataColumns: Analyzing', records.length, 'record(s) for column union');

    var columns = [];

    // Developer Name / API Name column. For component families where the
    // "Name" cell Salesforce renders is really the Label (multiple rows can
    // share it — CustomField most famously, where Account.MyField__c and
    // Contact.MyField__c both show as "My Field"), we prepend a dedicated
    // column showing the API name so users can tell duplicates apart, sort
    // by it, and filter by it. For types whose Name already IS the API name
    // (ApexClass, ApexTrigger, LWC bundles, …) the column is redundant and
    // we skip adding it.
    //
    // filterType:'text' tells tableInitComplete to build a text-search input
    // instead of the default dropdown — for CustomField with 5000 unique
    // developer names a dropdown with 5000 options is useless.
    // Key lookup on resolvedMetadataType (Metadata API name, e.g. "CustomField"),
    // NOT selectedEntityType (Salesforce UI name, e.g. "CustomFieldDefinition").
    // The CSH_DEVELOPER_NAME_TYPES map is authored against API names, so checking
    // the UI name never matched — the column silently never appeared.
    if (CSH_DEVELOPER_NAME_TYPES[resolvedMetadataType]) {
        columns.push({
            propertyName: 'fullName',
            headerLabel: 'Developer Name',
            isDate: false,
            filterType: 'text'
        });
    }

    // Define which properties to include and in what order
    // Skip certain properties that aren't useful for display
    // fullName is skipped in the generic union loop because we've already
    // handled it as the Developer Name column above (types where it matters)
    // or intentionally omitted it (types where it'd duplicate the Name cell).
    var skipProperties = ['id', 'type', 'fileName', 'manageableState', 'namespacePrefix', 'fullName'];

    // Preferred order for common properties
    // Note: ID columns (createdById, lastModifiedById) are automatically filtered out
    // Note: fullName is excluded (already have "Name" column in Salesforce table)
    var propertyOrder = [
        'createdDate',
        'createdByName',
        'lastModifiedDate',
        'lastModifiedByName'
    ];

    function propertyIsUsable(prop) {
        // Scan up to the first 25 records: a property is "usable" when any one
        // of them holds a non-ID, defined value. This tolerates records with
        // sparse metadata (managed packages, older components).
        var limit = Math.min(records.length, 25);
        for (var r = 0; r < limit; r++) {
            var rec = records[r];
            if (rec && rec.hasOwnProperty(prop) && rec[prop] !== undefined && rec[prop] !== null && rec[prop] !== '') {
                if (isSalesforceId(rec[prop])) continue;
                return true;
            }
        }
        return false;
    }

    // First add properties in preferred order if any record exposes them
    for (var i = 0; i < propertyOrder.length; i++) {
        var prop = propertyOrder[i];
        if (propertyIsUsable(prop)) {
            console.log('    → Adding preferred column:', prop);
            columns.push({
                propertyName: prop,
                headerLabel: camelCaseToCapitalCase(prop),
                isDate: prop.toLowerCase().includes('date')
            });
        } else {
            console.log('    → Skipping preferred column (not present on any scanned record):', prop);
        }
    }

    // Then union any remaining properties across all scanned records.
    var seen = {};
    columns.forEach(function (c) { seen[c.propertyName] = true; });
    var scanLimit = Math.min(records.length, 25);
    for (var r = 0; r < scanLimit; r++) {
        var rec = records[r];
        if (!rec) continue;
        for (var prop in rec) {
            if (!rec.hasOwnProperty(prop)) continue;
            if (seen[prop]) continue;
            if (skipProperties.indexOf(prop) !== -1) continue;
            if (propertyOrder.indexOf(prop) !== -1) continue;
            if (!propertyIsUsable(prop)) continue;

            columns.push({
                propertyName: prop,
                headerLabel: camelCaseToCapitalCase(prop),
                isDate: prop.toLowerCase().includes('date')
            });
            seen[prop] = true;
        }
    }

    console.log('========================================');
    console.log('FINAL COLUMN LIST (' + columns.length + ' columns):');
    for (var i = 0; i < columns.length; i++) {
        console.log('  ' + i + ': ' + columns[i].propertyName + ' -> "' + columns[i].headerLabel + '" (date: ' + columns[i].isDate + ')');
    }
    console.log('========================================');

    return columns;
}


function processListResults(response) {
    console.log('========================================');
    console.log('processListResults: Received response from JSforce');
    console.log('Response type:', typeof response);
    console.log('Has results:', !!response.results);

    var results = [];
    if (response.results && !Array.isArray(response.results)) {
        results.push(response.results);
        console.log('Single result converted to array');
    } else {
        results = response.results;
        console.log('Results is already array');
    }
    // Narrow the result set to what the Salesforce picker actually lists
    // (e.g. CustomObject → __mdt-only for "Custom Metadata Type"). No-op for
    // picker types without a registered filter.
    results = cshApplyPostFilter(results) || results;
    var len = results ? results.length : 0;
    console.log('Processing', len, 'metadata results from JSforce');

    // Log first few results to see data structure. Gated: the object print
    // stringifies the full record, which is costly when fired per batch.
    if (len > 0) {
        if (CSH_DEBUG) console.log('First JSforce result:', results[0]);
        if (len > 1) {
            if (CSH_DEBUG) console.log('Second JSforce result:', results[1]);
        }

        // Determine dynamic columns from the union of all records (only once)
        var isFirstTime = !dynamicColumns;
        if (isFirstTime && results[0]) {
            dynamicColumns = determineMetadataColumns(results);
            console.log('Dynamic columns determined:', dynamicColumns.length, 'columns');

            // Setup table structure with dynamic columns (first time only)
            console.log('Setting up table with dynamic columns...');
            setupTable();
        }
    } else if (!dynamicColumns && numCallsInProgress <= 1) {
        // listMetadata returned zero rows for this type. Two distinct causes,
        // and we can't be 100% sure which without a second probe:
        //   (a) the org genuinely has no components of this type
        //   (b) Salesforce's Metadata API doesn't surface this type even
        //       though the change-set picker lists it (SharingSet is the
        //       canonical case — listMetadata returns [] but the picker may
        //       show items in orgs that use Experience Cloud sharing)
        //
        // Heuristic: the Salesforce page already rendered its rows by the time
        // this callback fires (listTableLength was read at script-load). If the
        // page has rows but our metadata call returned none, we're in case (b);
        // if both are empty, we're in case (a). Don't claim "unsupported" when
        // we can't prove it — the user complained (rightly) that the old
        // message looked wrong on empty-org types that were clearly supported.
        //
        // Either way we need setupTable() to run so DataTables has a <thead>,
        // padded rows, and a matching columnConfig — otherwise createDataTable
        // initialises against a malformed table and DataTables gets stuck in
        // a perpetual "Processing…" state with indeterminate scroll behaviour.
        // The numCallsInProgress<=1 gate keeps this a one-shot on the last
        // callback so folder-scoped multi-batch loads still take the dynamic-
        // column path when any batch returns data.
        var apiGap = listTableLength > 0;
        console.log('processListResults: no metadata returned for "' + selectedEntityType +
                    '" (' + (apiGap ? 'rows present — probable Metadata API gap' :
                                      'empty org — no components of this type') +
                    '). Using setupTable fallback columns so the table still renders.');
        setupTable();
        if (apiGap) {
            // Rows exist on the page but listMetadata came back empty — warn
            // the user that the Last-Modified columns will be blank for this
            // type even though the components themselves are fine to select.
            window.cshToast && window.cshToast.show(
                'Last-Modified metadata is unavailable for "' + selectedEntityType +
                '". The listed components are still valid — you can select and add them normally.',
                { type: 'info', duration: 8000 }
            );
        }
        // Empty-org case deliberately shows no toast: DataTables already
        // renders "No data available in table" which is self-explanatory, and
        // a popup on top of that would be redundant noise.
    }

    // Cache metadata results for reuse during pagination. Dedup via the
    // companion Set for O(1) checks — the prior Array.findIndex scan was
    // O(cacheSize) per record, which on big-org Custom Fields (30k+ records
    // delivered by the fast path in one batch) dominated per-call time at
    // roughly 450M string compares on the main thread before the apply
    // loop even started.
    for (i = 0; i < len; i++) {
        var rid = results[i] && results[i].id;
        if (!rid) continue;
        if (!cachedMetadataIds.has(rid)) {
            cachedMetadataIds.add(rid);
            cachedMetadataResults.push(results[i]);
        }
    }
    console.log('Cached metadata now has', cachedMetadataResults.length, 'total records');

    // Apply metadata to matching rows in the table
    applyMetadataToRows(results);

    // Phase 6: lazy-resolve imported cart items now that rows carry
    // data-fullName. Safe no-op when no imported items await resolution.
    if (window.cshCart && window.cshCart.rescanForFullNames) {
        var csId = $('#id').val();
        if (csId && selectedEntityType) {
            window.cshCart.rescanForFullNames(csId, selectedEntityType)
                .catch(function (e) { console.warn('rescanForFullNames failed:', e && e.message); });
        }
    }

    numCallsInProgress--;
    console.log('numCallsInProgress:', numCallsInProgress);

    // Only create table if it doesn't exist yet (first time)
    // During progressive loading, table is already created
    if (numCallsInProgress <= 0 && !changeSetTable) {
        console.log('All metadata calls complete - creating DataTable');
        createDataTable();
    }
    console.log('========================================');

}

// Apply metadata to rows in the table
// Uses same hardcoded indices as original version for consistency
function applyMetadataToRows(results) {
    if (!results || results.length === 0) {
        console.log('applyMetadataToRows: No results to apply');
        return;
    }

    console.log('========================================');
    console.log('applyMetadataToRows: Processing', results.length, 'metadata records');

    // Diagnostic snapshots of the first metadata record + the DOM side of
    // the join. Useful when triaging a user report, noisy otherwise — each
    // fires on every fast-path batch and on every pagination page re-apply,
    // which on big orgs means 30+ bursts of structured logs per selection.
    if (CSH_DEBUG) {
        if (results.length > 0) {
            console.log('Sample metadata record:', {
                id: results[0].id,
                fullName: results[0].fullName,
                lastModifiedDate: results[0].lastModifiedDate,
                lastModifiedByName: results[0].lastModifiedByName,
                createdDate: results[0].createdDate,
                createdByName: results[0].createdByName
            });
        }

        var sampleRow = $("table.list tr.dataRow").first();
        if (sampleRow.length > 0) {
            var cellCount = sampleRow.find('td').length;
            console.log('Sample row has', cellCount, 'cells');
            var cellContents = [];
            sampleRow.find('td').each(function(index) {
                var text = $(this).text().trim();
                cellContents.push(index + ':' + (text.substring(0, 20) || 'empty'));
            });
            console.log('Sample row cells:', cellContents.join(' | '));
        }

        var headers = [];
        $("table.list thead tr th, table.list thead tr td").each(function(index) {
            var text = $(this).text().trim();
            var linkText = $(this).find('a').text().trim();
            headers.push(index + ':' + (linkText || text || 'empty'));
        });
        console.log('Table headers:', headers.join(' | '));
    }

    // Build a value → row lookup ONCE per call. Salesforce renders every
    // dataRow with a row-selection <input> whose value is the 15-char
    // Salesforce Id we match against. Indexing up front turns the per-record
    // match from an O(rows) DOM scan (jQuery's `input[value=…]` attribute
    // selector has no attribute index and walks every <input>) into an O(1)
    // hash lookup. On big orgs this was the dominant freeze: with 30k
    // CustomField metadata records and an eventually-30k-row DOM after
    // auto-pagination, the old path executed on the order of 900M DOM
    // visits across all applyMetadataToRows invocations in the session.
    var rowByInputValue = new Map();
    var dataRowInputs = document.querySelectorAll('table.list tr.dataRow input');
    for (var rbi = 0; rbi < dataRowInputs.length; rbi++) {
        var inp = dataRowInputs[rbi];
        if (!inp || !inp.value) continue;
        // First <input> per row wins — its value is the 15-char Id Salesforce
        // uses for the selection checkbox. Later inputs in the same row (hidden
        // 18-char variants, etc.) are ignored so a later sibling can't overwrite
        // the mapping with a stale / unrelated row reference.
        if (!rowByInputValue.has(inp.value)) {
            var r = inp.closest('tr');
            if (r) rowByInputValue.set(inp.value, r);
        }
    }

    for (i = 0; i < results.length; i++) {
        // Normalize ID to 15 characters (Salesforce IDs can be 15 or 18 chars)
        // 18-char IDs are just 15-char IDs with a 3-char case-safe suffix
        shortid = results[i].id.substring(0, 15);
        var rowEl = rowByInputValue.get(shortid);

        // If not found with 15-char ID, try the full 18-char ID if available
        if (!rowEl && results[i].id.length === 18) {
            rowEl = rowByInputValue.get(results[i].id);
        }

        if (!rowEl) {
            if (CSH_DEBUG && i === 0) console.log('First metadata record: No matching row found for ID:', shortid, 'or', results[i].id);
            continue;
        }

        var row = $(rowEl);

        // Dynamic columns start AFTER every cell Salesforce originally rendered
        // in this row (Name + optional Type + optional ParentObject + ...).
        // Using cshOriginalRowCellCount keeps alignment correct regardless of
        // how many columns the entity type actually emits.
        var baseColumnCount = (typeof cshOriginalRowCellCount === 'number' && cshOriginalRowCellCount > 0)
            ? cshOriginalRowCellCount
            : (typeColumn.length > 0 ? 2 : 1);

        // First-record diagnostic trace. Gated — only useful when triaging.
        if (CSH_DEBUG && i === 0) {
            console.log('Updating first row:');
            console.log('  - typeColumn exists:', typeColumn.length > 0);
            console.log('  - Base column count (td cells before dynamic):', baseColumnCount);
            console.log('  - Dynamic columns:', dynamicColumns ? dynamicColumns.length : 0);
            console.log('  - Row has', row.children('td').length, 'total td cells');
        }

        // Store fullName as data attribute on Name column for Compare functionality
        // Name is at td index 0 in the row (checkbox is separate)
        if (results[i].fullName) {
            var nameCell = row.children('td:eq(0)');
            nameCell.attr("data-fullName", results[i].fullName);
            nameCell.addClass("fullNameClass");
            if (CSH_DEBUG && i === 0) {
                console.log('  - Stored fullName on Name column (td index 0):', results[i].fullName);
            }
        }

        // Populate dynamic columns with metadata values
        if (dynamicColumns && dynamicColumns.length > 0) {
            for (var colIdx = 0; colIdx < dynamicColumns.length; colIdx++) {
                var column = dynamicColumns[colIdx];
                var cellIndex = baseColumnCount + colIdx;
                var value = results[i][column.propertyName];

                if (CSH_DEBUG && i === 0) {
                    console.log('  - Column', colIdx, '(' + column.propertyName + '): raw value =', value, ', isDate =', column.isDate);
                }

                // Format the value based on column type
                if (value !== undefined && value !== null) {
                    if (column.isDate) {
                        value = convertDate(new Date(value));
                    }
                } else {
                    value = ''; // Empty for undefined/null values
                }

                var cell = row.children('td:eq(' + cellIndex + ')');
                cell.text(value);

                if (CSH_DEBUG && i === 0) {
                    console.log('    → Writing to cell index', cellIndex, ':', value);
                }
            }
        }

        // Populate compare columns (folder field for folder-based entities)
        // The compare columns are at the end: Folder, Compare Date Mod, Compare Mod By, Full Name
        var compareColumnsStartIndex = baseColumnCount + (dynamicColumns ? dynamicColumns.length : 0);

        // Folder column (for folder-based entities like Reports, Dashboards, etc.)
        if (results[i].folder) {
            var folderCell = row.children('td:eq(' + compareColumnsStartIndex + ')');
            folderCell.text(results[i].folder);
            if (CSH_DEBUG && i === 0) {
                console.log('  - Populated folder cell at index', compareColumnsStartIndex, ':', results[i].folder);
            }
        }
    }

    console.log('applyMetadataToRows: Completed updating', results.length, 'rows');
    console.log('========================================');
}

function jq(myid) {
    return "#" + myid.replace(/(:|\.|\[|\]|,)/g, "\\$1");
}

// Phase 6 — render ghost rows in the main DataTable for components that
// exist in the compare org but NOT in the current change set. Uses
// DataTables' row.add API so they participate in sort / filter / export
// naturally; styled via csh-diff-target-only (red).
//
// All textual cells are coerced to String so DataTables renders them via
// textContent rather than innerHTML. Belt-and-braces against metadata
// records with angle brackets in fullName (rare but a theoretical XSS
// vector if an attacker controls a compare-org target).
function cshAppendTargetOnlyRows(records, env) {
    if (!changeSetTable) return;
    var totalCols = changeSetTable.columns().count();
    // Build every row array first, then batch-add via rows.add(). Calling
    // row.add(...).draw() per record re-renders the whole table N times; for
    // orgs with thousands of target-only ghosts that compounds with
    // processCompareResults' own draw to freeze the tab. The caller redraws
    // once after us.
    var rowArrays = [];
    records.forEach(function (rec) {
        var row = new Array(totalCols).fill('');
        // Column 0 - plain-text badge. Styling comes from the row class
        // csh-diff-target-only (see changeset.css) so no HTML is needed here.
        row[0] = '[target only]';
        row[1] = String(rec.fullName == null ? '' : rec.fullName);
        if (compareColumnIndices.compareDateMod >= 0 && rec.lastModifiedDate) {
            row[compareColumnIndices.compareDateMod] = convertDate(new Date(rec.lastModifiedDate));
        }
        if (compareColumnIndices.compareModBy >= 0) {
            row[compareColumnIndices.compareModBy] = String(rec.lastModifiedByName == null ? '' : rec.lastModifiedByName);
        }
        if (compareColumnIndices.fullName >= 0) {
            row[compareColumnIndices.fullName] = String(rec.fullName == null ? '' : rec.fullName);
        }
        if (compareColumnIndices.folder >= 0 && rec.folder) {
            row[compareColumnIndices.folder] = String(rec.folder);
        }
        rowArrays.push(row);
    });
    var addedRows = changeSetTable.rows.add(rowArrays);
    addedRows.every(function () {
        var node = this.node();
        if (node) {
            node.classList.add('csh-diff-target-only');
            node.setAttribute('data-csh-target-only', '1');
        }
    });
    console.log('cshAppendTargetOnlyRows: added', records.length, 'ghost rows');
}

function processCompareResults(results, env) {
    console.log('processCompareResults: Processing', results.length, 'compare results');
    console.log('processCompareResults: Using column indices:', compareColumnIndices);

    // Show compare columns (use dynamic indices)
    changeSetTable.column(compareColumnIndices.folder).visible(true);  // Folder (temporarily shown for processing)
    changeSetTable.column(compareColumnIndices.compareDateMod).visible(true);  // Compare Date Modified
    changeSetTable.column(compareColumnIndices.compareModBy).visible(true);  // Compare Modified By
    changeSetTable.column(compareColumnIndices.fullName).visible(true);  // Full Name for diff

    // Update header labels based on environment
    if (env == 'prod') {
        $('.compareOrgName').text('(Prod/Dev)');
    } else {
        $('.compareOrgName').text('(Sandbox)');
    }

    // Update Full Name column header
    $(changeSetTable.column(compareColumnIndices.fullName).header()).text('Full name (Click for diff)');

    // Phase 6: track target-only records. These exist in the compare org
    // but not in the current change set / local listing. We surface them as
    // "ghost" rows in red so the user can see what they might be missing.
    var targetOnlyRecords = [];

    // Pre-index fullName → rowIdx so the join is O(n+m) instead of O(n·m).
    // The previous code ran two jQuery attribute-selector scans per result
    // (`td[data-fullName = "..."]`), which for a 5000-row local table and a
    // 5000-record compare payload (CustomLabel in an org with many managed
    // packages is common) is 50M DOM lookups — enough to wedge the page for
    // 30+ seconds. rows().every() is a single pass over the DataTables API.
    var fullNameToRowIdx = {};
    changeSetTable.rows().every(function () {
        var node = this.node();
        if (!node) return;
        var cell = node.querySelector('td[data-fullName]');
        if (!cell) return;
        var key = cell.getAttribute('data-fullName');
        if (key && !(key in fullNameToRowIdx)) fullNameToRowIdx[key] = this.index();
    });

    // Track rows we actually mutated so a single invalidate+draw at the end
    // can re-sync DataTables' internal cache with what we wrote to the DOM.
    // Writing via cell().data() per-cell triggers an internal invalidation
    // each call — at 5000 matches × 3 cells that's 15k invalidations, which
    // by itself adds several seconds even after Fix 3's join speedup. Direct
    // DOM writes + one rows().invalidate('dom') is orders of magnitude faster.
    var mutatedRowIdxs = [];

    for (i = 0; i < results.length; i++) {
        var fullName = results[i].fullName;
        var rowIdx = fullNameToRowIdx[fullName];

        if (rowIdx === undefined) {
            targetOnlyRecords.push(results[i]);
            continue;
        }

        dateMod = new Date(results[i].lastModifiedDate);
        mutatedRowIdxs.push(rowIdx);

            // Update compare columns with data from other org. Write to the
            // cell nodes directly to avoid the per-call redraw that cell().data()
            // triggers — we invalidate & redraw once after the loop.
            var dateCellNode = changeSetTable.cell(rowIdx, compareColumnIndices.compareDateMod).node();
            var modByCellNode = changeSetTable.cell(rowIdx, compareColumnIndices.compareModBy).node();
            var fullNameCellNode = changeSetTable.cell(rowIdx, compareColumnIndices.fullName).node();
            if (dateCellNode) dateCellNode.textContent = convertDate(dateMod);
            if (modByCellNode) modByCellNode.textContent = results[i].lastModifiedByName || '';
            if (fullNameCellNode) fullNameCellNode.innerHTML = '<a href="#">' + fullName + '</a>';

            // Make Full Name cell clickable for diff. Also stamp the cell
            // with data-fullName so the click handler can resolve the item
            // name directly off the clicked node (the historical bug was
            // reading data-fullName from a cell that never had it set).
            var fullNameCell = fullNameCellNode;
            $(fullNameCell).attr('data-fullName', fullName);
            $(fullNameCell).off("click");
            $(fullNameCell).click(getContents);

            // Inject a compact compare icon into the Name cell (which sits
            // immediately after the checkbox visually) so users can kick off
            // a diff without hunting for the appended column at the far right.
            // Only added once compare is live — before connect the icon would
            // just error out. The icon stops propagation so it doesn't toggle
            // the row selection under it.
            //
            // The click handler resolves fullName off the icon's own
            // data-fullName attribute at click time, NOT from a closure over
            // the for-loop variable. `var fullName` is function-scoped, so a
            // closure captures the last iteration's value and every icon
            // would trigger compare for the last row processed.
            var nameCellNode = changeSetTable.row(rowIdx).node();
            if (nameCellNode) {
                var $nameCell = $(nameCellNode).find('td[data-fullName]').first();
                if ($nameCell.length && !$nameCell.find('.csh-compare-icon').length) {
                    var $icon = $('<span class="csh-compare-icon" title="Compare with target org">⇄</span>');
                    $icon.attr('data-fullName', fullName);
                    $icon.on('click', function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        var resolved = $(this).attr('data-fullName');
                        cshTriggerCompare(resolved);
                    });
                    $nameCell.prepend($icon);
                }
            }

            // Phase 5: colour-code the whole row based on recency comparison.
            //   csh-diff-newer-local  → local is newer (safe to deploy from here)
            //   csh-diff-newer-target → target is newer (deploying would REGRESS)
            //   csh-diff-same         → timestamps match (no-op deploy)
            if (compareColumnIndices.lastModifiedDate >= 0) {
                var thisOrgDateMod = changeSetTable.cell(rowIdx, compareColumnIndices.lastModifiedDate).data();
                var localMoment = convertToMoment(thisOrgDateMod);
                var targetMoment = moment(dateMod);
                var rowNode = changeSetTable.row(rowIdx).node();
                if (rowNode) {
                    rowNode.classList.remove('csh-diff-newer-local', 'csh-diff-newer-target', 'csh-diff-same');
                    if (localMoment.isValid() && targetMoment.isValid()) {
                        var delta = targetMoment.diff(localMoment);
                        if (delta < 0) rowNode.classList.add('csh-diff-newer-local');
                        else if (delta > 0) rowNode.classList.add('csh-diff-newer-target');
                        else rowNode.classList.add('csh-diff-same');
                    }
                }
                // Also keep the legacy inline-colour hint on the date cell for
                // anyone with custom selectors; the row class is the source of
                // truth for new users.
                if (targetMoment.diff(localMoment) < 0) {
                    changeSetTable.cell(rowIdx, compareColumnIndices.lastModifiedDate).node().style.color = "green";
                }
            }
    }

    // One-shot re-sync: pull the DOM changes we just made back into the
    // DataTables internal cache so sort/filter/search see the new compare
    // values, then redraw once. draw(false) preserves the current page so
    // the user isn't bounced to page 1 after a refresh.
    if (mutatedRowIdxs.length > 0) {
        changeSetTable.rows(mutatedRowIdxs).invalidate('dom');
    }

    // Phase 6: append ghost rows for target-only records.
    // These aren't in the local change set. They sort, filter, and export
    // like regular rows, but get the fourth colour-diff state: red + [target only].
    if (targetOnlyRecords.length > 0) {
        cshAppendTargetOnlyRows(targetOnlyRecords, env);
    }

    // Hide folder column after processing
    changeSetTable.column(compareColumnIndices.folder).visible(false);
    // Final draw picks up the invalidated rows, column visibility changes,
    // and any target-only rows appended above — in one pass.
    changeSetTable.draw(false);

    // Populate Compare Modified By dropdown filter
    var column = changeSetTable.column(compareColumnIndices.compareModBy);
    var select = $(column.footer()).find('select');

    select.find('option')
        .remove()
        .end()
        .append('<option value=""></option>');

    column.data().unique().sort().each(function (d) {
        select.append('<option value="' + d + '">' + d + '</option>')
    });

    $("#editPage").removeClass("lowOpacity");

    console.log('processCompareResults: Completed');
}

function createDataTable() {
    // Prevent double initialization
    var tableSelector = 'div.bPageBlock > div.pbBody > table.list';
    if ($.fn.DataTable.isDataTable(tableSelector)) {
        console.log('createDataTable: Table already initialized, getting existing instance');
        changeSetTable = $(tableSelector).DataTable(); // Get existing instance

        // Filters should already exist from first init via initComplete callback
        // If they're missing, log a warning (shouldn't happen)
        if ($('.dtsearch').length === 0) {
            console.log('createDataTable: WARNING - Filters are missing (this should not happen)');
        }

        // Ensure the unified toolbar group exists (Reset + Export CSV +
        // Export/Import package.xml all live inside cshInstallToolbarActions).
        if ($('.csh-toolbar-actions').length === 0) {
            cshInstallToolbarActions();
        }

        return;
    }

    console.log('createDataTable: Initializing DataTable for the first time');

    // Enable pagination for large datasets to improve performance
    // Enable if: 1) We already have enough rows, OR 2) We're still loading more pages (will exceed threshold)
    var enablePaging = totalComponentCount >= ENABLE_PAGINATION_THRESHOLD || isLoadingMorePages;
    var domLayout = enablePaging ? 'lprtip' : 'lrti'; // 'p' at top and bottom for pagination controls

    if (enablePaging) {
        if (isLoadingMorePages) {
            console.log(`Loading more pages - enabling pagination (currently ${totalComponentCount} rows, more coming)`);
        } else {
            console.log(`Large dataset detected (${totalComponentCount} rows) - enabling pagination for better performance`);
        }
    }

    // Build dynamic column configuration from the header baseline captured by
    // setupTable(). The first header cell is always the checkbox (searchable:
    // false, orderable: false). Every subsequent original header cell — Name,
    // Type, Parent Object, etc. — becomes a plain text column.
    var baseColumnCount = (typeof cshOriginalHeaderCount === 'number' && cshOriginalHeaderCount > 0)
        ? cshOriginalHeaderCount
        : (typeColumn.length > 0 ? 3 : 2);

    var columnConfig = [];
    // Column 0: the Salesforce checkbox header (no row-level <td>, DataTables still accounts for it)
    columnConfig.push({ searchable: false, orderable: false });
    // Columns 1..baseColumnCount-1: Name + whatever other base columns Salesforce rendered
    for (var base = 1; base < baseColumnCount; base++) {
        columnConfig.push(null);
    }

    // Find the column to order by (default to first date column)
    var orderByColumnIndex = baseColumnCount; // Default to first dynamic column

    // Add dynamic columns
    if (dynamicColumns && dynamicColumns.length > 0) {
        console.log('createDataTable: Building column config for', dynamicColumns.length, 'dynamic columns');
        for (var i = 0; i < dynamicColumns.length; i++) {
            var colConfig = {};

            // Mark date columns for proper sorting
            if (dynamicColumns[i].isDate) {
                colConfig.type = "date";
                // Use lastModifiedDate for default ordering
                if (dynamicColumns[i].propertyName === 'lastModifiedDate' && orderByColumnIndex === baseColumnCount) {
                    orderByColumnIndex = baseColumnCount + i; // Base columns + dynamic column index
                    // Store the index for compare functionality
                    compareColumnIndices.lastModifiedDate = baseColumnCount + i;
                }
            }

            columnConfig.push(colConfig);
            console.log('  - Column', (baseColumnCount + i), ':', dynamicColumns[i].propertyName, colConfig);
        }
    } else {
        console.log('createDataTable: WARNING - No dynamic columns, using default column config');
        // Fallback for basic columns
        columnConfig.push(null); // Full Name
        columnConfig.push({"type": "date"}); // Last Modified Date
        compareColumnIndices.lastModifiedDate = baseColumnCount + 1;
        columnConfig.push(null); // Last Modified By Name
    }

    // Add compare columns (hidden initially)
    var compareStartIndex = columnConfig.length;
    compareColumnIndices.folder = compareStartIndex;
    compareColumnIndices.compareDateMod = compareStartIndex + 1;
    compareColumnIndices.compareModBy = compareStartIndex + 2;
    compareColumnIndices.fullName = compareStartIndex + 3;

    columnConfig.push({"visible": false}); // Folder (hidden, used internally)
    columnConfig.push({"visible": false, "type": "date"}); // Compare Date Modified (hidden initially)
    columnConfig.push({"visible": false}); // Compare Modified By (hidden initially)
    columnConfig.push({"visible": false}); // Full Name for diff (hidden initially)

    console.log('createDataTable: Added compare columns at indices:', compareColumnIndices);
    console.log('createDataTable: Total columns:', columnConfig.length, ', Order by column:', orderByColumnIndex);

    //Create the datatable
    try {
        changeSetTable = $(tableSelector).DataTable({
            processing: true,
            paging: enablePaging,
            pageLength: 100,  // Show 100 rows per page when pagination is enabled
            dom: domLayout,
            "order": [[orderByColumnIndex, "desc"]], // Order by lastModifiedDate if available
            "deferRender": true,  // Performance optimization for large datasets
            "columns": columnConfig,
            initComplete: tableInitComplete
        });

        cshInstallToolbarActions();
        $("#editPage").submit(function (event) {
            clearFilters();
            return true;
        });
    } catch (e) {
        console.log(e);
    }

    $("#editPage").removeClass("lowOpacity");
}

function clearFilters() {
    //console.log(changeSetTable);
    changeSetTable
        .columns().search('')
        .draw();
    $(".dtsearch").val('');
}

// Installs the unified toolbar actions group on the Add Components page.
// Holds every button we add — Reset Search Filters, Export CSV, and
// package.xml I/O — so all extension affordances sit together in one row
// instead of being scattered around Salesforce's rolodex. Safe to call
// multiple times — idempotent.
function cshInstallToolbarActions() {
    if ($('.csh-toolbar-actions').length) return;
    var $group = $(
        '<span class="csh-toolbar-actions" style="float:left;display:inline-flex;gap:4px;margin-right:8px;">' +
          '<input type="button" value="Reset Search Filters"   class="clearFilters btn"     title="Reset search filters" />' +
          '<input type="button" value="Export CSV"             class="cshExportCsv btn"     title="Download the currently-filtered table as a CSV file" />' +
          '<input type="button" value="Export package.xml"     class="cshExportPkg btn"     title="Serialize the cart (staged + submitted items) into a Salesforce package.xml file" />' +
          '<input type="button" value="Import package.xml"     class="cshImportPkg btn"     title="Load a package.xml into the cart; items are staged and resolved against the current change-set add page" />' +
          '<input type="file"   class="cshImportPkgFile" accept=".xml,application/xml" style="display:none" />' +
        '</span>'
    );
    $group.prependTo('div.rolodex');

    $group.find('.clearFilters').on('click', clearFilters);
    $group.find('.cshExportCsv').on('click', cshExportTable);
    $group.find('.cshExportPkg').on('click', function () {
        if (!window.cshCart || !window.cshCart.exportCartAsPackageXml) {
            window.cshToast && window.cshToast.show('Cart is not ready yet — try again in a moment.', { type: 'info' });
            return;
        }
        window.cshCart.exportCartAsPackageXml()
            .catch(function (e) { window.cshToast && window.cshToast.show('Export failed: ' + e.message, { type: 'error' }); });
    });
    $group.find('.cshImportPkg').on('click', function () {
        $group.find('.cshImportPkgFile').trigger('click');
    });
    $group.find('.cshImportPkgFile').on('change', async function (ev) {
        var file = ev.target.files && ev.target.files[0];
        if (!file) return;
        try {
            var text = await file.text();
            if (!window.cshCart || !window.cshCart.importPackageXml) {
                throw new Error('Cart module not loaded');
            }
            var added = await window.cshCart.importPackageXml(text);
            window.cshToast && window.cshToast.show(
                'Imported ' + added + ' item(s) from ' + file.name + '. ' +
                'Items without a Salesforce Id will resolve when you visit each type.',
                { type: 'success', duration: 6000 }
            );
        } catch (e) {
            window.cshToast && window.cshToast.show('Import failed: ' + e.message, { type: 'error' });
        }
        ev.target.value = '';
    });
}

// ---------------------------------------------------------------------------
// Phase 5.1 — CSV export
//
// Dumps the currently-filtered DataTable rows as a comma-separated file.
// Respects visible columns and active search. Values containing a comma,
// quote, or newline are wrapped in double quotes per RFC 4180.
// ---------------------------------------------------------------------------
function cshCsvEscape(val) {
    if (val == null) return '';
    var s = String(val);
    if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function cshExportTable() {
    if (!changeSetTable) {
        window.cshToast && window.cshToast.show('Table not ready for export yet.', { type: 'info' });
        return;
    }
    var visibleIdxs = changeSetTable.columns(':visible').indexes().toArray();
    var headers = visibleIdxs.map(function (idx) {
        return $.trim($(changeSetTable.column(idx).header()).text());
    });
    var lines = [];
    lines.push(headers.map(cshCsvEscape).join(','));

    var rowApi = changeSetTable.rows({ search: 'applied' });
    var data = rowApi.data().toArray();
    var nodes = rowApi.nodes();
    for (var i = 0; i < data.length; i++) {
        var rowData = data[i];
        var rowNode = nodes[i];
        var line = visibleIdxs.map(function (colIdx) {
            // Prefer the rendered DOM text over raw cell data so we export
            // exactly what the user sees (includes name links, date strings).
            var cell = rowNode ? $(rowNode).children('td').eq(colIdx).text() : rowData[colIdx];
            return cshCsvEscape(String(cell == null ? '' : cell).replace(/\s+/g, ' ').trim());
        });
        lines.push(line.join(','));
    }

    var entityType = $('#entityType').val() || 'change-set';
    var stamp = new Date().toISOString().slice(0, 10);
    var fname = 'csh-' + entityType + '-' + stamp + '.csv';
    // UTF-8 BOM (U+FEFF) so Excel on Windows treats the file as UTF-8 and
    // renders non-ASCII characters (e.g. curly apostrophes in component
    // names) correctly instead of garbling them in the Windows-1252 guess.
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
        a.remove();
        URL.revokeObjectURL(url);
    }, 500);
    window.cshToast && window.cshToast.show(
        'Exported ' + (lines.length - 1) + ' row(s) to ' + fname,
        { type: 'success', duration: 3000 }
    );
}

/**
 When the list table is added, these functionas are added to the make the columns searchable and selectable.
 **/
function basicTableInitComplete() {
    this.api().columns().every(function () {
        var column = this;
        if ((column.index() == 1)) {
            var searchbox = $('<input class="dtsearch" type="text" placeholder="Search" />')
                .appendTo($(column.footer()))
                .on('keyup change', function () {
                    column
                        .search($(this).val())
                        .draw();
                });
        }

        if ((column.index() == 2)) {
            var select = $('<select class="dtsearch"><option value=""></option></select>')
                .appendTo($(column.footer()))
                .on('change', function () {
                    var val = $.fn.dataTable.util.escapeRegex(
                        $(this).val()
                    );

                    column
                        .search(val ? '^' + val + '$' : '', true, false)
                        .draw();
                })

            column.data().unique().sort().each(function (d, j) {
                select.append('<option value="' + d + '">' + d + '</option>')
            });
        }
        ;
    });
}

/**
 When the list table is added, these functionas are added to the make the columns searchable and selectable.
 **/
function tableInitComplete() {
    // Dynamic columns start after the checkbox + every original header cell.
    // cshOriginalHeaderCount already counts the checkbox, so it IS the start.
    var dynamicColumnsStartIndex = (typeof cshOriginalHeaderCount === 'number' && cshOriginalHeaderCount > 0)
        ? cshOriginalHeaderCount
        : (typeColumn.length > 0 ? 3 : 2);

    this.api().columns().every(function () {
        var column = this;
        var colIndex = column.index();

        // Determine if this column should have a filter
        var shouldAddFilter = false;
        var useTextSearch = false;
        var useDropdown = false;

        // Column 0: Checkbox - skip
        if (colIndex === 0) {
            return;
        }
        // Column 1: Name - text search
        else if (colIndex === 1) {
            shouldAddFilter = true;
            useTextSearch = true;
        }
        // Columns 2..dynamicColumnsStartIndex-1: Type / Parent Object / etc. -> dropdown
        else if (colIndex > 1 && colIndex < dynamicColumnsStartIndex) {
            shouldAddFilter = true;
            useDropdown = true;
        }
        // Dynamic columns (starting at dynamicColumnsStartIndex)
        else if (colIndex >= dynamicColumnsStartIndex && dynamicColumns) {
            var dynamicColIndex = colIndex - dynamicColumnsStartIndex; // Subtract base columns
            if (dynamicColIndex < dynamicColumns.length) {
                shouldAddFilter = true;
                var colDef = dynamicColumns[dynamicColIndex];

                // Explicit filterType hint wins (e.g. Developer Name column
                // forces text search because a dropdown with thousands of
                // unique API names is unusable). Otherwise fall back to the
                // old rule: date columns → text, everything else → dropdown.
                if (colDef.filterType === 'text') {
                    useTextSearch = true;
                } else if (colDef.filterType === 'dropdown') {
                    useDropdown = true;
                } else if (colDef.isDate) {
                    useTextSearch = true;
                } else {
                    useDropdown = true;
                }
            }
        }
        // Compare columns (added after dynamic columns, hidden initially)
        else if (colIndex === compareColumnIndices.folder) {
            // Folder column - no filter needed
            return;
        }
        else if (colIndex === compareColumnIndices.compareDateMod) {
            // Compare Date Modified - text search
            shouldAddFilter = true;
            useTextSearch = true;
        }
        else if (colIndex === compareColumnIndices.compareModBy) {
            // Compare Modified By - dropdown
            shouldAddFilter = true;
            useDropdown = true;
        }
        else if (colIndex === compareColumnIndices.fullName) {
            // Full Name - text search
            shouldAddFilter = true;
            useTextSearch = true;
        }

        // Add dropdown filter
        if (shouldAddFilter && useDropdown) {
            var select = $('<select class="dtsearch" ><option value=""></option></select>')
                .appendTo($(column.footer()))
                .on('change', function () {
                    var val = $.fn.dataTable.util.escapeRegex(
                        $(this).val()
                    );

                    column
                        .search(val ? '^' + val + '$' : '', true, false)
                        .draw();
                });

            column.data().unique().sort().each(function (d, j) {
                select.append('<option value="' + d + '">' + d + '</option>')
            });
        }

        // Add text search box
        if (shouldAddFilter && useTextSearch) {
            var searchbox = $('<input class="dtsearch" type="text" placeholder="Search" />')
                .appendTo($(column.footer()))
                .on('keyup change', function () {
                    column
                        .search($(this).val())
                        .draw();
                });
        }
    });
}


// Phase 2.3 — Tooling API SOQL fast path.
//
// For code-heavy metadata types the Tooling API's per-type sObject tables
// return the same attribution (Id, LastModifiedDate, LastModifiedBy.Name,
// CreatedDate, CreatedBy.Name, NamespacePrefix) as metadata.list() but in a
// single SOQL round-trip instead of the multi-stage SOAP list protocol.
// On orgs with thousands of Apex classes this cuts first-paint time ~3-5x.
//
// nameField is used when the Tooling sObject exposes DeveloperName instead
// of Name (Aura / Lightning bundles). metadataType is echoed on the
// normalized record so downstream consumers see the same shape as before.
// Tooling SOQL is the only path that scales cleanly past listMetadata's 2000
// hard cap — jsforce's tooling.query()+queryMore walks nextRecordsUrl until
// the whole result set is in hand. For every type below, one SOQL gets the
// entire org regardless of count. Types with composite Metadata-API fullNames
// (CustomField → Parent.Child, RecordType → SObject.DeveloperName, etc.) use
// `fullNameBuilder` so listMetadata-compatible member names come out the
// other side and downstream retrieve() / processCompareResults see the same
// shape they used to. Any type missing / restricted on a given org simply
// errors and callers fall back to listMetadata.
var TOOLING_QUERYABLE_TYPES = {
    // ---- Single-field name (namespace prefix applied by normalizer) ------
    'ApexClass':      { metadataType: 'ApexClass',      nameField: 'Name' },
    'ApexTrigger':    { metadataType: 'ApexTrigger',    nameField: 'Name' },
    'ApexPage':       { metadataType: 'ApexPage',       nameField: 'Name' },
    'ApexComponent':  { metadataType: 'ApexComponent',  nameField: 'Name' },
    'ApexTestSuite':  { metadataType: 'ApexTestSuite',  nameField: 'TestSuiteName' },
    'AuraDefinitionBundle':     { metadataType: 'AuraDefinitionBundle',     nameField: 'DeveloperName' },
    'LightningComponentBundle': { metadataType: 'LightningComponentBundle', nameField: 'DeveloperName' },
    'StaticResource':      { metadataType: 'StaticResource',      nameField: 'Name' },
    'CustomApplication':   { metadataType: 'CustomApplication',   nameField: 'DeveloperName' },
    // CustomTab intentionally omitted from the fast path. Tooling API's
    // CustomTab SObject lists only VF / Web / URL / Lightning tabs — it does
    // NOT include custom-object tabs (those are derived from the owning
    // CustomObject). Salesforce's change-set picker shows all tab kinds,
    // so routing through Tooling here left custom-object-tab rows with empty
    // Created/Modified columns. Metadata API's listMetadata({type:'CustomTab'})
    // returns every tab — slower, but complete. See getMetaData for fallback.
    'CustomPermission':    { metadataType: 'CustomPermission',    nameField: 'DeveloperName' },
    'CustomLabel':         { metadataType: 'CustomLabel',         nameField: 'Name' },
    'NamedCredential':     { metadataType: 'NamedCredential',     nameField: 'DeveloperName' },
    'RemoteSiteSetting':   { metadataType: 'RemoteSiteSetting',   nameField: 'DeveloperName' },
    'ExternalDataSource':  { metadataType: 'ExternalDataSource',  nameField: 'DeveloperName' },
    'BrandingSet':         { metadataType: 'BrandingSet',         nameField: 'DeveloperName' },

    // Flow: FlowDefinition gives one row per flow (not one per version), which
    // matches the Metadata API Flow fullName semantics. Version-level diffing
    // would double-count every flow in the table.
    //
    // Both picker values are keyed because Salesforce's change-set picker emits
    // 'FlowDefinition' in #entityType (see entityTypeMap above) while the fast
    // path's outputType is 'Flow'. Dual-keying avoids skipping the fast path
    // for the common picker path — keeping 'Flow' as a defensive alias in case
    // a future Salesforce build emits the API name directly. listMetadata
    // fallback must stay on {type:'FlowDefinition'} too: {type:'Flow'} has a
    // known Salesforce bug where it misreports the active-version entry.
    'Flow': {
        metadataType: 'FlowDefinition',
        outputType: 'Flow',
        nameField: 'DeveloperName'
    },
    'FlowDefinition': {
        metadataType: 'FlowDefinition',
        outputType: 'Flow',
        nameField: 'DeveloperName'
    },

    // ---- Composite fullNames (Parent.Child via fullNameBuilder) ----------
    // Managed-package rules for every composite builder below:
    //   - child name gets `ns__` prefix when NamespacePrefix is non-empty
    //   - CustomField additionally gets `__c` suffix (DeveloperName is bare)
    //   - everything else (ValidationRule/RecordType/FieldSet/CompactLayout)
    //     uses DeveloperName / ValidationName as-is (no __c suffix in API)
    // See cshBuildCompositeChild helper below — keeps the prefix/suffix logic
    // in one place so every builder stays consistent.
    // Composite types below deliberately OMIT `orderBy` so cshBuildToolingSoql
    // falls back to a local-field sort (nameField). ORDER BY on a relationship
    // field (`EntityDefinition.QualifiedApiName`) GACKs server-side on some
    // orgs — Salesforce's Tooling query planner chokes materializing the sort
    // across many EntityDefinitions. DataTables re-sorts client-side anyway,
    // so the server-side order only affects tie-breaking during queryMore
    // pagination, which is harmless.
    'CustomField': {
        metadataType: 'CustomField',
        nameField: 'DeveloperName',
        extraSelect: 'EntityDefinition.QualifiedApiName',
        fullNameBuilder: function (rec) {
            var parent = rec.EntityDefinition && rec.EntityDefinition.QualifiedApiName;
            if (!parent || !rec.DeveloperName) return null;
            // Tooling CustomField.DeveloperName is the bare API name (e.g.
            // "MyField"); Metadata API fullName needs the __c suffix plus
            // any managed-package prefix: Account.pkg__MyField__c
            return parent + '.' + cshBuildCompositeChild(rec.NamespacePrefix, rec.DeveloperName, '__c');
        }
    },
    'ValidationRule': {
        metadataType: 'ValidationRule',
        nameField: 'ValidationName',
        extraSelect: 'EntityDefinition.QualifiedApiName',
        fullNameBuilder: function (rec) {
            var parent = rec.EntityDefinition && rec.EntityDefinition.QualifiedApiName;
            if (!parent || !rec.ValidationName) return null;
            return parent + '.' + cshBuildCompositeChild(rec.NamespacePrefix, rec.ValidationName, '');
        }
    },
    'RecordType': {
        metadataType: 'RecordType',
        nameField: 'DeveloperName',
        extraSelect: 'SobjectType',
        orderBy: 'SobjectType, DeveloperName',
        fullNameBuilder: function (rec) {
            if (!rec.SobjectType || !rec.DeveloperName) return null;
            return rec.SobjectType + '.' + cshBuildCompositeChild(rec.NamespacePrefix, rec.DeveloperName, '');
        }
    },
    'FieldSet': {
        metadataType: 'FieldSet',
        nameField: 'DeveloperName',
        extraSelect: 'EntityDefinition.QualifiedApiName',
        fullNameBuilder: function (rec) {
            var parent = rec.EntityDefinition && rec.EntityDefinition.QualifiedApiName;
            if (!parent || !rec.DeveloperName) return null;
            return parent + '.' + cshBuildCompositeChild(rec.NamespacePrefix, rec.DeveloperName, '');
        }
    },
    'CompactLayout': {
        metadataType: 'CompactLayout',
        nameField: 'DeveloperName',
        extraSelect: 'EntityDefinition.QualifiedApiName',
        fullNameBuilder: function (rec) {
            var parent = rec.EntityDefinition && rec.EntityDefinition.QualifiedApiName;
            if (!parent || !rec.DeveloperName) return null;
            return parent + '.' + cshBuildCompositeChild(rec.NamespacePrefix, rec.DeveloperName, '');
        }
    },

    // ---- Tier 2: Tooling types needing EntityDefinition Id→ApiName -------
    // TableEnumOrId holds the entity API name for standard objects but the
    // 15/18-char Id for custom objects; the entity map resolves the latter.
    'Layout': {
        metadataType: 'Layout',
        nameField: 'Name',
        extraSelect: 'TableEnumOrId',
        orderBy: 'TableEnumOrId, Name',
        needsEntityMap: true,
        fullNameBuilder: function (rec, ctx) {
            if (!rec.TableEnumOrId || !rec.Name) return null;
            var parent = (ctx && ctx.entityMap && ctx.entityMap[rec.TableEnumOrId]) || rec.TableEnumOrId;
            // Layout fullName uses DASH, not dot: "Account-Account Layout".
            return parent + '-' + rec.Name;
        }
    },
    'WorkflowRule': {
        metadataType: 'WorkflowRule',
        nameField: 'Name',
        extraSelect: 'TableEnumOrId',
        orderBy: 'TableEnumOrId, Name',
        needsEntityMap: true,
        fullNameBuilder: function (rec, ctx) {
            if (!rec.TableEnumOrId || !rec.Name) return null;
            var parent = (ctx && ctx.entityMap && ctx.entityMap[rec.TableEnumOrId]) || rec.TableEnumOrId;
            return parent + '.' + rec.Name;
        }
    },
    // QuickActionDefinition.SobjectType is already the API name (or null for
    // global actions); no entity-map lookup needed.
    'QuickAction': {
        metadataType: 'QuickActionDefinition',
        outputType: 'QuickAction',
        nameField: 'DeveloperName',
        extraSelect: 'SobjectType',
        orderBy: 'SobjectType NULLS FIRST, DeveloperName',
        fullNameBuilder: function (rec) {
            if (!rec.DeveloperName) return null;
            return rec.SobjectType ? (rec.SobjectType + '.' + rec.DeveloperName) : rec.DeveloperName;
        }
    },
    // ListView intentionally omitted from the fast path. Tooling's ListView
    // SObject returns ~40% more rows than Metadata API listMetadata({type:
    // 'ListView'}) — the extras are list views on system / platform objects
    // (ForecastingItemPivot, FlowRecord, FlowInterview, AppMenuItem, Dashboard,
    // CollaborationGroup, …) plus rows with SobjectType=null (Sharing-report
    // style views). Change sets can't deploy any of these, and listMetadata
    // mirrors the change-set picker exactly, so letting listMetadata handle
    // ListView keeps the diff table honest. Measured on a real org: Tooling
    // 528 unmanaged rows vs listMetadata 278 (40% noise). listMetadata's
    // 2000-per-call cap is not a practical concern for ListView — orgs with
    // >2000 unmanaged list views are vanishingly rare. See getMetaData /
    // cshCompareListFlat fallback.

    // ---- Tier 1: Data API SObjects (not Tooling) -------------------------
    // Same one-SOQL + queryMore pagination, hits conn.query() instead of
    // conn.tooling.query(). Opted out of NamespacePrefix where the SObject
    // doesn't expose it (Profile, Group, UserRole).
    'Profile': {
        metadataType: 'Profile',
        api: 'data',
        nameField: 'Name',
        hasNamespace: false
    },
    'PermissionSet': {
        metadataType: 'PermissionSet',
        api: 'data',
        nameField: 'Name',
        // Since Spring '23 every Profile auto-generates a hidden PermissionSet
        // with IsOwnedByProfile=true as part of the "Enhanced Profile" rollout.
        // Salesforce's change-set picker hides these, so without the filter
        // every profile-backed row shows up as "[target only]" in the compare
        // view, making the diff look wildly out-of-sync when it isn't.
        whereClause: 'IsOwnedByProfile = false'
    },
    'PermissionSetGroup': {
        metadataType: 'PermissionSetGroup',
        api: 'data',
        nameField: 'DeveloperName'
    },
    'Group': {
        metadataType: 'Group',
        api: 'data',
        nameField: 'DeveloperName',
        hasNamespace: false,
        // The Group SObject is polymorphic (public groups, queues, role
        // groups, …). The Metadata API Group type is public groups only.
        whereClause: "Type = 'Regular'"
    },
    'Queue': {
        metadataType: 'Group',
        outputType: 'Queue',
        api: 'data',
        nameField: 'DeveloperName',
        hasNamespace: false,
        whereClause: "Type = 'Queue'"
    },
    'Role': {
        metadataType: 'UserRole',
        outputType: 'Role',
        api: 'data',
        nameField: 'DeveloperName',
        hasNamespace: false
    }
};

// Composes the child portion of a Parent.Child metadata fullName from the
// Tooling SObject row's bare developer name plus a managed-package prefix
// and an optional API suffix (e.g. "__c" for custom fields). Exists so the
// ns-prefix + suffix rule lives in one place instead of being copy-pasted
// across every composite fullNameBuilder.
function cshBuildCompositeChild(namespacePrefix, bareName, suffix) {
    var child = bareName;
    if (namespacePrefix) child = namespacePrefix + '__' + child;
    if (suffix) child = child + suffix;
    return child;
}

function cshBuildToolingSoql(cfg) {
    var fields = ['Id', cfg.nameField];
    // Some Data-API SObjects (Profile, UserRole, Group) have no NamespacePrefix.
    // Selecting it errors, so each config opts out explicitly.
    if (cfg.hasNamespace !== false) fields.push('NamespacePrefix');
    fields.push('LastModifiedDate', 'LastModifiedBy.Name', 'CreatedDate', 'CreatedBy.Name');
    if (cfg.extraSelect) fields.push(cfg.extraSelect);
    var soql = 'SELECT ' + fields.join(', ') + ' FROM ' + cfg.metadataType;

    // Managed-package components can't be deployed via a change set anyway
    // (Salesforce blocks redeploy for non-package-owner orgs), so they're
    // always excluded — server-side at SOQL level where possible, client-side
    // via cshFilterOutManaged for listMetadata fallbacks.
    var clauses = [];
    if (cfg.whereClause) clauses.push(cfg.whereClause);
    if (cfg.hasNamespace !== false) {
        clauses.push('NamespacePrefix = null');
    }
    if (clauses.length) soql += ' WHERE ' + clauses.join(' AND ');

    soql += ' ORDER BY ' + (cfg.orderBy || cfg.nameField);
    return soql;
}

// Drop managed-package records from a result set. Used after listMetadata
// calls (folder-scoped types, non-Tooling-queryable fallbacks) because
// listMetadata offers no server-side way to filter by namespace — we have
// to fetch everything and prune in JS. The Tooling fast path applies its
// own SOQL-level `NamespacePrefix = null` clause and doesn't come through
// here.
//
// Signals checked:
//   - namespacePrefix truthy → came from a namespaced package
//   - manageableState === 'installed' → subscriber org can't redeploy it
// Either match is enough. The two overlap heavily but neither strictly
// subsumes the other across every metadata type, so checking both covers
// edge cases like base-package-org records that have a namespace but are
// "unmanaged" because the package is defined in this org.
function cshFilterOutManaged(records) {
    if (!Array.isArray(records)) return records;
    return records.filter(function (r) {
        if (!r) return false;
        if (r.namespacePrefix) return false;
        if (r.manageableState && r.manageableState !== 'unmanaged') return false;
        return true;
    });
}

// Stashed so the compare refresh button can re-run the last compare listing
// against the same environment without prompting the user to reconnect.
var cshLastCompareEnv = null;

function cshNormalizeToolingRecord(rec, cfg, ctx) {
    var ns = rec.NamespacePrefix || '';
    var fullName;
    if (typeof cfg.fullNameBuilder === 'function') {
        // Parent.Child composite — builder owns the full shape, including any
        // namespace concerns specific to that type. Builders receive ctx so
        // they can consult e.g. the EntityDefinition Id→QualifiedApiName map.
        // Builders that can't compose a name (missing relationship field)
        // return null so the row is filtered upstream instead of
        // masquerading as "undefined".
        fullName = cfg.fullNameBuilder(rec, ctx);
    } else {
        var name = rec[cfg.nameField] || '';
        // Managed-package fullName convention is ns__Name (double underscore),
        // not ns.Name — Metadata API listMetadata would never emit the dot
        // form, so the old separator silently broke row-joins for every
        // simple-name type (ApexClass, LWC bundle, StaticResource, …) coming
        // out of a managed package.
        fullName = ns ? (ns + '__' + name) : name;
    }
    var outType = cfg.outputType || cfg.metadataType;
    // FlowDefinition → Flow, QuickActionDefinition → QuickAction, UserRole → Role, Group → Queue
    // for Type='Queue'. outputType keeps the Metadata API type that callers
    // expect decoupled from the SObject we queried.
    return {
        id: rec.Id,
        fullName: fullName,
        type: outType,
        fileName: (outType + '/' + (fullName || rec[cfg.nameField] || '')),
        namespacePrefix: ns || undefined,
        lastModifiedDate: rec.LastModifiedDate,
        lastModifiedByName: rec.LastModifiedBy ? rec.LastModifiedBy.Name : null,
        createdDate: rec.CreatedDate,
        createdByName: rec.CreatedBy ? rec.CreatedBy.Name : null
    };
}

// EntityDefinition Id → QualifiedApiName cache, used by types whose parent
// column (Layout.TableEnumOrId, WorkflowRule.TableEnumOrId) holds the 15/18-
// char Id for custom objects. Fetched at most once per connType per session;
// EntityDefinition is small enough that a single query is cheap.
var cshEntityApiCache = { local: null, deploy: null };

function cshResolveEntityApiNames(connType, cb) {
    if (cshEntityApiCache[connType]) {
        cb(null, cshEntityApiCache[connType]);
        return;
    }
    var proxy = connType === 'deploy' ? 'queryToolingDeploy' : 'queryToolingLocal';
    chrome.runtime.sendMessage(
        { proxyFunction: proxy, soql: 'SELECT Id, QualifiedApiName FROM EntityDefinition' },
        function (response) {
            if (response && response.err) { cb(response.err, null); return; }
            var records = (response && response.records) || [];
            var map = {};
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                if (r.Id && r.QualifiedApiName) {
                    map[r.Id] = r.QualifiedApiName;
                    // Salesforce Ids come back as 18-char case-safe here, but
                    // Layout.TableEnumOrId is documented as either a 15-char
                    // Id or an API name. Stash both for tolerant lookup.
                    if (r.Id.length === 18) map[r.Id.substring(0, 15)] = r.QualifiedApiName;
                }
            }
            cshEntityApiCache[connType] = map;
            cb(null, map);
        }
    );
}

// Dispatcher for the list-metadata fast paths. Picks the right proxy
// (queryTooling* vs querySoql*) based on cfg.api, pre-fetches the
// EntityDefinition map when the config needs it, and funnels results
// through cshNormalizeToolingRecord. Callers always get the
// { err, records: normalized[] } shape so list/compare paths stay
// interchangeable with the listMetadata response.
function cshRunQueryFastPath(connType, cfg, cb) {
    function pickProxy() {
        if (cfg.api === 'data') {
            return connType === 'deploy' ? 'querySoqlDeploy' : 'querySoqlLocal';
        }
        return connType === 'deploy' ? 'queryToolingDeploy' : 'queryToolingLocal';
    }

    function runMain(entityMap) {
        var soql = cshBuildToolingSoql(cfg);
        console.log('FastPath SOQL [' + connType + '/' + (cfg.api || 'tooling') + ']:', soql);
        chrome.runtime.sendMessage(
            { proxyFunction: pickProxy(), soql: soql },
            function (response) {
                if (response && response.err) { cb(response.err, null); return; }
                var records = (response && response.records) || [];
                var ctx = { entityMap: entityMap };
                var normalized = records
                    .map(function (r) { return cshNormalizeToolingRecord(r, cfg, ctx); })
                    .filter(function (r) { return r && r.fullName; });
                cb(null, normalized);
            }
        );
    }

    if (cfg.needsEntityMap) {
        cshResolveEntityApiNames(connType, function (err, map) {
            if (err) { cb(err, null); return; }
            runMain(map);
        });
    } else {
        runMain(null);
    }
}

function getMetaData(processResultsFunction) {

    // Fast path: one SOQL (Tooling or Data API) + queryMore chain instead of
    // listMetadata's 2000-capped SOAP protocol. Covers code families plus a
    // broad swath of XML families (CustomField, Layout, ValidationRule, Flow,
    // RecordType, Profile, PermissionSet, Queue, Role, …). On Tooling error
    // or missing SObject the caller falls through to metadata.list so
    // coverage never regresses.
    // TOOLING_QUERYABLE_TYPES is keyed on the Metadata API name (CustomLabel,
    // CustomField, …). selectedEntityType is the picker value, which for
    // entityTypeMap-mapped types is the legacy UI name (ExternalString,
    // CustomFieldDefinition, …) — looking up only by selectedEntityType
    // silently skipped the fast path and routed those types through the
    // slow listMetadata fallback (bypassing the SOQL NamespacePrefix=null
    // filter, returning tens of thousands of managed-package rows).
    var fastCfg = TOOLING_QUERYABLE_TYPES[selectedEntityType] || TOOLING_QUERYABLE_TYPES[resolvedMetadataType];
    if (fastCfg) {
        numCallsInProgress++;
        cshRunQueryFastPath('local', fastCfg, function (err, normalized) {
            if (err) {
                console.warn('Fast path failed, falling back to metadata.list:', err);
                chrome.runtime.sendMessage({
                    proxyFunction: 'listLocalMetaData',
                    proxydata: [{ type: resolvedMetadataType }]
                }, processResultsFunction);
                return;
            }
            processResultsFunction({ err: null, results: normalized });
        });
        return;
    }

    if (selectedEntityType in entityFolderMap) {
        $(".compareorg").hide();
        var data = [{type: entityFolderMap[selectedEntityType]}];
        chrome.runtime.sendMessage({'proxyFunction': "listLocalMetaData", 'proxydata': data},
            function (response) {
                results = response.results;

                var folderQueries = [];
                var n = 0;
                for (i = 0; i < results.length; i++) {

                    n++;
                    folderName = results[i].fullName;
                    var folderQuery = {};
                    folderQuery.type = resolvedMetadataType;
                    folderQuery.folder = folderName;
                    folderQueries.push(folderQuery);
                    if (n == 3) {
                        numCallsInProgress++;
                        chrome.runtime.sendMessage({
                                'proxyFunction': "listLocalMetaData",
                                'proxydata': folderQueries
                            },
                            processResultsFunction
                        );

                        folderQueries = [];
                        n = 0;
                    }
                }

                if (n > 0) {
                    numCallsInProgress++;
                    chrome.runtime.sendMessage({
                            'proxyFunction': "listLocalMetaData",
                            'proxydata': folderQueries
                        },
                        processResultsFunction
                    );
                }

            }
        );
    } else {
        numCallsInProgress++;
        chrome.runtime.sendMessage({
                'proxyFunction': "listLocalMetaData",
                'proxydata': [{type: resolvedMetadataType}]
            },
            processResultsFunction
        );
    }

}

function listMetaDataProxy(data, retFunc, isDefault) {
    if (isDefault) {
        chrome.runtime.sendMessage({'proxyFunction': "listLocalMetaData", 'proxydata': data}, function (response) {
            retFunc(response.results);
        });
    } else {
        chrome.runtime.sendMessage({'proxyFunction': "listDeployMetaData", 'proxydata': data}, function (response) {
            retFunc(response.results);
        });
    }

}


// -------------------------------------------------------------------------
// Saved-orgs picker for the Compare flow.
//
// Mirrors the Validate-Helper approach: offer a dropdown of orgs we already
// have refresh tokens for, auto-select the one last used for this change
// set, and only prompt OAuth when the user explicitly adds a new org or when
// a refresh token has been revoked.
// -------------------------------------------------------------------------

function cshCompareChangeSetId() {
    return $('#id').val() ||
        ((location.search.match(/[?&]id=([^&]+)/) || [])[1] || null);
}

function cshCompareFormatLastUsed(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
}

function cshCompareRenderSavedOrgsDropdown(orgs, preselectOrgId) {
    var $sel = $('#compareSavedOrgsSelect').empty();
    if (!orgs || !orgs.length) {
        $('#compareSavedOrgsGroup').hide();
        $('#compareNewOrgGroup').show();
        $('#compareBackToSavedOrgsLink').hide();
        return null;
    }
    orgs.forEach(function (o) {
        var hostShort = (o.host || '').replace(/^https?:\/\//, '');
        var label = (o.username || 'unknown') + '  —  ' + hostShort +
            (o.envLabel ? ' · ' + o.envLabel : '') +
            (o.lastUsedAt ? '  (' + cshCompareFormatLastUsed(o.lastUsedAt) + ')' : '');
        var $opt = $('<option></option>').val(o.orgId).text(label);
        $opt.data('org', o);
        $sel.append($opt);
    });
    var ids = orgs.map(function (o) { return o.orgId; });
    var chosen = (preselectOrgId && ids.indexOf(preselectOrgId) >= 0)
        ? preselectOrgId
        : ids[0];
    $sel.val(chosen);
    $('#compareSavedOrgsGroup').show();
    $('#compareNewOrgGroup').hide();
    $('#compareBackToSavedOrgsLink').show();
    return chosen;
}

function cshCompareRefreshSavedOrgsUI() {
    return new Promise(function (resolve) {
        chrome.runtime.sendMessage({
            type: 'cshListSavedOrgs',
            changeSetId: cshCompareChangeSetId()
        }, function (resp) {
            if (resp && resp.ok) {
                cshCompareRenderSavedOrgsDropdown(resp.orgs || [], resp.lastOrgIdForChangeSet || null);
            } else {
                cshCompareRenderSavedOrgsDropdown([], null);
            }
            resolve();
        });
    });
}

// Run the compare-metadata list call after we've established a deploy
// connection (whether via saved org or freshly logged in).
// Soft cap on listMetadata — Salesforce returns at most this many items per
// ListMetadataQuery, and the API has no native pagination. We use the value
// to detect probable truncation (results.length === LIST_META_LIMIT) and
// warn the user; for folder-based types we sidestep the cap entirely by
// listing per-folder.
var CSH_LIST_META_LIMIT = 2000;
// Metadata API allows up to 3 queries per listMetadata call. Batching by
// this number minimises round trips when scanning N folders.
var CSH_LIST_BATCH_SIZE = 3;

function cshCompareStartMetadataList(env) {
    $("#compareSavedOrgsGroup, #compareNewOrgGroup, #compareEnv, #compareMyDomain").hide();
    $("#logout").show();
    // Stash env so the compare refresh button can rerun the listing against
    // the same org without prompting the user to re-pick.
    cshLastCompareEnv = env;
    $('#csh-compare-refresh').show();
    $("#editPage").addClass("lowOpacity");

    // Folder-based types (Report, Dashboard, Document, EmailTemplate) have
    // a cap per folder, not per type — listing per folder aggregates the
    // whole org even when the total count exceeds CSH_LIST_META_LIMIT.
    var folderType = entityFolderMap[selectedEntityType];
    if (folderType) {
        cshCompareListFolderScoped(folderType, env);
    } else {
        cshCompareListFlat(env);
    }
}

function cshCompareListFlat(env) {
    // Fast path: one SOQL, queryMore walks past 2000 automatically. Covers
    // code families, Tooling-queryable XML families (CustomField, Layout,
    // ValidationRule, RecordType, Flow, QuickAction, ListView, …) and Data-
    // API SObjects (Profile, PermissionSet, Queue, Role, …). Errors fall
    // back to listMetadata so coverage never regresses.
    // Same dual lookup as getMetaData — picker value first, then resolved API
    // name. Without this, picker values like ExternalString, CustomFieldDefinition,
    // ValidationFormula skipped the fast path and the compare flow pulled every
    // managed-package row from listMetadata before filtering client-side.
    var cfg = TOOLING_QUERYABLE_TYPES[selectedEntityType] || TOOLING_QUERYABLE_TYPES[resolvedMetadataType];
    if (cfg) {
        cshRunQueryFastPath('deploy', cfg, function (err, normalized) {
            if (err) {
                console.warn('Compare fast path failed, falling back to listMetadata:', err);
                cshCompareListFlatViaListMetadata(env);
                return;
            }
            console.log('Compare fast path results:', normalized.length, 'records for', selectedEntityType);
            processCompareResults(normalized, env);
        });
        return;
    }
    cshCompareListFlatViaListMetadata(env);
}

function cshCompareListFlatViaListMetadata(env) {
    listMetaDataProxy([{ type: resolvedMetadataType }],
        function (results) {
            if (!results) {
                window.cshToast && window.cshToast.show(
                    'Compare org did not return a metadata list.',
                    { type: 'error' }
                );
                processCompareResults([], env);
                return;
            }
            if (results.error) {
                console.log('Problem listing compare metadata:', results.error);
            }
            var filtered = cshFilterOutManaged(cshApplyPostFilter(results) || results);
            // Cap warning fires on the POST-filter count — what the user
            // actually sees in the table. Warning on the raw listMetadata
            // count was misleading: a CustomLabel org with 19k managed labels
            // triggered the warning even though only ~50 unmanaged rows
            // survived the filter and nothing was actually truncated.
            if (Array.isArray(filtered) && filtered.length >= CSH_LIST_META_LIMIT) {
                window.cshToast && window.cshToast.show(
                    resolvedMetadataType + ': target org returned ' + filtered.length +
                    ' items after filtering (listMetadata cap). If the type has more, extras will not appear in the compare columns.',
                    { type: 'warning', duration: 7000 }
                );
            }
            processCompareResults(filtered, env);
        },
        false);
}

// Fetch a folder-based type by iterating its folders. Salesforce's per-query
// cap is per folder, so a 10k-report org with 50 folders lists cleanly as
// long as each folder stays under 2000. We batch CSH_LIST_BATCH_SIZE folder
// queries per listMetadata call and run those batches in parallel, then
// merge results once every batch finishes.
function cshCompareListFolderScoped(folderType, env) {
    window.cshToast && window.cshToast.show(
        'Listing folders in compare org…',
        { type: 'info', duration: 1800 }
    );
    listMetaDataProxy([{ type: folderType }], function (folders) {
        folders = folders || [];
        if (!Array.isArray(folders) || folders.length === 0) {
            // No folder records — fall back to flat list so we still show
            // whatever the bare type query returns (handles orgs where the
            // folder type happens to be empty or inaccessible).
            cshCompareListFlat(env);
            return;
        }

        var allResults = [];
        var pendingBatches = 0;
        var completedFolders = 0;
        var truncatedFolders = [];

        function sendBatch(queries) {
            pendingBatches++;
            var foldersInBatch = queries.map(function (q) { return q.folder; });
            chrome.runtime.sendMessage(
                { proxyFunction: 'listDeployMetaData', proxydata: queries },
                function (response) {
                    var batchResults = (response && response.results) || [];
                    if (Array.isArray(batchResults)) {
                        allResults = allResults.concat(batchResults);
                    }
                    // Aggregate-level cap detection: if this batch came back
                    // with exactly CSH_LIST_META_LIMIT across its queries,
                    // flag the folders (aggregate across 3 folders is the
                    // best we can do without per-query counts).
                    if (batchResults.length >= CSH_LIST_META_LIMIT) {
                        truncatedFolders = truncatedFolders.concat(foldersInBatch);
                    }
                    completedFolders += queries.length;
                    window.cshToast && window.cshToast.show(
                        'Listing ' + resolvedMetadataType + ' from target: ' +
                        completedFolders + ' / ' + folders.length + ' folders',
                        { type: 'info', duration: 1200 }
                    );
                    pendingBatches--;
                    if (pendingBatches === 0) {
                        if (truncatedFolders.length > 0) {
                            window.cshToast && window.cshToast.show(
                                resolvedMetadataType + ': these folders may be truncated at ' +
                                CSH_LIST_META_LIMIT + ' items: ' + truncatedFolders.join(', '),
                                { type: 'warning', duration: 8000 }
                            );
                        }
                        processCompareResults(cshFilterOutManaged(allResults), env);
                    }
                }
            );
        }

        var queries = [];
        for (var i = 0; i < folders.length; i++) {
            queries.push({ type: resolvedMetadataType, folder: folders[i].fullName });
            if (queries.length === CSH_LIST_BATCH_SIZE) {
                sendBatch(queries);
                queries = [];
            }
        }
        if (queries.length > 0) sendBatch(queries);
    }, false);
}

function cshCompareOnConnectSavedOrg() {
    var orgId = $('#compareSavedOrgsSelect').val();
    if (!orgId) return;
    var $btn = $('#compareSavedOrgConnect');
    var original = $btn.val();
    $btn.prop('disabled', true).val('Connecting…');
    chrome.runtime.sendMessage({
        oauth: 'connectToDeploy',
        orgId: orgId,
        changeSetId: cshCompareChangeSetId()
    }, function (response) {
        $btn.prop('disabled', false).val(original);
        if (!response || !response.ok) {
            var msg = (response && response.error) || 'Unknown error';
            if (response && response.needsReauth) {
                var orgData = $('#compareSavedOrgsSelect option:selected').data('org') || {};
                var host = orgData.host || '';
                var env;
                if (/^https?:\/\/login\.salesforce\.com/i.test(host)) env = 'prod';
                else if (/^https?:\/\/test\.salesforce\.com/i.test(host)) env = 'sandbox';
                else env = 'mydomain';
                window.cshToast && window.cshToast.show(msg + ' — re-authorizing…', { type: 'info' });
                cshCompareStartNewOrgLogin(env, host);
                return;
            }
            window.cshToast && window.cshToast.show('Connect failed: ' + msg, { type: 'error' });
            return;
        }
        $("#loggedInUsername").html(response.username || '');
        // Fresh connection — nuke any entity-map cache from a previous
        // deploy org so Tier-2 composites (Layout, WorkflowRule) don't
        // resolve Ids against the wrong org.
        cshEntityApiCache.deploy = null;
        // envLabel hint: fall back to 'prod' if unknown so processCompareResults
        // doesn't choke — it only uses env for naming in its UI.
        var env = response.envLabel === 'Sandbox' ? 'sandbox'
            : response.envLabel === 'Production' ? 'prod' : 'mydomain';
        cshCompareStartMetadataList(env);
    });
}

function cshCompareOnDeleteSavedOrg() {
    var orgId = $('#compareSavedOrgsSelect').val();
    if (!orgId) return;
    var label = $('#compareSavedOrgsSelect option:selected').text();
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
        cshCompareRefreshSavedOrgsUI();
    });
}

function cshCompareStartNewOrgLogin(env, customHost) {
    chrome.runtime.sendMessage({
        oauth: 'connectToDeploy',
        environment: env,
        customHost: customHost || null,
        changeSetId: cshCompareChangeSetId()
    }, function (response) {
        if (!response || !response.ok) {
            var err = (response && response.error) || 'Unknown error';
            console.log('Problem logging in: ' + err);
            window.cshToast && window.cshToast.show('Problem logging in: ' + err, { type: 'error' });
            return;
        }
        $("#loggedInUsername").html(response.username || '');
        // Fresh connection — clear the deploy entity-map cache so Tier-2
        // composite resolution doesn't use Ids from a previous org.
        cshEntityApiCache.deploy = null;
        cshCompareStartMetadataList(env);
    });
}

function oauthLogin(env) {
    if (!cshIsExtContextValid()) { cshWarnStaleContext(); return; }
    var env = $("#compareEnv :selected").val();
    var customHost = null;
    if (env === 'mydomain') {
        customHost = $.trim($('#compareMyDomain').val() || '');
        if (!customHost) {
            window.cshToast && window.cshToast.show(
                'Enter a My Domain URL (e.g. https://yourorg.my.salesforce.com) before comparing.',
                { type: 'error' }
            );
            return;
        }
    }
    console.log('oauthLogin');
    cshCompareStartNewOrgLogin(env, customHost);
}


// Detects whether the content script is still bound to a live extension
// context. When the user reloads the extension from chrome://extensions
// without refreshing this tab, the injected script keeps running but every
// chrome.runtime.* call throws "Extension context invalidated." Surface a
// friendly toast instead of a raw stack trace so users know to hit F5.
function cshIsExtContextValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (_) { return false; }
}

function cshWarnStaleContext() {
    var msg = 'Extension was updated — please refresh this tab to reconnect.';
    if (window.cshToast && window.cshToast.show) {
        window.cshToast.show(msg, { type: 'warning', duration: 8000 });
    } else {
        // Toast hasn't mounted yet (very early in page life) — fall back to
        // alert so the user still sees something actionable.
        try { alert(msg); } catch (_) {}
    }
}

// Trigger a compare popup for a single item. The diff ("Full name (Click
// for diff)") column and the new compare icon both funnel through this.
// Historical bug: the click handler was bound to the diff-column cell, which
// never carried the data-fullName attribute — so $(this).attr('data-fullName')
// returned undefined and the popup opened with item=undefined. Resolving the
// name explicitly via argument fixes that and lets the new icon reuse the
// same flow.
function cshTriggerCompare(fullName) {
    if (!fullName) {
        console.warn('cshTriggerCompare called without a fullName');
        return;
    }
    if (!resolvedMetadataType) {
        window.cshToast && window.cshToast.show(
            'Connect a compare org before diffing an item.',
            { type: 'error' }
        );
        return;
    }
    if (!cshIsExtContextValid()) { cshWarnStaleContext(); return; }
    // Label the popup with something meaningful on each side. Local = the
    // org hosting the change set page; target = whatever username the deploy
    // connect flow wrote into #loggedInUsername (already visible above the
    // compare table). Fall back to generic labels if either is missing so
    // the popup doesn't render "undefined" in the header.
    var localLabel = window.location.host || 'This org';
    var targetLabel = ($.trim($('#loggedInUsername').text())) || 'Other org';
    try {
        chrome.runtime.sendMessage({
            'proxyFunction': "compareContents",
            'entityType': resolvedMetadataType,
            'itemName': fullName,
            'localOrg': localLabel,
            'targetOrg': targetLabel
        }, function () { /* background opens the popup */ });
    } catch (e) {
        // Context can flip between the check above and the actual send in a
        // narrow race window. Catch here so the click doesn't surface a raw
        // "Extension context invalidated" to the console.
        cshWarnStaleContext();
    }
}

function getContents() {
    // Prefer the cell's own attribute; fall back to the row's Name cell
    // (which is where setupTable writes data-fullName first), then to the
    // link text. Any of these pins down the item without caring which DOM
    // node the click actually landed on.
    var cell = $(this);
    var fullName = cell.attr('data-fullName') ||
        cell.closest('tr').find('td[data-fullName]').first().attr('data-fullName') ||
        $.trim(cell.find('a').first().text()) ||
        $.trim(cell.text());
    cshTriggerCompare(fullName);
}

function deployLogout() {
    chrome.runtime.sendMessage({'oauth': 'deployLogout'}, function(response) {
        //console.log(response);
        //do nothing else
    });

    // Entity-Id ↔ API-name map is org-specific — the next deploy connection
    // could be a completely different org with its own custom-object Ids.
    // Clear both sides so a stale local cache can't leak into a fresh
    // compare either (local flips too on a tab-level org change).
    cshEntityApiCache.local = null;
    cshEntityApiCache.deploy = null;

    $("#loggedInUsername").html('');
    $("#logout").hide();
    // Hide compare-only affordances and drop the stashed env so a subsequent
    // action can't re-trigger an orphaned listing against a logged-out conn.
    $('#csh-compare-refresh').hide();
    cshLastCompareEnv = null;
    // Refresh the saved-orgs picker — if the user has one or more saved
    // orgs they'll see the dropdown; otherwise they fall back to the classic
    // env-select form. Makes a silent no-op if the Compare UI isn't mounted
    // yet (e.g. user logs out before ever triggering setupTable).
    if (typeof cshCompareRefreshSavedOrgsUI === 'function') {
        cshCompareRefreshSavedOrgsUI().catch(function () {});
    } else {
        // Fallback for pages that never ran setupTable — keep the legacy
        // env-select visible so Logout still returns to a usable state.
        $("#compareEnv").show();
        if ($('#compareEnv').val() === 'mydomain') $('#compareMyDomain').show();
    }


}

//This is the part that runs when loaded!

// Clear cached metadata and dynamic columns for fresh load
cachedMetadataResults = [];
cachedMetadataIds = new Set();
dynamicColumns = null; // Reset so next entity type can determine its own columns

var selectedEntityType = $('#entityType').val();
var changeSetId = $("#id").val();
var listTableLength = $("table.list tr.dataRow").length;
var nextPageHref = $('a:contains("Next Page")').first().attr('href');
if (nextPageHref) {
    //nextPageHref = nextPageHref.replace("&lsr=1000", "");
    nextPageHref = serverUrl + '/p/mfpkg/AddToPackageFromChangeMgmtUi' ;
    //console.log(nextPageHref + changeSetId + selectedEntityType);
}
// Async pagination to avoid blocking the browser
var nextPageLsr = 1000;
var shouldContinuePagination = false;
var ENABLE_PAGINATION_THRESHOLD = 1500; // Enable DataTables paging above this threshold

// Resolve the UI entity name (e.g. "ApexClass", "CustomEntityDefinition",
// "LightningMessageChannel") to a Metadata API type name:
//   1. hardcoded entityTypeMap override (for UI names that differ from API names)
//   2. describeMetadata identity match from the per-host cache
//   3. null → type is not yet supported; we fall back to a plain DataTable
// Describe-based resolution eliminates most of the need to hand-maintain the
// override map as Salesforce adds new component types each release.

// When the Add Components URL is loaded directly (not inside Lightning),
// Salesforce wraps the Visualforce body in one or more nested iframes on a
// sibling VF origin — both the top frame AND those iframes match our
// manifest pattern, so all_frames:true injects our content script in each
// and we end up rendering multiple spinners / carts / toolbars. Detect the
// sibling-nested case by reading the PARENT frame's URL and short-circuit
// everything in that case.
//
// Why parent URL, not document.referrer: referrer reflects the previous
// navigation within the SAME frame, not the embedding context. In Lightning
// the Add page lives inside an iframe; when the user switches entity types
// on the picker dropdown, the iframe re-navigates within itself. After the
// switch, document.referrer becomes the *previous* AddToPackage URL, which
// matched the old regex and made every post-switch navigation silently
// skip init — users saw the extension disappear the moment they changed
// picker selection in Lightning.
//
// Parent URL behaves correctly in both scenarios:
//   - Classic sibling-iframe: parent IS the top Add page, same origin, the
//     cross-frame read succeeds and matches the AddToPackage pattern → skip.
//   - Lightning wrapper (Aura / Aloha): parent is a different eTLD (lightning
//     .force.com, salesforce-setup.com, etc.), the read throws SecurityError,
//     we catch it and treat ourselves as the primary iframe → run.
// Top frame short-circuit stays: top is never a nested duplicate.
var cshIsNestedDuplicate = (function () {
    if (window === window.top) return false;
    try {
        var parentUrl = window.parent.location.href;
        if (/\/p\/mfpkg\/AddToPackage(FromChangeMgmtUi|Ui)/i.test(parentUrl)) {
            console.log('csh: skipping init — parent frame is also an AddToPackage page');
            return true;
        }
        // Same-origin parent that isn't AddToPackage — we're embedded by
        // something unrelated; run normally.
        return false;
    } catch (_) {
        // Cross-origin parent (Lightning shell, split-domain Setup wrapper,
        // etc.) — we're the primary Add iframe, run normally.
        return false;
    }
})();

if (cshIsNestedDuplicate) {
    // Leave a tiny breadcrumb so DevTools inspection confirms the skip.
    try { document.documentElement.setAttribute('data-csh-skipped', '1'); } catch (_) {}
} else
window.cshMetadata.getDescribe().then(function (describeCache) {
    resolvedMetadataType = window.cshMetadata.resolveEntityType(
        selectedEntityType, describeCache, entityTypeMap
    );
    console.log('Entity type resolution:', selectedEntityType, '->', resolvedMetadataType,
                describeCache ? '(describe cache warm)' : '(describe cache cold)');

    if (resolvedMetadataType == null) {
        // Coverage gap — toast the user so they know why the table isn't enhanced.
        window.cshToast && window.cshToast.show(
            'Metadata enhancement is not available for "' + selectedEntityType + '".\n\n' +
            'The table will still load. To enable last-modified columns for this type, ' +
            'visit any supported component type first to refresh the type cache, ' +
            'then return to this page.',
            { type: 'info', duration: 10000 }
        );
        totalComponentCount = listTableLength;
        startMetadataLoading();
        return;
    }

    runEnhancedFlow();
});

function runEnhancedFlow() {
    // Show loading spinner
    var loadingHtml = `
        <style>
            @keyframes csh-spinner {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
        <div id="csh-loading-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%;
             background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
            <div style="background: white; border: 3px solid #0070d2; border-radius: 8px; padding: 30px;
                 text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
                <div style="width: 60px; height: 60px; border: 6px solid #f3f3f3; border-top: 6px solid #0070d2;
                     border-radius: 50%; margin: 0 auto 20px; animation: csh-spinner 1s linear infinite;"></div>
                <h3 style="margin: 0 0 10px 0; color: #0070d2;">Loading Metadata...</h3>
                <p style="margin: 0; color: #666;">Please wait while we fetch component details</p>
            </div>
        </div>
    `;
    $('body').append(loadingHtml);

    $("#editPage").addClass("lowOpacity");

    // Wait for the session id. On HttpOnly-on orgs the fast sync read is
    // empty, but cshSession.ready resolves via the cookies API fallback.
    window.cshSession.ready.then(function (sid) {
        if (!sid) {
            $('#csh-loading-overlay').remove();
            window.cshToast && window.cshToast.show(
                'Could not read your Salesforce session cookie. Ensure the Change Set Helper ' +
                'has the "cookies" permission enabled, or uncheck Session Settings → Require HttpOnly.',
                { type: 'error' }
            );
            $("#editPage").removeClass("lowOpacity");
                    return;
        }
        // Fetch metadata FIRST. Pass the chosen auth mode so offscreen uses
        // the right jsforce.Connection shape (sessionId+serverUrl vs
        // accessToken+instanceUrl).
        chrome.runtime.sendMessage({
            "oauth": "connectToLocal",
            "sessionId": sid,
            "serverUrl": serverUrl,
            "authMode": window.cshSession.mode ? window.cshSession.mode() : 'sid',
            "instanceUrl": window.cshSession.instanceUrl ? window.cshSession.instanceUrl() : serverUrl
        }, function (response) {
        // Check for Chrome runtime errors only
        if (chrome.runtime.lastError) {
            console.error('OAuth connection failed:', chrome.runtime.lastError);
            $('#csh-loading-overlay').remove();
            window.cshToast && window.cshToast.show(
                'Failed to connect to Salesforce. Please refresh the page and try again.\n\nError: ' +
                chrome.runtime.lastError.message,
                { type: 'error' }
            );
            $("#editPage").removeClass("lowOpacity");
                    return;
        }

        // Check for explicit error in response
        if (response && response.error) {
            console.error('OAuth connection failed:', response.error);
            $('#csh-loading-overlay').remove();
            window.cshToast && window.cshToast.show(
                'Failed to connect to Salesforce. Please refresh the page and try again.\n\nError: ' + response.error,
                { type: 'error' }
            );
            $("#editPage").removeClass("lowOpacity");
                    return;
        }

        console.log('Fetching metadata before loading rows for type:', selectedEntityType);

        // Warm the describeMetadata cache in the background — doesn't block
        // list fetching. Fresh cache feeds resolveEntityType() on the next visit,
        // so newly added Salesforce types become supported without a release.
        if (window.cshMetadata && window.cshMetadata.warmDescribeCache) {
            window.cshMetadata.warmDescribeCache().catch(function (e) {
                console.warn('warmDescribeCache failed:', e && e.message);
            });
        }

        try {
            // Custom callback that waits for all metadata calls to complete
            getMetaData(function(metadataResponse) {
                // Process and cache the metadata!
                processListResults(metadataResponse);

                // Check if ALL metadata calls are complete
                if (numCallsInProgress <= 0) {
                    console.log('All metadata loaded and cached!');

                    // Metadata successfully loaded and cached!
                    $('#csh-loading-overlay').remove();

                    // Check if we need pagination
                    if (listTableLength >= 1000) {
                        // Automatically load all pages without confirmation
                        shouldContinuePagination = true;
                        isLoadingMorePages = true;
                        startPaginationWithMetadata();
                    } else {
                        // Less than 1000 rows - show immediately with metadata
                        totalComponentCount = listTableLength;
                        initializeTableWithMetadata();
                    }
                }
                // Otherwise, wait for more metadata calls to complete
            });
        } catch (error) {
            console.error('Error during metadata fetch:', error);
            $('#csh-loading-overlay').remove();
            window.cshToast && window.cshToast.show(
                'An error occurred while fetching metadata. Please try again.\n\nError: ' + error.message,
                { type: 'error' }
            );
            $("#editPage").removeClass("lowOpacity");
                }
        }); // end chrome.runtime.sendMessage connectToLocal
    }); // end window.cshSession.ready.then
}
// End of runEnhancedFlow — the coverage-gap path is handled inside the
// resolveEntityType .then() above.

// Function to start pagination after metadata is loaded
function startPaginationWithMetadata() {
    // Create progress indicator
    var progressHtml = `
        <style>
            @keyframes csh-indeterminate {
                0% { left: -35%; right: 100%; }
                60% { left: 100%; right: -90%; }
                100% { left: 100%; right: -90%; }
            }
            .csh-progress-indeterminate {
                position: absolute;
                background-color: #0070d2;
                top: 0;
                bottom: 0;
                animation: csh-indeterminate 1.5s cubic-bezier(0.65, 0.815, 0.735, 0.395) infinite;
            }
            .csh-progress-determinate {
                transition: width 0.3s ease;
            }
        </style>
        <div id="csh-pagination-progress" style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
             background: white; border: 3px solid #0070d2; border-radius: 8px; padding: 20px; z-index: 10000;
             box-shadow: 0 4px 16px rgba(0,0,0,0.3); min-width: 400px;">
            <h3 style="margin: 0 0 15px 0; color: #0070d2;">Loading Components...</h3>
            <div style="margin-bottom: 10px;">
                <div style="background: #f3f3f3; border-radius: 4px; height: 24px; overflow: hidden; position: relative;">
                    <div id="csh-progress-bar" class="csh-progress-indeterminate"></div>
                </div>
            </div>
            <div id="csh-progress-text" style="margin-bottom: 10px; color: #333;">
                Loaded: <strong>1,000</strong> rows | Current page: <strong>1</strong>
            </div>
            <div id="csh-progress-estimate" style="margin-bottom: 15px; font-size: 12px; color: #666;">
                Calculating...
            </div>
            <button id="csh-cancel-pagination" style="background: #c23934; color: white; border: none;
                    padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;">
                Cancel Loading
            </button>
        </div>
        <div id="csh-pagination-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%;
             background: rgba(0,0,0,0.5); z-index: 9999;"></div>
    `;
    $('body').append(progressHtml);

    // Add cancel handler
    $('#csh-cancel-pagination').click(function() {
        shouldContinuePagination = false;
        isLoadingMorePages = false; // Mark pagination as complete

        // Finalize the table with rows loaded so far
        if (changeSetTable) {
            totalComponentCount = changeSetTable.rows().count();
            changeSetTable.draw(); // Redraw to show final state
        }

        $('#csh-pagination-progress').remove();
        $('#csh-pagination-overlay').remove();
        $("#editPage").removeClass("lowOpacity");
    
        console.log(`Pagination cancelled by user. Table finalized with ${totalComponentCount} rows.`);
    });

    $("#editPage").addClass("lowOpacity");

    // Async recursive function to fetch pages (metadata already loaded!)
    var totalRowsLoaded = 1000;
    var currentPage = 1;
    var startTime = Date.now();
    var tableInitialized = false;

    async function fetchNextPage() {
        // Initialize table with first 1000 rows immediately (metadata already applied!)
        if (!tableInitialized && currentPage === 1) {
            tableInitialized = true;
            totalComponentCount = totalRowsLoaded;

            // Use shared initialization function
            console.log(`Initializing table with first ${totalRowsLoaded} rows with metadata (pagination in progress)...`);
            doTableInitialization();

            // Update progress to show table is visible
            $('#csh-progress-text').html(
                `<span style="color: #16844c;">✓ Table visible with ${totalRowsLoaded.toLocaleString()} rows</span><br>` +
                `Loading more in background...`
            );
        }

        if (!shouldContinuePagination || listTableLength < 1000) {
            // Done loading all pages - cleanup
            $('#csh-pagination-progress').remove();
            $('#csh-pagination-overlay').remove();

            // Final update
            totalComponentCount = totalRowsLoaded;
            isLoadingMorePages = false;
            console.log(`Pagination complete: ${totalComponentCount} total rows loaded`);

            // Redraw table to show final count
            if (changeSetTable) {
                changeSetTable.draw();
            }

            $("#editPage").removeClass("lowOpacity");
        
            return;
        }

        try {
            // Use async AJAX
            const data = await $.ajax({
                url: nextPageHref,
                data: {
                    rowsperpage: 1000,
                    isdtp: 'mn',
                    lsr: nextPageLsr,
                    id: changeSetId,
                    entityType: selectedEntityType
                },
                async: true
            });

            var parsedResponse = $(data);
            var nextTable = parsedResponse.find("table.list tr.dataRow");

            // Add columns to new rows
            if (resolvedMetadataType != null) {
                addColumnsToRows(nextTable);
            }

            // Add rows to DOM
            nextTable.appendTo("table.list tbody");

            // Apply cached metadata to these new rows
            if (cachedMetadataResults.length > 0) {
                applyMetadataToRows(cachedMetadataResults);
            }

            listTableLength = nextTable.length;
            nextPageLsr = nextPageLsr + listTableLength;
            totalRowsLoaded += listTableLength;
            currentPage++;

            // Add new rows to DataTable
            if (changeSetTable) {
                var newRowNodes = nextTable.toArray();
                changeSetTable.rows.add(newRowNodes);
                changeSetTable.draw(false);
                totalComponentCount = totalRowsLoaded;
            }

                // Calculate time estimates
                var now = Date.now();
                var avgTimePerPage = (now - startTime) / currentPage;

                // Update progress bar - switch to determinate 100% on completion
                if (listTableLength < 1000) {
                    // Completed - switch to determinate mode and show 100%
                    $('#csh-progress-bar')
                        .removeClass('csh-progress-indeterminate')
                        .addClass('csh-progress-determinate')
                        .css('width', '100%');
                }
                // Otherwise, let the indeterminate animation run (don't set width)

                if (tableInitialized) {
                    $('#csh-progress-text').html(
                        `<span style="color: #16844c;">✓ Table visible</span> | ` +
                        `Total: <strong>${totalRowsLoaded.toLocaleString()}</strong> rows | ` +
                        `Page: <strong>${currentPage}</strong>` +
                        (listTableLength < 1000 ? ' | <em>Complete!</em>' : '')
                    );
                } else {
                    $('#csh-progress-text').html(
                        `Loaded: <strong>${totalRowsLoaded.toLocaleString()}</strong> rows | ` +
                        `Current page: <strong>${currentPage}</strong>` +
                        (listTableLength < 1000 ? ' | <em>Last page reached</em>' : '')
                    );
                }

                // Update time estimate
                if (listTableLength >= 1000) {
                    $('#csh-progress-estimate').html(
                        `Average: ${(avgTimePerPage / 1000).toFixed(1)}s per page`
                    );
                } else {
                    $('#csh-progress-estimate').html('Complete!');
                }

                // Continue to next page with a small delay to keep UI responsive
                if (listTableLength >= 1000 && shouldContinuePagination) {
                    setTimeout(fetchNextPage, 50); // Small delay to allow UI updates (reduced since we batch draws)
                } else {
                    // Finished
                    shouldContinuePagination = false;
                    fetchNextPage(); // Call one more time to trigger cleanup
                }

            } catch (error) {
                console.error("Error fetching page:", error);
                window.cshToast && window.cshToast.show(
                    "Error loading page " + (currentPage + 1) +
                    ". Table will display " + totalRowsLoaded + " rows loaded so far.",
                    { type: 'warning' }
                );
                shouldContinuePagination = false;
                isLoadingMorePages = false; // Mark as complete

                // Finalize table with rows loaded so far
                if (changeSetTable) {
                    totalComponentCount = totalRowsLoaded;
                    changeSetTable.draw();
                }

                fetchNextPage(); // Trigger cleanup
            }
        }

        // Start fetching pages
        fetchNextPage();
}

// Shared function to initialize table with metadata
function doTableInitialization() {
    // setupTable() is now called from processListResults when dynamic columns are first determined
    // So we don't call it here - it's already been called
    // Just apply metadata and create DataTable
    applyMetadataToRows(cachedMetadataResults);

    // Only create table if it doesn't exist yet (prevent double initialization)
    if (!changeSetTable) {
        createDataTable();
    } else {
        console.log('DataTable already initialized, skipping createDataTable()');
    }
}

// Function to initialize table with metadata already loaded (no pagination needed)
function initializeTableWithMetadata() {
    console.log(`Initializing table with ${totalComponentCount} rows with metadata (no pagination)...`);
    doTableInitialization();
    $("#editPage").removeClass("lowOpacity");
}

// Function to start metadata loading after pagination is complete (or skipped)
function startMetadataLoading() {
    if (resolvedMetadataType != null) {
        // Don't call setupTable yet - wait until first metadata batch returns
        // so we can determine dynamic columns from the metadata properties
        $("#editPage").addClass("lowOpacity");

        window.cshSession.ready.then(function (sid) {
            if (!sid) {
                console.warn('startMetadataLoading: no session id resolved');
                $("#editPage").removeClass("lowOpacity");
                            return;
            }
            chrome.runtime.sendMessage({
                "oauth": "connectToLocal",
                "sessionId": sid,
                "serverUrl": serverUrl,
                "authMode": window.cshSession.mode ? window.cshSession.mode() : 'sid',
                "instanceUrl": window.cshSession.instanceUrl ? window.cshSession.instanceUrl() : serverUrl
            }, function (response) {
                console.log('Fetching metadata to determine table columns for type:', selectedEntityType);
                getMetaData(processListResults);
            });
        });
    } else {
        // Non-mapped entity types - setup basic table
    typeColumn = $("table.list>tbody>tr.headerRow>th>a:contains('Type')");
    nameColumn = $("table.list>tbody>tr.headerRow>th>a:contains('Name')");


    var changeSetHead2 = $('<thead></thead>').prependTo('table.list').append($('table.list tr:first'));

    // Build tfoot with one <td> per actual header <th>. Hard-coding 2 or 3
    // cells here broke on pages where Salesforce rendered additional columns
    // (Parent Object, API Name, Included By, etc.) — DataTables' _fnBuildHead
    // then crashed with "Cannot set properties of undefined (setting 'nTf')"
    // when its column loop ran off the end of the short footer.
    var colCount = changeSetHead2.find('th').length;
    var tfootCells = new Array(Math.max(colCount, 1)).fill('<td></td>').join('');
    changeSetHead2.after('<tfoot><tr>' + tfootCells + '</tr></tfoot>');

    // Derive the initial sort column from the actual header th count.
    // Salesforce usually renders Action+Type+Name (3 cols) or Action+Name (2),
    // so index 1 is safe — but for edge-case renders with only 1 th, a
    // hardcoded [[1,'asc']] makes DataTables throw inside _fnSortFlatten
    // ("Cannot read properties of undefined (reading 'aDataSort')").
    var initialOrder = colCount >= 2 ? [[1, 'asc']] : (colCount >= 1 ? [[0, 'asc']] : []);
    changeSetTable = $('table.list').DataTable({
            paging: false,
            dom: 'lrti',
            order: initialOrder,
            "deferRender": true,  // Performance optimization for large datasets
            initComplete: basicTableInitComplete
        }
    );

    cshInstallToolbarActions();
    $('#editPage').append('<input type="hidden" name="rowsperpage" value="1000" /> ');

    var gotoloc2 = "'/" + $("#id").val() + "?tab=PackageComponents&rowsperpage=1000'";
    $('input[name="cancel"]').before('<input value="View change set" class="btn" name="viewall" title="View all items in changeset in new window" type="button" onclick="window.open(' + gotoloc2 + ',\'_blank\');" />');
    }
}



$(document).ready(function () {
    if (cshIsNestedDuplicate) return;
    $(".clearFilters").on('click', clearFilters);
	$( "#logoutLink" ).on('click', deployLogout);

    $("#editPage").on('submit', function (event) {
        clearFilters();
        return true;
    });

    $('input[name="cancel"]').parent().on('click','#compareorg' , oauthLogin);
    // Saved-orgs wiring for Compare. These handlers mirror the Validate
    // Helper's saved-orgs behavior so both flows share one persistent org
    // registry.
    $(document).on('click', '#compareSavedOrgConnect', cshCompareOnConnectSavedOrg);
    $(document).on('click', '#compareSavedOrgDelete', cshCompareOnDeleteSavedOrg);
    // Refresh pulls the target-org listing again (and re-reads the local
    // change set rows off the DataTable). Handy when the user has just added
    // components to the change set, or when someone edited metadata in the
    // target org and they want updated "modified by/date" columns without
    // reconnecting.
    $(document).on('click', '#csh-compare-refresh', function (ev) {
        ev.preventDefault();
        if (!cshLastCompareEnv) return;
        cshCompareStartMetadataList(cshLastCompareEnv);
    });
    $(document).on('click', '#compareAddAnotherOrgLink', function (ev) {
        ev.preventDefault();
        $('#compareSavedOrgsGroup').hide();
        $('#compareNewOrgGroup').show();
        $('#compareBackToSavedOrgsLink').show();
    });
    $(document).on('click', '#compareBackToSavedOrgsLink', function (ev) {
        ev.preventDefault();
        $('#compareNewOrgGroup').hide();
        $('#compareSavedOrgsGroup').show();
    });
    // Populate the saved-orgs dropdown once the compare controls are rendered.
    cshCompareRefreshSavedOrgsUI();
    // Reveal My Domain URL input when the user picks it.
    $(document).on('change', '#compareEnv', function () {
        if ($(this).val() === 'mydomain') $('#compareMyDomain').show();
        else $('#compareMyDomain').hide();
    });

    // Three-stage auth ladder: cookie → chrome.cookies → OAuth. If all three
    // fail, show an actionable Sign In button that triggers the OAuth PKCE
    // flow in a popup. Success reloads the page so the new token is picked
    // up by cshSession.ready on next init.
    if (window.cshSession && window.cshSession.ready) {
        window.cshSession.ready.then(function (sid) {
            if (sid) return;
            var banner = $(
                '<div id="csh-signin-banner" style="background:#fff5d6;border:1px solid #d1c083;border-radius:4px;padding:12px 14px;margin:10px 0;display:flex;gap:10px;align-items:center;">' +
                '<div style="flex:1 1 auto;">' +
                  '<strong>Change Set Helper needs to sign in.</strong><br/>' +
                  'Your Salesforce session cookie is not readable from this browser. ' +
                  'Sign in via OAuth to let the extension call the Metadata API on your behalf. ' +
                  'You can alternatively uncheck Setup → Session Settings → Require HttpOnly attribute.' +
                '</div>' +
                '<button id="csh-signin-btn" style="flex:0 0 auto;padding:8px 14px;background:#0176d3;color:#fff;border:0;border-radius:3px;cursor:pointer;font:inherit;font-weight:600;">Sign in via OAuth</button>' +
                '</div>'
            );
            $('.bDescription').append(banner);
            banner.find('#csh-signin-btn').on('click', async function () {
                var btn = $(this);
                btn.prop('disabled', true).text('Opening popup…');
                var resp = await window.cshAuth.login();
                if (resp && resp.ok && resp.accessToken) {
                    window.cshToast && window.cshToast.show(
                        'Signed in. Reloading to pick up the new session…',
                        { type: 'success', duration: 2000 }
                    );
                    setTimeout(function () { location.reload(); }, 600);
                } else {
                    btn.prop('disabled', false).text('Sign in via OAuth');
                    window.cshToast && window.cshToast.show(
                        'Sign in failed: ' + ((resp && resp.error) || 'unknown error') +
                        '. Use Options → OAuth Diagnostic to troubleshoot.',
                        { type: 'error' }
                    );
                }
            });
        });
    } else if (!sessionId) {
        $('.bDescription').append(
            '<span style="background-color:yellow"><strong><br/> <br/>' +
            'Sorry, currently for the Change Set Helper to work, please UNSET the Require ' +
            'HTTPOnly Attribute checkbox in Security -&gt; Session Settings. Then logout ' +
            'and back in again.' +
            '</strong></span>'
        );
    }

    // Resolve the 0A2 outbound change-set id alongside the 033 package id so
    // the cart sync can write to both storage keys the extension uses for
    // the same change set (Add page keys by 033; Detail page keys by 0A2).
    //
    // Source ladder for the 0A2:
    //   1. retURL parameter — present when the user navigated here from
    //      the Detail page's "Add Components" link (carries the detail
    //      URL whose ?id= is the 0A2).
    //   2. DOM scan — Salesforce embeds many "View Change Set" links and
    //      breadcrumbs back to the Detail page; the 0A2 appears in their
    //      hrefs even when retURL is missing.
    var __cshPkgId = $('#id').val() || null;
    var __cshCsId = null;
    var __cshRet = (location.search.match(/[?&]retURL=([^&]+)/) || [])[1];
    if (__cshRet) {
        try {
            var __cshM = decodeURIComponent(__cshRet).match(/[?&]id=([^&]+)/);
            if (__cshM) __cshCsId = decodeURIComponent(__cshM[1]);
        } catch (_) { /* malformed retURL, fall through */ }
    }
    if (!__cshCsId) {
        // DOM fallback: any anchor pointing at outboundChangeSetDetailPage
        // carries the 0A2 in its ?id=.
        var __cshAnchors = document.querySelectorAll('a[href*="outboundChangeSetDetailPage"]');
        for (var __cshI = 0; __cshI < __cshAnchors.length; __cshI++) {
            var __cshHref = __cshAnchors[__cshI].getAttribute('href') || '';
            var __cshMatch = __cshHref.match(/0A2[A-Za-z0-9]{12,15}/);
            if (__cshMatch) { __cshCsId = __cshMatch[0]; break; }
        }
    }

    // Persist the 0A2 ↔ 033 mapping so the Detail page's authoritative cart
    // sync can resolve the package id without bouncing through a hidden
    // iframe (Salesforce often refuses to render the Add page in iframes
    // and the resolver times out).
    if (window.cshIdMap && __cshPkgId && __cshCsId) {
        window.cshIdMap.putMapping(__cshCsId, __cshPkgId)
            .catch(function (e) { console.warn('cshIdMap.putMapping failed:', e && e.message); });
    }

    // Kick off the cart module: caches the form shape for this type, restores
    // staged checkboxes from any prior session, installs the type-switch
    // guard, and renders the floating panel if there are pending items.
    if (window.cshCart && window.cshCart.init) {
        window.cshCart.init({
            changeSetId: __cshPkgId,
            currentType: selectedEntityType || null
        });
    }

    // Populate the cart with components already in the change set so the
    // panel reflects reality on first visit to the Add page (previously the
    // panel stayed empty unless the user had already visited the Detail
    // page AND its dual-key sync had happened to land on the 033 key).
    //
    // Writes to both the 033 (Add-page) and 0A2 (Detail-page) storage keys
    // so the cart stays in sync across navigations.
    if (window.cshCart && window.cshCart.syncFromChangeSetView && __cshPkgId) {
        var __cshSetSync = window.cshCart.setSyncState || function () {};
        __cshSetSync('syncing');
        window.cshCart.syncFromChangeSetView(__cshCsId || __cshPkgId, __cshPkgId)
            .then(function (r) {
                console.log('[CSH] Add-page cart sync:', r);
                __cshSetSync('idle');
            })
            .catch(function (e) {
                console.warn('[CSH] Add-page cart sync failed:', e && e.message);
                __cshSetSync('error', (e && e.message) || 'Sync failed');
            });
    }
});

//Find out if they are logged in already
chrome.runtime.sendMessage({'proxyFunction': 'getDeployUsername'}, function(username) {
	console.log(username);
	if (username) {
		//Then there is a logged in deploy user — hide both login paths
		$("#compareSavedOrgsGroup, #compareNewOrgGroup, #compareEnv, #compareMyDomain").hide();
		$("#loggedInUsername").html(username);
		$("#logout").show();
	} else {
		$("#loggedInUsername").html('');
		$("#logout").hide();
		// cshCompareRefreshSavedOrgsUI is also called from setupTable and
		// from the wiring block — calling again here is cheap and covers the
		// race where this message response arrives after the DOM is ready.
		if (typeof cshCompareRefreshSavedOrgsUI === 'function') {
			cshCompareRefreshSavedOrgsUI().catch(function () {});
		} else {
			$("#compareEnv").show();
		}
	}
});