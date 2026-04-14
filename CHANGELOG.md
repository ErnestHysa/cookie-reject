# Changelog

All notable changes to CookieReject will be documented in this file.

## [1.2.0] - 2026-04-14

### Fixed
- Race condition: detection could fire before settings loaded from background
- Cookiebot handler could accidentally click "Allow All" instead of saving rejection
- Handler detect() methods bypassed visibility check for window-global CMPs
- Time saved stat used total visits instead of unique sites (inflated numbers)
- innerHTML XSS risk in popup activity list and domain lists
- Import data now validated before storing (prevents corrupted stats)
- Stale data on tab switch -- Activity and Lists tabs now refresh on activation
- Generic handler's close button strategy was too broad (could close unrelated UI)

### Performance
- Added detection result cache (1s TTL) to avoid triple querySelector per CMP
- offsetParent fast-path in isVisible() avoids expensive getComputedStyle
- findAllByText() skips elements shorter than the shortest search pattern
- MutationObserver has explicit 35s safety timeout (prevents observer leaks)

### Added
- Shadow DOM piercing in generic banner detection
- registerHandler() pattern for cleaner CMP handler management
- Custom dark-themed confirm dialog for "Reset Stats"
- "Load More" button in activity log (pagination)
- Vendors unticked count shown in activity log entries
- Better messaging on restricted pages (chrome://, about:)
- Off-screen element detection in isVisible()
- Automatic error handling wrapper in registerHandler()

### Changed
- All magic numbers moved to CONFIG object
- Removed dead CONFIG entry (avgTimeSavedPerSite)
- Sourcepoint handler: removed dead cross-origin iframe code
- Polyfill logic reconciled between browser-polyfill.js and background.js
- Duplicate CSS selector removed from generic detection

## [1.1.0] - 2026-04-12

### Added
- Cross-browser support (Chrome, Firefox, Edge, Safari)
- Data migration system for version upgrades
- Unique domain tracking
- Import/Export system for backup and restore
- Debug mode toggle (console logging)
- Keyboard shortcut (Alt+Shift+R) for manual reject
- Smart popup polling (stops after 30s or when page reaches final state)
- Toast notification system
- 4-tab popup layout (Dashboard, Activity, Lists, Settings)
- MIT License and CONTRIBUTING.md
- Version centralized in manifest.json

### Fixed
- MutationObserver retry starvation
- Custom cookie overlays + multilingual text matching + Shadow DOM
- Auto-detection reliability improvements
- False positive rejection (three-layer defense)
- Hidden banner false positive (visibility check)

## [1.0.0] - 2026-04-10

### Added
- Initial release
- 16 CMP handler frameworks (OneTrust, Fides, Ketch, Cookiebot, Didomi, Sourcepoint, TrustArc, Quantcast, Usercentrics, CookieYes, Iubenda, ConsentManager, Sirdata, Ezoic, Borlabs, LGCookiesLaw)
- Generic fallback detection with multilingual text matching
- TCF/USP/GPP API rejection
- Whitelist and blacklist management
- Statistics tracking
- Activity log
- Dark-themed popup UI
