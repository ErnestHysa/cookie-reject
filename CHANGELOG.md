# Changelog

All notable changes to CookieReject will be documented in this file.

## [2.1.0] - 2025-04-17

### Fixed
- Fixed SPA navigation cleanup not clearing Engine.intervalId (BUG-1)
- Fixed shadow DOM scan in detectGeneric() using individual selectors instead of `:is()` batches (BUG-2)
- Added missing detectCheck opts for consentmanager and lgcookieslaw handlers
- Fixed ListManager reading from local storage instead of SyncStorage (CQ-5)
- Fixed misleading vendor toggle delay comment (ROB-3)

### Added
- **Smart Observer Scanning**: Top 5 most common CMPs checked first on MutationObserver ticks, full scan only as fallback (PERF-2)
- **Shadow Root Cache**: WeakMap cache for shadow DOM scanning to avoid re-scanning known elements (PERF-3)
- **Narrowed findAllByText**: Default tag parameter changed from '*' to interactive elements only (PERF-1)
- **Interruptible Scroll**: scrollToLoadAll now accepts an AbortSignal and capped at 30 iterations (ROB-4)
- **Banner Re-check Delay**: 500ms delay before verifying banner visibility after rejection (ROB-1)
- **JSDoc on all 47 handlers**: Each handler now has documentation describing strategy and targets (CQ-4)
- **Handler Wait Delay Config**: New `handlerWaitDelay` and `topCMPs` CONFIG entries (CQ-3)
- **Import Size Limit**: 5MB max on imported JSON data (SEC-2)
- **Remote Rules Validation**: Fetched rules are validated for correct structure before storage (SEC-3)
- **Blacklist Button**: Added blacklist current-site button in popup dashboard (UX-1)
- **Today's Stats**: Shows today's rejection count below the stats grid (UX-2)
- **Scanning Message**: Improved scanning status message (UX-3)
- **Search Feedback**: Activity search shows search term when no matches found (UX-4)
- **Undo Toast**: Whitelist/blacklist additions show undo toast (UX-5)
- **Dark/Light Theme**: Theme toggle button in popup header, persisted via storage (FEAT-7)
- **CSV Export**: Export activity log as CSV file (FEAT-3)
- **Failed Rejection Tracking**: New LOG_FAILED_REJECTION message handler (FEAT-2)
- **Google Consent Mode**: Injects gtag consent denial via scripting API (FEAT-6)
- **Per-Site CMP Override**: Override which handler is used for a specific domain (FEAT-1)
- **Dry Run Mode**: New setting to detect but not reject banners (FEAT-4)
- **Report Undetected Banner**: Link to pre-filled GitHub issue (FEAT-5)
- **Unified Polyfill**: browser-polyfill.js now matches background.js inline polyfill (ARCH-3)
- **Remote Rules Placeholder**: rules.json created for future remote rule updates (ARCH-4)
- **Shared Search Filter**: Extracted filterActivityEntries() to deduplicate popup.js logic (CQ-1)
- **Integration Test Framework**: Puppeteer-based test structure (TEST-3)

### Changed
- Content.js confidence scoring added to CMPDetector.detect() results
- Badge update timer and tab state persistence improvements
- Multiple handler functions now use HandlerHelpers.standardReject()

### Removed
- Empty `assets/` directory (ARCH-2)

## [2.0.0] - 2026-04-15

### Major Changes
- **Architecture: Single-source handler registration** -- registerHandler() now
  auto-populates CMPDetector and _primarySelectors via opts parameter. Adding
  a new CMP handler only requires updating ONE place instead of THREE. This
  eliminates the class of bugs found in R9-R11 where detection fell out of sync.
- **Cross-device sync** -- Settings, whitelist, and blacklist now sync across
  devices via chrome.storage.sync (with local fallback for Safari/unsupported).
- **Iframe consent banner detection** -- content.js now runs in all_frames.
  CMP-hosting iframes (Sourcepoint, TrustArc, Cookiebot, Quantcast) get a
  lightweight rejection scan. Major publisher coverage improved.
