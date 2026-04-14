# Changelog

All notable changes to CookieReject will be documented in this file.

## [1.3.0] - 2026-04-14

### Fixed
- Duplicated primarySelectors map between isCMPBannerVisible() and isBannerStillVisible() extracted to shared constant
- Detection cache not invalidated on handler failure (stale cache could delay retries)
- Shadow DOM scan iterated ALL elements on every detection -- now caches known hosts
- CookieYes handler could use "Accept" button as save button -- now prefers reject/save buttons
- False-positive warning now reports which CSS selector is still visible for easier debugging
- Import validation allowed string values in numeric stat fields
- Clear Log button had no confirmation (Reset Stats did, but Clear didn't)
- Log entry IDs used Date.now() + 4 random chars -- now uses monotonic counter for guaranteed uniqueness

### Performance
- isVisible() adds cheap inline `display:none` check before expensive getComputedStyle
- Generic handler reject texts now batched into single DOM pass (was 60+ individual scans)
- Badge updates debounced (500ms) to avoid storage reads on every tab completion
- Shadow DOM host elements cached after first scan

### Architecture
- Settings changes now propagate live to already-loaded content scripts (no page reload needed)
- Mouse clicks use dispatchEvent(new MouseEvent) for more realistic click simulation
- Guard global renamed to unique `__cookieReject_ext_v1x2x0` to avoid conflicts

### UX/UI
- Confirm modal now closes on Escape key and overlay background click
- Activity log has search/filter input for finding specific domains
- Tab bar has keyboard navigation (arrow keys) and ARIA attributes
- Status indicator more prominent with colored text matching state
- Toast z-index raised above modal overlay
- Popup body has max-width safety net

### Docs
- Test file notes that utility functions are duplicated (not imported) and must be kept in sync

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
