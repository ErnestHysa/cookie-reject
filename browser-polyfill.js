/**
 * CookieReject - Cross-Browser API Polyfill
 *
 * Normalizes the extension API across Chrome, Firefox, Edge, Brave, Opera, and Safari.
 *
 * - Chrome/Edge/Brave/Opera: use `chrome.*` namespace (callback-based)
 * - Firefox: uses `browser.*` namespace (Promise-based, also supports callbacks)
 * - Safari: uses `chrome.*` namespace via safari-web-extension-converter
 *
 * This polyfill ensures `chrome` is always available as a global,
 * falling back to `browser` where needed (Firefox).
 *
 * Zero external dependencies.
 */

(function () {
  'use strict';

  // If chrome is undefined but browser exists (Firefox), alias it
  if (typeof chrome === 'undefined' && typeof browser !== 'undefined') {
    // Firefox environment -- browser.* is the native API
    // Alias the entire namespace so all chrome.* calls work
    window.chrome = browser;
  }

  // If both exist (some Firefox versions have both), ensure all APIs are available
  if (typeof chrome !== 'undefined' && typeof browser !== 'undefined') {
    const apis = ['action', 'tabs', 'runtime', 'storage', 'alarms', 'scripting', 'offscreen', 'declarativeNetRequest'];
    for (const api of apis) {
      if (!chrome[api] && browser[api]) chrome[api] = browser[api];
    }
    // Deep-clone storage areas
    if (chrome.storage && browser.storage) {
      if (!chrome.storage.sync && browser.storage.sync) chrome.storage.sync = browser.storage.sync;
      if (!chrome.storage.local && browser.storage.local) chrome.storage.local = browser.storage.local;
      if (!chrome.storage.session && browser.storage.session) chrome.storage.session = browser.storage.session;
    }
  }

  // If neither exists (unlikely, but defensive)
  if (typeof chrome === 'undefined' && typeof browser === 'undefined') {
    console.warn('[CookieReject] No extension API found. Running in non-extension context.');
  }
})();
