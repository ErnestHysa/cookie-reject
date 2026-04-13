# CookieReject

Auto-reject cookies, vendor consents, and privacy popups across the web. Saves you time by unticking every vendor toggle so you don't have to.

## What It Does

- **Auto-detects** 15+ cookie consent frameworks (OneTrust, Cookiebot, Fides/Ketch, Didomi, Sourcepoint, TrustArc, Quantcast, Usercentrics, CookieYes, Iubenda, ConsentManager, Borlabs, and more)
- **Rejects all cookies** when a banner appears -- clicks "Reject All" / "Decline" / "Deny" automatically
- **Unticks every vendor** in the vendor list -- scrolls through, finds all toggles, and turns them off
- **Dismisses overlays** -- removes dark backdrops, scroll locks, and blocking popups
- **Uses TCF API** -- programmatically rejects consent via IAB Transparency & Consent Framework
- **Tracks your stats** -- cookies rejected, vendors unticked, sites protected
- **Shows time saved** -- calculates how much time you've saved vs. manual rejection (~47 seconds per site)

## Supported CMP Frameworks

| Framework | Detection | Reject All | Vendor Unticking |
|-----------|:---------:|:----------:|:----------------:|
| OneTrust/Optanon | Yes | Yes | Yes |
| Fides (ethyca) | Yes | Yes | Yes |
| Ketch | Yes | Yes | Yes |
| Cookiebot/Cybot | Yes | Yes | Yes |
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
| Generic (fallback) | Yes | Yes | Yes |

*Sourcepoint uses cross-origin iframes; vendor unticking works when same-origin.

## Installation (Safari - Unsigned)

Since you don't have Xcode, here's how to load this extension in Safari:

### Option A: Quick Install (Safari 17+ / macOS Sonoma+)

1. Open Safari
2. Go to **Safari > Settings > Advanced**
3. Check **"Show features for web developers"**
4. Close Settings
5. Go to **Develop > Allow Unsigned Extensions**
6. You need to build the extension into a Safari App Extension. Run:

```bash
# If you have Xcode installed:
xcrun safari-web-extension-converter ~/Desktop/DEVPROJECTS/cookie-reject
# Then open the generated Xcode project and build/run
```

### Option B: Install Xcode First (Recommended)

Since Safari Web Extensions require an app wrapper even for unsigned loading:

1. Install Xcode from the Mac App Store (free, ~12 GB)
2. After installation, run:

```bash
xcrun safari-web-extension-converter ~/Desktop/DEVPROJECTS/cookie-reject --no-open
cd ~/Desktop/DEVPROJECTS/cookie-reject-safari
xcodebuild -scheme "CookieReject (macOS)" -configuration Debug build
```

3. The built app will be in `build/Debug/CookieReject.app`
4. Copy it to `/Applications` (optional)
5. Run the app once -- it will offer to enable the Safari extension
6. Go to Safari > Settings > Extensions and enable CookieReject

### Option C: Load in Chrome/Firefox/Edge for Testing

The extension works as a standard web extension:

**Chrome/Edge:**
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `cookie-reject` folder

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the `cookie-reject` folder

## Features

### Popup UI
- **Toggle on/off** -- quickly enable/disable the extension
- **Current site status** -- see if the current site was protected
- **Whitelist/Blacklist** -- add sites to allow or always-reject lists
- **Force reject** -- manually trigger rejection on the current page

### Stats Dashboard
- Total cookies rejected
- Total vendors unticked
- Sites protected
- Cookies allowed
- **Time saved** (highlighted feature) -- estimated time saved based on ~47 seconds per site + ~2 seconds per vendor

### Activity Log
- Recent activity with domain, CMP framework detected, and actions taken
- Shows what was rejected and how many vendors were unticked

### Whitelist/Blacklist
- Add domains by typing or using the Whitelist/Blacklist buttons for the current site
- Supports subdomain matching: adding `example.com` also covers `sub.example.com`
- Entries can be removed from the Manage Lists tab

### Settings
- Auto-reject cookies (on/off)
- Untick all vendors (on/off)
- Dismiss overlays (on/off)
- Use TCF API (on/off)
- Reset stats / Clear activity log

## How It Works

1. **Content script** runs on every page load
2. **MutationObserver** watches for dynamically injected consent banners
3. **CMP Detection** identifies which framework is running (15+ known frameworks + generic fallback)
4. **CMP Handler** applies framework-specific rejection logic:
   - Clicks "Reject All" / "Decline" / "Deny" buttons directly if available
   - If no direct reject button, opens "Manage Preferences", unticks all toggles, then saves
   - Scrolls through vendor lists to reveal and untick lazy-loaded vendor toggles
5. **TCF API** rejects consent programmatically for IAB-compliant frameworks
6. **Overlay removal** cleans up dark backdrops and scroll locks
7. **Background worker** logs actions, tracks stats, and manages lists

## Project Structure

```
cookie-reject/
├── manifest.json       Extension manifest (Manifest V2)
├── content.js          Content script - consent rejection engine
├── background.js       Background worker - stats, logging, storage
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

## Technical Notes

- **Manifest V2** for maximum Safari compatibility
- Uses `chrome.storage.local` for all persistent data (stats, lists, settings)
- Content script uses MutationObserver for dynamic banner detection
- Supports both `chrome.runtime` and `browser.runtime` APIs
- No external dependencies -- pure vanilla JS/CSS/HTML
- Maximum vendor safety limit of 2000 toggles per page
- Activity log capped at 500 entries

## Browser Compatibility

| Browser | Status |
|---------|--------|
| Safari 14+ | Supported (needs Xcode for app wrapper) |
| Chrome 88+ | Supported (load unpacked) |
| Edge 88+ | Supported (load unpacked) |
| Firefox 78+ | Supported (temporary load) |

## License

MIT
