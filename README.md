# 🍪 CookieReject

**Auto-reject cookies, vendor consents, and privacy popups.**

Cookie consent banners are everywhere. Most of them have a tiny "Reject All" button buried in a submenu, or make you untick hundreds of vendor toggles one by one. CookieReject handles all of that automatically -- detecting the banner, navigating to preferences, unticking every vendor, and saving your choice. Across 16+ CMP frameworks and in 6 languages.

---

[![CMP Frameworks](https://img.shields.io/badge/CMP_frameworks-16%2B-green)](#supported-cmp-frameworks)
[![Browser Support](https://img.shields.io/badge/browsers-Chrome%20%7C%20Firefox%20%7C%20Edge%20%7C%20Safari-blue)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

## Screenshots

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

- **16+ CMP frameworks** with dedicated handlers
- **Generic fallback** for unknown cookie banners
- **Vendor unticking** -- scrolls lazy-loaded vendor lists, clicks every toggle
- **6 languages** -- English, German, French, Spanish, Italian, Dutch
- **Cross-browser** -- Chrome, Firefox, Edge, Safari (Manifest V3)
- **Privacy-first** -- all data stored locally, no external calls
- **Import/Export** -- backup your settings, whitelist, and stats
- **Debug mode** -- toggle console logging for troubleshooting
- **Keyboard shortcut** -- Alt+Shift+R for manual rejection
- **Smart verification** -- confirms banners actually disappeared after rejection
- **Whitelist/Blacklist** -- per-site control

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
├── .gitignore
├── LICENSE                # MIT
├── CONTRIBUTING.md        # How to contribute
└── README.md              # This file
```

## Contributing

Found a site where CookieReject doesn't work? Open an issue with the URL and browser version. See [CONTRIBUTING.md](CONTRIBUTING.md) for details on adding new CMP handlers.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
