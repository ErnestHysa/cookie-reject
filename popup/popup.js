/**
 * CookieReject - Popup UI Controller
 * Handles all interactions in the browser extension popup.
 */

(function () {
  'use strict';

  // ─── Helpers ──────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch { resolve(null); }
    });
  }

  function sendTabMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0] && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
              if (chrome.runtime.lastError) resolve(null);
              else resolve(response);
            });
          } else {
            resolve(null);
          }
        });
      } catch { resolve(null); }
    });
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderActivityItems(entries) {
    return entries.map(entry => `
      <div class="activity-item">
        <div>
          <div class="activity-domain" title="${escapeHTML(entry.domain)}">${escapeHTML(entry.domain)}</div>
          <div class="activity-meta">
            <span class="activity-cmp">${escapeHTML(entry.cmp || 'Unknown')}</span>
            ${entry.vendorsUnticked ? '<span class="activity-badge">' + escapeHTML(String(entry.vendorsUnticked)) + ' vendors</span>' : ''}
          </div>
        </div>
        <span class="activity-time">${formatTimestamp(entry.timestamp)}</span>
      </div>
    `).join('');
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    return d.toLocaleDateString();
  }

  function showToast(message, isError = false) {
    // Remove existing toasts
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('show'));
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ─── Tab Management ────────────────────────────────────────────────

  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    $('tab-' + tab.dataset.tab).classList.add('active');

    // Refresh data when switching tabs (Fix #19)
    const tabName = tab.dataset.tab;
    if (tabName === 'dashboard') {
      loadStats();
      loadCurrentSite();
    } else if (tabName === 'activity') {
      loadActivity();
    } else if (tabName === 'lists') {
      loadLists();
    }
  }

  function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab));
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    });

    // Arrow key navigation between tabs (Fix #16)
    tabs.forEach((tab) => {
      tab.addEventListener('keydown', (e) => {
        const tabList = Array.from(tabs);
        const idx = tabList.indexOf(tab);
        let newIdx = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          newIdx = (idx + 1) % tabList.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          newIdx = (idx - 1 + tabList.length) % tabList.length;
        }
        if (newIdx >= 0) {
          e.preventDefault();
          tabList[newIdx].focus();
          switchTab(tabList[newIdx]);
        }
      });
    });
  }

  // ─── Version ───────────────────────────────────────────────────────

  async function loadVersion() {
    const manifest = chrome.runtime.getManifest();
    $('version').textContent = 'v' + manifest.version;
    $('footerVersion').textContent = 'v' + manifest.version;
  }

  // ─── Master Toggle ─────────────────────────────────────────────────

  function initMasterToggle() {
    $('masterToggle').addEventListener('change', async (e) => {
      await sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: e.target.checked } });
      showToast(e.target.checked ? 'Extension enabled' : 'Extension disabled');
    });
  }

  // ─── Current Site ──────────────────────────────────────────────────

  async function loadCurrentSite() {
    const tabInfo = await sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
    if (!tabInfo || !tabInfo.domain) {
      $('siteDomain').textContent = 'Not a web page';
      updateStatus('inactive', 'CookieReject only works on websites');
      // Disable action buttons on non-web pages (Fix #20)
      $('rejectNowBtn').disabled = true;
      $('whitelistBtn').disabled = true;
      return;
    }

    // Re-enable buttons for valid web pages (Fix #20)
    $('rejectNowBtn').disabled = false;
    $('whitelistBtn').disabled = false;

    $('siteDomain').textContent = tabInfo.domain;

    // Check list status
    const listCheck = await sendMessage({ type: 'CHECK_LIST', domain: tabInfo.domain });
    if (listCheck && listCheck.whitelisted) {
      updateStatus('warning', 'Whitelisted');
      $('whitelistBtn').textContent = 'Remove from Whitelist';
      $('whitelistBtn').dataset.action = 'remove-whitelist';
      return;
    }

    // Reset whitelist button for non-whitelisted sites (Fix #5)
    $('whitelistBtn').textContent = 'Whitelist';
    $('whitelistBtn').removeAttribute('data-action');

    // Check content script status
    const status = await sendTabMessage({ type: 'GET_STATUS_CONTENT' });
    if (!status || !status.active) {
      if (status && status.error) {
        updateStatus('inactive', 'No content script');
      }
      return;
    }

    if (status.processed) {
      if (status.cmp) {
        updateStatus('active', `Rejected (${status.cmp.name})`);
        // Show per-site details
        showSiteDetails(tabInfo.domain, status.cmp.name, status.vendorsUnticked);
      } else {
        updateStatus('active', 'No banner found');
      }
    } else {
      const elapsed = Date.now() - (status.timestamp || Date.now());
      if (elapsed < 15000) {
        updateStatus('warning', 'Scanning...');
      } else {
        updateStatus('inactive', 'No banner detected');
      }
    }
  }

  function updateStatus(state, text) {
    const dot = document.querySelector('.status-dot');
    const textEl = document.querySelector('.status-text');
    dot.className = 'status-dot';
    if (state === 'active') dot.classList.add('active');
    else if (state === 'warning') dot.classList.add('warning');
    else if (state === 'error') dot.classList.add('error');
    textEl.textContent = text;
  }

  function showSiteDetails(domain, cmpName, vendorsUnticked) {
    const details = $('siteDetails');
    if (!details) return;
    details.style.display = 'block';
    $('siteCMP').textContent = cmpName || '-';
    $('siteVendors').textContent = vendorsUnticked != null ? String(vendorsUnticked) : '-';
    // Fetch last action time from activity log
    sendMessage({ type: 'GET_LOG_FOR_DOMAIN', domain }).then((entries) => {
      if (entries && entries.length > 0) {
        const last = entries[0]; // most recent
        const ago = formatTimeAgo(last.timestamp);
        $('siteLastAction').textContent = ago;
      } else {
        $('siteLastAction').textContent = 'Just now';
      }
    }).catch(() => {
      $('siteLastAction').textContent = '-';
    });
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return '-';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  async function loadStats() {
    const stats = await sendMessage({ type: 'GET_STATS' });
    if (!stats) return;
    $('statRejected').textContent = stats.totalRejected || 0;
    $('statUnique').textContent = stats.totalUniqueSites || 0;
    $('statVendors').textContent = stats.totalVendorsUnticked || 0;
    $('statTime').textContent = stats.timeSavedFormatted || '0s';
  }

  // ─── Activity ──────────────────────────────────────────────────────

  // Fix #23: pagination state
  let activityLimit = 30;
  let _allActivityEntries = [];
  let _searchDebounce = null;

  async function loadActivity(loadMore = false) {
    if (!loadMore) {
      activityLimit = 30;
      const log = await sendMessage({ type: 'GET_LOG', limit: 500 });
      _allActivityEntries = log || [];
    } else {
      activityLimit += 30;
    }

    const searchTerm = ($('activitySearch').value || '').trim().toLowerCase();
    const filtered = searchTerm
      ? _allActivityEntries.filter(e => (e.domain || '').toLowerCase().includes(searchTerm))
      : _allActivityEntries;

    const visible = filtered.slice(0, activityLimit);
    const container = $('activityList');

    if (visible.length === 0) {
      container.innerHTML = '<div class="empty-state">' + (_allActivityEntries.length === 0 ? 'No activity yet' : 'No matches') + '</div>';
      $('loadMoreBtn').style.display = 'none';
      return;
    }

    // Fix #22: show vendorsUnticked badge; background.js LOG_ACTION already stores it
    container.innerHTML = renderActivityItems(visible);

    // Fix #23: show/hide "Load more" button
    $('loadMoreBtn').style.display = filtered.length > activityLimit ? 'block' : 'none';
  }

  // ─── Lists ─────────────────────────────────────────────────────────

  async function loadLists() {
    const [whitelist, blacklist] = await Promise.all([
      sendMessage({ type: 'GET_LIST', list: 'whitelist' }),
      sendMessage({ type: 'GET_LIST', list: 'blacklist' }),
    ]);

    renderList('whitelist', whitelist || [], 'whitelistItems', 'whitelistCount');
    renderList('blacklist', blacklist || [], 'blacklistItems', 'blacklistCount');
  }

  function renderList(type, items, containerId, countId) {
    const container = $(containerId);
    const countEl = $(countId);
    countEl.textContent = items.length;

    if (items.length === 0) {
      container.innerHTML = '<div class="empty-state">No entries</div>';
      return;
    }

    container.innerHTML = items.map(item => `
      <div class="list-item">
        <span class="list-item-domain">${escapeHTML(item.domain)}</span>
        <button class="list-item-remove" data-list="${type}" data-domain="${escapeHTML(item.domain)}" title="Remove">&times;</button>
      </div>
    `).join('');
  }

  function initListHandlers() {
    // Add to whitelist
    $('addWhitelistBtn').addEventListener('click', async () => {
      const domain = $('whitelistInput').value.trim();
      if (!domain) return;
      await sendMessage({ type: 'ADD_TO_LIST', list: 'whitelist', domain });
      $('whitelistInput').value = '';
      loadLists();
      loadCurrentSite();
      showToast('Added to whitelist');
    });

    // Add to blacklist
    $('addBlacklistBtn').addEventListener('click', async () => {
      const domain = $('blacklistInput').value.trim();
      if (!domain) return;
      await sendMessage({ type: 'ADD_TO_LIST', list: 'blacklist', domain });
      $('blacklistInput').value = '';
      loadLists();
      showToast('Added to blacklist');
    });

    // Remove from list (delegated)
    document.addEventListener('click', async (e) => {
      if (e.target.classList.contains('list-item-remove')) {
        const { list, domain } = e.target.dataset;
        await sendMessage({ type: 'REMOVE_FROM_LIST', list, domain });
        loadLists();
        loadCurrentSite();
        showToast('Removed from ' + list);
      }
    });
  }

  // ─── Whitelist / Blacklist Current Site ─────────────────────────────

  function initSiteActions() {
    // Reject Now button
    $('rejectNowBtn').addEventListener('click', async () => {
      $('rejectNowBtn').disabled = true;
      $('rejectNowBtn').textContent = 'Rejecting...';
      await sendTabMessage({ type: 'FORCE_REJECT' });
      // Wait a moment then refresh
      setTimeout(async () => {
        $('rejectNowBtn').disabled = false;
        $('rejectNowBtn').textContent = 'Reject Now';
        await loadCurrentSite();
        await loadStats();
        await loadActivity();
      }, 1500);
    });

    // Whitelist button
    $('whitelistBtn').addEventListener('click', async () => {
      const action = $('whitelistBtn').dataset.action;
      const tabInfo = await sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
      if (!tabInfo) return;

      if (action === 'remove-whitelist') {
        await sendMessage({ type: 'REMOVE_FROM_LIST', list: 'whitelist', domain: tabInfo.domain });
        $('whitelistBtn').textContent = 'Whitelist';
        $('whitelistBtn').removeAttribute('data-action');
        showToast('Removed from whitelist');
      } else {
        await sendMessage({ type: 'ADD_TO_LIST', list: 'whitelist', domain: tabInfo.domain });
        $('whitelistBtn').textContent = 'Remove from Whitelist';
        $('whitelistBtn').dataset.action = 'remove-whitelist';
        showToast('Added to whitelist');
      }
      loadCurrentSite();
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────

  async function loadSettings() {
    const settings = await sendMessage({ type: 'GET_SETTINGS' });
    if (!settings) return;

    $('masterToggle').checked = settings.enabled;
    $('settingAutoReject').checked = settings.autoReject;
    $('settingUntickVendors').checked = settings.untickVendors;
    $('settingDismissOverlays').checked = settings.dismissOverlays;
    $('settingTCFApi').checked = settings.useTCFApi;
    $('settingDebug').checked = settings.debugMode;
  }

  function initSettingsHandlers() {
    const toggles = [
      { id: 'settingAutoReject', key: 'autoReject' },
      { id: 'settingUntickVendors', key: 'untickVendors' },
      { id: 'settingDismissOverlays', key: 'dismissOverlays' },
      { id: 'settingTCFApi', key: 'useTCFApi' },
      { id: 'settingDebug', key: 'debugMode' },
    ];

    for (const { id, key } of toggles) {
      $(id).addEventListener('change', async (e) => {
        await sendMessage({ type: 'UPDATE_SETTINGS', settings: { [key]: e.target.checked } });
        showToast(`${key} ${e.target.checked ? 'enabled' : 'disabled'}`);
      });
    }
  }

  // ─── Reset Stats ───────────────────────────────────────────────────

  // Fix #21: themed confirm dialog replacing native confirm()
  function showConfirm(message) {
    return new Promise((resolve) => {
      $('confirmMessage').textContent = message;
      $('confirmModal').classList.add('active');

      const cleanup = () => {
        $('confirmModal').classList.remove('active');
        $('confirmOk').removeEventListener('click', onOk);
        $('confirmCancel').removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onEscape);
        $('confirmModal').removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onTabTrap);
      };

      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onEscape = (e) => { if (e.key === 'Escape') { cleanup(); resolve(false); } };
      const onOverlayClick = (e) => { if (e.target === $('confirmModal')) { cleanup(); resolve(false); } };

      $('confirmOk').addEventListener('click', onOk);
      $('confirmCancel').addEventListener('click', onCancel);
      document.addEventListener('keydown', onEscape);
      $('confirmModal').addEventListener('click', onOverlayClick);

      // Focus trap -- keep Tab within modal while open (Fix #22)
      const focusableSelector = 'button, [tabindex]:not([tabindex="-1"])';
      const onTabTrap = (e) => {
        if (e.key !== 'Tab') return;
        const focusable = $('confirmModal').querySelectorAll(focusableSelector);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };
      document.addEventListener('keydown', onTabTrap);

      $('confirmCancel').focus();
    });
  }

  function initResetStats() {
    $('resetStatsBtn').addEventListener('click', async () => {
      const confirmed = await showConfirm('Reset all statistics and activity? This cannot be undone.');
      if (confirmed) {
        await sendMessage({ type: 'RESET_STATS' });
        await loadStats();
        await loadActivity();
        showToast('Stats reset');
      }
    });
  }

  // ─── Clear Log ─────────────────────────────────────────────────────

  function initClearLog() {
    $('clearLogBtn').addEventListener('click', async () => {
      const confirmed = await showConfirm('Clear all activity log entries?');
      if (confirmed) {
        await sendMessage({ type: 'CLEAR_LOG' });
        await loadActivity();
        showToast('Log cleared');
      }
    });
  }

  // ─── Import / Export ───────────────────────────────────────────────

  function initImportExport() {
    $('exportBtn').addEventListener('click', async () => {
      const data = await sendMessage({ type: 'EXPORT_DATA' });
      if (!data) { showToast('Export failed', true); return; }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cookiereject-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Data exported');
    });

    $('importBtn').addEventListener('click', () => {
      $('importFile').click();
    });

    $('importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const result = await sendMessage({ type: 'IMPORT_DATA', json: text });
        if (result && result.success) {
          showToast(`Imported (${result.keysImported} keys)`);
          await Promise.all([loadStats(), loadLists(), loadSettings(), loadActivity()]);
        } else {
          showToast(result.error || 'Import failed', true);
        }
      } catch (err) {
        showToast('Invalid file', true);
      }
      e.target.value = '';
    });
  }

  // ─── Event Handlers ────────────────────────────────────────────────

  function initEventHandlers() {
    initMasterToggle();
    initSiteActions();
    initListHandlers();
    initSettingsHandlers();
    initResetStats();
    initClearLog();
    initImportExport();

    // Enter key on list inputs
    $('whitelistInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('addWhitelistBtn').click();
    });
    $('blacklistInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('addBlacklistBtn').click();
    });

    // Fix #23: Load more activity entries
    $('loadMoreBtn').addEventListener('click', () => loadActivity(true));

    // Activity search filter (Fix #13, Fix #24: debounced)
    $('activitySearch').addEventListener('input', () => {
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => {
        activityLimit = 30;
        const searchTerm = ($('activitySearch').value || '').trim().toLowerCase();
        const filtered = searchTerm
          ? _allActivityEntries.filter(e => (e.domain || '').toLowerCase().includes(searchTerm))
          : _allActivityEntries;
        const visible = filtered.slice(0, activityLimit);
        const container = $('activityList');
        if (visible.length === 0) {
          container.innerHTML = '<div class="empty-state">' + (_allActivityEntries.length === 0 ? 'No activity yet' : 'No matches') + '</div>';
          $('loadMoreBtn').style.display = 'none';
          return;
        }
        container.innerHTML = renderActivityItems(visible);
        $('loadMoreBtn').style.display = filtered.length > activityLimit ? 'block' : 'none';
      }, 150);
    });
  }

  // ─── Smart Polling ─────────────────────────────────────────────────
  // Only poll while the page might still be processing (not yet processed
  // and within 30s of init). After that, stop to save resources.

  let pollInterval = null;

  function startSmartPolling() {
    let pollCount = 0;
    const maxPolls = 15; // 30 seconds at 2s intervals

    pollInterval = setInterval(async () => {
      pollCount++;
      await loadCurrentSite();
      await loadStats();

      // Stop polling after max attempts or if processed
      if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        pollInterval = null;
        return;
      }

      const statusText = document.querySelector('.status-text').textContent;
      if (statusText.startsWith('Rejected') || statusText.startsWith('No banner')) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 2000);
  }

  // ─── Initialize ─────────────────────────────────────────────────────

  async function init() {
    loadVersion();
    initTabs();
    initEventHandlers();
    await Promise.all([
      loadStats(),
      loadCurrentSite(),
      loadActivity(),
      loadLists(),
      loadSettings(),
    ]);
    startSmartPolling();
  }

  // ─── Boot ──────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
