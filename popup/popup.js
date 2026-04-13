/**
 * CookieReject - Popup Script
 * Handles UI interactions, stats display, and list management.
 */

(function () {
  'use strict';

  // ─── Helpers ────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            console.debug('[CookieReject Popup]', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch {
        resolve(null);
      }
    });
  }

  function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ─── Tab Navigation ─────────────────────────────────────────────────
  function initTabs() {
    const tabs = $$('.nav-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        $$('.tab-content').forEach((c) => c.classList.remove('active'));
        tab.classList.add('active');
        const target = $(`#tab-${tab.dataset.tab}`);
        if (target) target.classList.add('active');
      });
    });
  }

  // ─── Load Stats ─────────────────────────────────────────────────────
  async function loadStats() {
    const stats = await sendMessage({ type: 'GET_STATS' });
    if (!stats) return;

    $('#stat-rejected').textContent = formatNumber(stats.totalRejected || 0);
    $('#stat-vendors').textContent = formatNumber(stats.totalVendorsUnticked || 0);
    $('#stat-sites').textContent = formatNumber(stats.totalSitesProtected || 0);
    $('#stat-allowed').textContent = formatNumber(stats.totalAllowed || 0);

    // Time saved
    const timeSaved = stats.timeSaved || 0;
    const timeFormatted = stats.timeSavedFormatted || '0s';
    $('#time-saved').textContent = timeFormatted;

    // Sub text showing days since install
    if (stats.installDate) {
      const daysSince = Math.max(1, Math.floor((Date.now() - stats.installDate) / 86400000));
      $('#time-saved-sub').textContent = `in ${daysSince} day${daysSince !== 1 ? 's' : ''} of browsing`;
    }
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ─── Load Current Site Info ─────────────────────────────────────────
  async function loadCurrentSite() {
    const tabInfo = await sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
    if (!tabInfo || !tabInfo.domain) {
      $('#current-domain').textContent = 'Not available';
      $('#site-status').innerHTML = `
        <span class="status-dot inactive"></span>
        <span class="status-text">Not a web page</span>
      `;
      return;
    }

    $('#current-domain').textContent = tabInfo.domain;

    // Check list status
    const listCheck = await sendMessage({ type: 'CHECK_LIST', domain: tabInfo.domain });
    // Check content script status
    const contentStatus = await sendMessage({ type: 'GET_CONTENT_STATUS' });

    if (listCheck && listCheck.whitelisted) {
      $('#site-status').innerHTML = `
        <span class="status-dot whitelisted"></span>
        <span class="status-text">Whitelisted - cookies allowed</span>
      `;
    } else if (contentStatus && contentStatus.processed) {
      $('#site-status').innerHTML = `
        <span class="status-dot protected"></span>
        <span class="status-text">Protected${contentStatus.cmp ? ' (' + contentStatus.cmp.name + ')' : ''}</span>
      `;
    } else if (contentStatus && contentStatus.active) {
      $('#site-status').innerHTML = `
        <span class="status-dot processing"></span>
        <span class="status-text">Processing...</span>
      `;
    } else {
      $('#site-status').innerHTML = `
        <span class="status-dot inactive"></span>
        <span class="status-text">No banner detected</span>
      `;
    }

    // Store domain for button actions
    $('#btn-whitelist').dataset.domain = tabInfo.domain;
    $('#btn-blacklist').dataset.domain = tabInfo.domain;
  }

  // ─── Load Activity Log ──────────────────────────────────────────────
  async function loadActivity() {
    const log = await sendMessage({ type: 'GET_LOG', limit: 20 });
    const container = $('#activity-list');

    if (!log || log.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </span>
          <p>No activity yet. Browse the web and CookieReject will protect you!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = log.map((entry) => `
      <div class="activity-item">
        <div class="activity-icon rejected">🛡️</div>
        <div class="activity-details">
          <div class="activity-domain" title="${entry.url || entry.domain}">${entry.domain}</div>
          <div class="activity-meta">
            <span>${timeAgo(entry.timestamp)}</span>
            ${entry.cmp ? `<span class="activity-cmp">${entry.cmp}</span>` : ''}
            ${entry.rejected ? `<span>🚫 ${entry.rejected} rejected</span>` : ''}
            ${entry.vendorsUnticked ? `<span>⚙️ ${entry.vendorsUnticked} vendors</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');
  }

  // ─── Load Lists ─────────────────────────────────────────────────────
  async function loadLists() {
    const lists = await sendMessage({ type: 'GET_ALL_LISTS' });
    if (!lists) return;

    renderList('whitelist', lists.whitelist || []);
    renderList('blacklist', lists.blacklist || []);
  }

  function renderList(listName, entries) {
    const container = $(`#${listName}-items`);
    const countEl = $(`#${listName}-count`);

    countEl.textContent = entries.length;

    if (entries.length === 0) {
      container.innerHTML = `<p class="list-empty">No ${listName === 'whitelist' ? 'whitelisted' : 'blacklisted'} sites</p>`;
      return;
    }

    container.innerHTML = entries.map((entry) => `
      <div class="list-entry">
        <span class="list-entry-domain">${entry.domain}</span>
        <button class="list-entry-remove" data-list="${listName}" data-domain="${entry.domain}" title="Remove">&times;</button>
      </div>
    `).join('');

    // Attach remove handlers
    container.querySelectorAll('.list-entry-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await sendMessage({
          type: 'REMOVE_FROM_LIST',
          list: btn.dataset.list,
          domain: btn.dataset.domain,
        });
        loadLists();
        loadStats();
      });
    });
  }

  // ─── Load Settings ──────────────────────────────────────────────────
  async function loadSettings() {
    const settings = await sendMessage({ type: 'GET_SETTINGS' });
    if (!settings) return;

    $('#toggle-enabled').checked = settings.enabled;
    $('#setting-auto-reject').checked = settings.autoReject;
    $('#setting-untick-vendors').checked = settings.untickVendors;
    $('#setting-dismiss-overlays').checked = settings.dismissOverlays;
    $('#setting-tcf-api').checked = settings.useTCFApi;
  }

  // ─── Event Handlers ─────────────────────────────────────────────────
  function initEventHandlers() {
    // Main toggle
    $('#toggle-enabled').addEventListener('change', async (e) => {
      await sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { enabled: e.target.checked },
      });
    });

    // Whitelist current site
    $('#btn-whitelist').addEventListener('click', async () => {
      const domain = $('#btn-whitelist').dataset.domain;
      if (!domain) return;
      await sendMessage({ type: 'ADD_TO_LIST', list: 'whitelist', domain });
      loadCurrentSite();
      loadLists();
    });

    // Blacklist current site
    $('#btn-blacklist').addEventListener('click', async () => {
      const domain = $('#btn-blacklist').dataset.domain;
      if (!domain) return;
      await sendMessage({ type: 'ADD_TO_LIST', list: 'blacklist', domain });
      loadCurrentSite();
      loadLists();
    });

    // Force reject
    $('#btn-force-reject').addEventListener('click', async () => {
      const tabInfo = await sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
      if (tabInfo && tabInfo.tabId) {
        chrome.tabs.sendMessage(tabInfo.tabId, { type: 'FORCE_REJECT' }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
          loadCurrentSite();
          loadStats();
          loadActivity();
        });
      }
    });

    // Add to whitelist from input
    $('#btn-add-whitelist').addEventListener('click', () => {
      addFromInput('whitelist');
    });
    $('#whitelist-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFromInput('whitelist');
    });

    // Add to blacklist from input
    $('#btn-add-blacklist').addEventListener('click', () => {
      addFromInput('blacklist');
    });
    $('#blacklist-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFromInput('blacklist');
    });

    // Settings toggles
    const settingMap = {
      'setting-auto-reject': 'autoReject',
      'setting-untick-vendors': 'untickVendors',
      'setting-dismiss-overlays': 'dismissOverlays',
      'setting-tcf-api': 'useTCFApi',
    };

    for (const [id, key] of Object.entries(settingMap)) {
      $(`#${id}`).addEventListener('change', async (e) => {
        await sendMessage({
          type: 'UPDATE_SETTINGS',
          settings: { [key]: e.target.checked },
        });
      });
    }

    // Reset stats
    $('#btn-reset-stats').addEventListener('click', async () => {
      if (confirm('Reset all stats and activity log? This cannot be undone.')) {
        await sendMessage({ type: 'RESET_STATS' });
        loadStats();
        loadActivity();
      }
    });

    // Clear log
    $('#btn-clear-log').addEventListener('click', async () => {
      await sendMessage({ type: 'CLEAR_LOG' });
      loadActivity();
    });
  }

  async function addFromInput(listName) {
    const input = $(`#${listName}-input`);
    const domain = input.value.trim();
    if (!domain) return;

    await sendMessage({ type: 'ADD_TO_LIST', list: listName, domain });
    input.value = '';
    loadLists();
  }

  // ─── Initialize ─────────────────────────────────────────────────────
  async function init() {
    initTabs();
    initEventHandlers();
    await Promise.all([
      loadStats(),
      loadCurrentSite(),
      loadActivity(),
      loadLists(),
      loadSettings(),
    ]);
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
