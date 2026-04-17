/**
 * CookieReject - Background Service Worker
 * Handles stats tracking, logging, whitelist/blacklist management, and storage.
 * All data is stored in chrome.storage.local with cr_ prefixed keys.
 * Data persists across extension reloads and updates.
 */

// ─── Cross-Browser Polyfill (inlined for service worker) ────────────
// Service workers can only load a single file in Manifest V3,
// so the polyfill is inlined here instead of loaded separately.
// This mirrors browser-polyfill.js exactly (using self instead of window).
{
  // If chrome is undefined but browser exists (Firefox), alias it
  if (typeof chrome === 'undefined' && typeof browser !== 'undefined') {
    self.chrome = browser;
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
}

(function () {
  'use strict';

  // ─── Version (single source of truth: read from manifest) ──────────
  const APP_VERSION = chrome.runtime.getManifest().version;

  // ─── Constants ──────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    STATS: 'cr_stats',
    LOG: 'cr_log',
    WHITELIST: 'cr_whitelist',
    BLACKLIST: 'cr_blacklist',
    SETTINGS: 'cr_settings',
    META: 'cr_meta',
    UNIQUE_DOMAINS: 'cr_unique_domains',
  };

  const DEFAULT_STATS = {
    totalRejected: 0,
    totalVendorsUnticked: 0,
    totalBannersRejected: 0,
    totalUniqueSites: 0,
    installDate: null,
    lastResetDate: null,
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    showNotifications: false,
    autoReject: true,
    untickVendors: true,
    dismissOverlays: true,
    useTCFApi: true,
    debugMode: false,
    dryRun: false,
  };

  const MAX_LOG_ENTRIES = 500;

  // ─── Debug Logging ─────────────────────────────────────────────────
  let debugMode = false;

  function debugLog(...args) {
    if (debugMode) console.log('[CookieReject]', ...args);
  }

  async function loadDebugMode() {
    const settings = await SyncStorage.get(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
    debugMode = settings.debugMode || false;
  }

  // ─── Storage Helpers ────────────────────────────────────────────────
  const Storage = {
    async get(key, defaultValue = null) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(key, (result) => {
            resolve(result[key] !== undefined ? result[key] : defaultValue);
          });
        } catch {
          resolve(defaultValue);
        }
      });
    },

    async set(key, value) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [key]: value }, resolve);
        } catch {
          resolve();
        }
      });
    },

    async remove(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.remove(keys, resolve);
        } catch {
          resolve();
        }
      });
    },

    async getAll() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(null, resolve);
        } catch {
          resolve({});
        }
      });
    },
  };

  // ─── Sync Storage (cross-device sync for settings/lists) ────────────
  // chrome.storage.sync has a 100KB total limit and 8KB per-item limit.
  // Only settings, whitelist, and blacklist are synced. Stats/log stay local.
  const SYNC_KEYS = new Set(['cr_settings', 'cr_whitelist', 'cr_blacklist']);

  const SyncStorage = {
    async get(key, defaultValue = null) {
      return new Promise((resolve) => {
        try {
          // Try sync first, fall back to local
          const store = SYNC_KEYS.has(key) ? chrome.storage.sync : chrome.storage.local;
          store.get(key, (result) => {
            if (chrome.runtime.lastError) {
              // Sync not available (e.g. Safari), fall back to local
              chrome.storage.local.get(key, (localResult) => {
                resolve(localResult[key] !== undefined ? localResult[key] : defaultValue);
              });
              return;
            }
            resolve(result[key] !== undefined ? result[key] : defaultValue);
          });
        } catch {
          resolve(defaultValue);
        }
      });
    },

    async set(key, value) {
      return new Promise((resolve) => {
        try {
          if (SYNC_KEYS.has(key)) {
            // Write to both sync and local for redundancy
            chrome.storage.sync.set({ [key]: value }, () => {
              if (chrome.runtime.lastError) {
                // Sync quota exceeded or unavailable -- just use local
                chrome.storage.local.set({ [key]: value }, resolve);
                return;
              }
              // Also write to local as fallback
              chrome.storage.local.set({ [key]: value }, resolve);
            });
          } else {
            chrome.storage.local.set({ [key]: value }, resolve);
          }
        } catch {
          chrome.storage.local.set({ [key]: value }, resolve);
        }
      });
    },
  };

  // ─── Data Migration ─────────────────────────────────────────────────
  const Migration = {
    mergeWithDefaults(stored, defaults) {
      if (!stored || typeof stored !== 'object') return { data: { ...defaults }, needsUpdate: true };
      let needsUpdate = false;
      const merged = { ...defaults };
      for (const key of Object.keys(stored)) {
        merged[key] = stored[key];
      }
      for (const key of Object.keys(defaults)) {
        if (!(key in stored)) {
          needsUpdate = true;
        }
      }
      return { data: merged, needsUpdate };
    },

    async run() {
      let migrated = false;

      // 1. Migrate stats
      const stats = await Storage.get(STORAGE_KEYS.STATS, null);
      if (stats) {
        const { data, needsUpdate } = this.mergeWithDefaults(stats, DEFAULT_STATS);
        if (needsUpdate) {
          await Storage.set(STORAGE_KEYS.STATS, data);
          migrated = true;
        }
      }

      // 2. Migrate settings
      const settings = await SyncStorage.get(STORAGE_KEYS.SETTINGS, null);
      if (settings) {
        const { data, needsUpdate } = this.mergeWithDefaults(settings, DEFAULT_SETTINGS);
        if (needsUpdate) {
          await SyncStorage.set(STORAGE_KEYS.SETTINGS, data);
          migrated = true;
        }
      }

      // 3. Ensure meta record exists
      const meta = await Storage.get(STORAGE_KEYS.META, null);
      if (!meta) {
        await Storage.set(STORAGE_KEYS.META, {
          version: APP_VERSION,
          firstInstallDate: (await Storage.get(STORAGE_KEYS.STATS, {})).installDate || Date.now(),
          lastMigrationDate: Date.now(),
        });
        migrated = true;
      } else if (meta.version !== APP_VERSION) {
        await Storage.set(STORAGE_KEYS.META, {
          ...meta,
          version: APP_VERSION,
          lastMigrationDate: Date.now(),
        });
        migrated = true;
      }

      if (migrated) {
        console.log(`[CookieReject] Migration complete. Data preserved. v${APP_VERSION}`);
      }
    },
  };

  // Simple promise queue to serialize storage read-modify-write operations
  let _storageQueue = Promise.resolve();

  // ─── Stats Management ───────────────────────────────────────────────
  const StatsManager = {
    async get() {
      return await Storage.get(STORAGE_KEYS.STATS, DEFAULT_STATS);
    },

    async update(updates) {
      const stats = await this.get();
      const updated = { ...stats, ...updates };
      await Storage.set(STORAGE_KEYS.STATS, updated);
      return updated;
    },

    async increment(fields) {
      return _storageQueue = _storageQueue.then(async () => {
        const stats = await this.get();
        for (const [key, amount] of Object.entries(fields)) {
          stats[key] = (stats[key] || 0) + amount;
        }
        await Storage.set(STORAGE_KEYS.STATS, stats);
        return stats;
      }).catch(e => {
        console.error('Storage operation failed:', e);
        return this.get();
      });
    },

    async reset() {
      const resetStats = {
        ...DEFAULT_STATS,
        installDate: Date.now(),
        lastResetDate: Date.now(),
      };
      await Storage.set(STORAGE_KEYS.STATS, resetStats);
      // Also clear unique domains set
      await Storage.set(STORAGE_KEYS.UNIQUE_DOMAINS, []);
      // Invalidate UniqueDomainTracker cache so it reloads from empty storage
      UniqueDomainTracker._cache = null;
      return resetStats;
    },

    // Estimated time saved (based on average manual interaction times).
    // ~8 seconds per banner (find + reject), ~2 seconds per vendor toggle.
    calculateTimeSaved(stats) {
      const siteTime = (stats.totalUniqueSites || 0) * 8;
      const vendorTime = (stats.totalVendorsUnticked || 0) * 2;
      return siteTime + vendorTime;
    },

    formatTime(seconds) {
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      if (minutes < 60) return `${minutes}m ${secs}s`;
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}h ${mins}m`;
    },
  };

  // ─── Activity Log ───────────────────────────────────────────────────
  const LogManager = {
    _idCounter: 0,

    async add(entry) {
      return _storageQueue = _storageQueue.then(async () => {
        const log = await Storage.get(STORAGE_KEYS.LOG, []);

        log.unshift({
          id: `${Date.now()}-${++LogManager._idCounter}`,
          ...entry,
        });

        if (log.length > MAX_LOG_ENTRIES) {
          log.length = MAX_LOG_ENTRIES;
        }

        await Storage.set(STORAGE_KEYS.LOG, log);
        return log;
      }).catch(e => {
        console.error('LogManager.add failed:', e);
        return null;
      });
    },

    async get(limit = 50, offset = 0) {
      const log = await Storage.get(STORAGE_KEYS.LOG, []);
      return log.slice(offset, offset + limit);
    },

    async getForDomain(domain, limit = 10) {
      const log = await Storage.get(STORAGE_KEYS.LOG, []);
      return log.filter(e => e.domain === domain).slice(0, limit);
    },

    async clear() {
      await Storage.set(STORAGE_KEYS.LOG, []);
    },

    async getRecent(count = 10) {
      const log = await Storage.get(STORAGE_KEYS.LOG, []);
      return log.slice(0, count);
    },
  };

  // ─── Whitelist / Blacklist ──────────────────────────────────────────
  const ListManager = {
    extractBaseDomain(hostname) {
      if (!hostname || typeof hostname !== 'string') return '';
      hostname = hostname.trim().toLowerCase();
      // Reject clearly invalid inputs (paths, protocols, spaces, special chars)
      if (hostname.includes('/') || hostname.includes(' ') || hostname.includes('\\')) return '';
      // Remove any trailing port or path that may have slipped in
      hostname = hostname.replace(/[:?#].*$/, '');
      // Handle IP addresses (v4 and v6) -- return as-is
      if (/^[\d.:]+$/.test(hostname) || hostname === 'localhost') {
        return hostname;
      }
      const parts = hostname.split('.');
      if (parts.length <= 2) return hostname;

      const multiTLDs = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.mx',
        'org.uk', 'net.au', 'co.za', 'com.sg', 'co.nz', 'com.hk'];
      const lastTwo = parts.slice(-2).join('.');

      if (multiTLDs.includes(lastTwo) && parts.length > 2) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    },

    domainMatches(domain, pattern) {
      if (!domain || !pattern) return false;
      domain = domain.toLowerCase();
      pattern = pattern.toLowerCase();

      if (domain === pattern) return true;
      if (domain.endsWith('.' + pattern)) return true;

      if (pattern.startsWith('*.')) {
        const basePattern = pattern.slice(2);
        return domain === basePattern || domain.endsWith('.' + basePattern);
      }

      return false;
    },

    async getList(listName) {
      const key = listName === 'whitelist' ? STORAGE_KEYS.WHITELIST : STORAGE_KEYS.BLACKLIST;
      return SyncStorage.get(key, []);
    },

    async setList(listName, list) {
      const key = listName === 'whitelist' ? STORAGE_KEYS.WHITELIST : STORAGE_KEYS.BLACKLIST;
      return Storage.set(key, list);
    },

    async addEntry(listName, domain) {
      return _storageQueue = _storageQueue.then(async () => {
        const baseDomain = this.extractBaseDomain(domain);
        if (!baseDomain) return false;

        const list = await this.getList(listName);

        const exists = list.some(entry =>
          this.domainMatches(baseDomain, entry.domain)
        );
        if (exists) return false;

        list.push({
          domain: baseDomain,
          addedAt: Date.now(),
          source: 'user',
        });

        await this.setList(listName, list);
        return true;
      }).catch(e => {
        console.error('ListManager.addEntry failed:', e);
        return false;
      });
    },

    async removeEntry(listName, domain) {
      return _storageQueue = _storageQueue.then(async () => {
        const storageKey = listName === 'whitelist' ? STORAGE_KEYS.WHITELIST : STORAGE_KEYS.BLACKLIST;
        let list = await this.getList(listName);
        const before = list.length;
        list = list.filter(e => !this.domainMatches(domain, e.domain));
        if (list.length < before) {
          await Storage.set(storageKey, list);
          return true;
        }
        return false;
      }).catch(e => {
        console.error('ListManager.removeEntry failed:', e);
        return false;
      });
    },

    async checkDomain(domain) {
      const whitelist = await this.getList('whitelist');
      const blacklist = await this.getList('blacklist');

      for (const entry of whitelist) {
        if (this.domainMatches(domain, entry.domain)) {
          return { whitelisted: true, blacklisted: false };
        }
      }

      for (const entry of blacklist) {
        if (this.domainMatches(domain, entry.domain)) {
          return { whitelisted: false, blacklisted: true };
        }
      }

      return { whitelisted: false, blacklisted: false };
    },
  };

  // ─── Settings ───────────────────────────────────────────────────────
  const SettingsManager = {
    async get() {
      const stored = await SyncStorage.get(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
      const { data } = Migration.mergeWithDefaults(stored, DEFAULT_SETTINGS);
      // Sync debug mode
      debugMode = data.debugMode || false;
      return data;
    },

    async update(updates) {
      return _storageQueue = _storageQueue.then(async () => {
        const settings = await this.get();
        const updated = { ...settings, ...updates };
        await SyncStorage.set(STORAGE_KEYS.SETTINGS, updated);
        // Sync debug mode
        if ('debugMode' in updates) debugMode = updates.debugMode;
        return updated;
      }).catch(e => {
        console.error('SettingsManager.update failed:', e);
        return this.get();
      });
    },
  };

  // ─── Unique Domain Tracker ─────────────────────────────────────────
  const UniqueDomainTracker = {
    _cache: null,
    _dirty: false,
    _flushTimer: null,

    async _load() {
      if (!this._cache) {
        const domains = await Storage.get(STORAGE_KEYS.UNIQUE_DOMAINS, []);
        this._cache = new Set(domains);
      }
      return this._cache;
    },

    async isNew(domain) {
      const cache = await this._load();
      return !cache.has(domain);
    },

    async add(domain) {
      try {
        const cache = await this._load();
        if (cache.has(domain)) return false;
        cache.add(domain);
        this._dirty = true;
        // Debounce writes: flush every 3 seconds if dirty
        if (!this._flushTimer) {
          this._flushTimer = setTimeout(async () => {
            this._flushTimer = null;
            if (this._dirty) {
              this._dirty = false;
              await Storage.set(STORAGE_KEYS.UNIQUE_DOMAINS, [...this._cache]);
            }
          }, 3000);
        }
        return true;
      } catch (e) {
        console.error('UniqueDomainTracker.add failed:', e);
        return false;
      }
    },

    async count() {
      const cache = await this._load();
      return cache.size;
    },
  };

  // ─── Import / Export ────────────────────────────────────────────────
  const ImportExport = {
    async exportData() {
      const all = await Storage.getAll();
      // Only export our prefixed keys
      const data = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith('cr_')) {
          data[key] = value;
        }
      }
      return {
        version: APP_VERSION,
        exportedAt: Date.now(),
        data: data,
      };
    },

    validateImportData(key, value) {
      // cr_stats: object with non-negative integer numeric values
      if (key === STORAGE_KEYS.STATS) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { valid: false, sanitizedValue: null };
        }
        // Explicitly check expected numeric fields
        const numericFields = ['totalRejected', 'totalUniqueSites', 'totalVendorsUnticked', 'totalBannersRejected', 'cookiesRejected', 'bannersRejected', 'vendorsUnticked'];
        for (const nf of numericFields) {
          if (value[nf] !== undefined && typeof value[nf] !== 'number') {
            return { valid: false, sanitizedValue: null };
          }
        }
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'number' && (!Number.isInteger(v) || v < 0)) {
            return { valid: false, sanitizedValue: null };
          }
        }
        return { valid: true, sanitizedValue: value };
      }

      // cr_log: array of entries with domain (string), timestamp (number), cmp (string or undefined)
      if (key === STORAGE_KEYS.LOG) {
        if (!Array.isArray(value)) {
          return { valid: false, sanitizedValue: null };
        }
        const sanitized = value.filter(entry => {
          if (!entry || typeof entry !== 'object') return false;
          if (typeof entry.domain !== 'string') return false;
          if (typeof entry.timestamp !== 'number') return false;
          if (entry.cmp !== undefined && typeof entry.cmp !== 'string') return false;
          return true;
        });
        return { valid: true, sanitizedValue: sanitized };
      }

      // cr_whitelist / cr_blacklist: arrays of objects with domain (string) and addedAt (number)
      if (key === STORAGE_KEYS.WHITELIST || key === STORAGE_KEYS.BLACKLIST) {
        if (!Array.isArray(value)) {
          return { valid: false, sanitizedValue: null };
        }
        const sanitized = value.filter(entry => {
          if (!entry || typeof entry !== 'object') return false;
          if (typeof entry.domain !== 'string') return false;
          if (typeof entry.addedAt !== 'number') return false;
          return true;
        });
        return { valid: true, sanitizedValue: sanitized };
      }

      // cr_settings: object with boolean values for known settings keys
      if (key === STORAGE_KEYS.SETTINGS) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { valid: false, sanitizedValue: null };
        }
        const sanitized = {};
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'boolean') {
            sanitized[k] = v;
          }
        }
        return { valid: true, sanitizedValue: sanitized };
      }

      // cr_unique_domains: array of strings
      if (key === STORAGE_KEYS.UNIQUE_DOMAINS) {
        if (!Array.isArray(value)) {
          return { valid: false, sanitizedValue: null };
        }
        const sanitized = value.filter(item => typeof item === 'string');
        return { valid: true, sanitizedValue: sanitized };
      }

      // cr_meta: object with version (string) and numeric timestamps
      if (key === STORAGE_KEYS.META) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { valid: false, sanitizedValue: null };
        }
        if (typeof value.version !== 'string') {
          return { valid: false, sanitizedValue: null };
        }
        // Check that any timestamp-like keys are numbers
        for (const [k, v] of Object.entries(value)) {
          if (k.toLowerCase().includes('date') || k.toLowerCase().includes('timestamp')) {
            if (typeof v !== 'number') {
              return { valid: false, sanitizedValue: null };
            }
          }
        }
        return { valid: true, sanitizedValue: value };
      }

      // Unknown key: reject -- only known cr_ keys are accepted
      return { valid: false, sanitizedValue: null };
    },

    async importData(jsonString) {
      try {
        const jsonSize = jsonString.length;
        if (jsonSize > 5 * 1024 * 1024) { // 5MB limit
          return { success: false, error: 'Import file too large (max 5MB)' };
        }

        const parsed = JSON.parse(jsonString);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { success: false, error: 'Invalid format: top-level value must be an object' };
        }
        if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
          return { success: false, error: 'Invalid format: missing data object' };
        }

        // Validate it looks like our data
        const keys = Object.keys(parsed.data);
        const validPrefixes = ['cr_'];
        const allValid = keys.every(k => validPrefixes.some(p => k.startsWith(p)));
        if (!allValid) {
          return { success: false, error: 'Invalid format: unexpected keys' };
        }

        // Serialize writes through storage queue to prevent data loss
        return _storageQueue = _storageQueue.then(async () => {
          let validCount = 0;
          for (const [key, value] of Object.entries(parsed.data)) {
            const { valid, sanitizedValue } = this.validateImportData(key, value);
            if (valid) {
              await Storage.set(key, sanitizedValue);
              validCount++;
            } else {
              debugLog('Import skipped invalid key:', key);
            }
          }
          // Run migration after import to ensure data integrity
          await Migration.run();
          // Invalidate UniqueDomainTracker cache so it reloads imported domains
          UniqueDomainTracker._cache = null;
          return { success: true, keysImported: validCount };
        }).catch(e => {
          console.error('Import write failed:', e);
          return { success: false, error: 'Import write failed: ' + e.message };
        });
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  };

  // ─── Message Handler ────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handle = async () => {
      switch (message.type) {
        // ── Status ──
        case 'GET_STATUS': {
          const settings = await SettingsManager.get();
          return { enabled: settings.enabled };
        }

        // ── Full Settings (for content script) ──
        case 'GET_FULL_SETTINGS': {
          const settings = await SettingsManager.get();
          return settings;
        }

        // ── Logging ──
        case 'LOG_ACTION': {
          const { data } = message;
          const baseDomain = ListManager.extractBaseDomain(data.domain);

          // Track unique domains
          const isNewDomain = await UniqueDomainTracker.add(baseDomain);

          // Update stats
          const stats = await StatsManager.increment({
            totalRejected: data.rejected || 0,
            totalVendorsUnticked: data.vendorsUnticked || 0,
            totalBannersRejected: 1,
            totalUniqueSites: isNewDomain ? 1 : 0,
          });

          // Add to activity log (strip query params from URL)
          const safeUrl = data.url ? data.url.split('?')[0].split('#')[0] : data.domain;
          await LogManager.add({
            domain: data.domain,
            cmp: data.cmp,
            rejected: data.rejected,
            vendorsUnticked: data.vendorsUnticked,
            timestamp: data.timestamp,
            url: safeUrl,
          });

          debugLog('Action logged:', data.domain, data.cmp, 'new domain:', isNewDomain);

          return { success: true, stats };
        }

        case 'LOG_FAILED_REJECTION': {
          const { data } = message;
          debugLog('Failed rejection:', data.domain, data.cmp);
          // Store failed rejections separately for analytics
          const failStats = await Storage.get('cr_failed_rejections', []);
          failStats.unshift({ domain: data.domain, cmp: data.cmp, timestamp: Date.now(), reason: data.reason });
          if (failStats.length > 100) failStats.length = 100;
          await Storage.set('cr_failed_rejections', failStats);
          return { success: true };
        }

        case 'GET_FAILED_REJECTIONS': {
          return await Storage.get('cr_failed_rejections', []);
        }

        case 'REJECT_CONSENT_MODE': {
          // Inject consent mode rejection into the tab
          try {
            const tabs = await new Promise(resolve => {
              chrome.tabs.query({ active: true, currentWindow: true }, resolve);
            });
            if (tabs[0]) {
              await new Promise((resolve, reject) => {
                try {
                  chrome.scripting.executeScript({
                    target: { tabId: tabs[0].id },
                    func: () => {
                      if (typeof gtag === 'function') {
                        gtag('consent', 'update', {
                          analytics_storage: 'denied',
                          ad_storage: 'denied',
                          ad_user_data: 'denied',
                          ad_personalization: 'denied',
                          functionality_storage: 'denied',
                          personalization_storage: 'denied',
                          security_storage: 'granted',
                        });
                      }
                      if (typeof dataLayer !== 'undefined' && Array.isArray(dataLayer)) {
                        dataLayer.push({ event: 'consent_update', consent_type: 'rejected' });
                      }
                    }
                  }, () => {
                    if (chrome.runtime.lastError) {
                      resolve({ success: false });
                      return;
                    }
                    resolve({ success: true });
                  });
                } catch (e) {
                  resolve({ success: false });
                }
              });
            }
          } catch (e) {
            debugLog('REJECT_CONSENT_MODE failed:', e.message);
          }
          return { success: false };
        }

        // ── Stats ──
        case 'GET_STATS': {
          const stats = await StatsManager.get();
          const timeSaved = StatsManager.calculateTimeSaved(stats);
          return { ...stats, timeSaved, timeSavedFormatted: StatsManager.formatTime(timeSaved) };
        }

        case 'RESET_STATS': {
          const stats = await StatsManager.reset();
          await LogManager.clear();
          return stats;
        }

        // ── Activity Log ──
        case 'GET_LOG': {
          const log = await LogManager.get(message.limit || 50, message.offset || 0);
          return log;
        }

        case 'GET_LOG_FOR_DOMAIN': {
          return await LogManager.getForDomain(message.domain, message.limit || 10);
        }

        case 'CLEAR_LOG': {
          await LogManager.clear();
          return { success: true };
        }

        // ── Whitelist / Blacklist ──
        case 'CHECK_LIST': {
          return await ListManager.checkDomain(message.domain);
        }

        case 'ADD_TO_LIST': {
          const oppositeList = message.list === 'whitelist' ? 'blacklist' : 'whitelist';
          await ListManager.removeEntry(oppositeList, message.domain);
          const added = await ListManager.addEntry(message.list, message.domain);
          return { success: added };
        }

        case 'REMOVE_FROM_LIST': {
          const removed = await ListManager.removeEntry(message.list, message.domain);
          return { success: removed };
        }

        case 'GET_LIST': {
          const list = await ListManager.getList(message.list);
          return list;
        }

        case 'GET_ALL_LISTS': {
          const whitelist = await ListManager.getList('whitelist');
          const blacklist = await ListManager.getList('blacklist');
          return { whitelist, blacklist };
        }

        // ── Settings ──
        case 'GET_SETTINGS': {
          return await SettingsManager.get();
        }

        case 'UPDATE_SETTINGS': {
          const updated = await SettingsManager.update(message.settings);
          // Broadcast settings change to all content scripts
          chrome.tabs.query({}, (tabs) => {
            for (const t of tabs) {
              chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED', settings: updated }, () => {
                if (chrome.runtime.lastError) { /* tab not receptive */ }
              });
            }
          });
          return updated;
        }

        // ── Import / Export ──
        case 'EXPORT_DATA': {
          return await ImportExport.exportData();
        }

        case 'IMPORT_DATA': {
          return await ImportExport.importData(message.json);
        }

        // ── Popup: Get current tab info ──
        case 'GET_CURRENT_TAB_INFO': {
          return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]) {
                const url = new URL(tabs[0].url);
                resolve({
                  url: tabs[0].url,
                  domain: url.hostname,
                  tabId: tabs[0].id,
                });
              } else {
                resolve(null);
              }
            });
          });
        }

        // ── Content script status check ──
        case 'GET_CONTENT_STATUS': {
          return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS_CONTENT' }, (response) => {
                  if (chrome.runtime.lastError) {
                    resolve({ active: false, error: chrome.runtime.lastError.message });
                  } else {
                    resolve({ active: true, ...response });
                  }
                });
              } else {
                resolve({ active: false });
              }
            });
          });
        }

        // ── Per-site CMP Override ──
        case 'SET_CMP_OVERRIDE': {
          return _storageQueue = _storageQueue.then(async () => {
            const meta = await Storage.get(STORAGE_KEYS.META, {});
            if (!meta.cmpOverrides) meta.cmpOverrides = {};
            if (message.handlerId === null) {
              delete meta.cmpOverrides[message.domain];
            } else {
              meta.cmpOverrides[message.domain] = message.handlerId;
            }
            await Storage.set(STORAGE_KEYS.META, meta);
            return { success: true };
          }).catch(e => ({ success: false, error: e.message }));
        }

        case 'GET_CMP_OVERRIDE': {
          const meta = await Storage.get(STORAGE_KEYS.META, {});
          const override = (meta.cmpOverrides || {})[message.domain];
          return { override: override || null };
        }

        // ── Version info ──
        case 'GET_VERSION': {
          return { version: APP_VERSION };
        }

        default:
          return { error: 'Unknown message type' };
      }
    };

    handle().then(sendResponse).catch(e => {
      console.error('Message handler error:', e);
      sendResponse({ error: e.message });
    });
    return true;
  });

  // ─── Keyboard Shortcut Handler ─────────────────────────────────────
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'reject-now') {
      debugLog('Keyboard shortcut triggered: reject-now');
      const tabs = await new Promise(resolve => {
        chrome.tabs.query({ active: true, currentWindow: true }, resolve);
      });
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'FORCE_REJECT' }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    }
  });

  // ─── Badge Management ───────────────────────────────────────────────
  let _badgeUpdateTimer = null;
  // Persist tab states to session storage so they survive SW restarts
  const _tabStates = {};
  async function _loadTabStates() {
    try {
      if (chrome.storage.session) {
        const data = await chrome.storage.session.get('_tabStates');
        if (data._tabStates) Object.assign(_tabStates, data._tabStates);
      }
    } catch { /* session storage not available */ }
  }
  async function _saveTabStates() {
    try {
      if (chrome.storage.session) {
        await chrome.storage.session.set({ _tabStates });
      }
    } catch { /* ignore */ }
  }

  const Badge = {
    async update() {
      const stats = await StatsManager.get();
      const count = stats.totalBannersRejected || 0;
      const text = count > 0 ? String(count > 999 ? '999+' : count) : '';

      try {
        chrome.action.setBadgeText({ text });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      } catch {
        // Safari may not support all badge API methods
      }
    },

    // Set per-tab badge color to indicate rejection status
    async setTabState(tabId, rejected, cmp) {
      _tabStates[tabId] = { rejected, cmp };
      _saveTabStates(); // fire-and-forget persist
      try {
        if (rejected) {
          chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId }); // green = rejected
        } else {
          chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E', tabId }); // gray = no banner
        }
      } catch { /* Safari compat */ }
    },
  };

  // ─── Tab Update Listener ────────────────────────────────────────────
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
      clearTimeout(_badgeUpdateTimer);
      _badgeUpdateTimer = setTimeout(() => Badge.update(), 500);
    }
  });

  // Clean up tab state when tabs close
  chrome.tabs.onRemoved.addListener((tabId) => {
    delete _tabStates[tabId];
  });

  // ─── Initialize ─────────────────────────────────────────────────────
  _loadTabStates();
  Migration.run().catch(e => console.error('Migration failed:', e));
  Badge.update().catch(e => console.error('Badge update failed:', e));
  loadDebugMode().catch(e => console.error('Debug mode load failed:', e));

  // Initialize log ID counter from existing data to prevent collisions after SW restart
  (async () => {
    try {
      const log = await Storage.get(STORAGE_KEYS.LOG, []);
      LogManager._idCounter = log.length > 0 ? log.length : 0;
    } catch (e) { /* ignore */ }
  })();

  // ─── Handler Update Checker (foundation for auto-updating rules) ───
  // Checks GitHub releases API for new versions. In the future, this can
  // be extended to fetch updated handler rules/selectors from a remote source.
  const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  const UPDATE_REPO = 'ErnestHysa/cookie-reject';

  async function checkForUpdates() {
    try {
      const meta = await Storage.get(STORAGE_KEYS.META, {});
      const lastCheck = meta.lastUpdateCheck || 0;
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL) return;

      const currentVersion = chrome.runtime.getManifest().version;
      const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
      });
      if (!response.ok) return;

      const release = await response.json();
      const latestVersion = release.tag_name?.replace(/^v/, '');
      if (latestVersion && latestVersion !== currentVersion) {
        debugLog(`Update available: ${latestVersion} (current: ${currentVersion})`);
      }

      meta.lastUpdateCheck = Date.now();
      await Storage.set(STORAGE_KEYS.META, meta);
    } catch (e) {
      debugLog('Update check failed:', e.message);
    }
  }

  // ─── Remote Rules Foundation ────────────────────────────────────────
  // Future: fetch updated selector/detection rules from GitHub repo.
  // Format: { version: 1, rules: [{ id, selectors, detectCheck }] }
  // Stored in cr_meta.remoteRules for content script to pick up.
  const RULES_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/rules.json`;
  const RULES_FETCH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

  async function fetchRemoteRules() {
    try {
      const meta = await Storage.get(STORAGE_KEYS.META, {});
      const lastFetch = meta.lastRulesFetch || 0;
      if (Date.now() - lastFetch < RULES_FETCH_INTERVAL) return;

      const response = await fetch(RULES_URL, {
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data && data.version === 1 && Array.isArray(data.rules)) {
        // Validate each rule has expected structure
        const validRules = data.rules.filter(rule => {
          return rule && typeof rule.id === 'string' &&
            (Array.isArray(rule.selectors) || typeof rule.detectCheck === 'function' || typeof rule.detectCheck === 'string');
        });
        if (validRules.length !== data.rules.length) {
          debugLog(`Filtered ${data.rules.length - validRules.length} invalid remote rules`);
        }
        data.rules = validRules;
        meta.remoteRules = data;
        meta.lastRulesFetch = Date.now();
        await Storage.set(STORAGE_KEYS.META, meta);
        debugLog(`Fetched ${data.rules.length} remote rules`);
      }
    } catch (e) {
      debugLog('Remote rules fetch failed:', e.message);
    }
  }

  fetchRemoteRules();

  // Run update check on initialization and daily via alarm (if available)
  checkForUpdates();
  if (chrome.alarms) {
    chrome.alarms.create('checkUpdates', { periodInMinutes: 24 * 60 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'checkUpdates') checkForUpdates();
    });
  }
})();