- **SPA navigation support** -- Engine resets and re-scans on pushState,
  replaceState, popstate, and hashchange events. Single-page apps no longer
  leave the extension inert after route changes.
- **Multi-step wizard support** -- Generic handler now advances through
  consent wizard steps by clicking "Next"/"Continue" buttons (6 languages),
  unticking toggles at each step, up to 5 steps.

### Bug Fixes
- **#1: Blacklist feature was completely non-functional** -- content.js only
  checked whitelist; blacklist was returned by background.js but never acted
  on. Blacklisted sites now force-run regardless of auto-reject setting.
- **#2: Usercentrics closed shadow root fail** -- UC_UI.rejectAll() API is now
  tried FIRST (works regardless of shadow root mode), DOM path is fallback.

### Robustness
- **#3: Sourcepoint iframe banners** -- Lightweight rejection for CMP iframes.
- **#4: SPA navigation** -- Engine resets on History API changes.
- **#5: Standard TCF v2** -- Added standard addEventListener fallback alongside
  non-standard rejectAll call for broader CMP compatibility.
- **#6: #ccc selector false positive** -- Beautiful Cookie Consent detector now
  requires contextual child elements (button, cookie class, wrapper).
- **#7: CookieControl false positive** -- CIVIC handler requires DOM context
  alongside window.CookieControl global.
- **#8: Admiral detector tightening** -- Requires banner/consent/privacy context
  in class, not just "admiral" substring.

### Performance
- **#9: Shadow DOM scan** -- Replaced querySelectorAll('*') with TreeWalker
  for 2-3x faster traversal on large DOMs.
- **#10: findAllByText caching** -- Button/link query cached for 2 seconds to
  avoid repeated full-DOM scans within a single detection cycle.
- **#11: Detector array optimized** -- Replaced hardcoded 48-entry array with
  auto-registered entries from registerHandler().

### UX
- **#12: Per-site activity view** -- Dashboard "Current Site" card now shows
  CMP detected, vendors unticked, and last action time.
- **#13: Time Saved metric** -- Fixed from 47s/site to realistic 8s/site.
  Label changed to "Time Saved (est.)".
- **#14: Per-tab icon state** -- Badge color: green = cookies rejected, gray =
  no banner detected. Tab state cleaned up on tab close.

### Gaps Addressed
- **#15: Auto-update foundation** -- Background script checks GitHub releases
  API daily. Ready for future remote handler rule updates.
- **#16: Cross-device sync** -- SyncStorage layer for settings/lists.
- **#17: Iframe banner detection** -- all_frames in manifest + CMP iframe logic.
- **#18: Multi-step wizards** -- Next/Continue button advancement in generic.

### Architecture
- **#19: Monolith navigation** -- Added 20-line table of contents to content.js
  header for developer orientation.
- **#20: Triple detection consolidation** -- registerHandler() with opts
  eliminates 3-place duplication (was root cause of R9-R11 bugs).
- **#21: Dead code removal** -- Utils.click() (never called) removed.
- **#23: Generic detection tightening** -- CCPA/optout selectors now require
  compound class match (e.g. ccpa+banner) to reduce false positives.

Bumped version: 1.9.0 -> 2.0.0

## [1.9.0] - 2026-04-15

### Fixed (MEDIUM)
- #1: LGCookiesLaw handler detect() was missing `[class*="lgcookieslaw"]`
  selector that CMPDetector.detect() uses. Pages matching only the broad
  selector failed handler re-verification, leaving banners unrejected.

### Fixed (LOW)
- #2: OneTrust toggle selector `input.ot-handler-toneop` was a typo -- should
  be `input.ot-handler-toggle`. Vendor/purpose toggles using only this class
  were never found.
- #3: Utils.isVisible() early `offsetParent !== null` return skipped
  visibility:hidden and opacity:0 checks. Reordered to check
  display/visibility/opacity first, then offsetParent as a fast path.
  Correctly identifies visibility:hidden elements as invisible now.
