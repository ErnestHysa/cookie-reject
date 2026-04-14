# Changelog

All notable changes to CookieReject will be documented in this file.

## [1.5.0] - 2026-04-14

### Fixed (CRITICAL)
- #1: `const _storageQueue` caused TypeError in strict mode, silently breaking ALL stats, logging, and domain tracking since v1.4.0. Changed to `let`.

### Fixed (HIGH)
- #2: ListManager addEntry/removeEntry not serialized -- wrapped with storage queue to prevent TOCTOU race conditions
- #3: `_detecting` flag could permanently stick if exception occurred in detectAndReject -- wrapped in try/finally
- #4: Observer callback called handleCMP without await, causing concurrent double-rejections -- added `_handling` re-entry guard with try/finally
- #5: whitelistBtn retained stale "Remove from Whitelist" label when switching to non-whitelisted site -- now resets on each load
- #6: TCF addEventListener listener leaked on failure -- removeEventListener now always called; added double-resolve protection

### Fixed (MEDIUM)
- #7: intervalId not cleared when settings/whitelist disables engine early -- added cleanup in both early-return paths
- #8: Shadow host cache never refreshed for dynamic pages -- added 5-second TTL invalidation
- #9: Utils.click() didn't check element visibility before clicking -- added isVisible() guard
- #10: getDomain() returned empty string for file:// URLs -- returns full href for non-HTTP protocols
- #11: findByText partial matching could click wrong elements -- added consent-context verification via closest()
- #12: BannerHider scroll-lock selector too broad -- narrowed to specific overlay/banner class patterns
- #13: Guard property accumulated across extension updates -- cleanup loop removes old __cookieReject_* properties
- #14: StatsManager.increment returned undefined on failure -- now returns current stats as fallback

### Fixed (LOW)
- #15: LogManager._idCounter reset on service worker restart -- initialized from stored log length
- #16: Removed conflicting word-break:break-all from .activity-domain CSS (was dead code vs nowrap+ellipsis)
- #17: StatsManager.get() double-merged defaults -- simplified to single Storage.get with defaults
- #18: Test file sync checklist added -- lists specific functions and their source locations
- #19: pollInterval not nulled after clearInterval -- added null assignment
- #21: Added top-level try/catch in content.js IIFE for fatal error logging

Bumped version: 1.4.0 -> 1.5.0

## [1.4.0] - 2026-04-14

### Fixed (HIGH)
- #1: FORCE_REJECT leaked MutationObserver + interval on repeated clicks (resource leak, double-processing)
- #2: Import silently discarded all whitelist/blacklist entries (field name mismatch: timestamp vs addedAt)
- #3: Unhandled promise rejection in message handler left message channel open indefinitely

### Fixed (MEDIUM)
- #4: Whitelist check raced with detection -- banner could be rejected on whitelisted sites under slow storage
- #5: detectAndReject() had no re-entry guard -- concurrent calls created unbounded observers/intervals
- #6: Read-modify-write race conditions in StatsManager, LogManager, UniqueDomainTracker (serialized with queue)
- #7: Version sentinel hardcoded to v1.2.0 -- now reads dynamically from manifest
- #8: TCF/GPP API rejection used non-standard commands (always failed silently) -- rewritten with spec-compliant calls
- #9: Generic handler scanned ALL divs/spans on page (thousands) -- now only checks button and a elements
- #10: Generic handler mutated DOM elements with _len expando property -- uses clean local variables now
- #11: Activity item HTML template duplicated in two places -- extracted to shared renderActivityItems() helper
- #12: vendorsUnticked not escaped with escapeHTML() in activity template -- now wrapped with escapeHTML(String(...))
- #13: No CSS for disabled buttons -- added opacity, cursor, pointer-events styles

### Fixed (LOW)
- #14: Math.min() on empty array in findAllByText -- added early return guard
- #15: Shadow DOM host cache never refreshed for dynamic pages -- invalidated on observer callback
- #16: BannerHider removed body scroll lock unconditionally -- now only acts when cookie overlay exists
- #17: Initialization was fire-and-forget -- added .catch() error handling
- #18: extractBaseDomain didn't handle IP addresses or localhost -- returns as-is now
- #19: removeEntry returned true unconditionally -- now returns false if nothing was removed
- #20: Utils.click() ignored dispatchEvent return value -- now returns the actual result
- #21: Cookiebot dialog variable used outside null check -- re-queries element as fallback
- #22: Confirm modal had no focus trap -- Tab/Shift+Tab now cycles within modal buttons
- #23: Missing .activity-search CSS class -- added margin-bottom
- #24: No debounce on activity search input -- added 150ms debounce
- #25: Redundant polyfill guard in popup.js removed (browser-polyfill.js already loaded)
- #26: Tab panels missing ARIA role="tabpanel" and aria-labelledby -- added to all 4 panels
- #27: Activity search input missing aria-label -- added descriptive label
- #28: loadActivity() always cleared search text on refresh -- removed, filter now persists
- #29: Toast z-index (300) above modal (200) -- modal raised to z-index 400
- #30: No :focus-visible styles for keyboard navigation -- added outline and box-shadow indicators
- #31: delete on dataset property -- replaced with removeAttribute('data-action')

Bumped version: 1.3.0 -> 1.4.0

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
