<p align="center">
  <img src="icons/icon-128.png" alt="CookieReject" width="80" height="80">
  <h1 align="center">CookieReject</h1>
  <p align="center">
    <strong>Because "Reject All" should mean you click it once. Not 942 times.</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/platform-Safari%20%7C%20Chrome%20%7C%20Edge%20%7C%20Firefox-blue" alt="Platforms">
    <img src="https://img.shields.io/badge/CMP_frameworks-15%2B-green" alt="CMP Frameworks">
    <img src="https://img.shields.io/badge/zero_dependencies-yes-brightgreen" alt="No Dependencies">
    <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
  </p>
</p>

---

## The Problem

You know the drill. You visit a website. A cookie banner pops up. You look for "Reject All" -- but some sites don't have one. Instead you get:

- "Manage Preferences" --> a wall of 200+ vendor toggles, all **ON** by default
- You have to scroll through every single one, unticking each vendor
- Some vendors are hidden behind "Show More" buttons or lazy-loaded as you scroll
- After 2 minutes of unticking, you hit "Save Preferences" and hope it actually worked

**Every. Single. Website.**

That ends now.

## The Solution

**CookieReject** is a browser extension that does all of this automatically:

1. **Detects** the cookie consent banner (supports 15+ CMP frameworks)
2. **Rejects all cookies** -- clicks "Reject All", "Decline", or "Deny" for you
3. **Opens "Manage Preferences"** when no reject button exists
4. **Scrolls through every vendor** and unticks all toggles
5. **Saves your preferences** and closes the banner
6. **Removes overlays** -- kills dark backdrops and scroll locks
7. **Shows you exactly how much time you've saved** doing this manually

## Quick Start

### Chrome / Edge / Brave (1 minute)

```bash
git clone https://github.com/ErnestHysa/cookie-reject.git
```

1. Open your browser
2. Go to `chrome://extensions` (or `edge://extensions` for Edge)
3. Turn on **Developer mode** (toggle in the top right)
4. Click **"Load unpacked"**
5. Select the cloned `cookie-reject` folder
6. Done. Browse the web -- cookie banners are now your problem of the past.

### Safari (requires Xcode)

Safari extensions need a macOS app wrapper. If you have Xcode installed:

```bash
# 1. Clone the repo
git clone https://github.com/ErnestHysa/cookie-reject.git

# 2. Convert to a Safari extension project
xcrun safari-web-extension-converter cookie-reject

# 3. Build and run
# Xcode will open automatically. Press Cmd+R to build and run.
# The app will offer to enable the Safari extension.
# Go to Safari > Settings > Extensions and enable CookieReject.
```

### Firefox

```bash
git clone https://github.com/ErnestHysa/cookie-reject.git
```

