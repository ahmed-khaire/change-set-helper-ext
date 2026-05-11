# Project Restructure Updates

> Historical note: this document describes an older flat-root restructure. The current extension layout keeps `manifest.json` in the root and groups implementation files under `js/`, `css/`, `pages/`, and `assets/`.

## Summary

The project documentation has been updated to reflect the **flat directory structure** where all source files are in the root directory (no `code/` subdirectory).

---

## Changes Made

### 1. README.md Updates

#### ✅ Installation Section
**Changed:**
- ~~`Select the code/ directory from this project`~~

**To:**
- `Select the root directory of this project (where manifest.json is located)`

#### ✅ Added Project Structure Section
Added a complete visual directory tree showing:
```
change-set-helper-ext/
├── manifest.json              # Manifest V3 configuration
├── background.js              # Service worker
├── offscreen.js               # JSforce operations handler
├── changeset.js               # Main change set page enhancement (33KB)
├── changeview.js              # Package view page handler
├── deployhelper.js            # Validation & deployment UI
├── metadatahelper.js          # Package download functionality
├── common.js                  # Shared utilities
├── compare.js                 # Cross-org comparison logic
├── lib/                       # External libraries
│   ├── jquery.min.js
│   ├── jquery.dataTables.js
│   ├── jsforce.js             # Salesforce API client
│   └── [other libraries...]
├── *.png                      # Icons and screenshots
├── loading.gif                # Loading animation
├── README.md                  # This file
└── CLAUDE.md                  # Development guidelines
```

#### ✅ Added "Why Flat Structure?" Section
Explained benefits:
- Faster browser loading (no nested path resolution)
- Simpler manifest.json references
- Easier debugging and testing
- Standard Chrome extension pattern

#### ✅ Updated Development Setup
**Changed:**
- ~~`Click "Load unpacked" and select the code/ directory`~~
- ~~`Make changes to files in code/`~~

**To:**
- `Click "Load unpacked" and select the root directory`
- `Make changes to files (all in root directory)`

#### ✅ Added File Organization Section
Clear breakdown of where different file types are located:
- **Extension Core**: `manifest.json`, `background.js`, `offscreen.js`
- **Content Scripts**: `changeset.js`, `changeview.js`, `deployhelper.js`, `metadatahelper.js`
- **UI Pages**: `options.html`, `popup.html`, `compare.html`
- **Utilities**: `common.js`, `compare.js`
- **Styling**: `changeset.css`
- **Assets**: `*.png`, `loading.gif`
- **Libraries**: `lib/*.js`, `lib/*.css`

---

### 2. CLAUDE.md Updates

#### ✅ Updated Version Number
- Changed from version 3.0.0 → **3.0.1**
- Updated name to "Salesforce Change Set Helper **Reloaded**"

#### ✅ Added Project Structure Section
Added complete directory tree showing the flat structure with file purposes

#### ✅ Updated References
**Changed all instances of:**
- ~~`code/lib/`~~ → `lib/`
- ~~`Load unpacked extension from code/ directory`~~ → `Load unpacked extension from root directory`
- ~~`code/changeset.js:6-57`~~ → `changeset.js:6-57`
- ~~`code/background.js:30`~~ → `background.js:24`

#### ✅ Updated Testing Instructions
- Clarified to load from **root directory** where `manifest.json` is located
- Updated terminology from "background page" to "service worker"

---

## Project Structure Overview

### Current Structure (Flat)

