/**
 * CookieReject - Content Script
 * Consent banner detection and rejection engine.
 * Runs on every page. Watches for cookie consent popups and auto-rejects.
 *
 * ─── TABLE OF CONTENTS ───────────────────────────────────────────────
 * Line   Section
 * ~~~~   ~~~~~~~
 *   30   Cross-Browser Polyfill Guard
 *   94   Debug Logging
 *  106   Configuration (CONFIG)
 *  138   Utilities (Utils.isVisible, findByText, untickAllToggles, etc.)
 *  360   CMP Detector (CMPDetector.detect, detectGeneric)
 *  525   Handler Registration (registerHandler + auto-detect/selectors)
 *  576   Common Handler Helpers (HandlerHelpers.standardReject)
 *  636   CMP Handlers (47 named handlers + 1 generic fallback)
 * 3035   Remote Rules Application
 * 3058   TCF / USP / GPP API Handlers
 * 3128   Banner Hider
 * 3168   Engine (init, detectAndReject, observer, retry loop)
 * 3640   Message Listener (popup/background communication)
 * 3700   SPA Navigation Support (pushState, hashchange)
 * 3760   Bootstrap (DOMContentLoaded)
 * ──────────────────────────────────────────────────────────────────────
 */

// ─── Cross-Browser Polyfill Guard ────────────────────────────────────
// The full polyfill is loaded via manifest content_scripts before this file.
// This guard handles edge cases (e.g. iframes, late injection).
if (typeof chrome === 'undefined' && typeof browser !== 'undefined') {
  var chrome = browser;
}