1. Open `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on"**
3. Select `manifest.json` from the `cookie-reject` folder
4. Note: Firefox temporary add-ons are removed when the browser closes

---

## How It Looks

The extension popup gives you a full dashboard:

- **Time Saved** -- the hero stat. See exactly how many hours you've saved not clicking vendor toggles
- **Stats Grid** -- cookies rejected, vendors unticked, sites protected
- **Activity Log** -- every site where action was taken, what CMP was detected, what was rejected
- **Whitelist / Blacklist** -- add sites to always-allow or always-reject (with subdomain support)
- **Settings** -- toggle auto-reject, vendor unticking, overlay dismissal, TCF API usage

---

## Supported CMP Frameworks

CookieReject recognizes and handles 15+ consent management platforms plus a generic fallback:

| Framework | Detect | Reject All | Vendor Unticking |
|-----------|:------:|:----------:|:----------------:|
| OneTrust / Optanon | Yes | Yes | Yes |
| Fides (ethyca) | Yes | Yes | Yes |
| Ketch | Yes | Yes | Yes |
| Cookiebot / Cybot | Yes | Yes | Yes |
| Didomi | Yes | Yes | Yes |
| Sourcepoint | Yes | Yes | Partial* |
| TrustArc | Yes | Yes | Yes |
| Quantcast Choice | Yes | Yes | Yes |
| Usercentrics | Yes | Yes | Yes |
| CookieYes | Yes | Yes | Yes |
| Iubenda | Yes | Yes | No |
| ConsentManager | Yes | Yes | Yes |
| Sirdata | Yes | Yes | No |
| Ezoic (EzCookie) | Yes | Yes | No |
| Borlabs Cookie | Yes | Yes | Yes |
| **Generic fallback** | **Yes** | **Yes** | **Yes** |

*Sourcepoint uses cross-origin iframes; vendor unticking works when same-origin.

In addition to CMP-specific handlers, CookieReject also uses the **IAB Transparency & Consent Framework APIs** (`__tcfapi`, `__uspapi`, `__gpp`) to programmatically reject consent on any compliant site.

---

## Features

### Automatic Rejection
- Runs silently on every page you visit
- MutationObserver catches banners injected after page load
- No configuration needed -- works out of the box

### Vendor Unticking
- Opens "Manage Preferences" when no direct reject button exists
- Scrolls through the full vendor list (handles lazy-loaded items)
- Unticks every vendor toggle except "Strictly Necessary" (disabled by the CMP)
- Clicks "Save Preferences" / "Confirm My Choices" when done

### Whitelist / Blacklist
- **Whitelist**: Sites where you want to allow cookies (e.g. your banking site). Covers all subdomains.
- **Blacklist**: Sites where you always want to force-reject. Also covers subdomains.
- Add from the popup UI for the current site, or type a domain manually.

### Stats & Activity
- **Cookies Rejected** -- total number of consent actions taken
- **Vendors Unticked** -- total vendor toggles turned off
- **Sites Protected** -- number of unique sites where action was taken
- **Time Saved** -- estimated time saved at ~47 seconds per site + ~2 seconds per vendor
- **Activity Log** -- scrollable list of every site action with CMP detected, actions taken, and timestamp

### Popup UI
- Dark theme with green accents
- Current site status: protected / whitelisted / no banner detected
- One-click "Reject Now" button for manual triggering
- Quick Whitelist / Blacklist buttons for the current site
- Settings with toggle switches for all features

---

## How It Works

```
Page loads
    |
    v
Content script injected
    |
    v
MutationObserver watches DOM for consent banners
    |
    v
CMP Detection identifies the framework
    |
    +-- OneTrust? --> OneTrust handler
    +-- Fides?     --> Fides handler
    +-- Cookiebot? --> Cookiebot handler
    +-- ...        --> (15+ more handlers)
    +-- Unknown?   --> Generic fallback handler
    |
    v
Handler executes rejection strategy:
    |
    +-- Try "Reject All" button directly
    +-- If none: open "Manage Preferences"
    |       +-- Untick all purpose toggles
    |       +-- Scroll vendor list, untick all vendors
    |       +-- Click "Save Preferences"
    |
    v
TCF API rejection (IAB-compliant sites)
    |
    v
Overlay removal (dark backdrops, scroll locks)
    |
    v
Stats logged to background worker
```

---

## Project Structure

```
cookie-reject/
├── manifest.json       Extension manifest (Manifest V3)
├── content.js          Content script -- consent rejection engine (57 KB)
├── background.js       Background worker -- stats, logging, storage
├── popup/
│   ├── popup.html      Popup UI structure
│   ├── popup.css       Dark theme styling
│   └── popup.js        Popup interaction logic
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

## Technical Details

- **Manifest V3** for Chrome/Edge compatibility (Safari supports V3 via converter)
- **Zero dependencies** -- pure vanilla JavaScript, HTML, CSS
- **~47 seconds estimated** per manual cookie rejection (industry research)
- **~2 seconds estimated** per manual vendor toggle untick
- Vendor processing safety limit of 2,000 toggles per page
- Activity log capped at 500 entries
- All data stored locally via `chrome.storage.local` -- nothing leaves your machine

## Browser Support

| Browser | Version | Install Method |
|---------|---------|---------------|
| Chrome | 88+ | Load unpacked |
| Edge | 88+ | Load unpacked |
| Brave | Latest | Load unpacked |
| Firefox | 78+ | Temporary add-on |
| Safari | 14+ | Requires Xcode for app wrapper |

## Contributing

Found a CMP framework that isn't handled? A site where CookieReject doesn't work? Open an issue with the site URL and what you see. PRs welcome.

## License

MIT
