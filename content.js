/**
 * CookieReject - Content Script
 * Consent banner detection and rejection engine.
 * Runs on every page. Watches for cookie consent popups and auto-rejects.
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
  if (window !== window.top) return;

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
    vendorToggleDelay: 50,
    // How long to wait for dynamic content to load after clicking (ms)
    dynamicLoadDelay: 800,
    // How long to wait after scrolling a vendor list (ms)
    scrollDelay: 300,
    // Max vendors to process per CMP (safety limit)
    maxVendors: 2000,
    // Observer throttle: minimum ms between detect() calls via MutationObserver
    observerThrottle: 300,
    // Cooldown after a failed rejection attempt (ms)
    failedCooldown: 3000,
    // Delay before calling handler.reject() to let banner JS initialize (ms)
    preRejectDelay: 800,
    // Safety timeout: force-disconnect observer after this many ms
    observerTimeout: 35000,
    // Max time to wait for settings to load before proceeding (ms)
    settingsWaitTimeout: 2000,
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
      // Cheap check: if offsetParent exists, element is definitely visible
      // (offsetParent is null only for display:none or position:fixed)
      if (el.offsetParent !== null) return true;
      // Quick check: if element or its direct parent has inline display:none
      if (el.style.display === 'none') return false;
      // offsetParent is null -- could be display:none or position:fixed
      const style = getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      // Check if element is positioned far off-screen
      const viewWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewHeight = window.innerHeight || document.documentElement.clientHeight;
      if (rect.right < -100 || rect.bottom < -100 || rect.left > viewWidth + 100 || rect.top > viewHeight + 100) {
        return false;
      }
      return true;
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
     * Click an element safely. Returns true if the element existed and was clicked.
     */
    async click(selectorOrElement, root = document) {
      const el =
        typeof selectorOrElement === 'string'
          ? root.querySelector(selectorOrElement)
          : selectorOrElement;
      if (!el) return false;
      if (!Utils.isVisible(el)) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const dispatched = el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return dispatched;
    },

    /**
     * Find a button or link by its visible text content (case-insensitive, partial match).
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
     */
    findAllByText(texts, root = document, tag = '*') {
      if (!texts || texts.length === 0) return [];
      const results = [];
      // Pre-lowercase all search texts for efficiency
      const lowerTexts = texts.map(t => t.toLowerCase());
      const minLen = Math.min(...lowerTexts.map(t => t.length));
      const elements = root.querySelectorAll(tag);
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
      container.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          const shadowToggles = el.shadowRoot.querySelectorAll(toggleSelector);
          shadowToggles.forEach(t => toggles.push(t));
        }
      });

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

        // Small delay between toggles to not overwhelm the CMP
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
    async scrollToLoadAll(container, direction = 'down') {
      let lastHeight = container.scrollHeight;
      let attempts = 0;

      while (attempts < 50) {
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
     * Returns an object { id, name } or null.
     */
    detect() {
      const now = Date.now();
      if (this._lastDetection && (now - this._lastDetectionTime < this._cacheTTL)) {
        return this._lastDetection;
      }
      const detectors = [
        { id: 'onetrust', name: 'OneTrust', check: () => document.getElementById('onetrust-banner-sdk') || document.getElementById('onetrust-consent-sdk') || window.OneTrust || window.OptanonActiveGroups },
        { id: 'fides', name: 'Fides', check: () => document.getElementById('fides-banner-container') || document.getElementById('fides-banner') || document.getElementById('fides-modal') },
        { id: 'ketch', name: 'Ketch', check: () => document.getElementById('ketch-consent-banner') || document.getElementById('ketch-banner') || window.ketchConsent },
        { id: 'cookiebot', name: 'Cookiebot', check: () => document.getElementById('CybotCookiebotDialog') || window.Cookiebot || document.querySelector('[data-cb-id]') },
        { id: 'didomi', name: 'Didomi', check: () => document.getElementById('didomi-popup') || document.getElementById('didomi-host') || window.Didomi },
        { id: 'sourcepoint', name: 'Sourcepoint', check: () => document.querySelector('[id^="sp_message_iframe"]') || document.querySelector('.sp_message_container') || window._sp_ },
        { id: 'trustarc', name: 'TrustArc', check: () => document.getElementById('truste-consent-track') || document.getElementById('trustarc-banner') || document.querySelector('.trustarc-banner') || window.truste },
        { id: 'quantcast', name: 'Quantcast', check: () => document.querySelector('.qc-cmp2-container') || document.querySelector('[class*="qc-cmp"]') || window.__qcmp },
        { id: 'usercentrics', name: 'Usercentrics', check: () => document.getElementById('usercentrics-root') || document.querySelector('[data-testid="uc-banner"]') || window.UC_UI },
        { id: 'cookieyes', name: 'CookieYes', check: () => document.getElementById('cky-btn-reject') || document.querySelector('.cky-consent-bar') || document.querySelector('[data-cky-tag]') },
        { id: 'iubenda', name: 'Iubenda', check: () => document.querySelector('.iubenda-cs-banner') || document.getElementById('iubenda-cs-banner') || window._iub },
        { id: 'consentmanager', name: 'ConsentManager', check: () => document.getElementById('cmpbox') || document.getElementById('cmpwrapper') || document.querySelector('.cmpbox[role="dialog"]') || document.querySelector('[class*="cmpbox"]') || window.__cmp || window.cmp },
        { id: 'sirdata', name: 'Sirdata', check: () => document.querySelector('[class*="sdrn-"]') || document.getElementById('sd-cmp') },
        { id: 'ezcookie', name: 'Ezoic (EzCookie)', check: () => document.querySelector('[class*="ez-cookie"]') || document.getElementById('ez-cookie-dialog') },
        { id: 'borlabs', name: 'Borlabs Cookie', check: () => document.querySelector('#BorlabsCookieBox') || window.BorlabsCookie },
        { id: 'lgcookieslaw', name: 'LGCookiesLaw (PrestaShop)', check: () => document.getElementById('lgcookieslaw_banner') || document.querySelector('.lgcookieslaw-banner') || document.querySelector('[class*="lgcookieslaw"]') },
        // ── v1.8.0: 31 new CMP detectors ──
        { id: 'complianz', name: 'Complianz', check: () => document.querySelector('#cmplz-cookiebanner') || document.querySelector('.cmplz-cookiebanner') || window.cmplz },
        { id: 'cookienotice', name: 'Cookie Notice', check: () => document.querySelector('#cookie-notice') || document.querySelector('.cookie-notice-container') || document.querySelector('#cn-notice-content') },
        { id: 'osano', name: 'Osano', check: () => document.querySelector('.osano-cm-dialog') || window.Osano },
        { id: 'termly', name: 'Termly', check: () => document.querySelector('#termly-consent-content') || document.querySelector('[data-testid="termly-consent"]') || window.Termly },
        { id: 'cookieinfo', name: 'Cookie Information', check: () => document.querySelector('#coiOverlay') || document.querySelector('.coi-banner') || window.CookieInformation || window.CookieInformationConsent },
        { id: 'realcookiebanner', name: 'Real Cookie Banner', check: () => document.querySelector('#real-cookie-banner') || document.querySelector('.real-cookie-banner') || window.realCookieBanner },
        { id: 'moovegdpr', name: 'Moove GDPR', check: () => document.querySelector('#moove_gdpr_cookie_modal') || document.querySelector('.moove-gdpr-infobar') || document.querySelector('#moove_gdpr_cookie_info_bar') },
        { id: 'cookieadmin', name: 'CookieAdmin', check: () => document.querySelector('#cookieadmin-banner') || document.querySelector('.cookieadmin') || document.querySelector('[id^="cookieadmin"]') },
        { id: 'beautifulcookie', name: 'Beautiful Cookie Consent', check: () => document.querySelector('#ccc') || document.querySelector('#ccc-icon') || document.querySelector('.ccc-wrapper') },
        { id: 'pressidium', name: 'Pressidium', check: () => document.querySelector('#pressidium-cc') || document.querySelector('.pressidium-cookie-consent') },
        { id: 'wplpcookie', name: 'WPLP Cookie Consent', check: () => document.querySelector('.gdpr-cookie-consent') || document.querySelector('#gdpr-cookie-consent') || document.querySelector('[class*="wplp-cookie"]') },
        { id: 'axeptio', name: 'Axeptio', check: () => document.querySelector('#axeptio_overlay') || document.querySelector('.axeptio_main') || window.axeptio },
        { id: 'admiral', name: 'Admiral', check: () => document.querySelector('[class*="admiral"][class*="banner"]') || document.querySelector('[class*="admiral"][class*="consent"]') || window.admiral },
        { id: 'commandersact', name: 'Commanders Act', check: () => document.querySelector('#tc-privacy-wrapper') || document.querySelector('[class*="tc-privacy"]') || window.tC },
        { id: 'cookiefirst', name: 'CookieFirst', check: () => document.querySelector('#cookiefirst-modal') || document.querySelector('.cookiefirst') || window.cookiefirst },
        { id: 'cookiehub', name: 'CookieHub', check: () => document.querySelector('#cookiehub-dialog') || document.querySelector('.cookiehub') || window.cookiehub },
        { id: 'gravito', name: 'Gravito', check: () => document.querySelector('.gravito-cmp') || document.querySelector('[id*="gravito"]') || window.gravito },
        { id: 'truendo', name: 'TRUENDO', check: () => document.querySelector('[id*="truendo"]') || document.querySelector('.truendo') || window.TRUENDO },
        { id: 'clickio', name: 'Clickio', check: () => document.querySelector('.clickio-cookie') || document.querySelector('[id*="clickio"]') || window.Clickio },
        { id: 'appconsent', name: 'AppConsent', check: () => document.querySelector('[class*="appconsent"]') || document.querySelector('[id*="appconsent"]') || window.AppConsent || window.SFBX },
        { id: 'cloudflare', name: 'Cloudflare', check: () => document.querySelector('#cf-cc-banner') || document.querySelector('[class*="cf-cookie"]') || document.querySelector('#cf-consent') },
        { id: 'securiti', name: 'Securiti', check: () => document.querySelector('[class*="securiti"][class*="consent"]') || document.querySelector('[class*="securiti"][class*="banner"]') || window.Securiti },
        { id: 'transcend', name: 'Transcend', check: () => document.querySelector('[class*="transcend"][class*="consent"]') || document.querySelector('[class*="transcend"][class*="banner"]') || window.transcend },
        { id: 'civic', name: 'CIVIC', check: () => document.querySelector('[class*="civic-cookie"]') || document.querySelector('[id*="civic-cookie"]') || window.CookieControl },
        { id: 'fastcmp', name: 'FastCMP', check: () => document.querySelector('[id*="fastcmp"]') || document.querySelector('[class*="fastcmp"]') || window.FastCMP },
        { id: 'lawwwing', name: 'Lawwwing', check: () => document.querySelector('[class*="lawwwing"]') || document.querySelector('[id*="lawwwing"]') || window.Lawwwing },
        { id: 'avacy', name: 'AVACY', check: () => document.querySelector('[class*="avacy"]') || document.querySelector('[id*="avacy"]') || window.AvacyCMP },
        { id: 'consentmo', name: 'Consentmo', check: () => document.querySelector('#cookie-consent-banner.consentmo') || document.querySelector('#cookie-consent-banner[data-consentmo]') || document.querySelector('[class*="consentmo"]') || document.querySelector('[id*="consentmo"]') },
        { id: 'pandectes', name: 'Pandectes', check: () => document.querySelector('[class*="pandectes"]') || document.querySelector('[id*="pandectes"]') || window.Pandectes },
        { id: 'enzuzo', name: 'Enzuzo', check: () => document.querySelector('[class*="enzuzo"]') || document.querySelector('[id*="enzuzo"]') || window.Enzuzo },
        { id: 'cookiescript', name: 'Cookie Script', check: () => document.querySelector('#cookiescript_injected') || document.querySelector('[class*="cookiescript"]') },
      ];

      for (const detector of detectors) {
        try {
          const result = detector.check();
          if (result) {
            // If the check returned a DOM element, verify it's actually visible.
            // Many CMPs leave their banner element in the DOM but hidden
            // (display:none) after the user has already consented. Without
            // this check, we'd "detect" and "reject" an invisible banner,
            // incrementing the stats counter on every page load.
            if (result instanceof HTMLElement && !Utils.isVisible(result)) {
              continue;
            }
            const cached = { id: detector.id, name: detector.name };
            this._lastDetection = cached;
            this._lastDetectionTime = now;
            return cached;
          }
        } catch (e) { /* skip */ }
      }

      // Fallback: generic detection based on common banner patterns
      if (CMPDetector.detectGeneric()) {
        const cached = { id: 'generic', name: 'Generic' };
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
        // CCPA / Do Not Sell banners
        '[class*="do-not-sell"]', '[id*="do-not-sell"]',
        '[class*="ccpa"]', '[id*="ccpa"]',
        '[class*="opt-out-banner"]', '[class*="optout"]',
        // Third-party hosted banners
        '[class*="cookieconsent"]', '[id*="cookieconsent"]',
        '[class*="cookie-law"]', '[id*="cookie-law"]',
        '[id*="cookie-script"]', '[class*="cookie-script"]',
        '[id*="cookielaw"]', '[class*="cookielaworg"]',
      ];

      for (const sel of bannerIndicators) {
        const el = document.querySelector(sel);
        if (el && Utils.isVisible(el)) return true;
      }

      // Also check inside Shadow DOMs (cache known hosts)
      if (!this._shadowHosts || Date.now() - this._shadowHostsTimestamp > 5000) {
        this._shadowHosts = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.shadowRoot) this._shadowHosts.push(el);
        }
        this._shadowHostsTimestamp = Date.now();
      }
      for (const host of this._shadowHosts) {
        for (const sel of bannerIndicators) {
          const el = host.shadowRoot.querySelector(sel);
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

  function registerHandler(id, name, detect, reject) {
    CMPHandlers[id] = {
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
  }

  // ──────────────── OneTrust ────────────────────────
  registerHandler('onetrust', 'OneTrust', function detect() {
    return !!(
      document.getElementById('onetrust-banner-sdk') ||
      document.getElementById('onetrust-consent-sdk') ||
      window.OneTrust
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
          '.category-switch-handler, input.ot-handler-toneop'
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
  });

  // ──────────────── Fides (ethyca) ────────────────────────
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
            await Utils.sleep(30);
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
              await Utils.sleep(30);
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
  });

  // ──────────────── Ketch ────────────────────────
  registerHandler('ketch', 'Ketch', function detect() {
    return !!(
      document.getElementById('ketch-consent-banner') ||
      document.getElementById('ketch-banner') ||
      document.querySelector('[id*="ketch-consent"]')
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
          await Utils.sleep(30);
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
            await Utils.sleep(30);
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
  });

  // ──────────────── Cookiebot ────────────────────────
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
  });

  // ──────────────── Didomi ────────────────────────
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
  });

  // ──────────────── Sourcepoint ────────────────────────
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
        window.__tcfapi('rejectAll', 2, () => {});
        rejected++;
      } catch (e) { /* ignore */ }
    }

    return { rejected, vendorsUnticked };
  });

  // ──────────────── TrustArc ────────────────────────
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

  });

  // ──────────────── Quantcast ────────────────────────
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
  });

  // ──────────────── Usercentrics ────────────────────────
  registerHandler('usercentrics', 'Usercentrics', function detect() {
    return !!(

      document.getElementById('usercentrics-root') ||
      document.querySelector('[data-testid="uc-banner"]') ||
      window.UC_UI
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    const root = document.getElementById('usercentrics-root');
    const container = root ? root.shadowRoot : document;

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

    // Fallback: use UC_UI API
    if (rejected === 0 && window.UC_UI) {
      try {
        window.UC_UI.rejectAll();
        rejected++;
      } catch (e) { /* ignore */ }
    }

    return { rejected, vendorsUnticked };
  });

  // ──────────────── CookieYes ────────────────────────
  registerHandler('cookieyes', 'CookieYes', function detect() {
    return !!(
      document.getElementById('cky-btn-reject') ||
      document.querySelector('.cky-consent-bar') ||
      document.querySelector('[data-cky-tag]')
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;

    // Click "Reject All"
    const rejectBtn =
      document.getElementById('cky-btn-reject') ||
      document.querySelector('[data-cky-tag="reject-button"]') ||
      Utils.findByText('reject all', document.querySelector('.cky-consent-bar') || document, 'button');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
      return { rejected, vendorsUnticked };
    }

    // Open preferences
    const prefsBtn =
      document.querySelector('[data-cky-tag="settings-button"]') ||
      Utils.findByText('manage', document.querySelector('.cky-consent-bar') || document, 'button');
    if (prefsBtn) {
      prefsBtn.click();
      await Utils.sleep(CONFIG.dynamicLoadDelay);

      const modal = document.querySelector('.cky-modal, [class*="cky-preference"]');
      if (modal) {
        const toggles = modal.querySelectorAll('input[type="checkbox"], input[role="switch"]');
        for (const toggle of toggles) {
          if (toggle.checked && !toggle.disabled) {
            toggle.click();
            rejected++;
          }
        }

        const saveBtn =
          modal.querySelector('[data-cky-tag="reject-button"], [data-cky-tag="save-button"]') ||
          Utils.findByText('save preferences', modal, 'button') ||
          Utils.findByText('save', modal, 'button') ||
          Utils.findByText('confirm', modal, 'button') ||
          Utils.findByText('reject all', modal, 'button');
        if (saveBtn) {
          saveBtn.click();
          rejected++;
        }
      }
    }

    return { rejected, vendorsUnticked };
  });

  // ──────────────── Iubenda ────────────────────────
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
  });

  // ──────────────── ConsentManager ────────────────────────
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
            await Utils.sleep(100);
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
            await Utils.sleep(30);
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
  });

  // ──────────────── Sirdata ────────────────────────
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
  });

  // ──────────────── Ezoic ────────────────────────
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
  });

  // ──────────────── Borlabs Cookie ────────────────────────
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
  });

  // ──────────────── LGCookiesLaw (PrestaShop) ────────────────────────
  registerHandler('lgcookieslaw', 'LGCookiesLaw (PrestaShop)', function detect() {
    return !!(
      document.getElementById('lgcookieslaw_banner') ||
      document.querySelector('.lgcookieslaw-banner')
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
  });

  // ──────────────── Complianz ────────────────────────
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
  });

  // ──────────────── Cookie Notice (Humanityco) ────────────────────────
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
  });

  // ──────────────── Osano ────────────────────────
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
  });

  // ──────────────── Termly ────────────────────────
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
  });

  // ──────────────── Cookie Information ────────────────────────
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
  });

  // ──────────────── Real Cookie Banner ────────────────────────
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
  });

  // ──────────────── Moove GDPR ────────────────────────
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
  });

  // ──────────────── CookieAdmin ────────────────────────
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
  });

  // ──────────────── Beautiful Cookie Consent ────────────────────────
  registerHandler('beautifulcookie', 'Beautiful Cookie Consent', function detect() {
    return !!(
      document.querySelector('#ccc') ||
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
  });

  // ──────────────── Pressidium Cookie Consent ────────────────────────
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
  });

  // ──────────────── WPLP Cookie Consent ────────────────────────
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
  });

  // ──────────────── Axeptio ────────────────────────
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
  });

  // ──────────────── Admiral ────────────────────────
  registerHandler('admiral', 'Admiral', function detect() {
    return !!(
      document.querySelector('[class*="admiral"]') ||
      document.querySelector('[id*="admiral"]') ||
      typeof window.admiral !== 'undefined'
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
  });

  // ──────────────── Commanders Act ────────────────────────
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
  });

  // ──────────────── CookieFirst ────────────────────────
  registerHandler('cookiefirst', 'CookieFirst', function detect() {
    return !!(
      document.querySelector('#cookiefirst-modal') ||
      document.querySelector('.cookiefirst') ||
      typeof window.cookiefirst !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const modal = document.querySelector('#cookiefirst-modal') ||
                  document.querySelector('.cookiefirst');
    if (!modal) return { rejected, vendorsUnticked };

    const rejectBtn =
      modal.querySelector('[class*="reject"]') ||
      Utils.findByText('reject all', modal, 'button, a') ||
      Utils.findByText('reject', modal, 'button, a') ||
      Utils.findByText('necessary only', modal, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  });

  // ──────────────── CookieHub ────────────────────────
  registerHandler('cookiehub', 'CookieHub', function detect() {
    return !!(
      document.querySelector('#cookiehub-dialog') ||
      document.querySelector('.cookiehub') ||
      typeof window.cookiehub !== 'undefined'
    );
  }, async function reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    const dialog = document.querySelector('#cookiehub-dialog') ||
                   document.querySelector('.cookiehub');
    if (!dialog) return { rejected, vendorsUnticked };

    const rejectBtn =
      dialog.querySelector('[class*="reject"]') ||
      dialog.querySelector('[id*="reject"]') ||
      Utils.findByText('reject all', dialog, 'button, a') ||
      Utils.findByText('necessary only', dialog, 'button, a') ||
      Utils.findByText('reject', dialog, 'button, a');
    if (rejectBtn) {
      rejectBtn.click();
      rejected++;
    }
    return { rejected, vendorsUnticked };
  });

  // ──────────────── Gravito ────────────────────────
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
  });

  // ──────────────── TRUENDO ────────────────────────
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
  });

  // ──────────────── Clickio ────────────────────────
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
  });

  // ──────────────── AppConsent ────────────────────────
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
  });

  // ──────────────── Cloudflare ────────────────────────
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
  });

  // ──────────────── Securiti ────────────────────────
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
  });

  // ──────────────── Transcend ────────────────────────
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
  });

  // ──────────────── CIVIC Cookie Control ────────────────────────
  registerHandler('civic', 'CIVIC', function detect() {
    return !!(
      document.querySelector('[class*="civic-cookie"]') ||
      document.querySelector('[id*="civic-cookie"]') ||
      typeof window.CookieControl !== 'undefined'
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
  });

  // ──────────────── FastCMP ────────────────────────
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
  });

  // ──────────────── Lawwwing ────────────────────────
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
  });

  // ──────────────── AVACY ────────────────────────
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
  });

  // ──────────────── Consentmo ────────────────────────
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
  });

  // ──────────────── Pandectes ────────────────────────
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
  });

  // ──────────────── Enzuzo ────────────────────────
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
  });

  // ──────────────── Cookie Script ────────────────────────
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
  });


  // ──────────────── Generic (fallback) ────────────────────────
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

        // Untick all toggles
        const modals = document.querySelectorAll(
          '[role="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"]'
        );
        for (const modal of modals) {
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
            setTimeout(finish, 2000);
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
    _primarySelectors: {
      onetrust: '#onetrust-banner-sdk',
      fides: '#fides-banner-container, #fides-banner',
      ketch: '#ketch-consent-banner, #ketch-banner',
      cookiebot: '#CybotCookiebotDialog',
      didomi: '#didomi-popup',
      sourcepoint: '.sp_message_container, [class*="sp_veil"]',
      trustarc: '#truste-consent-track, .trustarc-banner',
      quantcast: '.qc-cmp2-container',
      usercentrics: '#usercentrics-root',
      cookieyes: '.cky-consent-bar',
      iubenda: '.iubenda-cs-banner',
      consentmanager: '#cmpbox',
      sirdata: '#sd-cmp',
      ezcookie: '#ez-cookie-dialog',
      borlabs: '#BorlabsCookieBox',
      lgcookieslaw: '#lgcookieslaw_banner',
      // ── v1.8.0: 31 new CMP selectors ──
      complianz: '#cmplz-cookiebanner, .cmplz-cookiebanner',
      cookienotice: '#cookie-notice, .cookie-notice-container',
      osano: '.osano-cm-dialog',
      termly: '#termly-consent-content, [data-testid="termly-consent"]',
      cookieinfo: '#coiOverlay, .coi-banner',
      realcookiebanner: '#real-cookie-banner, .real-cookie-banner',
      moovegdpr: '#moove_gdpr_cookie_modal, .moove-gdpr-infobar',
      cookieadmin: '#cookieadmin-banner, .cookieadmin',
      beautifulcookie: '#ccc, .ccc-wrapper',
      pressidium: '#pressidium-cc, .pressidium-cookie-consent',
      wplpcookie: '.gdpr-cookie-consent, #gdpr-cookie-consent',
      axeptio: '#axeptio_overlay, .axeptio_main',
      admiral: '[class*="admiral"][class*="banner"], [class*="admiral"][class*="consent"]',
      commandersact: '#tc-privacy-wrapper, [class*="tc-privacy"]',
      cookiefirst: '#cookiefirst-modal, .cookiefirst',
      cookiehub: '#cookiehub-dialog, .cookiehub',
      gravito: '.gravito-cmp, [id*="gravito"]',
      truendo: '[id*="truendo"], .truendo',
      clickio: '.clickio-cookie, [id*="clickio"]',
      appconsent: '[class*="appconsent"], [id*="appconsent"]',
      cloudflare: '#cf-cc-banner, [class*="cf-cookie"], #cf-consent',
      securiti: '[class*="securiti"][class*="consent"], [class*="securiti"][class*="banner"]',
      transcend: '[class*="transcend"][class*="consent"], [class*="transcend"][class*="banner"]',
      civic: '[class*="civic-cookie"], [id*="civic-cookie"]',
      fastcmp: '[id*="fastcmp"], [class*="fastcmp"]',
      lawwwing: '[class*="lawwwing"], [id*="lawwwing"]',
      avacy: '[class*="avacy"], [id*="avacy"]',
      consentmo: '#cookie-consent-banner, [class*="consentmo"]',
      pandectes: '[class*="pandectes"], [id*="pandectes"]',
      enzuzo: '[class*="enzuzo"], [id*="enzuzo"]',
      cookiescript: '#cookiescript_injected, [class*="cookiescript"]',
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
    _detecting: false,
    _handling: false,
    _pendingForceReject: false,
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
          if (!settings.enabled || !settings.autoReject) {
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

      // Check whitelist (non-blocking)
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
        this._whitelistChecked = true;
      });

      // Start detection -- runs immediately, settings will abort if needed
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
          await Utils.sleep(50);
        }
        this._settingsLoaded = true; // proceed anyway after timeout
      }

      // Wait for whitelist check (max 2s)
      if (!this._whitelistChecked) {
        const wlDeadline = Date.now() + CONFIG.settingsWaitTimeout;
        while (!this._whitelistChecked && Date.now() < wlDeadline) {
          await Utils.sleep(50);
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

        const cmp = CMPDetector.detect();
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

        const cmp = CMPDetector.detect();
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


      const handler = CMPHandlers[cmpInfo.id];
      if (!handler) return;

      // Verify detection
      if (!handler.detect()) return;

      // Verify the banner element is actually visible (not just the JS global)
      if (!this.isCMPBannerVisible(cmpInfo.id)) {
        DebugLog.log('CMP detected via global but banner not visible, skipping:', cmpInfo.name);
        return;
      }

      this.currentCMP = cmpInfo;
      DebugLog.log('Detected CMP:', cmpInfo.name, 'on', this.getDomain());

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

        DebugLog.log('Handler result:', result);

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
        const stillVisible = this.isBannerStillVisible(cmpInfo);

        if (stillVisible && result.rejected > 0) {
          // The handler claimed success but the banner is still there.
          // The click was a false positive -- the JS wasn't ready.
          // Don't mark as processed so the observer/interval can retry.
          this.lastFailedAttempt = Date.now();
          const visibleSel = this._primarySelectors[cmpInfo.id] || 'unknown';
          DebugLog.warn('False positive -- banner still visible after rejection. Selector:', visibleSel);
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
              cmp: cmpInfo.name,
              rejected: result.rejected,
              vendorsUnticked: result.vendorsUnticked,
              timestamp: Date.now(),
              url: safeUrl,
            },
          });
          DebugLog.log('Logged action:', domain, cmpInfo.name);

        }
      } catch (e) {
        DebugLog.error('Error handling CMP:', e.message);
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
        // The detection may have come from a window global only,
        // so we can't confirm visibility via DOM -- assume visible
        // and let existing logic handle it.
        return true;
      }

      return Utils.isVisible(el);
    },

    /**
     * Check if the banner from a previously detected CMP is still visible.
     * Uses the handler's detect() method dynamically instead of a hardcoded
     * list of selectors -- so adding a new handler automatically updates this.
     */
    isBannerStillVisible(cmpInfo) {
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
          if (!message.settings.enabled || !message.settings.autoReject) {
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
