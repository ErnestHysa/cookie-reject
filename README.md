# 🍪 CookieReject

**Auto-reject cookies, vendor consents, and privacy popups.**

Cookie consent banners are everywhere. Most of them have a tiny "Reject All" button buried in a submenu, or make you untick hundreds of vendor toggles one by one. CookieReject handles all of that automatically -- detecting the banner, navigating to preferences, unticking every vendor, and saving your choice. Across 48 CMP handlers (47 named + 1 generic fallback) and in 18 languages.

---

[![CMP Frameworks](https://img.shields.io/badge/CMP_frameworks-48-green)](#supported-cmp-frameworks)
[![Browser Support](https://img.shields.io/badge/browsers-Chrome%20%7C%20Firefox%20%7C%20Edge%20%7C%20Safari-blue)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

## Screenshots

> **TODO**: Add popup screenshot and before/after demo GIF here.

> Screenshots coming soon. The extension features a dark-themed popup with 4 tabs:
> - **Dashboard**: Current site status, quick stats, reject now button
> - **Activity**: Log of all rejected sites with CMP identification
> - **Lists**: Whitelist and blacklist management
> - **Settings**: Toggle switches for auto-reject, vendor unticking, overlay dismissal, TCF API, and debug mode

## Install

### Chrome / Edge / Brave / Opera
1. Download or clone this repo
2. Go to `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `cookie-reject` folder
5. Done! The icon appears in your toolbar.

### Firefox

1. Open `about:debugging#/runtime/this-firefox` in Firefox
2. Click **"Load Temporary Add-on..."**
3. Select any file in the extension directory (e.g., `manifest.json`)
4. The extension is now active (temporary -- removed on browser restart)

**For permanent installation:**
1. Package as XPI: `zip -r cookiereject.xpi manifest.json content.js background.js popup/ icons/ browser-polyfill.js`
2. Sign the XPI at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
3. Install the signed XPI via `about:addons` → "Install Add-on From File"
4. Note: Firefox minimum version 126 (set in manifest.json `browser_specific_settings.gecko.strict_min_version`)

### Safari (macOS)
Requires Xcode to build a Safari Web Extension wrapper. See [Apple's guide](https://developer.apple.com/documentation/safariservices/creating-a-safari-web-extension).

## Quick Start

1. Install the extension (see above)
2. Browse the web normally
3. Cookie banners are auto-rejected -- check the popup to see stats
4. Press **Alt+Shift+R** to manually reject on the current page

## How It Works

CookieReject runs a content script on every page you visit:

1. **Detect** which CMP framework the site uses (OneTrust, Cookiebot, Didomi, etc.)
2. **Reject** via the fastest path -- click "Reject All" if available, otherwise:
   - Open cookie preferences/settings
   - Untick all vendor toggles (scrolling lazy-loaded lists)
   - Click save/confirm
3. **Verify** the banner actually disappeared (not just clicked a dead button)
4. **Clean up** -- dismiss overlays, restore page scroll

Also uses IAB consent APIs (TCF v2, USP, GPP) to reject programmatically where available.

## Features

- **48 CMP handlers (47 named + 1 generic fallback)** with dedicated handlers
- **Generic fallback** for unknown cookie banners (18 languages)
- **Vendor unticking** -- scrolls lazy-loaded vendor lists, clicks every toggle
- **18 languages** -- EN, DE, FR, ES, IT, NL, PT, PL, CS, SV, DA, RO, HU, JA, KO, ZH, TR, RU
- **Cross-browser** -- Chrome, Firefox, Edge, Safari (Manifest V3)
- **Privacy-first** -- all data stored locally. Checks for extension updates via GitHub API (no personal data sent)
- **Import/Export** -- backup your settings, whitelist, and stats
- **Debug mode** -- toggle console logging for troubleshooting
- **Dry run mode** -- detect banners without rejecting (for testing)
- **Keyboard shortcuts** -- Alt+Shift+R (reject now), Alt+Shift+C (toggle on/off)
- **Smart verification** -- confirms banners actually disappeared after rejection
- **Whitelist/Blacklist** -- per-site control
- **CCPA support** -- handles "Do Not Sell" and opt-out banners
- **Theme toggle** -- dark and light themes
- **Per-CMP stats** -- track success/failure rate per framework
- **Pause feature** -- temporarily disable for N minutes

## Privacy & Permissions

CookieReject requests `<all_urls>` host permissions because it needs to inject a content script on every page to detect and reject cookie banners. It cannot know in advance which sites will have banners.

**What data is collected:** None. All stats, activity logs, and settings are stored locally in `chrome.storage`. No data is sent to any server.

**Network requests:** The extension makes one request per day to the GitHub Releases API to check for updates, and one request per week to fetch updated CMP detection rules from the repository's `rules.json`. These requests expose your IP address to GitHub but transmit no personal information. Both features can be disabled by setting `debugMode` to `false` (they are controlled by the background service worker).

## Supported CMP Frameworks

| Framework | Auto-Detect | Auto-Reject | Vendor Unticking |
|-----------|:-----------:|:-----------:|:----------------:|
| OneTrust | Yes | Yes | Yes |
| Fides (Ethyca) | Yes | Yes | Yes |
| Ketch | Yes | Yes | Yes |
| Cookiebot | Yes | Yes | Yes |
| Didomi | Yes | Yes | Yes |
| Sourcepoint | Yes | Yes | Yes |
| TrustArc | Yes | Yes | Yes |
| Quantcast | Yes | Yes | Yes |
| Usercentrics | Yes | Yes | Yes |
| CookieYes | Yes | Yes | Yes |
| Iubenda | Yes | Yes | Yes |
| ConsentManager | Yes | Yes | Yes |
| Sirdata | Yes | Yes | Yes |
| Ezoic (EzCookie) | Yes | Yes | Yes |
| Borlabs Cookie | Yes | Yes | Yes |
| LGCookiesLaw (PrestaShop) | Yes | Yes | Yes |
| Complianz | Yes | Yes | Yes |
| Cookie Notice (Humanityco) | Yes | Yes | Yes |
| Osano | Yes | Yes | Yes |
| Termly | Yes | Yes | Yes |
| Cookie Information | Yes | Yes | Yes |
| Real Cookie Banner | Yes | Yes | Yes |
| Moove GDPR | Yes | Yes | Yes |
| CookieAdmin | Yes | Yes | Yes |
| Beautiful Cookie Consent | Yes | Yes | Yes |
| Pressidium | Yes | Yes | Yes |
| WPLP Cookie Consent | Yes | Yes | Yes |
| Axeptio | Yes | Yes | Yes |
| Admiral | Yes | Yes | Yes |
| Commanders Act | Yes | Yes | Yes |
| CookieFirst | Yes | Yes | Yes |
| CookieHub | Yes | Yes | Yes |
| Gravito | Yes | Yes | Yes |
| TRUENDO | Yes | Yes | Yes |
| Clickio | Yes | Yes | Yes |
| AppConsent | Yes | Yes | Yes |
| Cloudflare | Yes | Yes | Yes |
| Securiti | Yes | Yes | Yes |
| Transcend | Yes | Yes | Yes |
| CIVIC Cookie Control | Yes | Yes | Yes |
| FastCMP | Yes | Yes | Yes |
| Lawwwing | Yes | Yes | Yes |
| AVACY | Yes | Yes | Yes |
| Consentmo | Yes | Yes | Yes |
| Pandectes | Yes | Yes | Yes |
| Enzuzo | Yes | Yes | Yes |
| Cookie Script | Yes | Yes | Yes |
| **Generic fallback** | **Yes** | **Yes** | **Yes** |

## Settings

All settings are functional and respected by the content script engine:

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-Reject | On | Automatically detect and reject banners |
| Untick All Vendors | On | Untick every vendor toggle in CMP panels |
| Dismiss Overlays | On | Remove consent backdrops blocking page scroll |
| TCF / GPP APIs | On | Use IAB consent APIs to reject programmatically |
| Debug Mode | Off | Log detection details to browser console (F12) |

## Project Structure

```
cookie-reject/
├── manifest.json          # Extension manifest (Manifest V3)
├── background.js          # Service worker: stats, logging, lists, import/export
├── content.js             # Content script: detection + rejection engine
├── browser-polyfill.js    # Cross-browser API normalization
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.css          # Dark theme styles
│   └── popup.js           # Popup controller
├── icons/                 # Extension icons (16/32/48/128 PNG)
├── tests/
│   └── test-utils.js         # Unit tests for utility functions
├── .gitignore
├── CHANGELOG.md           # Version history
├── LICENSE                # MIT
├── CONTRIBUTING.md        # How to contribute
└── README.md              # This file
```

## Contributing

Found a site where CookieReject doesn't work? Open an issue with the URL and browser version. See [CONTRIBUTING.md](CONTRIBUTING.md) for details on adding new CMP handlers.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