- #4: isCMPBannerVisible() returned true for window-global-only detections
  (Admiral, Securiti, Transcend) with no DOM banner present, causing 30s
  of wasted retry cycles. Now returns false when no banner element exists.
- #5: Ketch handler detect() missing `window.ketchConsent` -- aligned with
  CMPDetector entry so window-global detection path passes verification.
- #6: OneTrust handler detect() missing `window.OptanonActiveGroups` --
  aligned with CMPDetector entry for consistent detection.

Bumped version: 1.8.2 -> 1.9.0

## [1.8.2] - 2026-04-15

### Fixed (CRITICAL)
- #C1: AppConsent handler crashed on every invocation -- missing `let rejected = 0`
  declaration caused ReferenceError. Handler was completely non-functional.
- #C2: 19 of 31 new handlers clicked reject buttons but never recorded success.
  `if (rejectBtn) rejectBtn.click();` pattern had no `rejected++`, so stats,
  activity log, and popup status were never updated. Engine also wasted 30s
  running detection on a page where the banner was already gone.

### Fixed (HIGH)
- #H1: Moove GDPR infobar early return -- clicked button without incrementing
  `rejected`, so the return always reported rejected=0.
- #H2: Complianz manage-settings path -- saveBtn.click() fired without
  incrementing `rejected`.
- #H3: Beautiful Cookie Consent toggle-save path -- same as H2.

### Fixed (MEDIUM)
- #M1: CookieScript handler used `window.cookieconsent` global which is shared
  by many unrelated cookie libraries. Removed to prevent false handler
  attribution.
- #M2: Detection selector asymmetry -- Fides (missing #fides-modal) and
  ConsentManager (missing .cmpbox[role="dialog"], [class*="cmpbox"],
  window.__cmp) had fewer selectors in CMPDetector.detect() than in their
  registerHandler() detect(). Pages using only those selectors were never
  detected. Now aligned.
- #M3: README updated -- 16+ -> 47+ CMP frameworks, 6 -> 18 languages,
  added all 31 new CMPs to supported table, added CCPA feature.
- #M4: Consentmo detector used bare `#cookie-consent-banner` which is an
  extremely generic ID used by many CMS plugins. Tightened to
  `#cookie-consent-banner.consentmo` and `#cookie-consent-banner[data-consentmo]`
  to avoid false detection attribution.

Bumped version: 1.8.1 -> 1.8.2

## [1.8.1] - 2026-04-15

### Fixed (HIGH)
- #1: 31 new CMP handlers were dead code -- CMPDetector.detect() never included
  them in its detection array. All 31 now wired up with proper check functions
  matching their registerHandler() detection selectors.

### Fixed (MEDIUM)
- #2: All 31 new handlers omitted `rejected` from return value, breaking
  stats/logging and retry behavior. Added `let rejected = 0`, `rejected++`
  on button clicks, and `{ rejected, vendorsUnticked }` returns.

### Fixed (LOW)
- #3: `_primarySelectors` map missing for 31 new handlers -- banner visibility
  checks now work correctly for all new CMPs.
- #4: `untickAllToggles` essential-category skip used loose `includes()` matching
  that could false-positive on "unnecessary" or vendor names containing
  "essential". Replaced with word-boundary regex.
- #5: Removed duplicate entries in bannerIndicators and rejectTexts.
- #6: Popup footer updated from "16+" to "47+" CMP frameworks.

Bumped version: 1.8.0 -> 1.8.1

## [1.8.0] - 2026-04-15

### Added -- 31 New CMP Handlers (16 -> 47 + generic)

**Tier 1 -- Major install base:**
- Complianz (1M+ WordPress installs)
- Cookie Notice / Humanityco (900K+ WordPress installs)
- Osano (100K+ websites globally)
- Termly (100K+ WordPress installs)
- Cookie Information (100K+ sites, Nordic market leader)
- Real Cookie Banner / devowl.io (100K+ WordPress installs)

