# Salesforce Change Set Helper Reloaded

![Version](https://img.shields.io/badge/version-3.1.0-blue.svg)
![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)
![License](https://img.shields.io/badge/license-MIT-orange.svg)

A powerful Chrome Extension that enhances Salesforce change set functionality with advanced features like last modified dates, sorting, searching, validation, deployment, and cross-org comparison capabilities.

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Technical Details](#technical-details)
- [Performance Optimizations](#performance-optimizations)
- [Requirements](#requirements)
- [Credits](#credits)
- [Support](#support)
- [License](#license)

---

## 🎯 Overview

**Salesforce Change Set Helper Reloaded** transforms the standard Salesforce change set interface into a powerful, feature-rich management tool. Whether you're working with small change sets or massive deployments with 50,000+ components, this extension provides the tools you need to efficiently manage your Salesforce metadata.

### Key Capabilities

- 📅 **Enhanced Metadata Display**: View last modified dates, modified by, creation dates, and folder information
- 🔍 **Advanced Search & Filtering**: Real-time search across all columns with type-based filters
- 📊 **Intelligent Pagination**: Automatic pagination for datasets over 1,500 rows
- 🚀 **Progressive Loading**: Table appears in 2-3 seconds, loads additional data in background
- ⚖️ **Cross-Org Comparison**: Compare metadata between source and target orgs
- ✅ **Validation & Deployment**: Validate and deploy change sets directly from the interface
- 📦 **Package Download**: Download change sets as ZIP packages
- 🎨 **Code Comparison**: View side-by-side diffs of metadata

---

## ✨ Features

### 1. **Enhanced Change Set View**

Transform the standard Salesforce change set table with additional metadata columns:

- **Folder Name**: For folder-based components (Reports, Dashboards, Email Templates, Documents)
- **Last Modified Date**: When the component was last changed
- **Modified By**: Who made the last modification
- **Full API Name**: Complete metadata API name
- **Compare Columns**: Side-by-side comparison with target org

### 2. **High-Performance Table Management**

#### Progressive Loading (NEW!)
- Table initializes with first 1,000 rows in 2-3 seconds
- Additional pages load in background without blocking
- Live row count updates as data loads
- **No freezing** even with 100,000+ components!

#### Smart Pagination
- Automatically enabled for datasets over 1,500 rows
- Shows 100 rows per page for optimal performance
- Search and filter work across ALL rows, not just current page
- Deferred rendering for instant page switching

#### Visual Progress Indicator
- Animated indeterminate progress bar during load
- Real-time row count and page statistics
- Average time per page calculation
- Cancel loading at any time

### 3. **Cross-Org Comparison**

Compare your change set components with another Salesforce org:

1. Click **"Compare with org"** button
2. Select environment (Sandbox or Production)
3. OAuth login to target org
4. View metadata comparison with color-coded differences:
   - 🟢 **Green**: Target org has newer version
   - Standard: Versions are the same

### 4. **Validation & Deployment**

From the Outbound Change Set Detail page:

- **Validate Deployment**: Run checkOnly=true deploy to validate
- **Quick Deploy**: Deploy previously validated change sets
- **Real-time Status**: Live deployment progress updates
- **Error Details**: View deployment errors and warnings
- **Cancel Deploy**: Stop running deployments

### 5. **Package Management**

- **Download as ZIP**: Export change set as Salesforce metadata package
- **Includes**: All components with proper package.xml structure
- **Uses**: Backup, version control, offline review

### 6. **Advanced Search & Filtering**

- **Name Search**: Filter by component name
- **Type Filter**: Dropdown to filter by metadata type
- **Folder Filter**: Filter folder-based components
- **Date Sorting**: Sort by last modified or creation date
- **Multi-column Sort**: Shift+click to sort by multiple columns

---

## 🚀 Installation

### From Source (Developer Mode)

1. **Clone or Download** this repository:
   ```bash
   git clone <repository-url>
   cd change-set-helper-ext
   ```

2. **Open Chrome Extensions Page**:
   ```
   chrome://extensions/
   ```

3. **Enable Developer Mode**:
   - Toggle the switch in the top-right corner

4. **Load Unpacked Extension**:
   - Click "Load unpacked"
   - Select the **root directory** of this project (where `manifest.json` is located)

5. **Verify Installation**:
   - Extension icon should appear in Chrome toolbar
   - Navigate to a Salesforce change set page to test

### Salesforce Configuration

**No longer required as of v3.0.3.** The extension reads the Salesforce session via the Chrome `cookies` permission, which works whether or not **Require HttpOnly attribute** is enabled in Session Settings. If you previously unchecked it for this extension and don't need it off for any other reason, you can safely re-enable it.

If your org blocks the extension from the `cookies` permission, the old fallback still works:

1. Go to **Setup** → **Session Settings**
2. Find **"Require HttpOnly attribute"**
3. **Uncheck** this option
4. Click **Save**

> ⚠️ **Security Note**: Unchecking this option allows JavaScript to access cookies. Only do this in development/sandbox environments or if you understand the security implications.

---

## 📖 Usage

### Viewing Enhanced Change Sets

1. **Navigate** to a change set in Salesforce:
   - Setup → Outbound Change Sets → Select a change set
   - Click "Add" to add components

2. **Enhanced Table Appears**:
   - Additional metadata columns automatically added
   - Search boxes in column footers
   - Sorting enabled on all columns

3. **For Large Datasets** (>1,000 components):
   - Confirmation prompt appears
   - Click **OK** to load all pages
   - Table appears in 2-3 seconds with first 1,000 rows
   - Additional rows load in background
   - Progress modal shows status

### Comparing with Another Org

1. Click **"Compare with org"** button
2. Select **Sandbox** or **Prod/Dev**
3. **OAuth Login** popup appears
4. Log into target Salesforce org
5. Wait for comparison to complete
6. Review differences (newer versions highlighted in green)

### Validating a Change Set

From the **Outbound Change Set Detail** page:

1. Configure validation options (test level, tests to run, etc.)
2. Click **"Validate"** button
3. Watch real-time progress
4. Review validation results
5. Use **"Quick Deploy"** if validation succeeded

### Downloading a Change Set

1. Navigate to **Outbound Change Set Detail** page
2. Click **"Download as ZIP"** button
3. Wait for package retrieval
4. ZIP file downloads automatically

---

## 🔧 Technical Details

### Project Structure

The extension uses a **flat directory structure** for simplicity and performance:

```
change-set-helper-ext/
├── manifest.json              # Manifest V3 configuration
├── background.js              # Service worker
├── offscreen.js               # JSforce operations handler
├── offscreen.html             # Offscreen document wrapper
├── changeset.js               # Main change set page enhancement (33KB)
├── changeview.js              # Package view page handler
├── deployhelper.js            # Validation & deployment UI
├── metadatahelper.js          # Package download functionality
├── common.js                  # Shared utilities
├── compare.js                 # Cross-org comparison logic
├── compare.html               # Comparison modal template
├── options.html               # Settings page
├── options.js                 # Settings logic
├── popup.html                 # Extension popup
├── changeset.css              # Main stylesheet
├── lib/                       # External libraries
│   ├── jquery.min.js
│   ├── jquery.dataTables.js
│   ├── jsforce.js             # Salesforce API client
│   ├── moment.js              # Date handling
│   ├── jszip.js               # ZIP operations
│   ├── codemirror.js          # Code editor
│   ├── mergely.js             # Diff viewer
│   └── [other libraries...]
├── *.png                      # Icons and screenshots
├── loading.gif                # Loading animation
└── README.md                  # This file

```

### Architecture

#### Manifest V3 Chrome Extension
- **Service Worker** (`background.js`): Non-persistent background script for OAuth and API proxying
- **Offscreen Document** (`offscreen.js`): Isolated context for JSforce operations (requires XMLHttpRequest)
- **Content Scripts**: Inject UI enhancements into Salesforce pages

**Why Flat Structure?**
- ✅ Faster browser loading (no nested path resolution)
- ✅ Simpler manifest.json references
- ✅ Easier debugging and testing
- ✅ Standard Chrome extension pattern

#### Three Injection Points

1. **Change Set Add Page** (`changeset.js`):
   - Enhanced component listing with DataTables
   - Metadata fetching (last modified date, modified by)
   - Cross-org comparison functionality
   - Progressive loading with pagination

2. **Package View Page** (`changeview.js`):
   - Read-only view with DataTables filtering
   - Simplified version of changeset.js

3. **Outbound Change Set Detail** (`deployhelper.js`, `metadatahelper.js`):
   - Deployment validation and quick deploy
   - Metadata package download

### Key Libraries

- **JSforce v1.x**: Salesforce API client
- **jQuery + DataTables**: Table enhancement and management
- **Moment.js**: Date formatting and manipulation
- **JSZip + FileSaver**: Package download functionality
- **CodeMirror + Mergely**: Code comparison and diff viewing

### Communication Flow

```
Content Script → chrome.runtime.sendMessage() → Service Worker
                                                      ↓
                                              Offscreen Document
                                                      ↓
                                                  JSforce API
                                                      ↓
                                              Salesforce Metadata API
```

### API Version

- Default: `60.0`
- Configurable via extension options
- Must match pattern `XX.0` (e.g., `48.0`, `55.0`, `60.0`)

---

## ⚡ Performance Optimizations

### Progressive Table Loading (v3.0.1+)

**Problem**: Loading 50,000+ row change sets would freeze the browser for 2-3 minutes.

**Solution**:
- Initialize DataTable with first 1,000 rows immediately
- Load additional pages asynchronously in background
- Add new rows incrementally to existing table
- Batch DOM updates every 5 pages for optimal performance

**Result**:
- Table appears in **2-3 seconds** instead of 2-3 minutes
- Browser remains responsive throughout loading
- Users can search/filter immediately with partial data
- No freezing regardless of dataset size

### Smart Pagination

**Automatic Threshold**: Pagination automatically enabled at **1,500 rows**

**Benefits**:
- Only renders 100 visible rows in DOM at a time
- Dramatically reduces memory usage
- Instant page switching with deferred rendering
- Search/filter still works across ALL rows

**Performance Comparison**:

| Rows | Without Pagination | With Pagination |
|------|-------------------|-----------------|
| 1,500 | ~2 seconds | ~1 second |
| 10,000 | ~8 seconds | ~2 seconds |
| 50,000 | ~120 seconds (freeze) | ~3 seconds (no freeze) |
| 100,000 | Browser crash | ~5 seconds |

### Async Pagination Loading

- Non-blocking AJAX requests (no browser freeze)
- 50ms delay between pages for UI responsiveness
- Animated progress indicator with real-time statistics
- Cancelable at any time

### Memory Efficiency

- **Deferred Rendering**: Rows created on-demand
- **Pagination**: Limits DOM nodes to ~100 per page
- **Incremental Updates**: Batched every 5 pages
- **Result**: 100k rows uses ~150KB visible memory instead of ~150MB

---

## 📋 Requirements

### Browser
- Google Chrome (or Chromium-based browsers)
- Version 88+ (Manifest V3 support required)

### Salesforce
- Salesforce Classic or Lightning Experience
- Session ID access enabled (HttpOnly attribute disabled)
- Change Set feature enabled in org
- Metadata API access

### Permissions

The extension requires these Chrome permissions:

- **`identity`**: OAuth authentication for cross-org comparison
- **`storage`**: Save user preferences and API version settings
- **`offscreen`**: Create offscreen document for JSforce operations
- **`host_permissions`**: Access Salesforce domains for metadata operations

---

## 👏 Credits

### Original Author

**Susan Bohme**
Email: [brainfield.initiative@gmail.com](mailto:brainfield.initiative@gmail.com)

Susan created the original **Salesforce Change Set Helper** extension that provided the foundation for this project. Her innovative work in enhancing the Salesforce change set experience has helped countless Salesforce administrators and developers work more efficiently.

### Current Maintainers

This "Reloaded" version includes significant performance improvements, Manifest V3 migration, and new features built upon Susan's original work.

### Contributors

We welcome contributions! See the [Contributing](#contributing) section below.

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

### Reporting Issues

1. Check existing issues to avoid duplicates
2. Include Chrome version, Salesforce org type, and error messages
3. Provide steps to reproduce the issue
4. Include screenshots if applicable

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly in a Salesforce environment
5. Commit with clear messages (`git commit -m 'Add amazing feature'`)
6. Push to your branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development Setup

```bash
# Clone the repository
git clone <repository-url>
cd change-set-helper-ext

# Load unpacked extension in Chrome
# Navigate to chrome://extensions/
# Enable Developer Mode
# Click "Load unpacked" and select the root directory

# Make changes to files (all in root directory)
# Click the refresh icon in chrome://extensions/ to reload

# Test in a Salesforce sandbox environment
```

### File Organization

All source files are in the **root directory** except for external libraries which are in `lib/`:

- **Extension Core**: `manifest.json`, `background.js`, `offscreen.js`
- **Content Scripts**: `changeset.js`, `changeview.js`, `deployhelper.js`, `metadatahelper.js`
- **UI Pages**: `options.html`, `popup.html`, `compare.html`
- **Utilities**: `common.js`, `compare.js`
- **Styling**: `changeset.css`
- **Assets**: `*.png`, `loading.gif`
- **Libraries**: `lib/*.js`, `lib/*.css`

### Code Style

- Use clear, descriptive variable names
- Comment complex logic
- Follow existing code patterns
- Test with datasets of varying sizes (100, 1000, 10000+ rows)

---

## 💡 Support

### Common Issues

#### Extension Not Loading
- Check that Developer Mode is enabled
- Verify the `code/` directory contains `manifest.json`
- Check for errors in `chrome://extensions/`

#### Session ID Not Accessible
- Go to Setup → Session Settings
- Uncheck "Require HttpOnly attribute"
- Refresh Salesforce page

#### OAuth Login Fails
- Check popup blocker settings
- Verify Salesforce Connected App is configured
- Try logout and login again

#### Table Not Loading
- Check browser console for errors (F12)
- Verify content script injected successfully
- Check Salesforce API version compatibility

### Getting Help
- **Issues**: Open an issue on the project repository

---

## 📄 License

This project builds upon the original work by Susan Bohme. Please respect the original author's contributions and provide appropriate attribution when using or modifying this code.

---

## 🔮 Roadmap

### Planned Features

- [ ] **Dependency Analysis**: Show component dependencies before deployment
- [ ] **Change History**: Track change set modifications over time
- [ ] **Bulk Operations**: Multi-select actions for components
- [ ] **Custom Filters**: Save and reuse filter configurations
- [ ] **Export Options**: Export to CSV, Excel, or JSON
- [ ] **Dark Mode**: Theme support for UI
- [ ] **Conflict Detection**: Warn about potential conflicts before deployment

### Performance Improvements

- [x] Progressive table loading (v3.0.1)
- [x] Automatic pagination for large datasets (v3.0.1)
- [x] Async pagination loading (v3.0.1)
- [x] Animated indeterminate progress bar (v3.0.1)
- [ ] IndexedDB caching for offline access
- [ ] Web Workers for metadata processing
- [ ] Virtualized scrolling for ultra-large datasets

---

## 📊 Version History

### v3.0.1 (Current)
- ✨ Progressive table loading - table appears in 2-3 seconds
- ✨ Smart pagination automatically enabled at 1,500 rows
- ✨ Async pagination with animated progress indicator
- ✨ Incremental row updates (no browser freeze)
- ✨ Batched DOM updates for optimal performance
- 🐛 Fixed setupTable() freeze with large datasets
- 🐛 Fixed pagination not enabling during progressive load
- 🔧 Reduced page load delay from 100ms to 50ms
- 🎨 Animated indeterminate progress bar

### v3.0.0
- 🚀 Migrated to Manifest V3
- 🔧 Offscreen document for JSforce operations
- 🔧 Service worker keepalive mechanism
- 🔧 Updated authentication flow

### v2.x
- Original release by Susan Bohme
- Core features: metadata display, comparison, validation

---

## 🙏 Acknowledgments

- **Susan Bohme** - Original creator and visionary
- **Salesforce Community** - Feature requests and feedback
- **JSforce Contributors** - Excellent Salesforce API library
- **DataTables** - Powerful table management library

---

<div align="center">

**Made with ❤️ by the Salesforce Community**

_Enhancing the Salesforce change set experience, one component at a time._

</div>
