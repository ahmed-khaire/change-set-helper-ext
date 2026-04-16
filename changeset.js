var changeSetTable = null;
var typeColumn = null;
var nameColumn = null;
var numCallsInProgress = 0;
var totalComponentCount = 0; // Track total rows loaded for pagination decisions
var isLoadingMorePages = false; // Flag to indicate we're still loading pages in background
var cachedMetadataResults = []; // Store metadata results to reuse during pagination
var dynamicColumns = null; // Store dynamic column configuration based on metadata properties
var resolvedMetadataType = null; // Metadata API type name resolved via override map or describeMetadata cache

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
}

//as Dashboard, Document,
//EmailTemplate, or Report.
var entityFolderMap = {
    'Report': 'ReportFolder',
    'Document': 'DocumentFolder',
    'EmailTemplate': 'EmailFolder',
    'Dashboard': 'DashboardFolder'
}


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
        .after(`<br /><input value="Compare with org" class="btn compareorg" name="compareorg" id="compareorg"
					title="Compare wtih another org. A login box will be displayed." type="button" />
		<select id='compareEnv' name='Compare Environment'>
			<option value='sandbox'>Sandbox</option>
			<option value='prod'>Prod/Dev</option>
			<option value='mydomain'>My Domain URL…</option>
		</select>
		<input type='text' id='compareMyDomain' placeholder='https://yourorg.my.salesforce.com' style='display:none;margin-left:6px;padding:3px 6px;min-width:240px;' />
	<span id="loggedInUsername"></span>  <span id="logout">(<a id="logoutLink" href="#">Logout</a>)</span>
`);

    $('#editPage').append('<input type="hidden" name="rowsperpage" value="5000" /> ');
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

    // Define which properties to include and in what order
    // Skip certain properties that aren't useful for display
    // fullName is skipped because the table already has a "Name" column
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
    var len = results ? results.length : 0;
    console.log('Processing', len, 'metadata results from JSforce');

    // Log first few results to see data structure
    if (len > 0) {
        console.log('First JSforce result:', results[0]);
        if (len > 1) {
            console.log('Second JSforce result:', results[1]);
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
    }

    // Cache metadata results for reuse during pagination
    // Merge new results with cached results (dedupe by id)
    for (i = 0; i < len; i++) {
        var existingIndex = cachedMetadataResults.findIndex(r => r.id === results[i].id);
        if (existingIndex === -1) {
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

    // Log first metadata record to see structure
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

    // Log table structure
    var sampleRow = $("table.list tr.dataRow").first();
    if (sampleRow.length > 0) {
        var cellCount = sampleRow.find('td').length;
        console.log('Sample row has', cellCount, 'cells');

        // Log each cell content
        var cellContents = [];
        sampleRow.find('td').each(function(index) {
            var text = $(this).text().trim();
            cellContents.push(index + ':' + (text.substring(0, 20) || 'empty'));
        });
        console.log('Sample row cells:', cellContents.join(' | '));
    }

    // Log header structure
    var headers = [];
    $("table.list thead tr th, table.list thead tr td").each(function(index) {
        var text = $(this).text().trim();
        var linkText = $(this).find('a').text().trim();
        headers.push(index + ':' + (linkText || text || 'empty'));
    });
    console.log('Table headers:', headers.join(' | '));

    for (i = 0; i < results.length; i++) {
        // Normalize ID to 15 characters (Salesforce IDs can be 15 or 18 chars)
        // 18-char IDs are just 15-char IDs with a 3-char case-safe suffix
        shortid = results[i].id.substring(0, 15);
        var matchingInput = $("input[value='" + shortid + "']");

        // If not found with 15-char ID, try the full 18-char ID if available
        if (matchingInput.length === 0 && results[i].id.length === 18) {
            matchingInput = $("input[value='" + results[i].id + "']");
        }

        if (matchingInput.length === 0) {
            if (i === 0) console.log('First metadata record: No matching row found for ID:', shortid, 'or', results[i].id);
            continue;
        }

        var row = matchingInput.first().closest('tr');

        // Dynamic columns start AFTER every cell Salesforce originally rendered
        // in this row (Name + optional Type + optional ParentObject + ...).
        // Using cshOriginalRowCellCount keeps alignment correct regardless of
        // how many columns the entity type actually emits.
        var baseColumnCount = (typeof cshOriginalRowCellCount === 'number' && cshOriginalRowCellCount > 0)
            ? cshOriginalRowCellCount
            : (typeColumn.length > 0 ? 2 : 1);

        // Log first row update
        if (i === 0) {
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
            if (i === 0) {
                console.log('  - Stored fullName on Name column (td index 0):', results[i].fullName);
            }
        }

        // Populate dynamic columns with metadata values
        if (dynamicColumns && dynamicColumns.length > 0) {
            for (var colIdx = 0; colIdx < dynamicColumns.length; colIdx++) {
                var column = dynamicColumns[colIdx];
                var cellIndex = baseColumnCount + colIdx;
                var value = results[i][column.propertyName];

                // Log first row details - BEFORE formatting
                if (i === 0) {
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

                // Log first row details - AFTER formatting
                if (i === 0) {
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
            if (i === 0) {
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
function cshAppendTargetOnlyRows(records, env) {
    if (!changeSetTable) return;
    var totalCols = changeSetTable.columns().count();
    records.forEach(function (rec) {
        var row = new Array(totalCols).fill('');
        // Column 0 is the checkbox — put a disabled, explanatory placeholder
        row[0] = '<span title="Exists in target org only" style="color:#8e0916;font-weight:600;">[target only]</span>';
        // Column 1 is Name — use fullName as the display name
        row[1] = rec.fullName || '';
        // Compare cells
        if (compareColumnIndices.compareDateMod >= 0 && rec.lastModifiedDate) {
            row[compareColumnIndices.compareDateMod] = convertDate(new Date(rec.lastModifiedDate));
        }
        if (compareColumnIndices.compareModBy >= 0) {
            row[compareColumnIndices.compareModBy] = rec.lastModifiedByName || '';
        }
        if (compareColumnIndices.fullName >= 0) {
            row[compareColumnIndices.fullName] = rec.fullName || '';
        }
        if (compareColumnIndices.folder >= 0 && rec.folder) {
            row[compareColumnIndices.folder] = rec.folder;
        }
        var added = changeSetTable.row.add(row).draw(false);
        var node = added.node();
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

    for (i = 0; i < results.length; i++) {
        var fullName = results[i].fullName;
        var matchingInput = $('td[data-fullName = "' + fullName + '"]');

        if (matchingInput.length === 0) {
            targetOnlyRecords.push(results[i]);
            continue;
        }
        if (matchingInput.length > 0) {
            var rowIdx = changeSetTable.cell('td[data-fullName = "' + fullName + '"]').index().row;

            dateMod = new Date(results[i].lastModifiedDate);

            // Update compare columns with data from other org (use dynamic indices)
            changeSetTable.cell(rowIdx, compareColumnIndices.compareDateMod).data(convertDate(dateMod));
            changeSetTable.cell(rowIdx, compareColumnIndices.compareModBy).data(results[i].lastModifiedByName);
            changeSetTable.cell(rowIdx, compareColumnIndices.fullName).data('<a href="#">' + fullName + '</a>');

            // Make Full Name cell clickable for diff
            var fullNameCell = changeSetTable.cell(rowIdx, compareColumnIndices.fullName).node();
            $(fullNameCell).off("click");
            $(fullNameCell).click(getContents);

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
    }

    // Phase 6: append ghost rows for target-only records.
    // These aren't in the local change set. They sort, filter, and export
    // like regular rows, but get the fourth colour-diff state: red + [target only].
    if (targetOnlyRecords.length > 0) {
        cshAppendTargetOnlyRows(targetOnlyRecords, env);
    }

    // Hide folder column after processing
    changeSetTable.column(compareColumnIndices.folder).visible(false);

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
    $("#bodyCell").removeClass("changesetloading");

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

        // Ensure clear filters + CSV button exist
        if ($('.clearFilters').length === 0) {
            console.log('createDataTable: Adding Clear Filters button');
            $('<input style="float: left;"  value="Reset Search Filters" class="clearFilters btn" name="Reset Search Filters" title="Reset search filters" type="button" />').prependTo('div.rolodex');
            $(".clearFilters").click(clearFilters);
        }
        if ($('.cshExportCsv').length === 0) {
            $('<input style="float: left;" value="Export TSV" class="cshExportCsv btn" name="Export TSV" title="Download the current table as a tab-separated file" type="button" />').prependTo('div.rolodex');
            $(".cshExportCsv").click(cshExportTable);
        }
        cshInstallModifiedByFilter();

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

        $('<input style="float: left;"  value="Reset Search Filters" class="clearFilters btn" name="Reset Search Filters" title="Reset search filters" type="button" />').prependTo('div.rolodex');
        $(".clearFilters").click(clearFilters);
        $('<input style="float: left;" value="Export TSV" class="cshExportCsv btn" name="Export TSV" title="Download the current table as a tab-separated file" type="button" />').prependTo('div.rolodex');
        $(".cshExportCsv").click(cshExportTable);
        cshInstallModifiedByFilter();
        $("#editPage").submit(function (event) {
            clearFilters();
            return true;
        });
    } catch (e) {
        console.log(e);
    }

    $("#editPage").removeClass("lowOpacity");
    $("#bodyCell").removeClass("changesetloading");
}

function clearFilters() {
    //console.log(changeSetTable);
    changeSetTable
        .columns().search('')
        .draw();
    $(".dtsearch").val('');
}

// ---------------------------------------------------------------------------
// Phase 5.1 — CSV / TSV export
//
// Dumps the currently-filtered DataTable rows as a tab-separated file so the
// user can paste directly into Excel / Numbers / Sheets without worrying
// about quoted-comma escaping. Respects visible columns and active search.
// ---------------------------------------------------------------------------
function cshCsvEscape(val) {
    if (val == null) return '';
    var s = String(val);
    if (/[\t\r\n"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
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
    lines.push(headers.map(cshCsvEscape).join('\t'));

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
        lines.push(line.join('\t'));
    }

    var entityType = $('#entityType').val() || 'change-set';
    var stamp = new Date().toISOString().slice(0, 10);
    var fname = 'csh-' + entityType + '-' + stamp + '.tsv';
    // UTF-8 BOM (U+FEFF) so Excel on Windows treats the file as UTF-8 and
    // renders non-ASCII characters (e.g. curly apostrophes in component
    // names) correctly instead of garbling them in the Windows-1252 guess.
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/tab-separated-values;charset=utf-8' });
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

// ---------------------------------------------------------------------------
// Phase 5.2 — Modified-by-me / last N days filter
//
// Sits above the table, filters using DataTables' custom search hook against
// lastModifiedBy and lastModifiedDate columns if they exist. Only registers
// the hook once; toggle off when fields are empty.
// ---------------------------------------------------------------------------
var cshModFilterInstalled = false;
var cshModFilterCtx = { byColIdx: -1, dateColIdx: -1 };

function cshInstallModifiedByFilter() {
    if (!changeSetTable || cshModFilterInstalled) return;
    if (!dynamicColumns || dynamicColumns.length === 0) return;

    var headerCount = (typeof cshOriginalHeaderCount === 'number' && cshOriginalHeaderCount > 0)
        ? cshOriginalHeaderCount : (typeColumn.length > 0 ? 3 : 2);
    cshModFilterCtx.byColIdx = -1;
    cshModFilterCtx.dateColIdx = -1;
    dynamicColumns.forEach(function (col, i) {
        if (col.propertyName === 'lastModifiedByName') cshModFilterCtx.byColIdx = headerCount + i;
        if (col.propertyName === 'lastModifiedDate')   cshModFilterCtx.dateColIdx = headerCount + i;
    });
    if (cshModFilterCtx.byColIdx === -1 && cshModFilterCtx.dateColIdx === -1) return;

    // Best-effort: pull a display name from the Salesforce header so the
    // "Modified by me" checkbox works out of the box. User can edit if wrong.
    var me = $.trim(
        $('.userProfile .uiOutputText').first().text() ||
        $('.branding-userProfile-button').attr('title') ||
        $('.userNav').text() || ''
    );

    var html =
        '<div id="csh-mod-filter" class="csh-mod-filter">' +
          '<strong>Quick filter:</strong> ' +
          '<label><input type="checkbox" id="csh-mod-me"> Modified by me</label> ' +
          '<input type="text" id="csh-mod-me-name" placeholder="my display name" value="' + $('<div>').text(me).html() + '" title="Your display name as it appears in Last Modified By">' +
          ' <label>In the last <input type="number" id="csh-mod-days" min="0" max="365" placeholder="7"> days</label>' +
          ' <button type="button" id="csh-mod-apply" class="btn">Apply</button>' +
          ' <button type="button" id="csh-mod-clear" class="btn">Clear</button>' +
        '</div>';
    $(html).insertBefore('table.list');

    $.fn.dataTable.ext.search.push(function (settings, rowData) {
        if (settings.nTable !== changeSetTable.table().node()) return true;
        var byMe = $('#csh-mod-me').prop('checked');
        var days = parseInt($('#csh-mod-days').val(), 10);
        var myName = $.trim(($('#csh-mod-me-name').val() || '')).toLowerCase();

        if (byMe && myName && cshModFilterCtx.byColIdx !== -1) {
            var name = String(rowData[cshModFilterCtx.byColIdx] || '').toLowerCase();
            if (name.indexOf(myName) === -1) return false;
        }
        if (!isNaN(days) && days > 0 && cshModFilterCtx.dateColIdx !== -1) {
            var dateStr = String(rowData[cshModFilterCtx.dateColIdx] || '').trim();
            if (!dateStr) return false;
            var d = moment(dateStr, 'DD MMM YYYY');
            if (d.isValid()) {
                var cutoff = moment().subtract(days, 'days').startOf('day');
                if (d.isBefore(cutoff)) return false;
            }
        }
        return true;
    });

    $(document).on('click', '#csh-mod-apply', function () { changeSetTable.draw(); });
    $(document).on('click', '#csh-mod-clear', function () {
        $('#csh-mod-me').prop('checked', false);
        $('#csh-mod-days').val('');
        changeSetTable.draw();
    });
    $(document).on('change', '#csh-mod-me', function () { changeSetTable.draw(); });

    cshModFilterInstalled = true;
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

                // Date columns get text search, others get dropdown
                if (colDef.isDate) {
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
var TOOLING_QUERYABLE_TYPES = {
    'ApexClass':      { metadataType: 'ApexClass',      nameField: 'Name' },
    'ApexTrigger':    { metadataType: 'ApexTrigger',    nameField: 'Name' },
    'ApexPage':       { metadataType: 'ApexPage',       nameField: 'Name' },
    'ApexComponent':  { metadataType: 'ApexComponent',  nameField: 'Name' },
    'AuraDefinitionBundle':     { metadataType: 'AuraDefinitionBundle',     nameField: 'DeveloperName' },
    'LightningComponentBundle': { metadataType: 'LightningComponentBundle', nameField: 'DeveloperName' }
};

function cshBuildToolingSoql(cfg) {
    return 'SELECT Id, ' + cfg.nameField +
        ', NamespacePrefix, LastModifiedDate, LastModifiedBy.Name, CreatedDate, CreatedBy.Name ' +
        'FROM ' + cfg.metadataType +
        ' ORDER BY ' + cfg.nameField;
}

function cshNormalizeToolingRecord(rec, cfg) {
    var name = rec[cfg.nameField] || '';
    var ns = rec.NamespacePrefix || '';
    return {
        id: rec.Id,
        fullName: ns ? (ns + '.' + name) : name,
        type: cfg.metadataType,
        fileName: (cfg.metadataType + '/' + name),
        namespacePrefix: ns || undefined,
        lastModifiedDate: rec.LastModifiedDate,
        lastModifiedByName: rec.LastModifiedBy ? rec.LastModifiedBy.Name : null,
        createdDate: rec.CreatedDate,
        createdByName: rec.CreatedBy ? rec.CreatedBy.Name : null
    };
}

function getMetaData(processResultsFunction) {

    // Fast path for code types: one Tooling SOQL query instead of listMetadata.
    // Falls through to the existing metadata.list path on error so coverage
    // is preserved even if Tooling is restricted on the org.
    if (TOOLING_QUERYABLE_TYPES[selectedEntityType]) {
        var cfg = TOOLING_QUERYABLE_TYPES[selectedEntityType];
        var soql = cshBuildToolingSoql(cfg);
        numCallsInProgress++;
        console.log('Tooling SOQL fast path for', selectedEntityType + ':', soql);
        chrome.runtime.sendMessage({
            proxyFunction: 'queryToolingLocal',
            soql: soql
        }, function (response) {
            if (response && response.err) {
                console.warn('Tooling fast path failed, falling back to metadata.list:', response.err);
                // Re-dispatch through metadata.list
                chrome.runtime.sendMessage({
                    proxyFunction: 'listLocalMetaData',
                    proxydata: [{ type: resolvedMetadataType }]
                }, processResultsFunction);
                return;
            }
            var records = (response && response.records) || [];
            var normalized = records.map(function (r) { return cshNormalizeToolingRecord(r, cfg); });
            // Match the shape of listLocalMetaData's response
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


function oauthLogin(env) {
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
    chrome.runtime.sendMessage({
        'oauth': "connectToDeploy",
        environment: env,
        customHost: customHost
    }, function (response) {
        console.log(response);
        $("#compareEnv, #compareMyDomain").hide();

        $("#loggedInUsername").html(response.username);
        $("#logout").show();

        listMetaDataProxy([{type: resolvedMetadataType}],
            function (results) {
                if (results.error) {
                    console.log("Problem logging in: " + results.error);
                    //do nothing else
                }
                $("#editPage").addClass("lowOpacity");
                $("#bodyCell").addClass("changesetloading");

                processCompareResults(results, env);
                //console.log(results);
            },
            false);

    });
}


function getContents() {
    var itemToGet = $(this).attr('data-fullName');
    //(itemToGet);
    chrome.runtime.sendMessage({
            'proxyFunction': "compareContents",
            'entityType': resolvedMetadataType,
            'itemName': itemToGet
        },
        function (response) {
            //do nothing
        }
    );
}

function deployLogout() {
    chrome.runtime.sendMessage({'oauth': 'deployLogout'}, function(response) {
        //console.log(response);
        //do nothing else
    });

    $("#compareEnv").show();
    // Only show the My-Domain input if that option is currently selected.
    if ($('#compareEnv').val() === 'mydomain') $('#compareMyDomain').show();
    $("#loggedInUsername").html('');
    $("#logout").hide();


}

//This is the part that runs when loaded!

// Clear cached metadata and dynamic columns for fresh load
cachedMetadataResults = [];
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
    $("#bodyCell").addClass("changesetloading");

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
            $("#bodyCell").removeClass("changesetloading");
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
            $("#bodyCell").removeClass("changesetloading");
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
            $("#bodyCell").removeClass("changesetloading");
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
            $("#bodyCell").removeClass("changesetloading");
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
        $("#bodyCell").removeClass("changesetloading");

        console.log(`Pagination cancelled by user. Table finalized with ${totalComponentCount} rows.`);
    });

    $("#editPage").addClass("lowOpacity");
    $("#bodyCell").addClass("changesetloading");

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
            $("#bodyCell").removeClass("changesetloading");

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
    $("#bodyCell").removeClass("changesetloading");
}

// Function to start metadata loading after pagination is complete (or skipped)
function startMetadataLoading() {
    if (resolvedMetadataType != null) {
        // Don't call setupTable yet - wait until first metadata batch returns
        // so we can determine dynamic columns from the metadata properties
        $("#editPage").addClass("lowOpacity");
        $("#bodyCell").addClass("changesetloading");

        window.cshSession.ready.then(function (sid) {
            if (!sid) {
                console.warn('startMetadataLoading: no session id resolved');
                $("#editPage").removeClass("lowOpacity");
                $("#bodyCell").removeClass("changesetloading");
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
    if (typeColumn.length > 0) {
        changeSetHead2.after('<tfoot><tr><td></td><td></td><td></td></tr></tfoot>');
    } else {
        changeSetHead2.after('<tfoot><tr><td></td><td></td></tr></tfoot>');
    }

    changeSetTable = $('table.list').DataTable({
            paging: false,
            dom: 'lrti',
            "order": [[1, "asc"]],
            "deferRender": true,  // Performance optimization for large datasets
            initComplete: basicTableInitComplete
        }
    );

    $('<input style="float: left;"  value="Reset Search Filters" class="clearFilters btn" name="Reset Search Filters" title="Reset search filters" type="button" />').prependTo('div.rolodex');
    $('#editPage').append('<input type="hidden" name="rowsperpage" value="1000" /> ');

    var gotoloc2 = "'/" + $("#id").val() + "?tab=PackageComponents&rowsperpage=1000'";
    $('input[name="cancel"]').before('<input value="View change set" class="btn" name="viewall" title="View all items in changeset in new window" type="button" onclick="window.open(' + gotoloc2 + ',\'_blank\');" />');
    }
}



$(document).ready(function () {
    $(".clearFilters").on('click', clearFilters);
	$( "#logoutLink" ).on('click', deployLogout);

    $("#editPage").on('submit', function (event) {
        clearFilters();
        return true;
    });

    $('input[name="cancel"]').parent().on('click','#compareorg' , oauthLogin);
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

    // Kick off the cart module: caches the form shape for this type, restores
    // staged checkboxes from any prior session, installs the type-switch
    // guard, and renders the floating panel if there are pending items.
    if (window.cshCart && window.cshCart.init) {
        window.cshCart.init({
            changeSetId: $('#id').val() || null,
            currentType: selectedEntityType || null
        });
    }
});

//Find out if they are logged in already
chrome.runtime.sendMessage({'proxyFunction': 'getDeployUsername'}, function(username) {
	console.log(username);
	if (username) {
		//Then there is a logged in deploy user
		$("#compareEnv").hide();
		$("#loggedInUsername").html(username);
		$("#logout").show();
	} else {
		$("#compareEnv").show();
        $("#loggedInUsername").html('');
		$("#logout").hide();
	}
	//do nothing else
});