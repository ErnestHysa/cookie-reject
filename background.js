/**
 * CookieReject - Background Service Worker
 * Handles stats tracking, logging, whitelist/blacklist management, and storage.
 */

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    STATS: 'cr_stats',
    LOG: 'cr_log',
    WHITELIST: 'cr_whitelist',
    BLACKLIST: 'cr_blacklist',
    SETTINGS: 'cr_settings',
  };

  const DEFAULT_STATS = {
    totalRejected: 0,
    totalVendorsUnticked: 0,
    totalSitesProtected: 0,
    totalAllowed: 0,
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
  };

  const MAX_LOG_ENTRIES = 500;

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
  };

  // ─── Stats Management ───────────────────────────────────────────────
  const StatsManager = {
    async get() {
      const stats = await Storage.get(STORAGE_KEYS.STATS, DEFAULT_STATS);
      if (!stats.installDate) {
        stats.installDate = Date.now();
        await Storage.set(STORAGE_KEYS.STATS, stats);
      }
      return stats;
    },

    async update(updates) {
      const stats = await this.get();
      const updated = { ...stats, ...updates };
      await Storage.set(STORAGE_KEYS.STATS, updated);
      return updated;
    },

    async increment(fields) {
      const stats = await this.get();
      for (const [key, amount] of Object.entries(fields)) {
        stats[key] = (stats[key] || 0) + amount;
      }
      await Storage.set(STORAGE_KEYS.STATS, stats);
      return stats;
    },

    async reset() {
      const resetStats = {
        ...DEFAULT_STATS,
        installDate: Date.now(),
        lastResetDate: Date.now(),
      };
      await Storage.set(STORAGE_KEYS.STATS, resetStats);
      return resetStats;
    },

    /**
     * Calculate estimated time saved.
     * Average manual cookie rejection takes ~47 seconds per site.
     * Vendor unticking adds ~2 seconds per vendor.
     */
    calculateTimeSaved(stats) {
      const siteTime = (stats.totalSitesProtected || 0) * 47; // seconds
      const vendorTime = (stats.totalVendorsUnticked || 0) * 2; // seconds
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
    async add(entry) {
      const log = await Storage.get(STORAGE_KEYS.LOG, []);

      log.unshift({
        id: Date.now() + Math.random().toString(36).slice(2, 6),
        ...entry,
      });

      // Keep only the last MAX_LOG_ENTRIES
      if (log.length > MAX_LOG_ENTRIES) {
        log.length = MAX_LOG_ENTRIES;
      }

      await Storage.set(STORAGE_KEYS.LOG, log);
      return log;
    },

    async get(limit = 50, offset = 0) {
      const log = await Storage.get(STORAGE_KEYS.LOG, []);
      return log.slice(offset, offset + limit);
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
    /**
     * Extract the base domain from a hostname.
     * e.g. "sub.example.co.uk" → "example.co.uk"
     *      "www.forbes.com" → "forbes.com"
     */
    extractBaseDomain(hostname) {
      if (!hostname) return '';
      const parts = hostname.split('.');
      if (parts.length <= 2) return hostname;

      // Common multi-part TLDs
      const multiTLDs = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.mx',
        'org.uk', 'net.au', 'co.za', 'com.sg', 'co.nz', 'com.hk'];
      const lastTwo = parts.slice(-2).join('.');
      const lastThree = parts.slice(-3).join('.');

      if (multiTLDs.includes(lastTwo) && parts.length > 2) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    },

    /**
     * Check if a domain matches a pattern (supports subdomain matching).
     */
    domainMatches(domain, pattern) {
      if (!domain || !pattern) return false;
      domain = domain.toLowerCase();
      pattern = pattern.toLowerCase();

      // Exact match
      if (domain === pattern) return true;

      // Subdomain match: pattern "example.com" matches "sub.example.com"
      if (domain.endsWith('.' + pattern)) return true;

      // Wildcard pattern
      if (pattern.startsWith('*.')) {
        const basePattern = pattern.slice(2);
        return domain === basePattern || domain.endsWith('.' + basePattern);
      }

      return false;
    },

    async getList(listName) {
      const key = listName === 'whitelist' ? STORAGE_KEYS.WHITELIST : STORAGE_KEYS.BLACKLIST;
      return Storage.get(key, []);
    },

    async setList(listName, list) {
      const key = listName === 'whitelist' ? STORAGE_KEYS.WHITELIST : STORAGE_KEYS.BLACKLIST;
      return Storage.set(key, list);
    },

    async addEntry(listName, domain) {
      const baseDomain = this.extractBaseDomain(domain);
      if (!baseDomain) return false;

      const list = await this.getList(listName);

      // Check for duplicates
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
    },

    async removeEntry(listName, domain) {
      const list = await this.getList(listName);
      const filtered = list.filter(entry => !this.domainMatches(domain, entry.domain));
      await this.setList(listName, filtered);
      return true;
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
      return Storage.get(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
    },

    async update(updates) {
      const settings = await this.get();
      const updated = { ...settings, ...updates };
      await Storage.set(STORAGE_KEYS.SETTINGS, updated);
      return updated;
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

        // ── Logging ──
        case 'LOG_ACTION': {
          const { data } = message;

          // Update stats
          const stats = await StatsManager.increment({
            totalRejected: data.rejected || 0,
            totalVendorsUnticked: data.vendorsUnticked || 0,
            totalSitesProtected: 1,
          });

          // Add to activity log
          await LogManager.add({
            domain: data.domain,
            cmp: data.cmp,
            rejected: data.rejected,
            vendorsUnticked: data.vendorsUnticked,
            timestamp: data.timestamp,
            url: data.url,
          });

          return { success: true, stats };
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

        case 'CLEAR_LOG': {
          await LogManager.clear();
          return { success: true };
        }

        // ── Whitelist / Blacklist ──
        case 'CHECK_LIST': {
          return await ListManager.checkDomain(message.domain);
        }

        case 'ADD_TO_LIST': {
          // Remove from the opposite list first (transfer, not duplicate)
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
          return updated;
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

        default:
          return { error: 'Unknown message type' };
      }
    };

    handle().then(sendResponse);
    return true; // keep channel open for async response
  });

  // ─── Badge Management ───────────────────────────────────────────────
  const Badge = {
    async update() {
      const stats = await StatsManager.get();
      const count = stats.totalSitesProtected || 0;
      const text = count > 0 ? String(count > 999 ? '999+' : count) : '';

      try {
        chrome.action.setBadgeText({ text });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
      } catch {
        // Safari may not support all badge API methods
      }
    },
  };

  // ─── Tab Update Listener ────────────────────────────────────────────
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
      Badge.update();
    }
  });

  // ─── Initialize ─────────────────────────────────────────────────────
  Badge.update();
})();
