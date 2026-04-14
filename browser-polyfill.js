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
    return;
  }

  // If both exist (some Firefox versions have both), ensure chrome.action exists
  // In Firefox, chrome.action may be undefined while browser.action works
  if (typeof chrome !== 'undefined' && typeof browser !== 'undefined') {
    // Firefox with both namespaces -- fill in any gaps
    if (!chrome.action && browser.action) {
      chrome.action = browser.action;
    }
    if (!chrome.tabs && browser.tabs) {
      chrome.tabs = browser.tabs;
    }
    if (!chrome.runtime && browser.runtime) {
      chrome.runtime = browser.runtime;
    }
    if (!chrome.storage && browser.storage) {
      chrome.storage = browser.storage;
    }
  }

  // If neither exists (unlikely, but defensive)
  if (typeof chrome === 'undefined' && typeof browser === 'undefined') {
    console.warn('[CookieReject] No extension API found. Running in non-extension context.');
  }
})();
