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

  // ─── Prevent double-injection and skip non-top frames ──────────────
  // Cookie consent banners always live in the top-level frame. Running
  // in every iframe wastes resources: N iframes = N Engine instances,
  // N MutationObservers, N intervals all scanning for banners that will
  // never appear there.
  if (window.__cookieReject_ext_v1x2x0) return;
  window.__cookieReject_ext_v1x2x0 = true;
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
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      // Use MouseEvent for more realistic clicks that CMPs are less likely to reject
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
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
        toggleSelector = 'input[type="checkbox"], input[role="switch"], .ot-switch input, .switch input, input[class*="toggle"]',
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
        '[class*="toggle"][role="switch"], [class*="switch"][aria-checked="true"], .ot-switch-nob, .ot-tgl-switch'
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
        { id: 'fides', name: 'Fides', check: () => document.getElementById('fides-banner-container') || document.getElementById('fides-banner') },
        { id: 'ketch', name: 'Ketch', check: () => document.getElementById('ketch-consent-banner') || document.getElementById('ketch-banner') || window.ketchConsent },
        { id: 'cookiebot', name: 'Cookiebot', check: () => document.getElementById('CybotCookiebotDialog') || window.Cookiebot || document.querySelector('[data-cb-id]') },
        { id: 'didomi', name: 'Didomi', check: () => document.getElementById('didomi-popup') || document.getElementById('didomi-host') || window.Didomi },
        { id: 'sourcepoint', name: 'Sourcepoint', check: () => document.querySelector('[id^="sp_message_iframe"]') || document.querySelector('.sp_message_container') || window._sp_ },
        { id: 'trustarc', name: 'TrustArc', check: () => document.getElementById('truste-consent-track') || document.getElementById('trustarc-banner') || document.querySelector('.trustarc-banner') || window.truste },
        { id: 'quantcast', name: 'Quantcast', check: () => document.querySelector('.qc-cmp2-container') || document.querySelector('[class*="qc-cmp"]') || window.__qcmp },
        { id: 'usercentrics', name: 'Usercentrics', check: () => document.getElementById('usercentrics-root') || document.querySelector('[data-testid="uc-banner"]') || window.UC_UI },
        { id: 'cookieyes', name: 'CookieYes', check: () => document.getElementById('cky-btn-reject') || document.querySelector('.cky-consent-bar') || document.querySelector('[data-cky-tag]') },
        { id: 'iubenda', name: 'Iubenda', check: () => document.querySelector('.iubenda-cs-banner') || document.getElementById('iubenda-cs-banner') || window._iub },
        { id: 'consentmanager', name: 'ConsentManager', check: () => document.getElementById('cmpbox') || document.getElementById('cmpwrapper') || window.cmp },
        { id: 'sirdata', name: 'Sirdata', check: () => document.querySelector('[class*="sdrn-"]') || document.getElementById('sd-cmp') },
        { id: 'ezcookie', name: 'Ezoic (EzCookie)', check: () => document.querySelector('[class*="ez-cookie"]') || document.getElementById('ez-cookie-dialog') },
        { id: 'borlabs', name: 'Borlabs Cookie', check: () => document.querySelector('#BorlabsCookieBox') || window.BorlabsCookie },
        { id: 'lgcookieslaw', name: 'LGCookiesLaw (PrestaShop)', check: () => document.getElementById('lgcookieslaw_banner') || document.querySelector('.lgcookieslaw-banner') || document.querySelector('[class*="lgcookieslaw"]') },
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
        // Common cookie banner classes
        '[class*="cookie-banner"]', '[class*="cookie-notice"]',
        '[class*="cookie-consent"]', '[class*="cookie-popup"]',
        '[class*="consent-banner"]', '[class*="consent-popup"]',
        '[class*="gdpr-banner"]', '[class*="gdpr-notice"]',
        '[class*="privacy-banner"]', '[class*="privacy-popup"]',
        '[class*="cc-banner"]', '[class*="cmp-banner"]',
        // Role-based
        '[role="dialog"][class*="cookie"]',
        '[role="dialog"][class*="consent"]',
        '[role="dialog"][class*="privacy"]',
        // Fixed position banners (common for cookie popups)
        'div[style*="position: fixed"][class*="cookie"]',
        // Custom/proprietary cookie overlays
        '[class*="privacy-cookie"]',
        '[id*="CookiePolicy"]',
        '[class*="cookie-overlay"]',
        '[class*="cookie-policy"]',
      ];

      for (const sel of bannerIndicators) {
        const el = document.querySelector(sel);
        if (el && Utils.isVisible(el)) return true;
      }

      // Also check inside Shadow DOMs (cache known hosts)
      if (!this._shadowHosts) {
        this._shadowHosts = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.shadowRoot) this._shadowHosts.push(el);
        }
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
      Utils.findByText('decline', document.getElementById('CybotCookiebotDialog'), 'a, button');
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
      const saveBtn =
        document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll') ||
        Utils.findByText('save', dialog || document, 'a, button') ||
        Utils.findByText('confirm', dialog || document, 'a, button') ||
        Utils.findByText('submit', dialog || document, 'a, button');
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
            vendorsUnticked += 5; // approximate
            await Utils.sleep(100);
          }
        }

        // Also untick individual vendor checkboxes via aria-checked
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
      'continue without accepting', 'manage choices',
      'necessary cookies only', 'strictly necessary only',
      'accept only essential', 'accept required',
      // German
      'ablehnen', 'alle ablehnen', 'nur notwendige',
      'nur erforderliche', 'notwendige cookies',
      'alle ablehnen', 'ablehnen alle',
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
    ];

    // Find and click reject button -- single DOM pass for all patterns
    const rejectBtns = Utils.findAllByText(rejectTexts, document, 'button, a, span, div');
    if (rejectBtns.length > 0) {
      // Pick the best match: prefer buttons with exact-ish text over partial matches
      // (e.g. "Reject All" over "I reject everything and leave")
      const btn = rejectBtns.reduce((best, el) => {
        const txt = (el.textContent || '').trim().toLowerCase();
        // Prefer shorter matches (more specific button text)
        if (!best || txt.length < best._len) return Object.assign(el, { _len: txt.length });
        return best;
      }, null);
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
          const rBtn = Utils.findByText(rText, document, 'button, a, span, div');
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
      if (typeof window.__tcfapi === 'function') {
        try {
          window.__tcfapi('addEventListener', 2, (tcData, success) => {
            if (success && tcData.eventStatus === 'tcloaded') {
              // Reject all purposes and vendors
              window.__tcfapi('rejectAll', 2, () => {}, tcData.listenerId);
              // Also try posting a rejectAll command
            }
          });
          success = true;
        } catch (e) { /* ignore */ }
      }

      // Try __uspapi (US Privacy)
      if (typeof window.__uspapi === 'function') {
        try {
          window.__uspapi('setUspDftData', 1, () => {}, { version: 1, uspString: '1YYN' });
          success = true;
        } catch (e) { /* ignore */ }
      }

      // Try __gpp (Global Privacy Platform)
      if (typeof window.__gpp === 'function') {
        try {
          window.__gpp('addEventListener', (evt) => {
            if (evt.eventName === 'sectionChange') {
              window.__gpp('setNavEntry', null, 'rejectAll');
            }
          });
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

      // Remove body scroll lock
      if (document.body.style.overflow === 'hidden' ||
          document.body.style.overflow === 'clip') {
        document.body.style.overflow = '';
      }
      if (document.documentElement.style.overflow === 'hidden' ||
          document.documentElement.style.overflow === 'clip') {
        document.documentElement.style.overflow = '';
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
    },
    initialized: false,
    intervalRetries: 0,
    processed: false,
    currentCMP: null,
    observer: null,
    observerActive: false,
    initTimestamp: Date.now(),
    lastFailedAttempt: 0,
    _settingsLoaded: false,
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
          }
        }
        this._settingsLoaded = true;
      });

      // Check whitelist (non-blocking)
      this.sendMessage({ type: 'CHECK_LIST', domain: this.getDomain() }).then((listCheck) => {
        if (listCheck && listCheck.whitelisted) {
          this.processed = true;
          DebugLog.log('Site whitelisted, skipping:', this.getDomain());
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
        }
      });

      // Start detection -- runs immediately, settings will abort if needed
      this.detectAndReject();
    },

    async detectAndReject() {
      // Wait for settings to load before starting detection (max 2s)
      if (!this._settingsLoaded) {
        const settingsDeadline = Date.now() + CONFIG.settingsWaitTimeout;
        while (!this._settingsLoaded && Date.now() < settingsDeadline) {
          await Utils.sleep(50);
        }
        this._settingsLoaded = true; // proceed anyway after timeout
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
      const intervalId = setInterval(async () => {
        if (this.processed) {
          clearInterval(intervalId);
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
          return;
        }

        this.intervalRetries++;
        if (this.intervalRetries > CONFIG.maxRetries) {
          clearInterval(intervalId);
          // Stop the observer too -- we've waited long enough
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
          return;
        }

        const cmp = CMPDetector.detect();
        if (cmp) {
          clearInterval(intervalId);
          if (this.observerActive) {
            this.observerActive = false;
            this.observer.disconnect();
          }
          await this.handleCMP(cmp);
        }
      }, CONFIG.retryInterval);
    },

    async handleCMP(cmpInfo) {
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
        return new URL(window.location.href).hostname;
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
})();