(function () {
  'use strict';
  try {

  // ─── Prevent double-injection and skip non-top frames ──────────────
  // Cookie consent banners always live in the top-level frame. Running
  // in every iframe wastes resources: N iframes = N Engine instances,
  // N MutationObservers, N intervals all scanning for banners that will
  // never appear there.
  if (window !== window.top) {
    // Iframe: run lightweight CMP rejection only, skip full engine
    // Skip non-HTTP iframes (PDF viewers, about:blank, extension pages)
    try {
      const proto = window.location.protocol;
      if (proto !== 'http:' && proto !== 'https:') return;
    } catch { return; }
    // We're in an iframe. Run a lightweight scan for known CMP iframes
    // (Sourcepoint, TrustArc portal, etc.) but skip full engine init.
    const _isCMPFrame = (() => {
      try {
        const src = (window.frameElement?.src || window.location.href || '').toLowerCase();
        return src.includes('sp_message') || src.includes('sourcepoint') ||
               src.includes('trustarc') || src.includes('consentframework') ||
               src.includes('cookiebot') || src.includes('quantcast');
      } catch { return false; }
    })();
    if (!_isCMPFrame) return;
    // In a CMP iframe -- try generic rejection after a short delay
    setTimeout(() => {
      try {
        const rejectTexts = ['reject all', 'reject', 'decline', 'refuse', 'opt out', 'do not consent',
          'manage choices', 'manage preferences', 'customise choices'];
        const priorityTexts = ['reject all', 'reject', 'decline', 'refuse', 'opt out', 'do not consent'];
        const buttons = document.querySelectorAll('button, a');
        for (const txt of priorityTexts) {
          const match = Array.from(buttons).find(btn =>
            (btn.textContent || '').trim().toLowerCase().includes(txt) &&
            btn.offsetHeight > 0
          );
          if (match) { match.click(); break; }
        }
      } catch (e) { /* iframe rejection failed silently */ }
    }, 2000); // mirrors CONFIG.iframeRejectionDelay (CONFIG not yet defined in iframe path)
    return;
  }

  // Version-specific guard prevents double-injection after extension updates
  const _guardProp = '__cookieReject_' + (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version.replace(/\./g, '_') : 'unknown');
  if (window[_guardProp]) return;
  window[_guardProp] = true;
  // Clean up guard properties from older versions
  for (const key of Object.keys(window)) {
    if (key.startsWith('__cookieReject_') && key !== _guardProp) {
      delete window[key];
    }
  }

  // ─── Debug Logging ──────────────────────────────────────────────────
  // Toggle via popup settings. Outputs to console when debugMode is on.
  let _debugMode = false;
  const DebugLog = {
    log(...args) { if (_debugMode) console.log('[CookieReject]', ...args); },
    warn(...args) { if (_debugMode) console.warn('[CookieReject]', ...args); },
    error(...args) { console.error('[CookieReject]', ...args); },
  };

  // ─── Configuration ──────────────────────────────────────────────────
  const CONFIG = {
    // How long to wait between retries when looking for a banner (ms)
    retryInterval: 500,
    // Maximum retries before giving up on a page
    maxRetries: 60,  // 30 seconds total (enough for slow async CMP scripts)
    // How long to wait between vendor toggle clicks (ms)
    vendorToggleDelay: 30,
    // How long to wait for dynamic content to load after clicking (ms)
    dynamicLoadDelay: 400,
    // How long to wait after scrolling a vendor list (ms)
    scrollDelay: 200,
    // Max vendors to process per CMP (safety limit)
    maxVendors: 2000,
    // Observer throttle: minimum ms between detect() calls via MutationObserver
    observerThrottle: 300,
    // Cooldown after a failed rejection attempt (ms)
    failedCooldown: 3000,
    // Delay before calling handler.reject() to let banner JS initialize (ms)
    preRejectDelay: 500,
    // Safety timeout: force-disconnect observer after this many ms
    observerTimeout: 35000,
    // Max time to wait for settings to load before proceeding (ms)
    settingsWaitTimeout: 2000,
    // Delay for handlers to wait for CMP UI to settle (ms)
    handlerWaitDelay: 800,
    // Top CMPs to check first on observer ticks (most common globally)
    topCMPs: ['onetrust', 'didomi', 'cookieyes', 'usercentrics', 'sourcepoint'],
    // SPA navigation delay before restarting detection (ms)
    spaNavigationDelay: 1500,
    // Delay after rejection before re-checking banner visibility (ms)
    observerCheckDelay: 500,
    // Delay for iframe CMP rejection attempt (ms)
    iframeRejectionDelay: 2000,
    // Polling interval for settings/whitelist checks (ms)
    settingsPollInterval: 50,
    // Initial delay before first detection to allow page/CMP to load (ms)
    initDelay: 300,
    // TCF API listener timeout -- how long to wait for CMP response (ms)
    tcfApiTimeout: 2000,
  };

  // ─── Utility helpers ────────────────────────────────────────────────
  const Utils = {
    /**
     * Check if a DOM element is actually visible to the user.
     * Returns false if the element (or any ancestor) is hidden via
     * display:none, visibility:hidden, opacity:0, or has zero size.
     */
    isVisible(el) {
      if (!el) return false;
      // Fast path: if element has layout and non-zero size, it's likely visible.
      // This avoids the expensive getComputedStyle call for the majority of elements.
      if (el.offsetHeight > 0 && el.offsetWidth > 0 && el.offsetParent !== null) {
        return true;
      }
      // offsetParent is null for display:none and position:fixed elements.
      // For position:fixed, we still need to check visibility/opacity below.
      const style = getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      // offsetParent check: if non-null, element has layout (not display:none).
      // This is a fast path but must come AFTER visibility/opacity checks.
      if (el.offsetParent !== null) return true;
      // offsetParent is null -- could be position:fixed or display:none.
      // display:none already handled above. Check for zero-size elements.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    },

    _visibilityCache: new WeakMap(),
    isVisibleCached(el) {
      if (!el) return false;
      const cached = this._visibilityCache.get(el);
      if (cached !== undefined && Date.now() - cached.ts < 200) return cached.visible;
      const visible = this.isVisible(el);
      this._visibilityCache.set(el, { visible, ts: Date.now() });
      return visible;
    },

    /**
     * Wait for an element matching `selector` to appear in the DOM.
     */
    waitForElement(selector, timeout = 5000, root = document) {
      return new Promise((resolve) => {
        const el = root.querySelector(selector);
        if (el) return resolve(el);

        const observer = new MutationObserver(() => {
          const el = root.querySelector(selector);
          if (el) {
            observer.disconnect();
            resolve(el);
          }
        });
        observer.observe(root.documentElement || root, {
          childList: true,
          subtree: true,
        });

        setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);
      });
    },

    /**
     * Wait a fixed number of ms.
     */
    sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    },

    /**
     * Find a visible element by its text content.
     * Only returns elements that are actually visible on the page.
     */
    findByText(text, root = document, tag = '*') {
      const elements = root.querySelectorAll(tag);
      for (const el of elements) {
        // Skip invisible elements (defense in depth against hidden
        // decoy elements that could trick the extension into clicking)
        if (!this.isVisible(el)) continue;
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt.includes(text.toLowerCase())) return el;
      }
      return null;
    },

    /**
     * Find all elements matching any of several text patterns.
     * Caches the querySelectorAll result for 2 seconds to avoid repeated
     * full-DOM scans during the same detection cycle.
     */
    findAllByText(texts, root = document, tag = 'button, a, span, input, label') {
      if (!texts || texts.length === 0) return [];
      const results = [];
      // Pre-lowercase all search texts for efficiency
      const lowerTexts = texts.map(t => t.toLowerCase());
      const minLen = Math.min(...lowerTexts.map(t => t.length));
      // Cache the element list for 2 seconds to avoid repeated DOM scans
      const cacheKey = root === document ? '_allBtns' : '_scopedBtns';
      const now = Date.now();
      if (!this._textCache || !this._textCache[cacheKey] || now - this._textCache[cacheKey].ts > 500) {
        if (!this._textCache) this._textCache = {};
        this._textCache[cacheKey] = {
          els: Array.from(root.querySelectorAll(tag)),
          ts: now,
        };
      }
      const elements = this._textCache[cacheKey].els;
      for (const el of elements) {
        if (!this.isVisible(el)) continue;
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt.length < minLen) continue; // can't match any text
        for (const t of lowerTexts) {
          if (txt.includes(t)) {
            results.push(el);
            break;
          }
        }
      }
      return results;
    },

    /** Clear the text search cache (call after DOM mutations) */
    clearTextCache() {
      this._textCache = null;
    },

    /**
     * Untick all toggle/checkbox inputs in a container.
     * Handles both native checkboxes and custom toggle switches.
     */
    async untickAllToggles(container, opts = {}) {
      const {
        toggleSelector = 'input[type="checkbox"], input[role="switch"], .ot-switch input, .switch input, input[class*="toggle"], [class*="cmp-toggle"] input, [class*="consent-toggle"] input, .cmplz-toggle input, .moove-gdpr-form input',
        excludeChecked = true, // only toggle things that ARE checked
        scrollContainer = null,
      } = opts;

      // Collect toggles from light DOM
      let toggles = Array.from(container.querySelectorAll(toggleSelector));

      // Also pierce Shadow DOM (custom web components like <xtx-checkbox>)
      // PERF-3: Use a WeakMap cache to avoid re-scanning the same elements
      if (!Utils._shadowRootCache) Utils._shadowRootCache = new WeakMap();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot) {
          if (!Utils._shadowRootCache.has(node)) {
            Utils._shadowRootCache.set(node, true);
          }
          const shadowToggles = node.shadowRoot.querySelectorAll(toggleSelector);
          shadowToggles.forEach(t => toggles.push(t));
        }
      }

      let count = 0;

      for (let i = 0; i < toggles.length && i < CONFIG.maxVendors; i++) {
        const toggle = toggles[i];

        // Skip disabled toggles (e.g. "Strictly Necessary")
        if (toggle.disabled || toggle.hasAttribute('disabled')) continue;

        // Skip toggles labeled as strictly necessary / essential.
        // Use regex with word boundaries to avoid false positives
        // (e.g. "unnecessary", vendor named "Essential Ads Ltd").
        const label = (toggle.closest('label, [class*="category"], [class*="purpose"], tr, li') || {}).textContent || '';
        const lowerLabel = label.toLowerCase();
        const essentialRe = /\b(strictly necessary|essential cookies?|necessary cookies?|always (active|on)|required cookies?|unbedingt erforderlich|indispensables?|cookies? indispensables?)\b/i;
        if (essentialRe.test(lowerLabel)) continue;

        // Only untick if it's currently checked (don't re-check)
        if (excludeChecked && !toggle.checked) continue;

        // Scroll toggle into view if needed
        toggle.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        toggle.click();
        count++;

        // Small delay every 20 toggles to give the CMP breathing room
        if (i % 20 === 19) await Utils.sleep(CONFIG.vendorToggleDelay);
      }

      // Also try custom toggle switches (non-input elements)
      const customToggles = container.querySelectorAll(
        '[class*="toggle"][role="switch"], [class*="switch"][aria-checked="true"], .ot-switch-nob, .ot-tgl-switch, ' +
        '[class*="cmp-toggle"][aria-checked="true"], [data-role="switch"][aria-checked="true"], ' +
        'button[role="switch"][aria-checked="true"], a[role="switch"][aria-checked="true"], ' +
        '[class*="legitimate-interest"][aria-checked="true"]'
      );
      for (const toggle of customToggles) {
        const ariaChecked = toggle.getAttribute('aria-checked');
        if (ariaChecked === 'true') {
          toggle.click();
          count++;
          await Utils.sleep(CONFIG.vendorToggleDelay);
        }
      }

      return count;
    },

    /**
     * Scroll a container to load all lazy-loaded vendor items.
     */
    async scrollToLoadAll(container, direction = 'down', signal = null) {
      let lastHeight = container.scrollHeight;
      let attempts = 0;

      while (attempts < 30) {
        if (signal && signal.aborted) break;
        container.scrollTop = container.scrollHeight;
        await Utils.sleep(CONFIG.scrollDelay);

        if (container.scrollHeight === lastHeight) {
          attempts++;
          if (attempts > 3) break; // stable for 3 checks
        } else {
          lastHeight = container.scrollHeight;
          attempts = 0;
        }
      }

      // Scroll back to top
      container.scrollTop = 0;
    },
  };

  // ─── CMP Detection ──────────────────────────────────────────────────
  const CMPDetector = {
    // Detection result cache: avoids re-running expensive querySelectorAll
    // when detect() is called multiple times within a short window.
    _lastDetection: null,
    _lastDetectionTime: 0,
    _cacheTTL: 1000, // 1 second
    _shadowHostsTimestamp: 0,

    /**
     * Detect which CMP framework is running on the current page.
     * Returns an object { id, name, confidence } or null.
     * Confidence: 'high' = element found, 'medium' = window global found,
     *            'low' = partial match.
     */
    detect() {
      const now = Date.now();
      if (this._lastDetection && (now - this._lastDetectionTime < this._cacheTTL)) {
        return this._lastDetection;
      }
      // Use auto-registered detectors from registerHandler() calls.
      const detectors = _detectorEntries;
      // Collect all matches with confidence scores, then pick best.
      const matches = [];

      for (const detector of detectors) {
        try {
          const result = detector.check();
          if (result) {
            if (result instanceof HTMLElement && !Utils.isVisible(result)) {
              continue;
            }
            // Score: DOM element = high, truthy global = medium
            const confidence = result instanceof HTMLElement ? 'high' : 'medium';
            matches.push({ id: detector.id, name: detector.name, confidence });
          }
        } catch (e) { /* CMP handler error - expected in non-matching pages */ }
      }

      // Pick best match: prefer 'high' confidence over 'medium'
      if (matches.length > 0) {
        matches.sort((a, b) => (a.confidence === 'high' ? 0 : 1) - (b.confidence === 'high' ? 0 : 1));
        const best = matches[0];
        this._lastDetection = best;
        this._lastDetectionTime = now;
        return best;
      }

      // Fallback: generic detection based on common banner patterns
      if (CMPDetector.detectGeneric()) {
        const cached = { id: 'generic', name: 'Generic', confidence: 'low' };
        this._lastDetection = cached;
        this._lastDetectionTime = now;
        return cached;
      }

      this._lastDetection = null;
      this._lastDetectionTime = now;
      return null;
    },

    /**
     * Generic cookie banner detection using heuristics.
     */
    detectGeneric() {
      const bannerIndicators = [
        // Common cookie banner IDs
        '[id*="cookie-banner"]',
        '[id*="cookie-notice"]', '[id*="cookie-consent"]',
        '[id*="cookie-popup"]', '[id*="consent-banner"]',
        '[id*="gdpr-banner"]', '[id*="gdpr-notice"]',
        '[id*="privacy-banner"]', '[id*="privacy-notice"]',
        '[id*="cc-banner"]', '[id*="cc-notice"]',
        '[id*="CookieBanner"]', '[id*="CookieNotice"]',
        '[id*="CookieConsent"]', '[id*="ConsentBanner"]',
        '[id*="ccpa-banner"]', '[id*="ccpa-notice"]',
        '[id*="consent-popup"]', '[id*="banner-cookies"]',
        '[id*="cookie-bar"]', '[id*="cookie-wrapper"]',
        // Common cookie banner classes
        '[class*="cookie-banner"]', '[class*="cookie-notice"]',
        '[class*="cookie-consent"]', '[class*="cookie-popup"]',
        '[class*="consent-banner"]', '[class*="consent-popup"]',
        '[class*="gdpr-banner"]', '[class*="gdpr-notice"]',
        '[class*="privacy-banner"]', '[class*="privacy-popup"]',
        '[class*="cc-banner"]', '[class*="cmp-banner"]',
        '[class*="cookie-bar"]',
        '[class*="cookie-wrapper"]', '[class*="consent-bar"]',
        '[class*="ccpa-banner"]', '[class*="ccpa-notice"]',
        '[class*="banner-cookies"]', '[class*="notice-cookies"]',
        '[class*="cookie-message"]', '[class*="cookie-alert"]',
        // Role-based
        '[role="dialog"][class*="cookie"]',
        '[role="dialog"][class*="consent"]',
        '[role="dialog"][class*="privacy"]',
        '[role="dialog"][class*="banner"]',
        // Fixed position banners (common for cookie popups)
        'div[style*="position: fixed"][class*="cookie"]',
        'div[style*="position: fixed"][class*="consent"]',
        // Custom/proprietary cookie overlays
        '[class*="privacy-cookie"]',
        '[id*="CookiePolicy"]',
        '[class*="cookie-overlay"]',
        '[class*="cookie-policy"]',
        // CCPA / Do Not Sell banners (require additional consent context)
        '[class*="do-not-sell"][class*="banner"], [id*="do-not-sell"][class*="banner"]',
        '[class*="ccpa"][class*="banner"], [class*="ccpa"][class*="notice"]',
        '[class*="opt-out-banner"]',
        // Third-party hosted banners
        '[class*="cookieconsent"]', '[id*="cookieconsent"]',
        '[class*="cookie-law"]', '[id*="cookie-law"]',
        '[id*="cookie-script"]', '[class*="cookie-script"]',
        '[id*="cookielaw"]', '[class*="cookielaworg"]',
      ];

      // Batch selectors into a single query using :is() for better performance.
      // Split into chunks of 10 to avoid exceeding CSS selector length limits.
      const CHUNK = 10;
      for (let i = 0; i < bannerIndicators.length; i += CHUNK) {
        const chunk = bannerIndicators.slice(i, i + CHUNK);
        const combined = ':is(' + chunk.join(',') + ')';
        const el = document.querySelector(combined);
        if (el && Utils.isVisible(el)) return true;
      }

      // Also check inside Shadow DOMs (cache known hosts)
      // Use TreeWalker for better performance than querySelectorAll('*')
      if (!this._shadowHosts || Date.now() - this._shadowHostsTimestamp > 5000) {
        this._shadowHosts = [];
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot) this._shadowHosts.push(node);
        }
        this._shadowHostsTimestamp = Date.now();
      }
      for (const host of this._shadowHosts) {
        // Batch selectors into :is() groups of 10 (same pattern as light DOM scan)
        for (let i = 0; i < bannerIndicators.length; i += CHUNK) {
          const chunk = bannerIndicators.slice(i, i + CHUNK);
          const combined = ':is(' + chunk.join(',') + ')';
          const el = host.shadowRoot.querySelector(combined);
          if (el && Utils.isVisible(el)) return true;
        }
      }



      return false;
    },

    invalidateCache() {
      this._lastDetection = null;
      this._shadowHosts = null;
    },
  };

  // ─── CMP Handlers ───────────────────────────────────────────────────
  // Each handler implements:
  //   detect()  → boolean
  //   reject()  → Promise<{ rejected: number, vendorsUnticked: number }>
  //
  // Handlers are registered via registerHandler() for easy future
  // modularization. New CMPs can be added by calling
  // registerHandler(id, name, detectFn, rejectFn).


  const CMPHandlers = {};

  // Auto-registered detector functions (populated by registerHandler)
  const _detectorEntries = [];

  // Cached top CMP detectors (populated lazily)
  let _topDetectorsCache = null;

  // Auto-registered primary selectors (populated by registerHandler)
  const _autoSelectors = {};

  /**
   * Register a CMP handler. Optionally pass selectors and a detectCheck
   * function to auto-populate CMPDetector and _primarySelectors -- this
   * eliminates the triple-registration problem where adding a new CMP
   * required updating 3 separate places.
   *
   * @param {string} id          Unique CMP identifier
   * @param {string} name        Human-readable CMP name
   * @param {function} detect    Detection function (returns boolean)
   * @param {function} reject    Rejection function (returns { rejected, vendorsUnticked })
   * @param {object} [opts]      Optional: { selectors, detectCheck }
   *   - selectors: CSS selector string for _primarySelectors (banner visibility checks)
   *   - detectCheck: function for CMPDetector.detect() array (returns element/truthy)
   */
  function registerHandler(id, name, detect, reject, opts) {
    CMPHandlers[id] = {
      id,
      name,
      detect,
      async reject() {
        try {
          return await reject();
        } catch (e) {
          DebugLog.error(`Handler ${id} error:`, e.message);
          return { rejected: 0, vendorsUnticked: 0 };
        }
      },
    };
    // Auto-register detector and selectors if provided
    if (opts) {
      if (opts.detectCheck) {
        _detectorEntries.push({ id, name, check: opts.detectCheck });
      }

      if (opts.selectors) {
        _autoSelectors[id] = opts.selectors;
      }
    }
  }

  // ─── Common Handler Helpers ─────────────────────────────────────────
  // These reduce duplication across the 47+ CMP handlers.
  const HandlerHelpers = {
    /**
     * Standard reject flow: find reject button, click preferences, untick, save.
     * @param {Object} opts
     * @param {string|string[]} opts.rejectTexts - Texts for the reject button
     * @param {string|string[]} [opts.prefsTexts] - Texts for preferences/customize button
     * @param {string} [opts.containerSelector] - Selector for the CMP container
     * @param {string} [opts.saveTexts] - Texts for the save/confirm button
     * @returns {{rejected: number, vendorsUnticked: number}}
     */
    async standardReject({ rejectTexts, prefsTexts, containerSelector, saveTexts }) {
      const texts = Array.isArray(rejectTexts) ? rejectTexts : [rejectTexts];
      let rejected = 0;
      let vendorsUnticked = 0;
      const container = containerSelector
        ? (document.querySelector(containerSelector) || document)
        : document;

      // 1. Try direct reject button
      for (const text of texts) {
        const btn = Utils.findByText(text, container, 'button, a, span');
        if (btn) {
          btn.click();
          return { rejected: 1, vendorsUnticked: 0 };
        }
      }

      // 2. Try opening preferences, then reject/untick/save
      if (prefsTexts) {
        const pTexts = Array.isArray(prefsTexts) ? prefsTexts : [prefsTexts];
        for (const text of pTexts) {
          const btn = Utils.findByText(text, container, 'button, a, span');
          if (btn) {
            btn.click();
            await Utils.sleep(CONFIG.preRejectDelay);
            break;
          }
        }
        // Untick toggles
        const modals = document.querySelectorAll(
          '[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]'
        );
        for (const modal of modals) {
          vendorsUnticked += await Utils.untickAllToggles(modal);
        }
        // Try reject-all again
        for (const text of texts) {
          const btn = Utils.findByText(text, document, 'button, a, span');
          if (btn) { btn.click(); return { rejected: 1, vendorsUnticked }; }
        }
        // Try save button
        if (saveTexts) {
          const sTexts = Array.isArray(saveTexts) ? saveTexts : [saveTexts];
          for (const text of sTexts) {
            const btn = Utils.findByText(text, document, 'button, a');
            if (btn) { btn.click(); return { rejected: 1, vendorsUnticked }; }
          }
        }
      }

      return { rejected, vendorsUnticked };
    },
  };

  // ──────────────── OneTrust ────────────────────────
  /** OneTrust - API-first (OneTrustInterop), then DOM reject/prefs/save. #onetrust-banner-sdk */
  registerHandler('onetrust', 'OneTrust', function detect() {
    return !!(
      document.getElementById('onetrust-banner-sdk') ||
      document.getElementById('onetrust-consent-sdk') ||
      window.OneTrust ||
      window.OptanonActiveGroups
    );
  }, async function reject() {

    let rejected = 0;

    let vendorsUnticked = 0;

    // Strategy 1: Click "Reject All" directly
    const rejectBtn = document.getElementById('onetrust-reject-all-handler');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open preferences, untick everything, save
    const prefsBtn =
      document.getElementById('onetrust-pc-btn-handler') ||
      document.querySelector('.ot-pc-btn-handler');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Wait for the preference center to open
      const pcSdk = await Utils.waitForElement('#onetrust-pc-sdk', 5000);
      if (pcSdk) {
        // Click "Reject Non-Essential" button in the PC panel
        const pcRejectBtn = pcSdk.querySelector(
          '.ot-pc-refuse-all-handler, button.save-preference-btn-handler'
        );
        if (pcRejectBtn && pcRejectBtn.textContent.toLowerCase().includes('reject')) {
          pcRejectBtn.click();
          rejected++;
          return { rejected, vendorsUnticked };
        }

        // If no reject-all in PC, untick all category toggles manually




        const categorySwitches = pcSdk.querySelectorAll(
          '.category-switch-handler, input.ot-handler-toggle'
        );
        for (const sw of categorySwitches) {
          if (sw.checked && !sw.disabled) {
            sw.click();
            rejected++;
          }
        }

        // Expand and handle vendor list
        const vendorListBtn = pcSdk.querySelector(
          '.onetrust-vendors-list-handler, [class*="vendor-list"]'
        );
        if (vendorListBtn) {
          vendorListBtn.click();
          await Utils.sleep(CONFIG.dynamicLoadDelay);

          // Untick all vendor toggles
          const vendorContainer = pcSdk.querySelector(
            '#ot-hosts-list, #ot-vendor-list, .ot-vlst-cntr, [class*="vendor-list"]'
          );
          if (vendorContainer) {
            vendorsUnticked = await Utils.untickAllToggles(vendorContainer, {
              toggleSelector: '.ot-switch input, input[type="checkbox"], input[role="switch"]',
            });
          }

          // Also click "Select All Vendors" toggle off if it exists
          const selectAllVendors = pcSdk.querySelector(
            '#select-all-vendor-groups-handler, .ot-select-all-vendor'

          );
          if (selectAllVendors) {
            const selectAllSwitch = selectAllVendors.querySelector('input');
            if (selectAllSwitch && selectAllSwitch.checked) {
              selectAllSwitch.click();
            }
          }
        }

        // Click "Confirm My Choices" / "Save Preferences"
        const saveBtn = pcSdk.querySelector(
          '.save-preference-btn-handler, button.onetrust-close-btn-handler'
        );
        if (saveBtn) {
          saveBtn.click();
          rejected++;
        }
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#onetrust-banner-sdk',
    detectCheck: () => document.getElementById('onetrust-banner-sdk') || document.getElementById('onetrust-consent-sdk') || window.OneTrust || window.OptanonActiveGroups
  });

  // ──────────────── Fides (ethyca) ────────────────────────
  /** Fides (Ethyca) - Click reject/customize, untick, save. .fides-banner */
  registerHandler('fides', 'Fides (ethyca)', function detect() {
    return !!(
      document.getElementById('fides-banner-container') ||
      document.getElementById('fides-banner') ||
      document.getElementById('fides-modal')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Strategy 1: Direct "Reject All" button on banner
    const rejectBtn =
      document.getElementById('fides-reject-all-button') ||
      document.querySelector('button.fides-reject-all-button');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open preferences modal
    const prefsBtn =
      document.getElementById('fides-manage-preferences-button') ||
      document.querySelector('button.fides-manage-preferences-button');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Wait for modal
      const modal = await Utils.waitForElement('#fides-modal', 5000);
      if (modal) {
        // Untick all purpose toggles
        const toggles = modal.querySelectorAll(
          'input.fides-toggle-input[role="switch"]'
        );
        for (const toggle of toggles) {
          if (toggle.checked && !toggle.disabled) {
            toggle.click();
            rejected++;
            await Utils.sleep(CONFIG.vendorToggleDelay);
          }
        }

        // Go to vendors tab and untick all
        const vendorsTab = modal.querySelector(
          '#fides-tab-vendors, button[class*="tab"][class*="vendor"]'
        );
        if (vendorsTab) {
          vendorsTab.click();
          await Utils.sleep(CONFIG.dynamicLoadDelay);

          const vendorToggles = modal.querySelectorAll(
            'input.fides-toggle-input[role="switch"]'
          );
          for (const toggle of vendorToggles) {
            if (toggle.checked && !toggle.disabled) {
              toggle.click();
              vendorsUnticked++;
              await Utils.sleep(CONFIG.vendorToggleDelay);
            }
          }
        }

        // Click "Save" / "Confirm My Choices"
        const saveBtn =
          document.getElementById('fides-save-button') ||
          document.querySelector('button.fides-save-button');
        if (saveBtn) {
          saveBtn.click();
          rejected++;
        } else {
          // Try reject all in modal
          const modalReject =
            document.getElementById('fides-reject-all-button') ||
            document.querySelector('#fides-modal button.fides-reject-all-button');
          if (modalReject) {
            modalReject.click();
            rejected++;
          }
        }
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#fides-banner-container, #fides-banner',
    detectCheck: () => document.getElementById('fides-banner-container') || document.getElementById('fides-banner') || document.getElementById('fides-modal')
  });

  // ──────────────── Ketch ────────────────────────
  /** Ketch - Click reject/opt-out via API or DOM. #ketch-banner */
  registerHandler('ketch', 'Ketch', function detect() {
    return !!(
      document.getElementById('ketch-consent-banner') ||
      document.getElementById('ketch-banner') ||
      document.querySelector('[id*="ketch-consent"]') ||
      typeof window.ketchConsent !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Strategy 1: Click "Reject All" on banner
    const rejectBtn = document.getElementById('ketch-banner-button-secondary');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open preferences
    const prefsBtn = document.getElementById('ketch-banner-button-tertiary');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Untick all purpose toggles
      const toggles = document.querySelectorAll(
        '#ketch-preferences input[role="switch"], [id*="ketch"] input[role="switch"]'
      );
      for (const toggle of toggles) {
        const purpose = toggle.id;
        if (purpose === 'required') continue; // skip essential
        if (toggle.checked) {
          toggle.click();
          rejected++;
          await Utils.sleep(CONFIG.vendorToggleDelay);
        }
      }

      // Handle vendor list
      const vendorLink = Utils.findByText('vendors', document, 'button');
      if (vendorLink) {
        vendorLink.click();
        await Utils.sleep(CONFIG.dynamicLoadDelay);

        const vendorToggles = document.querySelectorAll(
          '[id*="ketch"] .ketch-peer, [id*="ketch"] input[role="switch"]'
        );
        for (const toggle of vendorToggles) {
          if (toggle.checked) {
            toggle.click();
            vendorsUnticked++;
            await Utils.sleep(CONFIG.vendorToggleDelay);
          }
        }
      }

      // Save choices
      const saveBtn = Utils.findByText('save your choices', document, 'button');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      } else {
        // Try reject all in preferences panel
        const rejectAll = Utils.findByText('reject all', document, 'button');
        if (rejectAll) {
          rejectAll.click();
          rejected++;
        }
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#ketch-consent-banner, #ketch-banner',
    detectCheck: () => document.getElementById('ketch-consent-banner') || document.getElementById('ketch-banner') || document.querySelector('[id*="ketch-consent"]') || typeof window.ketchConsent !== 'undefined'
  });

  // ──────────────── Cookiebot ────────────────────────
  /** Cookiebot - Decline + preferences path to untick vendors. #CybotCookiebotDialog */
  registerHandler('cookiebot', 'Cookiebot', function detect() {
    return !!(
      document.getElementById('CybotCookiebotDialog') ||
      window.Cookiebot ||
      document.querySelector('[data-cb-id]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Strategy 1: Click "Decline" / "Reject All"
    const declineBtn =
      document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll') ||
      document.querySelector('.CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll') ||
      Utils.findByText('decline', document.getElementById('CybotCookiebotDialog') || document, 'a, button');
    if (declineBtn) {
      declineBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open details and untick everything
    const detailsBtn =
      document.getElementById('CybotCookiebotDialogBodyLevelButtonDetails') ||
      document.querySelector('.CybotCookiebotDialogBodyLevelButtonDetails');
    if (detailsBtn) {
      detailsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      const dialog = document.getElementById('CybotCookiebotDialog');
      if (dialog) {
        // Untick all non-necessary toggles
        const toggles = dialog.querySelectorAll(
          'input[type="checkbox"]:not(#CybotCookiebotDialogBodyLevelButtonLevel0)'
        );
        for (const toggle of toggles) {
          if (toggle.checked && !toggle.disabled) {
            toggle.click();
            rejected++;
          }
        }

        // Handle vendor toggles in Cookiebot
        const vendorToggle = dialog.querySelectorAll(
          '.CybotCookiebotDialogDetailBodyContentCookieContainerCheckbox, [class*="vendor"] input[type="checkbox"]'
        );
        for (const toggle of vendorToggle) {
          if (toggle.checked && !toggle.disabled) {
            toggle.click();
            vendorsUnticked++;
          }
        }
      }

      // Save - use DECLINE ALL button, NOT "Allow All"
      const searchRoot = dialog || document.getElementById('CybotCookiebotDialog') || document;
      const saveBtn =
        document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll') ||
        Utils.findByText('save', searchRoot, 'a, button') ||
        Utils.findByText('confirm', searchRoot, 'a, button') ||
        Utils.findByText('submit', searchRoot, 'a, button');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#CybotCookiebotDialog',
    detectCheck: () => document.getElementById('CybotCookiebotDialog') || window.Cookiebot || document.querySelector('[data-cb-id]')
  });

  // ──────────────── Didomi ────────────────────────
  /** Didomi - Click disagree/purpose deny. #didomi-popup */
  registerHandler('didomi', 'Didomi', function detect() {
    return !!(
      document.getElementById('didomi-popup') ||
      document.getElementById('didomi-host') ||
      window.Didomi
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const popup = document.getElementById('didomi-popup');
    if (!popup) return { rejected, vendorsUnticked };

    // Strategy 1: Click "Disagree" / "Reject All"
    const disagreeBtn =
      document.getElementById('didomi-notice-disagree-button') ||
      popup.querySelector('[id*="disagree"], [id*="reject"]') ||
      Utils.findByText('disagree', popup, 'button, a') ||

      Utils.findByText('reject all', popup, 'button, a');

    if (disagreeBtn) {
      disagreeBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open preferences and untick
    const prefsBtn =
      document.getElementById('didomi-notice-learn-more-link') ||
      Utils.findByText('learn more', popup, 'button, a') ||
      Utils.findByText('manage', popup, 'button, a') ||
      Utils.findByText('preferences', popup, 'button, a');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Untick all purpose toggles
      const toggles = document.querySelectorAll(

        '#didomi-popup input[type="checkbox"], #didomi-popup [role="switch"]'
      );
      for (const toggle of toggles) {
        if (toggle.checked && !toggle.disabled) {
          toggle.click();
          rejected++;
        }
      }

      // Handle vendors tab
      const vendorsTab = Utils.findByText('vendors', document.getElementById('didomi-popup'), 'button, a, span');
      if (vendorsTab) {
        vendorsTab.click();
        await Utils.sleep(CONFIG.dynamicLoadDelay);

        const vendorToggles = document.querySelectorAll(
          '#didomi-popup input[type="checkbox"], #didomi-popup [role="switch"]'
        );
        for (const toggle of vendorToggles) {
          if (toggle.checked && !toggle.disabled) {
            toggle.click();
            vendorsUnticked++;
          }
        }
      }

      // Save/disagree
      const saveBtn =
        document.getElementById('didomi-notice-disagree-button') ||
        Utils.findByText('disagree', document.getElementById('didomi-popup'), 'button, a') ||
        Utils.findByText('save', document.getElementById('didomi-popup'), 'button, a') ||
        Utils.findByText('confirm', document.getElementById('didomi-popup'), 'button, a');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#didomi-popup',
    detectCheck: () => document.getElementById('didomi-popup') || document.getElementById('didomi-host') || window.didomi || window.Didomi
  });

  // ──────────────── Sourcepoint ────────────────────────
  /** Sourcepoint - Click reject, handle multi-frame. .message-container */
  registerHandler('sourcepoint', 'Sourcepoint', function detect() {
    return !!(
      document.querySelector('[id^="sp_message_iframe"]') ||
      document.querySelector('.sp_message_container') ||
      window._sp_
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Sourcepoint iframes are always cross-origin, so iframe.contentDocument
    // is always null. We skip iframe DOM access entirely and rely on the
    // direct (non-iframe) approach and the TCF API below.

    // Try direct approach (non-iframe)
    const spContainer =
      document.querySelector('.sp_message_container') ||
      document.querySelector('[class*="sp_veil"]');
    if (spContainer) {
      const rejectBtn =
        Utils.findByText('reject', spContainer, 'button, a') ||
        Utils.findByText('do not sell', spContainer, 'button, a');
      if (rejectBtn) {
        rejectBtn.click();
        rejected++;
      }
    }

    // API-based: use TCF API to set consent
    if (rejected === 0 && window.__tcfapi) {
      try {
        // Try non-standard 'rejectAll' (supported by Sourcepoint and some CMPs)
        window.__tcfapi('rejectAll', 2, () => {});
        rejected++;
      } catch (e) {
        // Fallback: standard TCF v2 approach via addEventListener + purpose denial
        try {
          window.__tcfapi('addEventListener', 2, (tcData, success) => {
            if (success && tcData.eventStatus === 'tcloaded') {
              // Remove listener and signal rejection via custom purpose consent
              window.__tcfapi('removeEventListener', 2, () => {}, tcData.listenerId);
            }
          });
        } catch (e2) { /* ignore */ }
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '.sp_message_container, [class*="sp_veil"]',
    detectCheck: () => document.querySelector('[id^="sp_message_iframe"]') || document.querySelector('.sp_message_container') || window._sp_
  });

  // ──────────────── TrustArc ────────────────────────
  /** TrustArc - API (truste.eu) then DOM reject. .truste-banner */
  registerHandler('trustarc', 'TrustArc', function detect() {
    return !!(
      document.getElementById('truste-consent-track') ||
      document.getElementById('trustarc-banner') ||
      document.querySelector('.trustarc-banner, .truste-banner') ||
      window.truste
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Click "Reject All" / "Manage Preferences"
    const container =
      document.getElementById('truste-consent-track') ||
      document.querySelector('.trustarc-banner, .truste-banner');

    if (container) {
      const rejectBtn =
        container.querySelector('[class*="reject"], button[class*="reject"]') ||
        Utils.findByText('reject all', container, 'button, a') ||
        Utils.findByText('decline', container, 'button, a') ||
        Utils.findByText('opt out', container, 'button, a');
      if (rejectBtn) {
        rejectBtn.click();
        rejected++;
        return { rejected, vendorsUnticked };
      }

      // Open preferences
      const prefsBtn =
        Utils.findByText('manage preferences', container, 'button, a') ||
        Utils.findByText('cookie settings', container, 'button, a') ||
        Utils.findByText('more options', container, 'button, a');
      if (prefsBtn) {
        prefsBtn.click();
        await Utils.sleep(CONFIG.dynamicLoadDelay);

        // Untick all
        const toggles = document.querySelectorAll(
          '#truste-consent-track input[type="checkbox"], #truste-consent-track input[role="switch"]'
        );

        for (const toggle of toggles) {
          if (toggle.checked && !toggle.disabled) {
            toggle.click();
            rejected++;
          }
        }

        // Save
        const saveBtn = Utils.findByText('submit', document, 'button, a') ||
          Utils.findByText('save', document, 'button, a') ||
          Utils.findByText('confirm', document, 'button, a');
        if (saveBtn) {
          saveBtn.click();
          rejected++;
        }
      }
    }


    return { rejected, vendorsUnticked };

  }, {
    selectors: '#truste-consent-track, .trustarc-banner',
    detectCheck: () => document.getElementById('truste-consent-track') || document.querySelector('.trustarc-banner') || window.truste
  });

  // ──────────────── Quantcast ────────────────────────
  /** Quantcast Choice - Click reject/purpose deny. .qc-cmp2-summary-buttons */
  registerHandler('quantcast', 'Quantcast', function detect() {

    return !!(

      document.querySelector('.qc-cmp2-container') ||

      document.querySelector('[class*="qc-cmp"]') ||
      window.__qcmp
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const container = document.querySelector('.qc-cmp2-container, [class*="qc-cmp"]');
    if (!container) return { rejected, vendorsUnticked };

    // Strategy 1: "Reject All" button
    const rejectBtn =
      container.querySelector('[class*="reject"], button[class*="reject"]') ||
      Utils.findByText('reject all', container, 'button, span') ||
      Utils.findByText('i do not accept', container, 'button, span');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open preferences

    const prefsBtn =
      Utils.findByText('manage', container, 'button, span') ||
      Utils.findByText('preferences', container, 'button, span') ||
      Utils.findByText('customize', container, 'button, span');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Toggle off all purposes
      const toggles = container.querySelectorAll(
        'input[type="checkbox"], [role="switch"], .qc-cmp2-toggle'
      );
      for (const toggle of toggles) {
        const input = toggle.querySelector('input') || toggle;
        if (input.checked && !input.disabled) {
          input.click();
          rejected++;
        }
      }

      // Save
      const saveBtn =
        Utils.findByText('save', container, 'button, span') ||
        Utils.findByText('confirm', container, 'button, span');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '.qc-cmp2-container',
    detectCheck: () => document.querySelector('.qc-cmp2-container') || window.__qc
  });

  // ──────────────── Usercentrics ────────────────────────
  /** Usercentrics - API (UC_UI) then DOM. #usercentrics-root */
  registerHandler('usercentrics', 'Usercentrics', function detect() {
    return !!(

      document.getElementById('usercentrics-root') ||
      document.querySelector('[data-testid="uc-banner"]') ||
      window.UC_UI
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Preferred path: use UC_UI API (works regardless of shadow root mode)
    if (window.UC_UI) {
      try {
        window.UC_UI.rejectAll();
        rejected++;
        return { rejected, vendorsUnticked };
      } catch (e) { /* CMP handler error - expected in non-matching pages */ }
    }

    // Fallback: try DOM access (only works with open shadow root)
    const root = document.getElementById('usercentrics-root');
    const container = (root && root.shadowRoot) ? root.shadowRoot : document;

    // Click "Deny All" / "Reject All"
    const denyBtn =
      (container.querySelector ? container : document).querySelector(
        '[data-testid="uc-deny-all-button"], button[class*="deny"]'
      ) ||
      Utils.findByText('deny all', container.querySelector ? container : document, 'button') ||
      Utils.findByText('reject all', container.querySelector ? container : document, 'button');
    if (denyBtn) {
      denyBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Open more details
    const moreBtn =
      (container.querySelector ? container : document).querySelector(
        '[data-testid="uc-more-button"]'
      ) ||
      Utils.findByText('more', container.querySelector ? container : document, 'button');
    if (moreBtn) {
      moreBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Toggle all off
      const toggles = (container.querySelectorAll ? container : document).querySelectorAll(
        'input[type="checkbox"], input[role="switch"]'
      );
      for (const toggle of toggles) {
        if (toggle.checked && !toggle.disabled) {
          toggle.click();
          rejected++;
        }
      }

      // Save
      const saveBtn =
        Utils.findByText('save', container.querySelector ? container : document, 'button') ||
        Utils.findByText('save preferences', container.querySelector ? container : document, 'button');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#usercentrics-root',
    detectCheck: () => document.getElementById('usercentrics-root') || window.UC_UI
  });

  // ──────────────── CookieYes ────────────────────────
  /** CookieYes - standardReject. .cky-consent-bar */
  registerHandler('cookieyes', 'CookieYes', function detect() {
    return !!(
      document.getElementById('cky-btn-reject') ||
      document.querySelector('.cky-consent-bar') ||
      document.querySelector('[data-cky-tag]')
    );
  }, async function reject() {
    return HandlerHelpers.standardReject({
      rejectTexts: ['reject all', 'reject', 'necessary only'],
      prefsTexts: ['manage', 'customize', 'settings'],
      containerSelector: '.cky-consent-bar',
      saveTexts: ['save preferences', 'save', 'confirm', 'reject all'],
    });
  }, {
    selectors: '#ckyBanner, .cky-banner',
    detectCheck: () => document.getElementById('ckyBanner') || document.querySelector('.cky-banner') || window.CkyConsent
  });

  // ──────────────── Iubenda ────────────────────────
  /** Iubenda - Click reject/customize. .iubenda-cs-banner */
  registerHandler('iubenda', 'Iubenda', function detect() {
    return !!(
      document.querySelector('.iubenda-cs-banner') ||
      document.getElementById('iubenda-cs-banner') ||
      window._iub
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const banner = document.querySelector('.iubenda-cs-banner') ||
      document.getElementById('iubenda-cs-banner');

    if (banner) {
      // Click reject/customize
      const rejectBtn =
        banner.querySelector('[class*="reject"], button[class*="ibtn"]') ||
        Utils.findByText('reject', banner, 'button, a') ||
        Utils.findByText('customize', banner, 'button, a');
      if (rejectBtn) {
        rejectBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#iubenda-cs-banner, .iubenda-cs-banner',
    detectCheck: () => document.getElementById('iubenda-cs-banner') || document.querySelector('.iubenda-cs-banner') || window._iub
  });

  // ──────────────── ConsentManager ────────────────────────
  /** ConsentManager - Click reject/save via dialog. #cmpbox */
  registerHandler('consentmanager', 'ConsentManager', function detect() {
    return !!(
      document.getElementById('cmpbox') ||
      document.getElementById('cmpwrapper') ||
      document.querySelector('.cmpbox[role="dialog"]') ||
      document.querySelector('[class*="cmpbox"]') ||
      window.__cmp ||
      window.cmp
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const box = document.getElementById('cmpbox');
    if (!box) return { rejected, vendorsUnticked };

    // Strategy 1: Click "Go to the website" / "Reject All" / "Only necessary"
    // ConsentManager's "Go to the website" button IS the reject (proceed with essential only)
    const rejectBtn =
      box.querySelector('a.cmpboxbtnsave, a.cmptxt_btn_save') ||
      box.querySelector('a.cmpboxbtnreject') ||
      box.querySelector('[class*="cmpboxbtn"][class*="save"]') ||
      Utils.findByText('go to the website', box, 'a, button, span') ||
      Utils.findByText('reject all', box, 'a, button, span') ||
      Utils.findByText('only necessary', box, 'a, button, span') ||
      Utils.findByText('deny', box, 'a, button, span') ||
      Utils.findByText('do not consent', box, 'a, button, span');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open settings and untick all vendor toggles
    const settingsBtn =
      box.querySelector('a.cmpboxbtncustom, a.cmptxt_btn_settings') ||
      Utils.findByText('settings', box, 'a, button, span') ||
      Utils.findByText('manage', box, 'a, button, span') ||
      Utils.findByText('customise', box, 'a, button, span') ||
      Utils.findByText('customize', box, 'a, button, span');
    if (settingsBtn) {
      settingsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      // Navigate through each purpose tab and toggle all vendors off
      // Tabs: c51 (Function - always on), c52 (Marketing), c54 (Measurement)
      const tabs = box.querySelectorAll('div.cmpboxnaviitem[role="button"]');
      for (const tab of tabs) {
        const purpose = tab.getAttribute('data-cmp-purpose') || '';
        // Skip "Function" / "Essential" tabs (c51) - those vendors can't be toggled
        if (purpose === 'c51' || purpose === 'companyinfo') continue;

        tab.click();
        await Utils.sleep(CONFIG.dynamicLoadDelay);

        // Click the "toggle all vendors" switch off
        const toggleAll = box.querySelector('a[data-cmp-vendor="all"]');
        if (toggleAll) {
          const isChecked = toggleAll.getAttribute('aria-checked') === 'true';
          if (isChecked) {
            toggleAll.click();
            await Utils.sleep(CONFIG.handlerWaitDelay);
          }
        }

        // Untick individual vendor checkboxes via aria-checked and count them
        const vendorToggles = box.querySelectorAll('a[role="checkbox"][data-cmp-vendor]');
        for (const toggle of vendorToggles) {
          if (toggle.getAttribute('data-cmp-vendor') === 'all') continue;
          const isChecked = toggle.getAttribute('aria-checked') === 'true';
          if (isChecked) {
            toggle.click();
            vendorsUnticked++;
            await Utils.sleep(CONFIG.vendorToggleDelay);
          }
        }
      }

      // Save preferences
      const saveBtn =
        box.querySelector('a.cmptxt_btn_save2, a.cmpboxbtnyescustomchoices') ||
        Utils.findByText('save the selected', box, 'a, button, span') ||
        Utils.findByText('save', box, 'a, button, span') ||
        Utils.findByText('confirm', box, 'a, button, span');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cmpbox, #cmpwrapper, .cmpbox[role="dialog"]',
    detectCheck: () => document.getElementById('cmpbox') || document.getElementById('cmpwrapper') || document.querySelector('.cmpbox[role="dialog"]') || window.__cmp || window.cmp
  });

  // ──────────────── Sirdata ────────────────────────
  /** Sirdata - Click reject buttons. .sirdata-cmp */
  registerHandler('sirdata', 'Sirdata', function detect() {
    return !!(
      document.querySelector('[class*="sdrn-"]') ||

      document.getElementById('sd-cmp')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const container = document.getElementById('sd-cmp') ||
      document.querySelector('[class*="sdrn-cmp"]');
    if (!container) return { rejected, vendorsUnticked };

    const rejectBtn =
      container.querySelector('[class*="reject"]') ||
      Utils.findByText('reject', container, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }


    return { rejected, vendorsUnticked };
  }, {

    selectors: '#sd-cmp-dialog',
    detectCheck: () => document.querySelector('#sd-cmp-dialog') || document.querySelector('.sd-cmp') || window.SDDAN
  });

  // ──────────────── Ezoic ────────────────────────
  /** Ezoic - Click reject/opt-out. #ez-consent-dialog */
  registerHandler('ezcookie', 'Ezoic', function detect() {
    return !!(
      document.querySelector('[class*="ez-cookie"]') ||
      document.getElementById('ez-cookie-dialog')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const container = document.querySelector('[class*="ez-cookie"]') ||
      document.getElementById('ez-cookie-dialog');
    if (!container) return { rejected, vendorsUnticked };

    const rejectBtn =
      container.querySelector('[class*="reject"], [class*="decline"]') ||
      Utils.findByText('reject', container, 'button, a') ||
      Utils.findByText('decline', container, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#ez-cookie-dialog, .ez-cookie-dialog',
    detectCheck: () => document.querySelector('#ez-cookie-dialog') || document.querySelector('.ez-cookie-dialog') || window.ezCMP
  });

  // ──────────────── Borlabs Cookie ────────────────────────
  /** Borlabs Cookie - Click reject/customize/save. #BorlabsCookieBox */
  registerHandler('borlabs', 'Borlabs Cookie', function detect() {
    return !!(
      document.querySelector('#BorlabsCookieBox') ||
      window.BorlabsCookie
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const box = document.querySelector('#BorlabsCookieBox');
    if (!box) return { rejected, vendorsUnticked };

    // Click "Accept Only Essential"
    const rejectBtn =
      box.querySelector('[class*="reject"], [id*="reject"]') ||
      Utils.findByText('accept only essential', box, 'button, a') ||
      Utils.findByText('reject', box, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Open preferences
    const prefsBtn =
      box.querySelector('[class*="customize"], [id*="customize"]') ||
      Utils.findByText('customize', box, 'button, a') ||
      Utils.findByText('individual', box, 'button, a');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      const toggles = document.querySelectorAll(
        '#BorlabsCookieBox input[type="checkbox"]:not([disabled])'
      );
      for (const toggle of toggles) {
        if (toggle.checked) {
          toggle.click();
          rejected++;
        }
      }

      const saveBtn =
        Utils.findByText('save', document.querySelector('#BorlabsCookieBox'), 'button, a');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#BorlabsCookieBox',
    detectCheck: () => document.getElementById('BorlabsCookieBox') || window.BorlabsCookie
  });

  // ──────────────── LGCookiesLaw (PrestaShop) ────────────────────────
  /** LGCookiesLaw (PrestaShop) - Click reject/save. #lgcookieslaw_banner */
  registerHandler('lgcookieslaw', 'LGCookiesLaw (PrestaShop)', function detect() {
    return !!(
      document.getElementById('lgcookieslaw_banner') ||
      document.querySelector('.lgcookieslaw-banner') ||
      document.querySelector('[class*="lgcookieslaw"]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const banner = document.getElementById('lgcookieslaw_banner');
    if (!banner) return { rejected, vendorsUnticked };

    // Strategy 1: Click "Reject All" button directly
    const rejectBtn = banner.querySelector('.lgcookieslaw-reject-button');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Strategy 2: Open "Customize cookies" modal, untick all, save
    const customizeLink = document.getElementById('lgcookieslaw_customize_cookies_link') ||
      banner.querySelector('.lgcookieslaw-customize-cookies-link');
    if (customizeLink) {
      customizeLink.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      const modal = document.getElementById('lgcookieslaw_modal');
      if (modal) {
        // Untick all purpose toggles that aren't disabled
        const purposeInputs = modal.querySelectorAll('input.lgcookieslaw-purpose');
        for (const input of purposeInputs) {
          if (!input.disabled && input.checked) {
            input.click();
            vendorsUnticked++;
          }
        }

        // Click "Reject All" in the modal footer
        const modalRejectBtn = modal.querySelector('.lgcookieslaw-reject-button');
        if (modalRejectBtn) {
          modalRejectBtn.click();
          rejected++;
        } else {
          // Try "Save" / partial accept as last resort
          const partialBtn = modal.querySelector('.lgcookieslaw-partial-accept-button');
          if (partialBtn) {
            partialBtn.click();
            rejected++;
          }
        }
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#lgcookieslaw_banner, .lgcookieslaw-banner, [class*="lgcookieslaw"]',
    detectCheck: () => document.getElementById('lgcookieslaw_banner') || document.querySelector('.lgcookieslaw-banner') || document.querySelector('[class*="lgcookieslaw"]')
  });

  // ──────────────── Complianz ────────────────────────
  /** Complianz (WP) - Click reject/manage. #cmplz-cookiebanner */
  registerHandler('complianz', 'Complianz', function detect() {
    return !!(


      document.querySelector('#cmplz-cookiebanner') ||
      document.querySelector('.cmplz-cookiebanner') ||

      typeof window.cmplz !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#cmplz-cookiebanner') ||
                   document.querySelector('.cmplz-cookiebanner');
    if (!banner) return { rejected, vendorsUnticked };

    // Try direct reject button
    const rejectBtn =

      banner.querySelector('.cmplz-reject') ||
      banner.querySelector('.cmplz-btn-reject') ||
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a') ||
      Utils.findByText('weiger', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();

      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Try manage settings -> untick toggles -> save

    const manageBtn = Utils.findByText('manage', banner, 'button, a') ||
                      Utils.findByText('preferences', banner, 'button, a');
    if (manageBtn) {
      manageBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);
      const unticked = await Utils.untickAllToggles(document);
      vendorsUnticked += unticked;
      const saveBtn = Utils.findByText('save', document, 'button, a') ||
                      Utils.findByText('opslaan', document, 'button, a');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }

    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cmplz-cookiebanner, .cmplz-cookiebanner',
    detectCheck: () => document.querySelector('#cmplz-cookiebanner') || document.querySelector('.cmplz-cookiebanner') || window.cmplz
  });

  // ──────────────── Cookie Notice (Humanityco) ────────────────────────
  /** Cookie Notice (WP) - Click reject/decline. #cookie-notice */
  registerHandler('cookienotice', 'Cookie Notice', function detect() {

    return !!(
      document.querySelector('#cookie-notice') ||
      document.querySelector('.cookie-notice-container') ||
      document.querySelector('#cn-notice-content')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#cookie-notice') ||
                   document.querySelector('.cookie-notice-container');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      document.querySelector('#cn-refuse-cookie') ||
      banner.querySelector('.cn-reject-cookie') ||
      banner.querySelector('.cn-refuse-cookie') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('refuse', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cookie-notice, .cookie-notice-container',
    detectCheck: () => document.querySelector('#cookie-notice') || document.querySelector('.cookie-notice-container') || document.querySelector('#cn-notice-content')
  });

  // ──────────────── Osano ────────────────────────
  /** Osano - Click reject/customize. .osano-cm-dialog */
  registerHandler('osano', 'Osano', function detect() {
    return !!(
      document.querySelector('.osano-cm-dialog') ||
      typeof window.Osano !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const dialog = document.querySelector('.osano-cm-dialog');
    if (!dialog) return { rejected, vendorsUnticked };

    const rejectBtn =
      dialog.querySelector('.osano-cm-denyAll') ||
      dialog.querySelector('.osano-cm-deny') ||
      dialog.querySelector('.osano-cm-close') ||
      Utils.findByText('reject all', dialog, 'button') ||
      Utils.findByText('deny all', dialog, 'button');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '.osano-cm-dialog',
    detectCheck: () => document.querySelector('.osano-cm-dialog') || window.Osano
  });

  // ──────────────── Termly ────────────────────────
  /** Termly - Click reject/customize. #termly-cookie-consent */
  registerHandler('termly', 'Termly', function detect() {
    return !!(
      document.querySelector('#termly-consent-content') ||
      document.querySelector('[data-testid="termly-consent"]') ||
      typeof window.Termly !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const container = document.querySelector('#termly-consent-content') ||
                      document.querySelector('[data-testid="termly-consent"]') ||
                      document.querySelector('.termly-consent');
    if (!container) return { rejected, vendorsUnticked };

    const rejectBtn =
      container.querySelector('.termly-reject-all') ||
      Utils.findByText('reject all', container, 'button') ||
      Utils.findByText('reject', container, 'button') ||
      Utils.findByText('decline', container, 'button');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#termly-consent-content, [data-testid="termly-consent"]',
    detectCheck: () => document.querySelector('#termly-consent-content') || document.querySelector('[data-testid="termly-consent"]') || window.Termly
  });

  // ──────────────── Cookie Information ────────────────────────
  /** Cookie Info - Click reject/decline. #cookieinfo */
  registerHandler('cookieinfo', 'Cookie Information', function detect() {
    return !!(
      document.querySelector('#coiOverlay') ||
      document.querySelector('.coi-banner') ||
      typeof window.CookieInformation !== 'undefined' ||
      typeof window.CookieInformationConsent !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const overlay = document.querySelector('#coiOverlay') ||
                    document.querySelector('.coi-banner');
    if (!overlay) return { rejected, vendorsUnticked };

    const rejectBtn =
      overlay.querySelector('.coi-banner__reject') ||
      overlay.querySelector('.coi-reject') ||
      Utils.findByText('reject all', overlay, 'button, a') ||
      Utils.findByText('reject', overlay, 'button, a') ||
      Utils.findByText('afvis alle', overlay, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#coiOverlay, .coi-banner',
    detectCheck: () => document.querySelector('#coiOverlay') || document.querySelector('.coi-banner') || window.CookieInformation || window.CookieInformationConsent
  });

  // ──────────────── Real Cookie Banner ────────────────────────
  /** Real Cookie Banner - Click reject/essential only. .rcb-banner */
  registerHandler('realcookiebanner', 'Real Cookie Banner', function detect() {
    return !!(
      document.querySelector('#real-cookie-banner') ||
      document.querySelector('.real-cookie-banner') ||
      typeof window.realCookieBanner !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#real-cookie-banner') ||
                   document.querySelector('.real-cookie-banner');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[data-reject]') ||
      banner.querySelector('.reject') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('ablehnen', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#real-cookie-banner, .real-cookie-banner',
    detectCheck: () => document.querySelector('#real-cookie-banner') || document.querySelector('.real-cookie-banner') || window.realCookieBanner
  });

  // ──────────────── Moove GDPR ────────────────────────
  /** Moove GDPR (WP) - Click reject/save. #moove_gdpr_cookie_modal */
  registerHandler('moovegdpr', 'Moove GDPR', function detect() {
    return !!(
      document.querySelector('#moove_gdpr_cookie_modal') ||
      document.querySelector('.moove-gdpr-infobar') ||
      document.querySelector('#moove_gdpr_cookie_info_bar')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Try reject on the info bar first
    const infoBar = document.querySelector('#moove_gdpr_cookie_info_bar') ||
                    document.querySelector('.moove-gdpr-infobar');
    if (infoBar) {
      const rejectBtn =
        infoBar.querySelector('.moove-gdpr-infobar-reject-btn') ||
        infoBar.querySelector('[class*="reject"]') ||
        Utils.findByText('reject', infoBar, 'button, a') ||
        Utils.findByText('decline', infoBar, 'button, a');
      if (rejectBtn) {
        rejectBtn.click();
        rejected++;
        return { rejected, vendorsUnticked };
      }
    }

    // Otherwise open the modal and disable all categories
    const modal = document.querySelector('#moove_gdpr_cookie_modal');
    if (modal) {
      // Open modal if not visible
      if (!Utils.isVisible(modal)) {
        const settingsBtn = infoBar ?
          (infoBar.querySelector('[class*="settings"]') ||
           Utils.findByText('settings', infoBar, 'button, a') ||
           Utils.findByText('change', infoBar, 'button, a')) : null;
        if (settingsBtn) settingsBtn.click();
        await Utils.sleep(CONFIG.dynamicLoadDelay);
      }

      // Untick third-party toggles
      const toggles = modal.querySelectorAll('.moove-gdpr-form input[type="checkbox"]:not([disabled])');
      for (const toggle of toggles) {
        if (toggle.checked) {
          toggle.click();
          vendorsUnticked++;
        }
      }

      // Save
      const saveBtn = modal.querySelector('.moove-gdpr-modal-save-settings') ||
                      Utils.findByText('save', modal, 'button, a');
      if (saveBtn) {
        saveBtn.click();
        rejected++;
      }
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#moove_gdpr_cookie_modal, .moove-gdpr-infobar',
    detectCheck: () => document.querySelector('#moove_gdpr_cookie_modal') || document.querySelector('.moove-gdpr-infobar') || document.querySelector('#moove_gdpr_cookie_info_bar')
  });

  // ──────────────── CookieAdmin ────────────────────────
  /** Cookie Admin - Click reject/customize. .cookie-admin-banner */
  registerHandler('cookieadmin', 'CookieAdmin', function detect() {
    return !!(
      document.querySelector('#cookieadmin-banner') ||
      document.querySelector('.cookieadmin') ||
      document.querySelector('[id^="cookieadmin"]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#cookieadmin-banner') ||
                   document.querySelector('.cookieadmin') ||
                   document.querySelector('[id^="cookieadmin"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      banner.querySelector('[id*="reject"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a') ||
      Utils.findByText('only necessary', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cookieadmin-banner, .cookieadmin',
    detectCheck: () => document.querySelector('#cookieadmin-banner') || document.querySelector('.cookieadmin') || document.querySelector('[id^="cookieadmin"]')
  });

  // ──────────────── Beautiful Cookie Consent ────────────────────────
  /** Beautiful Cookie Banner - Click reject/customize. .bcb-banner */
  registerHandler('beautifulcookie', 'Beautiful Cookie Consent', function detect() {
    const el = document.querySelector('#ccc');
    if (el && (el.querySelector('.ccc-wrapper') || el.className.includes('ccc') || el.querySelector('[class*="cookie"]') || el.querySelector('button'))) return true;
    return !!(
      document.querySelector('#ccc-icon') ||
      document.querySelector('.ccc-wrapper')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Open the settings panel
    const icon = document.querySelector('#ccc-icon') ||
                 document.querySelector('#ccc-open');
    if (icon) {
      icon.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);
    }

    const container = document.querySelector('#ccc') ||
                      document.querySelector('.ccc-wrapper');
    if (!container) return { rejected, vendorsUnticked };

    // Try reject button
    const rejectBtn =
      container.querySelector('[class*="reject"]') ||

      Utils.findByText('reject', container, 'button, a') ||
      Utils.findByText('only necessary', container, 'button, a') ||
      Utils.findByText('essential only', container, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Untick toggles and save
    const unticked = await Utils.untickAllToggles(container);
    vendorsUnticked += unticked;
    const saveBtn = Utils.findByText('save', container, 'button, a');
    if (saveBtn) {
        saveBtn.click();
        rejected++;

      }

    return { rejected, vendorsUnticked };

  }, {
    selectors: '#ccc-icon, .ccc-wrapper',
    detectCheck: () => { const el = document.querySelector('#ccc'); if (el && (el.querySelector('.ccc-wrapper') || el.className.includes('ccc') || el.querySelector('[class*="cookie"]') || el.querySelector('button'))) return el; return document.querySelector('#ccc-icon') || document.querySelector('.ccc-wrapper'); }
  });

  // ──────────────── Pressidium Cookie Consent ────────────────────────
  /** Pressidium CC - Click reject/customize. .pressidium-cookie-consent */
  registerHandler('pressidium', 'Pressidium', function detect() {
    return !!(
      document.querySelector('#pressidium-cc') ||
      document.querySelector('.pressidium-cookie-consent')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#pressidium-cc') ||
                   document.querySelector('.pressidium-cookie-consent');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('necessary only', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#pressidium-cc, .pressidium-cookie-consent',
    detectCheck: () => document.querySelector('#pressidium-cc') || document.querySelector('.pressidium-cookie-consent')
  });

  // ──────────────── WPLP Cookie Consent ────────────────────────
  /** WP Libre Privacy - Click reject. #wplp-cookie-banner */
  registerHandler('wplpcookie', 'WPLP Cookie Consent', function detect() {
    return !!(
      document.querySelector('.gdpr-cookie-consent') ||
      document.querySelector('#gdpr-cookie-consent') ||
      document.querySelector('[class*="wplp-cookie"]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('.gdpr-cookie-consent') ||
                   document.querySelector('#gdpr-cookie-consent');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '.gdpr-cookie-consent, #gdpr-cookie-consent',
    detectCheck: () => document.querySelector('.gdpr-cookie-consent') || document.querySelector('#gdpr-cookie-consent') || document.querySelector('[class*="wplp-cookie"]')
  });

  // ──────────────── Axeptio ────────────────────────
  /** Axeptio - Click reject/all reject. #axeptio_overlay */
  registerHandler('axeptio', 'Axeptio', function detect() {
    return !!(
      document.querySelector('#axeptio_overlay') ||
      document.querySelector('.axeptio_main') ||
      typeof window.axeptio !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const overlay = document.querySelector('#axeptio_overlay') ||
                    document.querySelector('.axeptio_main');
    if (!overlay) return { rejected, vendorsUnticked };

    const rejectBtn =
      overlay.querySelector('[class*="reject"]') ||
      overlay.querySelector('[class*="deny"]') ||
      overlay.querySelector('[class*="refuse"]') ||
      Utils.findByText('reject all', overlay, 'button, a') ||
      Utils.findByText('reject', overlay, 'button, a') ||
      Utils.findByText('refuser', overlay, 'button, a') ||
      Utils.findByText('deny', overlay, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#axeptio_overlay, .axeptio_main',
    detectCheck: () => document.querySelector('#axeptio_overlay') || document.querySelector('.axeptio_main') || window.axeptio
  });

  // ──────────────── Admiral ────────────────────────
  /** Admiral - Click reject/opt-out. .admiral-banner */
  registerHandler('admiral', 'Admiral', function detect() {
    return !!(
      document.querySelector('[class*="admiral"][class*="banner"]') ||
      document.querySelector('[class*="admiral"][class*="consent"]') ||
      document.querySelector('[class*="admiral"][class*="privacy"]') ||
      (typeof window.admiral !== 'undefined' && document.querySelector('[class*="admiral"], [id*="admiral"]'))
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="admiral"][class*="banner"]') ||
                   document.querySelector('[class*="admiral"][class*="consent"]') ||
                   document.querySelector('[id*="admiral"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      banner.querySelector('[class*="deny"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="admiral"][class*="banner"], [class*="admiral"][class*="consent"]',
    detectCheck: () => document.querySelector('[class*="admiral"][class*="banner"]') || document.querySelector('[class*="admiral"][class*="consent"]') || document.querySelector('[class*="admiral"][class*="privacy"]') || (window.admiral && document.querySelector('[class*="admiral"], [id*="admiral"]'))
  });

  // ──────────────── Commanders Act ────────────────────────
  /** Commanders Act - Click reject/purpose deny. #tc-privacy-wrapper */
  registerHandler('commandersact', 'Commanders Act', function detect() {
    return !!(
      document.querySelector('#tc-privacy-wrapper') ||
      document.querySelector('[class*="tc-privacy"]') ||
      typeof window.tC !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const wrapper = document.querySelector('#tc-privacy-wrapper') ||
                    document.querySelector('[class*="tc-privacy"]');
    if (!wrapper) return { rejected, vendorsUnticked };

    const rejectBtn =
      wrapper.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', wrapper, 'button, a') ||
      Utils.findByText('reject', wrapper, 'button, a') ||
      Utils.findByText('refuser', wrapper, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#tc-privacy-wrapper, [class*="tc-privacy"]',
    detectCheck: () => document.querySelector('#tc-privacy-wrapper') || document.querySelector('[class*="tc-privacy"]') || window.tC
  });

  // ──────────────── CookieFirst ────────────────────────
  /** CookieFirst - standardReject. .cookiefirst-banner */
  registerHandler('cookiefirst', 'CookieFirst', function detect() {
    return !!(
      document.querySelector('#cookiefirst-modal') ||
      document.querySelector('.cookiefirst') ||

      typeof window.cookiefirst !== 'undefined'
    );
  }, async function reject() {
    return HandlerHelpers.standardReject({
      rejectTexts: ['reject all', 'reject', 'necessary only'],
      containerSelector: '#cookiefirst-modal, .cookiefirst',
    });
  }, {
    selectors: '#cookiefirst-modal, .cookiefirst',
    detectCheck: () => document.querySelector('#cookiefirst-modal') || document.querySelector('.cookiefirst') || window.cookiefirst
  });

  // ──────────────── CookieHub ────────────────────────
  /** CookieHub - standardReject. #cookiehub-dialog */
  registerHandler('cookiehub', 'CookieHub', function detect() {
    return !!(
      document.querySelector('#cookiehub-dialog') ||
      document.querySelector('.cookiehub') ||
      typeof window.cookiehub !== 'undefined'
    );
  }, async function reject() {
    return HandlerHelpers.standardReject({
      rejectTexts: ['reject all', 'necessary only', 'reject'],
      containerSelector: '#cookiehub-dialog, .cookiehub',
    });
  }, {
    selectors: '#cookiehub-dialog, .cookiehub',
    detectCheck: () => document.querySelector('#cookiehub-dialog') || document.querySelector('.cookiehub') || window.cookiehub
  });

  // ──────────────── Gravito ────────────────────────
  /** Gravito - Click reject/decline. .gravito-cmp */
  registerHandler('gravito', 'Gravito', function detect() {
    return !!(
      document.querySelector('.gravito-cmp') ||
      document.querySelector('[id*="gravito"]') ||
      typeof window.gravito !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('.gravito-cmp') ||
                   document.querySelector('[id*="gravito"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '.gravito-cmp, [id*="gravito"]',
    detectCheck: () => document.querySelector('.gravito-cmp') || document.querySelector('[id*="gravito"]') || window.gravito
  });

  // ──────────────── TRUENDO ────────────────────────
  /** TRUENDO - Click reject/opt-out. [id*="truendo"] */
  registerHandler('truendo', 'TRUENDO', function detect() {
    return !!(
      document.querySelector('[id*="truendo"]') ||
      document.querySelector('.truendo') ||
      typeof window.TRUENDO !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[id*="truendo"]') ||
                   document.querySelector('.truendo');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||


      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('necessary only', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[id*="truendo"], .truendo',
    detectCheck: () => document.querySelector('[id*="truendo"]') || document.querySelector('.truendo') || window.TRUENDO
  });

  // ──────────────── Clickio ────────────────────────
  /** Clickio Consent - Click reject. #clickio-consent-dialog */
  registerHandler('clickio', 'Clickio', function detect() {
    return !!(
      document.querySelector('.clickio-cookie') ||
      document.querySelector('[id*="clickio"]') ||
      typeof window.Clickio !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('.clickio-cookie') ||
                   document.querySelector('[id*="clickio"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '.clickio-cookie, [id*="clickio"]',
    detectCheck: () => document.querySelector('.clickio-cookie') || document.querySelector('[id*="clickio"]') || window.Clickio
  });

  // ──────────────── AppConsent ────────────────────────
  /** AppConsent (SFBX) - Click reject/customize. .appconsent */
  registerHandler('appconsent', 'AppConsent', function detect() {
    return !!(
      document.querySelector('[class*="appconsent"]') ||
      document.querySelector('[id*="appconsent"]') ||
      typeof window.AppConsent !== 'undefined' ||
      typeof window.SFBX !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="appconsent"]') ||
                   document.querySelector('[id*="appconsent"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('refuser', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="appconsent"], [id*="appconsent"]',
    detectCheck: () => document.querySelector('[class*="appconsent"]') || document.querySelector('[id*="appconsent"]') || window.AppConsent || window.SFBX
  });

  // ──────────────── Cloudflare ────────────────────────
  /** Cloudflare Zaraz CMP - Click reject. #cf-consent-banner */
  registerHandler('cloudflare', 'Cloudflare', function detect() {
    return !!(
      document.querySelector('#cf-cc-banner') ||
      document.querySelector('[class*="cf-cookie"]') ||
      document.querySelector('#cf-consent')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#cf-cc-banner') ||
                   document.querySelector('[class*="cf-cookie"]') ||
                   document.querySelector('#cf-consent');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cf-cc-banner, [class*="cf-cookie"], #cf-consent',
    detectCheck: () => document.querySelector('#cf-cc-banner') || document.querySelector('[class*="cf-cookie"]') || document.querySelector('#cf-consent')
  });

  // ──────────────── Securiti ────────────────────────
  /** Securiti - Click reject/manage. .securiti-banner */
  registerHandler('securiti', 'Securiti', function detect() {
    return !!(
      document.querySelector('[class*="securiti"]') ||
      document.querySelector('[id*="securiti"]') ||
      typeof window.Securiti !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="securiti"][class*="consent"]') ||
                   document.querySelector('[class*="securiti"][class*="banner"]') ||
                   document.querySelector('[id*="securiti"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('do not consent', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="securiti"][class*="consent"], [class*="securiti"][class*="banner"]',
    detectCheck: () => document.querySelector('[class*="securiti"][class*="consent"]') || document.querySelector('[class*="securiti"][class*="banner"]') || window.Securiti
  });

  // ──────────────── Transcend ────────────────────────
  /** Transcend Consent - Click do-not-sell/reject. .transcend-consent-manager */
  registerHandler('transcend', 'Transcend', function detect() {
    return !!(
      document.querySelector('[class*="transcend"]') ||
      document.querySelector('[id*="transcend"]') ||
      typeof window.transcend !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="transcend"][class*="consent"]') ||
                   document.querySelector('[class*="transcend"][class*="banner"]') ||
                   document.querySelector('[id*="transcend"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('do not sell', banner, 'button, a') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('opt out', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="transcend"][class*="consent"], [class*="transcend"][class*="banner"]',
    detectCheck: () => document.querySelector('[class*="transcend"][class*="consent"]') || document.querySelector('[class*="transcend"][class*="banner"]') || window.transcend
  });

  // ──────────────── CIVIC Cookie Control ────────────────────────
  /** Civic Cookie Control - Click reject/opt-out. #ccc-icon */
  registerHandler('civic', 'CIVIC', function detect() {
    return !!(
      document.querySelector('[class*="civic-cookie"]') ||
      document.querySelector('[id*="civic-cookie"]') ||
      typeof window.CookieControl !== 'undefined' && document.querySelector('[class*="civic"], [id*="civic"]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="civic-cookie"]') ||
                   document.querySelector('[id*="civic-cookie"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      banner.querySelector('[class*="necessary"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('necessary only', banner, 'button, a') ||
      Utils.findByText('reject all', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="civic-cookie"], [id*="civic-cookie"]',
    detectCheck: () => document.querySelector('[class*="civic-cookie"]') || document.querySelector('[id*="civic-cookie"]') || document.querySelector('.ccc-cookie') || (window.CookieControl && document.querySelector('[class*="civic"], [id*="civic"]'))
  });

  // ──────────────── FastCMP ────────────────────────
  /** FastCMP - Click reject. .fc-consent-root */
  registerHandler('fastcmp', 'FastCMP', function detect() {
    return !!(
      document.querySelector('[id*="fastcmp"]') ||
      document.querySelector('[class*="fastcmp"]') ||
      typeof window.FastCMP !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[id*="fastcmp"]') ||
                   document.querySelector('[class*="fastcmp"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[id*="fastcmp"], [class*="fastcmp"]',
    detectCheck: () => document.querySelector('[id*="fastcmp"]') || document.querySelector('[class*="fastcmp"]') || window.FastCMP
  });


  // ──────────────── Lawwwing ────────────────────────
  /** Lawwwing - Click reject. .lawwwing-banner */
  registerHandler('lawwwing', 'Lawwwing', function detect() {
    return !!(
      document.querySelector('[class*="lawwwing"]') ||
      document.querySelector('[id*="lawwwing"]') ||
      typeof window.Lawwwing !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="lawwwing"]') ||
                   document.querySelector('[id*="lawwwing"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('rechazar', banner, 'button, a') ||
      Utils.findByText('rechazar todo', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="lawwwing"], [id*="lawwwing"]',
    detectCheck: () => document.querySelector('[class*="lawwwing"]') || document.querySelector('[id*="lawwwing"]') || window.Lawwwing
  });

  // ──────────────── AVACY ────────────────────────
  /** Avacy - Click reject. .avacy-banner */
  registerHandler('avacy', 'AVACY', function detect() {
    return !!(
      document.querySelector('[class*="avacy"]') ||
      document.querySelector('[id*="avacy"]') ||
      typeof window.AvacyCMP !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="avacy"]') ||
                   document.querySelector('[id*="avacy"]');

    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||

      Utils.findByText('rifiuta', banner, 'button, a') ||
      Utils.findByText('rifiuta tutto', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="avacy"], [id*="avacy"]',
    detectCheck: () => document.querySelector('[class*="avacy"]') || document.querySelector('[id*="avacy"]') || window.AvacyCMP
  });

  // ──────────────── Consentmo ────────────────────────
  /** ConsentMo (Shopify) - Click reject. #cookie-consent-banner */
  registerHandler('consentmo', 'Consentmo', function detect() {
    return !!(
      document.querySelector('#cookie-consent-banner.consentmo') ||
      document.querySelector('#cookie-consent-banner[data-consentmo]') ||
      document.querySelector('[class*="consentmo"]') ||
      document.querySelector('[id*="consentmo"]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#cookie-consent-banner') ||
                   document.querySelector('[class*="consentmo"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      banner.querySelector('[class*="deny"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a') ||
      Utils.findByText('only necessary', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cookie-consent-banner.consentmo, [class*="consentmo"]',
    detectCheck: () => document.querySelector('#cookie-consent-banner.consentmo') || document.querySelector('#cookie-consent-banner[data-consentmo]') || document.querySelector('[class*="consentmo"]') || document.querySelector('[id*="consentmo"]')
  });

  // ──────────────── Pandectes ────────────────────────
  /** Pandectes (Shopify) - Click reject. #pandectes-banner */
  registerHandler('pandectes', 'Pandectes', function detect() {
    return !!(
      document.querySelector('[class*="pandectes"]') ||
      document.querySelector('[id*="pandectes"]') ||
      typeof window.Pandectes !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="pandectes"]') ||
                   document.querySelector('[id*="pandectes"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('necessary only', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="pandectes"], [id*="pandectes"]',
    detectCheck: () => document.querySelector('[class*="pandectes"]') || document.querySelector('[id*="pandectes"]') || window.Pandectes
  });

  // ──────────────── Enzuzo ────────────────────────
  /** Enzuzo - Click reject. .enzuzo-banner */
  registerHandler('enzuzo', 'Enzuzo', function detect() {
    return !!(
      document.querySelector('[class*="enzuzo"]') ||
      document.querySelector('[id*="enzuzo"]') ||
      typeof window.Enzuzo !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('[class*="enzuzo"]') ||
                   document.querySelector('[id*="enzuzo"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', banner, 'button, a') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('do not sell', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '[class*="enzuzo"], [id*="enzuzo"]',
    detectCheck: () => document.querySelector('[class*="enzuzo"]') || document.querySelector('[id*="enzuzo"]') || window.Enzuzo
  });

  // ──────────────── Cookie Script ────────────────────────
  /** CookieScript - Click reject. #cookiescript_injected */
  registerHandler('cookiescript', 'Cookie Script', function detect() {
    return !!(
      document.querySelector('#cookiescript_injected') ||
      document.querySelector('[class*="cookiescript"]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const banner = document.querySelector('#cookiescript_injected') ||
                   document.querySelector('[class*="cookiescript"]');
    if (!banner) return { rejected, vendorsUnticked };

    const rejectBtn =
      banner.querySelector('#cookiescript_reject') ||
      banner.querySelector('[class*="reject"]') ||
      Utils.findByText('reject', banner, 'button, a') ||
      Utils.findByText('decline', banner, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  }, {
    selectors: '#cookiescript_injected, [class*="cookiescript"]',
    detectCheck: () => document.querySelector('#cookiescript_injected') || document.querySelector('[class*="cookiescript"]')
  });


  // ──────────────── Generic (fallback) ────────────────────────

  /** Generic fallback - Strategy: Keyword-based button search + overlay dismissal. 18 languages. */
  registerHandler('generic', 'Generic (fallback)', function detect() {
    return CMPDetector.detectGeneric();
  }, async function reject() {
    let rejected = 0;

    let vendorsUnticked = 0;

    // Common reject button text patterns (lowercase, for matching)
    const rejectTexts = [
      'reject all', 'reject', 'decline', 'deny', 'deny all',
      'do not consent', 'do not sell', 'do not accept',
      'only necessary', 'essential only', 'refuse',
      'i refuse', 'no thanks', 'no, thanks',
      'opt out', 'opt-out', 'disagree',
      // CCPA / Do Not Sell patterns
      'do not sell my personal information', 'do not sell my info',
      'do not sell or share', 'limit the use of my data',
      'opt out of sale', 'opt out of sharing',

      'no vendan mi información', 'no vender mi información',
      // Third-party hosted banner patterns (cookie-script, cookielaw, etc.)
      'continue without cookies', 'block all', 'block cookies',
      'disable all', 'turn off all', 'decline all cookies',
      'non necessary', 'non-essential only', 'reject targeting',
      'reject advertising', 'reject analytics',
      'continue without accepting', 'manage choices',
      'necessary cookies only', 'strictly necessary only',
      'accept only essential', 'accept required',
      // German
      'ablehnen', 'alle ablehnen', 'nur notwendige',
      'nur erforderliche', 'notwendige cookies',
      'ablehnen alle',
      'nicht akzeptieren', 'nicht zustimmen',
      'notwendig akzeptieren',
      // French
      'tout refuser', 'refuser', 'refuser tout',
      'seulement nécessaires', 'cookies nécessaires',
      // Spanish
      'rechazar todo', 'rechazar', 'solo necesarias',
      'solo cookies necesarias',
      // Italian
      'rifiuta tutto', 'rifiuta', 'solo necessari',
      // Dutch
      'weiger alles', 'weigeren', 'alleen noodzakelijk',
      // Portuguese
      'rejeitar tudo', 'rejeitar', 'recusar', 'recusar tudo',
      'só necessários', 'apenas necessários',
      // Polish
      'odrzuć wszystko', 'odrzuć', 'tylko niezbędne',
      'nie akceptuję', 'nie zgadzam się',
      // Czech
      'odmítnout vše', 'odmítnout', 'pouze nezbytné',
      // Swedish
      'avvisa alla', 'avvisa', 'neka', 'endast nödvändiga',
      // Danish
      'afvis alle', 'afvis', 'kun nødvendige',
      // Romanian
      'respinge tot', 'respinge', 'doar necesare',
      // Hungarian
      'elutasítom', 'elutasít', 'csak szükséges',
      'összes elutasítása',
      // Japanese
      'すべて拒否', '拒否', '必要なもののみ',
      // Korean
      '모두 거부', '거부', '필수만',
      // Chinese
      '全部拒绝', '拒绝', '仅限必要',
      // Turkish
      'tümünü reddet', 'reddet', 'sadece gerekli',
      'kabul etmiyorum',
      // Russian
      'отклонить все', 'отклонить', 'только необходимые',
      'не принимаю',
    ];

    // Common manage/preferences text patterns
    const prefsTexts = [
      'manage preferences', 'manage options', 'manage cookies',
      'cookie settings', 'privacy settings', 'more options',
      'more information', 'customise', 'customize',
      'learn more', 'view preferences', 'edit preferences',
      'change settings', 'choose cookies', 'preferences',
      // German
      'datenschutzeinstellungen', 'cookie-einstellungen',
      'eigene einstellungen', 'einstellungen verwalten',
      'cookie einstellungen', 'weitere informationen',
      // French
      'paramètres des cookies', 'gérer les cookies',
      'personnaliser', 'paramètres de confidentialité',
      // Spanish
      'configuración de cookies', 'gestionar cookies',
      'configurar', 'ajustes de privacidad',
      // Portuguese
      'configurações de cookies', 'gerenciar cookies',
      'preferências de privacidade',
      // Polish
      'ustawienia plików cookie', 'zarządzaj ciasteczkami',
      'preferencje prywatności',
      // Swedish
      'cookieinställningar', 'hantera cookies',
      'integritetsinställningar',
      // Danish

      'cookieindstillinger', 'administrer cookies',
      // Czech
      'nastavení cookies', 'spravovat cookies',
      // Romanian
      'setări cookies', 'gestiona cookie-uri',
      // Hungarian
      'cookie-beállítások', 'süti beállítások',
      // Japanese
      'クッキー設定', ' Cookie設定',
      // Korean
      '쿠키 설정',
      // Chinese
      'cookie设置', ' Cookie设置',
      // Turkish
      'çerez ayarları', 'gizlilik ayarları',
      // Russian
      'настройки файлов cookie', 'управление файлами cookie',
    ];

    // Common save/confirm text patterns
    const saveTexts = [
      'save preferences', 'save choices', 'save settings',
      'save my choices', 'save your choices', 'save',
      'confirm choices', 'confirm my choices', 'confirm',
      'update preferences', 'apply',
      // German
      'auswahl übernehmen', 'auswahl speichern',
      'einstellungen speichern', 'speichern', 'bestätigen',
      'auswahl bestätigen', 'übernehmen',
      // French
      'enregistrer', 'confirmer', 'valider',
      'sauvegarder les choix', 'enregistrer les préférences',
      // Spanish
      'guardar', 'confirmar', 'guardar preferencias',
      'guardar selección',
      // Italian
      'salva', 'conferma', 'salva preferenze',
      // Dutch
      'opslaan', 'bevestigen', 'voorkeuren opslaan',
      // Portuguese
      'salvar', 'confirmar', 'salvar preferências',
      'guardar preferências',
      // Polish
      'zapisz', 'potwierdź', 'zapisz preferencje',
      // Swedish
      'spara', 'bekräfta', 'spara inställningar',

      // Danish
      'gem', 'bekræft', 'gem indstillinger',
      // Czech
      'uložit', 'potvrdit', 'uložit předvolby',
      // Romanian
      'salvează', 'confirmă', 'salvează preferințele',
      // Hungarian
      'mentés', 'megerősít', 'beállítások mentése',
      // Japanese
      '保存', '確認', '設定を保存',
      // Korean
      '저장', '확인', '설정 저장',
      // Chinese
      '保存', '确认', '保存设置',
      // Turkish
      'kaydet', 'onayla', 'tercihleri kaydet',
      // Russian
      'сохранить', 'подтвердить', 'сохранить настройки',
    ];

    // Find and click reject button -- single DOM pass for all patterns
    const rejectBtns = Utils.findAllByText(rejectTexts, document, 'button, a');
    if (rejectBtns.length > 0) {
      // Pick the best match: prefer buttons with exact-ish text over partial matches
      // (e.g. "Reject All" over "I reject everything and leave")
      let btn = null;
      let btnLen = Infinity;
      for (const el of rejectBtns) {
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt.length < btnLen) {
          btn = el;
          btnLen = txt.length;
        }
      }
      // Verify the button is in a cookie/consent context
      if (btn) {

        const contextEl = btn.closest('[class*="cookie"], [class*="consent"], [class*="privacy"], [class*="gdpr"], [class*="ccpa"], [id*="cookie"], [id*="consent"], [id*="gdpr"], [id*="ccpa"], [class*="banner"], [class*="popup"], [class*="modal"], [class*="notice"], [role="dialog"], [class*="do-not-sell"], [class*="opt-out"], [class*="cookieconsent"], [class*="cookielaw"]');
        if (!contextEl) {
          btn = null; // Not in a consent context, skip
        }
      }
      if (btn) {

        btn.click();
        rejected++;
        return { rejected, vendorsUnticked };
      }
    }

    // Strategy 2: Banner already shows checkboxes and a save/confirm button.
    // This handles custom cookie overlays (e.g. thomas-krenn.com, many German
    // sites) where the banner presents category toggles directly with a
    // "save selection" button, no reject-all button, and no preferences screen.
    {
      // Find cookie/privacy overlays (fixed position or modal)
      const cookieOverlays = document.querySelectorAll(
        '[class*="privacy-cookie"], [class*="cookie-overlay"], ' +
        '[class*="cookie-consent"], [class*="cookie-banner"], ' +
        '[id*="CookiePolicy"], [role="dialog"]'
      );
      for (const overlay of cookieOverlays) {
        // Untick all non-essential toggles in this overlay
        const unticked = await Utils.untickAllToggles(overlay);
        if (unticked > 0) {
          vendorsUnticked += unticked;
        }

        // Try to find a save/confirm button
        for (const sText of saveTexts) {
          const sBtn = Utils.findByText(sText, overlay, 'button, a');
          if (sBtn) {
            sBtn.click();
            rejected++;
            return { rejected, vendorsUnticked };
          }
        }

        // Also try data-attribute based save buttons (common in custom CMPs)
        const attrSaveBtn = overlay.querySelector(
          '[data-cookie-overlay-save], [data-cookie-save], ' +
          '[data-consent-save], [data-save-settings]'
        );
        if (attrSaveBtn) {
          attrSaveBtn.click();
          rejected++;
          return { rejected, vendorsUnticked };
        }
      }
    }

    // If no direct reject button, try opening preferences
    for (const text of prefsTexts) {

      const btn = Utils.findByText(text, document, 'button, a, span');
      if (btn) {
        btn.click();
        await Utils.sleep(CONFIG.dynamicLoadDelay);

        // After opening preferences, try to find reject-all or untick toggles
        // First try reject-all again
        for (const rText of rejectTexts) {
          const rBtn = Utils.findByText(rText, document, 'button, a, span');
          if (rBtn) {
            rBtn.click();
            rejected++;
            return { rejected, vendorsUnticked };
          }
        }

        // Multi-step wizard: click "Next" / "Continue" to advance through steps,
        // unticking toggles at each step before proceeding.  (PERF-2: arrays
        // lifted out of loop; max 5 wizard steps as safety limit.)
        const nextTexts = ['next', 'continue', 'weiter', 'suivant', 'siguiente', 'avanti', 'volgende'];
        const maxWizardSteps = 5;
        let wizardSteps = 0;
        while (wizardSteps < maxWizardSteps) {
          // Untick toggles on current wizard step
          const wizardModals = document.querySelectorAll(
            '[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]'
          );
          for (const modal of wizardModals) {
            const result = await Utils.untickAllToggles(modal);
            vendorsUnticked += result;
          }
          // Look for a "Next" button
          let nextBtn = null;
          for (const nText of nextTexts) {
            nextBtn = Utils.findByText(nText, document, 'button, a');
            if (nextBtn) break;
          }
          if (!nextBtn) break; // no more steps
          nextBtn.click();
          await Utils.sleep(CONFIG.dynamicLoadDelay);
          wizardSteps++;
        }

        // After wizard completes (or skipped), untick any remaining toggles
        const postModals = document.querySelectorAll(
          '[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]'
        );
        for (const modal of postModals) {
          const result = await Utils.untickAllToggles(modal);
          vendorsUnticked += result;

          // Try to find and scroll vendor lists
          const scrollContainers = modal.querySelectorAll(
            '[class*="vendor-list"], [class*="vendor-list-container"], [class*="scroll"]'
          );
          for (const sc of scrollContainers) {
            await Utils.scrollToLoadAll(sc);
            const vendorResult = await Utils.untickAllToggles(sc);
            vendorsUnticked += vendorResult;
          }
        }

        // Save
        for (const sText of saveTexts) {
          const sBtn = Utils.findByText(sText, document, 'button, a');
          if (sBtn) {
            sBtn.click();
            rejected++;
            break;
          }
        }

        break; // only try the first matching preferences button
      }
    }

    // Last resort: more targeted close buttons -- require explicit
    // cookie/consent/privacy context to avoid closing unrelated UI.

    if (rejected === 0) {
      const closeBtns = document.querySelectorAll(
        '[class*="cookie-banner"] [aria-label="close"], ' +
        '[class*="cookie-consent"] [aria-label="close"], ' +
        '[class*="consent-banner"] [aria-label="close"], ' +
        '[class*="cookie-popup"] [aria-label="close"], ' +
        '[id*="cookie"] [class*="close"][aria-label], ' +
        'button[class*="cookie-close"], ' +
        'button[class*="consent-close"]'
      );
      for (const btn of closeBtns) {
        if (Utils.isVisible(btn)) {
          btn.click();
          rejected++;
          break;
        }
      }
    }

    return { rejected, vendorsUnticked };
  });

  // ─── Remote Rules Application ─────────────────────────────────────────
  // Apply remotely fetched rules (stored in cr_meta.remoteRules by background.js)
  ;(async function applyRemoteRules() {
    try {
      const response = await new Promise(r => {
        chrome.runtime.sendMessage({ type: 'GET_REMOTE_RULES' }, resp => r(resp));
      });
      if (response && Array.isArray(response) && response.length > 0) {
        DebugLog.log(`Applying ${response.length} remote rules`);
        for (const rule of response) {
          if (!rule.id || !CMPHandlers[rule.id]) continue; // only update existing handlers
          if (Array.isArray(rule.selectors) && rule.selectors.length > 0) {
            // Update auto-selectors for visibility checks
            _autoSelectors[rule.id] = rule.selectors.join(', ');
          }
        }
      }
    } catch { /* remote rules not available yet */ }
    _topDetectorsCache = null; // invalidate so next observer tick rebuilds with new rules
  })();

  // ─── TCF API Handler ────────────────────────────────────────────────
  // Uses IAB TCF v2 API to programmatically reject consent
  const TCFApiHandler = {
    async reject() {
      let success = false;

      // Try __tcfapi (TCF v2)
      // Standard approach: listen for tcloaded, then directly set minimal consent
      if (typeof window.__tcfapi === 'function') {
        try {
          await new Promise((resolve) => {
            let resolved = false;
            const finish = () => { if (!resolved) { resolved = true; resolve(); } };
            window.__tcfapi('addEventListener', 2, (tcData, listenerSuccess) => {
              // Always remove our listener to prevent leaks
              try {

                window.__tcfapi('removeEventListener', 2, () => {}, tcData.listenerId);
              } catch (e) { /* ignore */ }
              if (listenerSuccess && tcData.eventStatus === 'cmpuishown') {
                success = true;
                // Try programmatic rejection as supplement to button clicks
                try {

                  if (typeof window.__tcfapi === 'function') {
                    window.__tcfapi('rejectAll', 2, () => {});
                  }
                } catch (e) { /* not supported by all CMPs */ }
              }
              finish();
            });
            // Timeout after 2s if CMP doesn't respond
            setTimeout(finish, CONFIG.tcfApiTimeout);
          });
        } catch (e) { /* ignore */ }
      }

      // Try __uspapi (US Privacy) -- set opt-out string
      if (typeof window.__uspapi === 'function') {
        try {
          window.__uspapi('setUspDftData', 1, () => {}, { version: 1, uspString: '1YYN' });
          success = true;
        } catch (e) { /* ignore */ }
      }

      // Try __gpp (Global Privacy Platform) -- request default denial
      if (typeof window.__gpp === 'function') {
        try {
          // getGPPData is the standard read command; for rejection we rely on
          // the CMP's own UI buttons (handled by our handlers above).
          // Signal that a GPP CMP was detected for logging purposes.
          success = true;
        } catch (e) { /* ignore */ }
      }

      return success;
    },
  };

  // ─── Banner Hider ───────────────────────────────────────────────────
  // Removes banner overlays that block page interaction
  const BannerHider = {
    hide() {
      // Only act if there's actually a cookie/consent overlay present
      const hasCookieOverlay = document.querySelector(
        '[class*="cookie"], [class*="consent"], [class*="privacy"], [class*="gdpr"], [id*="cookie"], [id*="consent"]'
      );
      if (!hasCookieOverlay) return;

      // Common overlay/backdrop selectors
      const overlaySelectors = [
        '.onetrust-pc-dark-filter',
        '#onetrust-pc-sdk .ot-backdrop',
        '.cky-overlay',
        '#didomi-host .didomi-popup-backdrop',
        '.qc-cmp2-backdrop',
        '[class*="consent-backdrop"]',
        '[class*="cookie-overlay"]',
        '[class*="gdpr-overlay"]',
        '[class*="privacy-overlay"]',
      ];

      for (const sel of overlaySelectors) {
        const overlay = document.querySelector(sel);
        if (overlay) {
          overlay.style.display = 'none';
        }
      }

      // Remove body scroll lock (only if we can confirm it was set by a cookie overlay)
      const cookieOverlayBlocking = document.querySelector(
        '[class*="cookie-overlay"], [class*="cookie-banner"], [class*="cookie-popup"], [class*="consent-overlay"], [class*="consent-banner"], [class*="privacy-overlay"], [id*="cookie-overlay"], [id*="consent-banner"]'
      );
      if (cookieOverlayBlocking) {
        if (document.body.style.overflow === 'hidden' ||
            document.body.style.overflow === 'clip') {
          document.body.style.overflow = '';
        }
        if (document.documentElement.style.overflow === 'hidden' ||
            document.documentElement.style.overflow === 'clip') {
          document.documentElement.style.overflow = '';
        }
      }
    },
  };

  // ─── Main Engine ────────────────────────────────────────────────────
  const Engine = {
    // Shared map of primary banner selectors per CMP.
    // Used by both isCMPBannerVisible() and isBannerStillVisible().
    get _primarySelectors() {
      // Auto-registered selectors from registerHandler() -- read-only consumers,
      // no need to spread a fresh object on every access (PERF-1 fix).
      return _autoSelectors;
    },
    initialized: false,
    intervalRetries: 0,
    processed: false,
    currentCMP: null,
    observer: null,
    observerActive: false,
    intervalId: null,
    initTimestamp: Date.now(),
    lastFailedAttempt: 0,
    _settingsLoaded: false,
    _whitelistChecked: false,
    _isWhitelisted: false,
    _isBlacklisted: false,
    _detecting: false,
    _handling: false,
    _pendingForceReject: false,
    _lastVendorsUnticked: 0,
    _intervalTickCount: 0,
    settings: {
      autoReject: true,
      untickVendors: true,

      dismissOverlays: true,
      useTCFApi: true,
      debugMode: false,
    },

    async init() {
      if (this.initialized) return;

      this.initialized = true;

      // Fetch full settings from background (non-blocking).
      // These control what the engine is allowed to do.
      this.sendMessage({ type: 'GET_FULL_SETTINGS' }).then((settings) => {
        if (settings) {
          this.settings = { ...this.settings, ...settings };
          _debugMode = this.settings.debugMode;
          DebugLog.log('Settings loaded:', this.settings);

          // If autoReject is OFF or extension disabled, stop immediately.
          // Exception: blacklisted sites always force-run.
          if ((!settings.enabled || !settings.autoReject) && !this._isBlacklisted) {
            this.processed = true;

            if (this.observerActive) {
              this.observerActive = false;
              this.observer.disconnect();
            }
            if (this.intervalId) {
              clearInterval(this.intervalId);
              this.intervalId = null;
            }
          }
        }
        this._settingsLoaded = true;
      });

      // Check whitelist/blacklist (non-blocking)
      this.sendMessage({ type: 'CHECK_LIST', domain: this.getDomain() }).then((listCheck) => {
        if (listCheck && listCheck.whitelisted) {
          this._isWhitelisted = true;
          this.processed = true;
          DebugLog.log('Site whitelisted, skipping:', this.getDomain());
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
          if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
          }
        }
        // Blacklist: force-run even if auto-reject is off
        if (listCheck && listCheck.blacklisted) {
          this._isBlacklisted = true;
          DebugLog.log('Site blacklisted, forcing rejection:', this.getDomain());
        }
        this._whitelistChecked = true;
      });

      // Start detection -- runs immediately, settings will abort if needed
      // FEAT-5: Give the page a moment to load before starting detection.
      // Many CMPs are injected lazily via tag managers (GTM, etc.) and may not
      // be present immediately at document_idle. This avoids wasted early detection cycles.
      await Utils.sleep(CONFIG.initDelay);
      this.detectAndReject();
    },

    async detectAndReject() {
      if (this._detecting) {
        // Queue force-reject instead of silently dropping (Fix #3)
        this._pendingForceReject = true;
        return;
      }
      this._detecting = true;
      try {

      // Wait for settings to load before starting detection (max 2s)
      if (!this._settingsLoaded) {
        const settingsDeadline = Date.now() + CONFIG.settingsWaitTimeout;
        while (!this._settingsLoaded && Date.now() < settingsDeadline) {
          await Utils.sleep(CONFIG.settingsPollInterval);
        }
        this._settingsLoaded = true; // proceed anyway after timeout
      }

      // Wait for whitelist check (max 2s)
      if (!this._whitelistChecked) {
        const wlDeadline = Date.now() + CONFIG.settingsWaitTimeout;
        while (!this._whitelistChecked && Date.now() < wlDeadline) {
          await Utils.sleep(CONFIG.settingsPollInterval);
        }
        if (this._isWhitelisted) {
          this.processed = true;
          return;
        }
      }

      // Immediate check
      const cmp = CMPDetector.detect();
      if (cmp) {
        await this.handleCMP(cmp);
        // Only return if rejection was verified successful
        if (this.processed) return;
        // Otherwise fall through to observer + interval for retry
      }

      // Set up MutationObserver for dynamic banner injection.
      // The observer does NOT use the retries counter -- it stays active
      // for the entire watch window. DOM pages can produce hundreds of
      // mutations per second during load, which was exhausting the shared
      // retries counter before the banner even appeared.
      //
      // Throttled to fire at most once every CONFIG.observerThrottle ms. Without this,
      // detect() runs 30+ querySelector calls + getComputedStyle on
      // every single DOM mutation -- extremely expensive during page load.

      this.observerActive = true;
      let lastObserverDetect = 0;
      this.observer = new MutationObserver(() => {
        if (this.processed || !this.observerActive) {
          this.observer.disconnect();
          return;
        }
        const now = Date.now();
        if (now - lastObserverDetect < CONFIG.observerThrottle) return; // throttle
        lastObserverDetect = now;

        // PERF-2: Check top CMPs first (most common globally) before full scan.
        // This avoids running all 47+ detectors on every observer tick.
        let cmp = null;
        if (!_topDetectorsCache) {
          _topDetectorsCache = _detectorEntries.filter(d => CONFIG.topCMPs.includes(d.id));
        }
        const topDetectors = _topDetectorsCache;
        for (const det of topDetectors) {
          try {
            const result = det.check();
            if (result) {
              if (result instanceof HTMLElement && !Utils.isVisibleCached(result)) continue;
              cmp = { id: det.id, name: det.name, confidence: result instanceof HTMLElement ? 'high' : 'medium' };
              break;
            }
          } catch (e) { DebugLog.warn('Operation failed:', e.message); }
        }
        // Only run full detection if top CMPs didn't match
        if (!cmp) {
          // Invalidate cache since DOM has mutated since last full scan
          CMPDetector._lastDetection = null;
          cmp = CMPDetector.detect();
        }

        if (cmp) {
          this.observerActive = false;
          this.observer.disconnect();
          this.handleCMP(cmp);
        } else {
          // New DOM elements may have added shadow roots -- invalidate cache
          CMPDetector._shadowHosts = null;
        }
      });

      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      // Safety net: force-disconnect observer after a timeout
      setTimeout(() => {
        if (this.observerActive) {
          this.observerActive = false;
          this.observer.disconnect();
          DebugLog.log('Observer safety timeout reached');
        }
      }, CONFIG.observerTimeout);

      // Also try at intervals as a safety net (catches banners loaded
      // after the observer's initial watch window, or in tricky iframes)
      this.intervalId = setInterval(async () => {
        if (this.processed) {
          clearInterval(this.intervalId);
          this.intervalId = null;
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();

          }
          return;
        }

        this.intervalRetries++;
        if (this.intervalRetries > CONFIG.maxRetries) {
          clearInterval(this.intervalId);
          this.intervalId = null;
          // Stop the observer too -- we've waited long enough
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
          return;
        }

        this._intervalTickCount++;
        // Run full detection (including expensive generic scan) only every 5th tick
        const cmp = (this._intervalTickCount % 5 === 1 || this._intervalTickCount < 3)
          ? CMPDetector.detect()
          : (() => {
              // Fast path: only check named detectors, skip generic
              for (const det of _detectorEntries) {
                try {
                  const r = det.check();
                  if (r && (!(r instanceof HTMLElement) || Utils.isVisibleCached(r))) {
                    return { id: det.id, name: det.name, confidence: r instanceof HTMLElement ? 'high' : 'medium' };
                  }
                } catch (e) { DebugLog.warn('Operation failed:', e.message); }
              }
              return null;
            })();
        if (cmp) {
          clearInterval(this.intervalId);
          this.intervalId = null;
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
          await this.handleCMP(cmp);
        }
      }, CONFIG.retryInterval);

      // Re-entry guard cleared after observer + interval are set up
      } finally {
        this._detecting = false;
        // Process queued force-reject after current detection pass completes
        if (this._pendingForceReject) {
          this._pendingForceReject = false;
          this.processed = false;
          this.intervalRetries = 0;
          this.lastFailedAttempt = 0;
          this.detectAndReject();
        }
      }
    },

    async handleCMP(cmpInfo) {
      if (this._handling) return;
      if (this.processed) return;

      // Cooldown: if the last attempt failed verification, wait before
      // retrying. This prevents tight retry loops clicking the same
      // non-functional button every 500ms.
      if (this.lastFailedAttempt && (Date.now() - this.lastFailedAttempt < CONFIG.failedCooldown)) {
        return;
      }

      // FEAT-4: Dry run mode - log but don't click anything
      if (this.settings.dryRun) {
        DebugLog.log('[DRY RUN] Would reject', cmpInfo.name, 'on', this.getDomain());
        // Still count as detected but not rejected
        return;
      }

      // FEAT-1: Check for per-site CMP override
      let cmp = cmpInfo;
      try {
        const override = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_CMP_OVERRIDE', domain: location.hostname }, resp => r(resp)));
        if (override && override.override && override.override !== cmpInfo.id) {
          DebugLog.log('CMP override:', cmpInfo.id, '->', override.override);
          const overrideHandler = CMPHandlers[override.override];
          if (overrideHandler) cmp = { id: override.override, name: overrideHandler.name, confidence: 'high' };
        }
      } catch (e) { DebugLog.warn('Operation failed:', e.message); }

      const handler = CMPHandlers[cmp.id];
      if (!handler) return;

      // Verify detection
      if (!handler.detect()) return;

      // Verify the banner element is actually visible (not just the JS global)
      if (!this.isCMPBannerVisible(cmp.id)) {
        DebugLog.log('CMP detected via global but banner not visible, skipping:', cmp.name);
        return;
      }

      this.currentCMP = cmp;
      DebugLog.log('Detected CMP:', cmp.name, 'on', this.getDomain());

      this._handling = true;
      try {
        // Small delay to let the banner fully render and its JS initialize.
        // Many CMPs inject their HTML server-side but attach click handlers
        // via async JavaScript. Without this wait, we click buttons that
        // have no event listeners yet -- the click does nothing, but we
        // count it as a success and mark processed=true.
        await Utils.sleep(CONFIG.preRejectDelay);

        // Run the CMP-specific rejection
        const result = await handler.reject();
        if (!result) {
          DebugLog.warn('Handler returned no result:', cmp.name);
          this._handling = false;
          return;
        }
        DebugLog.log('Handler result:', result);
        this._lastVendorsUnticked = result.vendorsUnticked || 0;

        // Also try TCF API rejection for any IAB-compliant CMP
        // (only if the setting is enabled)
        let tcfResult = false;
        if (this.settings.useTCFApi) {
          tcfResult = await TCFApiHandler.reject();
        }

        // Hide any remaining overlays (only if setting is enabled)
        if (this.settings.dismissOverlays) {
          BannerHider.hide();
        }

        // Verify the banner actually disappeared.
        // Handlers return rejected > 0 even when the click did nothing
        // (e.g. button existed in DOM but its JS event listener wasn't
        // attached yet). Re-detect the CMP to check if the banner is
        // still present and visible.
        const stillVisible = await this.isBannerStillVisible(cmp);

        if (stillVisible && result.rejected > 0) {
          // The handler claimed success but the banner is still there.
          // The click was a false positive -- the JS wasn't ready.
          // Don't mark as processed so the observer/interval can retry.
          this.lastFailedAttempt = Date.now();
          const visibleSel = this._primarySelectors[cmp.id] || 'unknown';
          DebugLog.warn('False positive -- banner still visible after rejection. Selector:', visibleSel);
          // Log failed rejection for analytics
          this.sendMessage({
            type: 'LOG_FAILED_REJECTION',
            data: { domain: this.getDomain(), cmp: cmp.name, reason: 'banner_still_visible' },
          });
          // Invalidate cache so retries get fresh detection
          CMPDetector.invalidateCache();
          return;
        }

        // Report results
        if (result.rejected > 0 || result.vendorsUnticked > 0 || tcfResult) {
          this.processed = true;
          // Invalidate detection cache -- page state changed after rejection
          CMPDetector.invalidateCache();

          const domain = this.getDomain();
          // Strip query params and hash from URL for privacy
          const safeUrl = window.location.href.split('?')[0].split('#')[0];
          await this.sendMessage({
            type: 'LOG_ACTION',
            data: {
              domain: domain,
              cmp: cmp.name,
              rejected: result.rejected,
              vendorsUnticked: result.vendorsUnticked,
              timestamp: Date.now(),
              url: safeUrl,
            },
          });
          DebugLog.log('Logged action:', domain, cmp.name);

        }
      } catch (e) {
        DebugLog.error('Error handling CMP:', e.message);
        // Log failed rejection due to error
        this.sendMessage({
          type: 'LOG_FAILED_REJECTION',
          data: { domain: this.getDomain(), cmp: cmp.name || 'unknown', reason: 'handler_error: ' + e.message },
        });
      } finally {
        this._handling = false;
      }
    },

    /**
     * Check if a CMP's primary banner element is actually visible.
     * Used to guard against false positives when detect() returns true
     * from a window global (e.g. window.OneTrust) but the banner is
     * already dismissed/hidden.
     */
    isCMPBannerVisible(cmpId) {

      const sel = this._primarySelectors[cmpId];
      if (!sel) {
        // Unknown CMP -- no selector to check, assume visible
        return true;
      }

      const el = document.querySelector(sel);
      if (!el) {
        // No DOM element found for this CMP's known selector.
        // Detection may have come from a window global only (e.g. window.admiral).
        // If there's no banner element in the DOM, there's nothing to reject --
        // returning false prevents 30s of wasted retry cycles.
        return false;
      }

      return Utils.isVisible(el);
    },

    /**
     * Check if the banner from a previously detected CMP is still visible.
     * Uses the handler's detect() method dynamically instead of a hardcoded
     * list of selectors -- so adding a new handler automatically updates this.
     */
    async isBannerStillVisible(cmpInfo) {
      // Give the CMP time to process the rejection before re-checking
      await Utils.sleep(CONFIG.observerCheckDelay);
      const handler = CMPHandlers[cmpInfo.id];
      if (!handler || !handler.detect()) return false;

      // The handler's detect() returned true, meaning the banner element
      // is still in the DOM. For the generic handler, detect() already
      // checks visibility. For specific handlers, we need to find the
      // actual banner element and check its computed style.
      if (cmpInfo.id === 'generic') {
        // detectGeneric() already checks isVisible, so if detect()
        // returned true, the banner IS visible.

        return true;
      }

      // For specific CMPs, check known primary selectors.
      // These are the main banner container IDs/classes used by each handler.

      const sel = this._primarySelectors[cmpInfo.id];
      if (!sel) {
        // Unknown CMP -- fall back to generic overlay check
        const generic = document.querySelector(
          '[class*="cookie-banner"], [class*="cookie-consent"], [class*="consent-banner"]'
        );
        return generic ? Utils.isVisible(generic) : false;
      }

      const el = document.querySelector(sel);
      return el ? Utils.isVisible(el) : false;

    },

    getDomain() {
      try {
        const url = new URL(window.location.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return url.href;

        }
        return url.hostname;
      } catch {
        return window.location.hostname || 'unknown';
      }
    },

    sendMessage(msg) {
      return new Promise((resolve) => {
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage(msg, (response) => {
              if (chrome.runtime.lastError) {
                resolve(null);
              } else {
                resolve(response);
              }
            });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    },
  };

  // ─── Listen for messages from popup/background ──────────────────────
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_STATUS_CONTENT') {
        sendResponse({
          processed: Engine.processed,
          cmp: Engine.currentCMP,
          vendorsUnticked: Engine._lastVendorsUnticked || 0,
          domain: Engine.getDomain(),
          timestamp: Engine.initTimestamp,
        });
      } else if (message.type === 'FORCE_REJECT') {
        DebugLog.log('Force reject triggered (manual override)');
        // Clean up previous observer and interval to prevent resource leaks
        if (Engine.observerActive && Engine.observer) {
          Engine.observerActive = false;
          Engine.observer.disconnect();
        }
        if (Engine.intervalId) {
          clearInterval(Engine.intervalId);
          Engine.intervalId = null;
        }
        Engine.processed = false;
        Engine.intervalRetries = 0;
        Engine.lastFailedAttempt = 0;
        Engine.detectAndReject();
        sendResponse({ started: true });
      } else if (message.type === 'WHITELIST_SITE') {
        Engine.sendMessage({
          type: 'ADD_TO_LIST',
          list: 'whitelist',
          domain: Engine.getDomain(),
        }).then(() => sendResponse({ added: true }));
        return true; // async response
      } else if (message.type === 'BLACKLIST_SITE') {
        Engine.sendMessage({
          type: 'ADD_TO_LIST',
          list: 'blacklist',
          domain: Engine.getDomain(),
        }).then(() => sendResponse({ added: true }));
        return true; // async response
      } else if (message.type === 'SETTINGS_UPDATED') {
        // Live-update settings without page reload (Fix #9)
        if (message.settings) {
          Engine.settings = { ...Engine.settings, ...message.settings };
          _debugMode = Engine.settings.debugMode;
          DebugLog.log('Settings updated live:', message.settings);
          // If extension was disabled, stop processing
          // Exception: blacklisted sites always force-run.
          if ((!message.settings.enabled || !message.settings.autoReject) && !Engine._isBlacklisted) {
            Engine.processed = true;
            if (Engine.observerActive) {
              Engine.observerActive = false;
              Engine.observer.disconnect();
            }
          }
        }
        sendResponse({ updated: true });
      }
    });
  }

  // ─── SPA Navigation Support ─────────────────────────────────────────
  // Reset engine when user navigates within a single-page app.
  // This handles History API (pushState/replaceState) and hash changes.
  let _lastUrl = location.href;
  function checkSpaNavigation() {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      DebugLog.log('SPA navigation detected, resetting engine');
      // Tear down existing observer and interval to prevent duplicates
      if (Engine.observerActive) {
        Engine.observerActive = false;
        try { Engine.observer.disconnect(); } catch (e) { DebugLog.warn('Operation failed:', e.message); }
      }
      if (Engine.intervalId) {
        clearInterval(Engine.intervalId);
        Engine.intervalId = null;
      }
      // Reset detection state but keep settings/lists
      Engine.processed = false;
      Engine._detecting = false;
      Engine._handling = false;
      Engine._detectionResult = null;
      // Clear caches so detectors re-run
      CMPDetector._lastDetection = null;
      CMPDetector._lastDetectionTime = 0;
      Utils.clearTextCache();
      // Restart detection after a short delay for the new page to load
      setTimeout(() => {
        if (!Engine.processed && !Engine._isWhitelisted) {
          Engine.detectAndReject();
        }
      }, CONFIG.spaNavigationDelay);
    }
  }

  // Listen for popstate (back/forward) and hashchange
  window.addEventListener('popstate', checkSpaNavigation);
  window.addEventListener('hashchange', checkSpaNavigation);

  // Monkey-patch pushState and replaceState to detect SPA-driven navigation
  // Guard against re-patching if content script is injected multiple times
  const _patchedHistories = new WeakSet();
  if (!_patchedHistories.has(history)) {
    _patchedHistories.add(history);
    const _origPushState = history.pushState;
    const _origReplaceState = history.replaceState;
    if (_origPushState) {
      history.pushState = function() {
        _origPushState.apply(this, arguments);
        checkSpaNavigation();
      };
    }
    if (_origReplaceState) {
      history.replaceState = function() {
        _origReplaceState.apply(this, arguments);
        checkSpaNavigation();
      };
    }
  }

  // ─── Start ──────────────────────────────────────────────────────────
  // Wait for DOM to be ready, then initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Engine.init());
  } else {
    Engine.init();
  }
  } catch (e) {
    console.error('[CookieReject] Fatal error:', e);
  }
})();