**WordPress plugins:**
- Moove GDPR Cookie Compliance (300K+ installs)
- CookieAdmin (300K+ installs)
- Beautiful Cookie Consent Banner (40K+ installs)
- Pressidium Cookie Consent (10K+ installs)
- WPLP Cookie Consent (20K+ installs)

**Tier 2 -- Significant market share:**
- Axeptio (popular French CMP)
- Admiral (10K+ publisher sites)
- Commanders Act / TagCommander (French tag+CMP platform)
- CookieFirst (growing EU CMP)
- CookieHub (20K+ sites)
- Gravito (UK/EU CMP)

**Tier 3 -- Niche/regional CMPs:**
- TRUENDO, Clickio, AppConsent/SFBX, Cloudflare, Securiti,
  Transcend, CIVIC Cookie Control, FastCMP, Lawwwing (Spanish),
  AVACY (Italian), Consentmo, Pandectes, Enzuzo, Cookie Script

### Added -- Generic Handler Improvements

**12 new languages for reject/preferences/save text matching:**
- Portuguese, Polish, Czech, Swedish, Danish, Romanian,
  Hungarian, Japanese, Korean, Chinese, Turkish, Russian
- Coverage expanded from 6 to 18 languages

**CCPA / "Do Not Sell" support:**
- New reject patterns: "do not sell my personal information",
  "limit the use of my data", "opt out of sale/sharing",
  Spanish-language CCPA patterns
- New detection selectors for CCPA banners and opt-out overlays

**Better vendor toggle handling:**
- untickAllToggles now skips "strictly necessary" / "essential"
  labeled toggles (prevents unticking required categories)
- Expanded toggle selectors for more CMP frameworks
  (cmplz-toggle, moove-gdpr-form, consent-toggle, etc.)
- Custom toggle switches now match more patterns:
  button/a[role="switch"], data-role="switch",
  legitimate-interest toggles
- New banner detection selectors: 30+ additional CSS patterns
  for cookie bars, CCPA notices, third-party hosted banners

Bumped version: 1.7.0 -> 1.8.0 (+917 lines)

## [1.7.0] - 2026-04-14

### Fixed (HIGH)
- #1: UniqueDomainTracker._cache not invalidated after import or reset -- stale cache silently overwrote imported domains and broke post-reset tracking. Cache now nulled in both paths.

### Fixed (MEDIUM)
- #2: ConsentManager handler double-counted vendorsUnticked -- removed the bulk count before toggleAll, individual loop is now the single source of truth for the count.
- #3: FORCE_REJECT silently dropped during initial detection phase -- now queues via _pendingForceReject flag and auto-restarts detection when the current pass completes.

Bumped version: 1.6.0 -> 1.7.0

## [1.6.0] - 2026-04-14

### Fixed (CRITICAL)
- #1: `_handling` flag in handleCMP permanently stuck after early returns (processed check, cooldown guard). All guards now run BEFORE the flag is set, so try/finally always cleans up.

### Fixed (MEDIUM)
- #2: Cookiebot handler passed null root to findByText when dialog not rendered -- falls back to document
- #3: SettingsManager.update read-modify-write now serialized via storage queue
- #4: Import data writes now go through storage queue to prevent data loss on concurrent operations

### Fixed (LOW)
- #5: TCF API handler now calls __tcfapi('rejectAll') as programmatic supplement to button clicks
- #6: ConsentManager vendor count uses actual checked toggle count instead of hardcoded +5
- #7: Generic handler preferences flow no longer searches all div elements (removed div from selector)
- #8: Storage queue catch handlers return consistent types (null/false instead of undefined)
- #9: Test domainMatches now matches source (added toLowerCase, wildcard patterns, null guards, 6 new tests)
- #10: UniqueDomainTracker uses Set for O(1) deduplication instead of O(n) Array.includes

### Tests
- 28 -> 34 tests (6 new: case insensitive, wildcard matching, null inputs for domainMatches)

Bumped version: 1.5.0 -> 1.6.0

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