```
change-set-helper-ext/
├── manifest.json              # Entry point
├── background.js              # Service worker (17KB)
├── offscreen.js               # JSforce handler (11KB)
├── offscreen.html             # Offscreen wrapper
├── changeset.js               # Main UI enhancement (33KB)
├── changeview.js              # Read-only view (1.8KB)
├── deployhelper.js            # Deployment UI (7.5KB)
├── metadatahelper.js          # Package download (3KB)
├── common.js                  # Utilities (134B)
├── compare.js                 # Cross-org compare (1.6KB)
├── compare.html               # Compare modal
├── options.html/js            # Settings page
├── popup.html                 # Extension popup
├── changeset.css              # Main styles (787B)
├── lib/                       # External libraries (~4.6MB)
│   ├── jquery.min.js
│   ├── jquery.dataTables.js
│   ├── jsforce.js
│   ├── moment.js
│   ├── jszip.js
│   ├── codemirror.js
│   ├── mergely.js
│   └── [20+ more library files]
├── brainbulb128.png           # Extension icon
├── brainbulb48.png            # Extension icon
├── loading.gif                # Loading animation
├── screenshot*.png            # Documentation
├── README.md                  # User documentation
├── CLAUDE.md                  # Development guide
└── .gitignore                 # Git configuration
```

### Key Facts

- **Total Files**: 65+ files
- **Library Size**: ~4.6MB (in `lib/` subdirectory)
- **Source Code**: ~60KB (in root directory)
- **Assets**: ~550KB (icons, screenshots)
- **Documentation**: ~24KB (README, CLAUDE.md)

### Benefits of Flat Structure

1. **Simplicity**: No nested directories to navigate
2. **Performance**: Chrome loads files faster without path resolution
3. **Manifest References**: All paths are simple (no `../` or complex paths)
4. **Debugging**: Easier to find files in DevTools
5. **Standard Pattern**: Follows Chrome extension best practices

---

## Installation Quick Reference

### For Users

```bash
# Clone the repository
git clone <repository-url>
cd change-set-helper-ext

# Open Chrome extensions
chrome://extensions/

# Enable Developer Mode
# Click "Load unpacked"
# Select the ROOT DIRECTORY (where manifest.json is)
```

### For Developers

```bash
# Clone and navigate
cd change-set-helper-ext

# All source files are in root directory
ls -la *.js *.html *.css

# Libraries are in lib/
ls -la lib/

# Make changes directly to root files
vim changeset.js

# Reload in Chrome
# Go to chrome://extensions/ and click refresh icon
```

---

## Verification Checklist

After these updates, verify:

- [ ] README.md has no references to `code/` directory
- [ ] CLAUDE.md has no references to `code/` directory
- [ ] Installation instructions point to root directory
- [ ] File paths in links are relative to root (e.g., `changeset.js` not `code/changeset.js`)
- [ ] Project structure diagrams match actual layout
- [ ] Version numbers are consistent (3.0.1)

---

## Files Modified

1. ✅ **README.md** (16KB)
   - Updated installation instructions
   - Added project structure section
   - Updated development setup
   - Added file organization section
   - Added "Why Flat Structure?" explanation

2. ✅ **CLAUDE.md** (8KB+)
   - Updated version to 3.0.1
   - Added project structure section
   - Updated all `code/` references
   - Updated testing instructions
   - Clarified service worker terminology

3. ✅ **RESTRUCTURE_UPDATES.md** (This file)
   - Documentation of all changes made

---

## Next Steps

### For Maintenance

1. Always refer to files by root path (e.g., `changeset.js` not `code/changeset.js`)
2. When adding new files, place in root directory (or `lib/` if external library)
3. Update manifest.json with root-relative paths
4. Keep documentation in sync with actual structure

### For New Features

1. Create new `.js` files in root directory
2. Create new `.html` pages in root directory
3. Add external libraries to `lib/` subdirectory
4. Update manifest.json content_scripts or background as needed

### For Publishing

1. Create a ZIP of the root directory
2. Include all files except:
   - `.git/`
   - `.claude/`
   - `RESTRUCTURE_UPDATES.md` (this file)
   - `CLAUDE.md` (optional, for development only)
   - `*.iml` (IntelliJ project file)

---

## Questions?

If you notice any remaining references to `code/` directory or incorrect paths, please update:

1. Search project for `code/` string
2. Replace with root-relative path
3. Update this document with changes made

---

**Last Updated**: 2025-01-XX
**Version**: 3.0.1
**Structure**: Flat (root directory + lib/ subdirectory)
