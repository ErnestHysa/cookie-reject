/**
 * CookieReject - Popup UI Controller
 * Handles all interactions in the browser extension popup.
 */

// SECURITY NOTE: All innerHTML assignments in this file use escapeHTML() for
// user-controlled data. When adding new HTML assignments, ALWAYS escape dynamic content.

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

  const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, c => _escapeMap[c]);
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

  function formatTimestamp(ts, detailed = false) {
    if (!ts) return '';
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 0) return 'Just now';
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
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

  // CQ-1: Extract shared search/filter function
  function filterActivityEntries(entries, searchTerm) {
    if (!searchTerm) return entries;
    const term = searchTerm.toLowerCase();
    return entries.filter(e =>
      (e.domain || '').toLowerCase().includes(term) ||
      (e.cmp || '').toLowerCase().includes(term)
    );
  }

  // UX-3: Sort activity entries
  function sortActivityEntries(entries, sortKey) {
    if (!sortKey || sortKey === 'time-desc') return entries;
    const sorted = [...entries];
    switch (sortKey) {
      case 'time-asc': sorted.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); break;
      case 'domain-asc': sorted.sort((a, b) => (a.domain || '').localeCompare(b.domain || '')); break;
      case 'vendors-desc': sorted.sort((a, b) => (b.vendorsUnticked || 0) - (a.vendorsUnticked || 0)); break;
    }
    return sorted;
  }

  // UX-5: Toast with undo button
  function showToastWithUndo(message, undoFn) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = '<span>' + escapeHTML(message) + '</span><button class="toast-undo">Undo</button>';
    document.body.appendChild(toast);
    toast.querySelector('.toast-undo').addEventListener('click', () => {
      toast.remove();
      undoFn();
    });
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 4000);
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
      updateDisabledState(e.target.checked);
    });
  }

  function updateDisabledState(enabled) {
    const settingsSection = $('settingsControls');
    if (settingsSection) {
      settingsSection.style.opacity = enabled ? '1' : '0.4';
      settingsSection.style.pointerEvents = enabled ? 'auto' : 'none';
    }
    // Also update site-actions buttons
    const siteActions = document.querySelector('.site-actions');
    if (siteActions) {
      siteActions.style.opacity = enabled ? '1' : '0.4';
      siteActions.style.pointerEvents = enabled ? 'auto' : 'none';
    }
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
      $('blacklistBtn').disabled = true;
      return;
    }

    // Re-enable buttons for valid web pages (Fix #20)
    $('rejectNowBtn').disabled = false;
    $('whitelistBtn').disabled = false;
    $('blacklistBtn').disabled = false;

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

    // UX-1: Check blacklist status
    if (listCheck && listCheck.blacklisted) {
      updateStatus('warning', 'Blacklisted');
      $('blacklistBtn').textContent = 'Remove from Blacklist';
      $('blacklistBtn').dataset.action = 'remove-blacklist';
    } else {
      $('blacklistBtn').textContent = 'Blacklist';
      $('blacklistBtn').removeAttribute('data-action');
    }

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
        updateStatus('warning', 'Scanning for banners...');
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
        const ago = formatTimestamp(last.timestamp);
        $('siteLastAction').textContent = ago;
      } else {
        $('siteLastAction').textContent = 'Just now';
      }
    }).catch(() => {
      $('siteLastAction').textContent = '-';
    });
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  async function loadStats() {
    const stats = await sendMessage({ type: 'GET_STATS' });
    if (!stats) return;
    $('statRejected').textContent = stats.totalRejected || 0;
    $('statUnique').textContent = stats.totalUniqueSites || 0;
    $('statVendors').textContent = stats.totalVendorsUnticked || 0;
    $('statTime').textContent = stats.timeSavedFormatted || '0s';

    // UX-1: Today count (server-side for performance)
    const todayResult = await sendMessage({ type: 'GET_TODAY_COUNT' });
    $('statToday').textContent = (todayResult && todayResult.count) || 0;
  }

  // ─── Activity ──────────────────────────────────────────────────────

  // Fix #23: pagination state
  let activityLimit = 30;
  let _allActivityEntries = [];
  let _allLoaded = false;
  let _searchDebounce = null;

  async function loadActivity(loadMore = false) {
    if (!loadMore) {
      activityLimit = 30;
      const log = await sendMessage({ type: 'GET_LOG', limit: 30 });
      _allActivityEntries = log || [];
      _allLoaded = false;
    } else if (!_allLoaded) {
      // First "Load More" fetches the rest
      const log = await sendMessage({ type: 'GET_LOG', limit: 500 });
      _allActivityEntries = log || [];
      _allLoaded = true;
      activityLimit += 30;
    } else {
      activityLimit += 30;
    }

    const searchTerm = ($('activitySearch').value || '').trim();
    const filtered = filterActivityEntries(_allActivityEntries, searchTerm);
    const sortKey = $('activitySort') ? $('activitySort').value : 'time-desc';
    const sorted = sortActivityEntries(filtered, sortKey);
    const visible = sorted.slice(0, activityLimit);
    const container = $('activityList');

    if (visible.length === 0) {
      container.innerHTML = '<div class="empty-state">' +
        (_allActivityEntries.length === 0 ? 'No activity yet' : 'No matches for "' + escapeHTML(searchTerm) + '"') + '</div>';
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
    const wlSearch = $('whitelistSearch') ? $('whitelistSearch').value.trim() : '';
    const blSearch = $('blacklistSearch') ? $('blacklistSearch').value.trim() : '';
    renderList('whitelist', whitelist || [], 'whitelistItems', 'whitelistCount', wlSearch);
    renderList('blacklist', blacklist || [], 'blacklistItems', 'blacklistCount', blSearch);
  }

  function renderList(type, items, containerId, countId, searchTerm = '') {
    const container = $(containerId);
    const countEl = $(countId);
    countEl.textContent = items.length;
    let filtered = items;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = items.filter(i => i.domain.toLowerCase().includes(term));
    }
    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">' + (searchTerm ? 'No matches' : 'No entries') + '</div>';
      return;
    }
    container.innerHTML = filtered.map(item => `
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
      const result = await sendMessage({ type: 'ADD_TO_LIST', list: 'whitelist', domain });
      $('whitelistInput').value = '';
      if (result && result.success) {
        loadLists();
        loadCurrentSite();
        showToast('Added to whitelist');
      } else {
        showToast('Invalid domain or already in list', true);
      }
    });

    // Add to blacklist
    $('addBlacklistBtn').addEventListener('click', async () => {
      const domain = $('blacklistInput').value.trim();
      if (!domain) return;
      const result = await sendMessage({ type: 'ADD_TO_LIST', list: 'blacklist', domain });
      $('blacklistInput').value = '';
      if (result && result.success) {
        loadLists();
        showToast('Added to blacklist');
      } else {
        showToast('Invalid domain or already in list', true);
      }
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
      $('rejectNowBtn').classList.add('rejecting');
      try {
        const response = await sendTabMessage({ type: 'FORCE_REJECT' });
        // Wait a moment then refresh
        setTimeout(async () => {
          $('rejectNowBtn').disabled = false;
          $('rejectNowBtn').textContent = 'Reject Now';
          $('rejectNowBtn').classList.remove('rejecting');
          await loadCurrentSite();
          await loadStats();
          await loadActivity();
        }, 1500);
      } catch (e) {
        $('rejectNowBtn').disabled = false;
        $('rejectNowBtn').textContent = 'Reject Now';
        $('rejectNowBtn').classList.remove('rejecting');
        showToast('Cannot reach this page (browser/extension page?)');
      }
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
        // UX-5: undo toast for whitelist add
        showToastWithUndo('Added to whitelist', async () => {
          await sendMessage({ type: 'REMOVE_FROM_LIST', list: 'whitelist', domain: tabInfo.domain });
          loadCurrentSite();
        });
      }
      loadCurrentSite();
    });
  }

  // UX-1: Blacklist button for current site
  function initBlacklistBtn() {
    $('blacklistBtn').addEventListener('click', async () => {
      const action = $('blacklistBtn').dataset.action;
      const tabInfo = await sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
      if (!tabInfo) return;

      if (action === 'remove-blacklist') {
        await sendMessage({ type: 'REMOVE_FROM_LIST', list: 'blacklist', domain: tabInfo.domain });
        $('blacklistBtn').textContent = 'Blacklist';
        $('blacklistBtn').removeAttribute('data-action');
        showToastWithUndo('Removed from blacklist', async () => {
          await sendMessage({ type: 'ADD_TO_LIST', list: 'blacklist', domain: tabInfo.domain });
          loadCurrentSite();
        });
      } else {
        // UX-5: Warn user about blacklist behavior
        const confirmed = await showConfirm('Blacklist forces rejection even when the extension is disabled. Continue?');
        if (!confirmed) return;
        await sendMessage({ type: 'ADD_TO_LIST', list: 'blacklist', domain: tabInfo.domain });
        $('blacklistBtn').textContent = 'Remove from Blacklist';
        $('blacklistBtn').dataset.action = 'remove-blacklist';
        showToastWithUndo('Added to blacklist', async () => {
          await sendMessage({ type: 'REMOVE_FROM_LIST', list: 'blacklist', domain: tabInfo.domain });
          loadCurrentSite();
        });
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
    $('settingDryRun').checked = settings.dryRun || false;
    updateDisabledState(settings.enabled);
  }

  function initSettingsHandlers() {
    const toggles = [
      { id: 'settingAutoReject', key: 'autoReject' },
      { id: 'settingUntickVendors', key: 'untickVendors' },
      { id: 'settingDismissOverlays', key: 'dismissOverlays' },
      { id: 'settingTCFApi', key: 'useTCFApi' },
      { id: 'settingDebug', key: 'debugMode' },
      { id: 'settingDryRun', key: 'dryRun' },
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

    // SUG-6: Export individual lists
    $('exportWhitelistBtn').addEventListener('click', async () => {
      const list = await sendMessage({ type: 'GET_LIST', list: 'whitelist' });
      if (!list || list.length === 0) { showToast('Whitelist is empty', true); return; }
      const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cookiereject-whitelist.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Whitelist exported');
    });
    $('exportBlacklistBtn').addEventListener('click', async () => {
      const list = await sendMessage({ type: 'GET_LIST', list: 'blacklist' });
      if (!list || list.length === 0) { showToast('Blacklist is empty', true); return; }
      const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cookiereject-blacklist.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Blacklist exported');
    });
  }

  // ─── CSV Export (FEAT-3) ──────────────────────────────────────────

  function exportCSV() {
    sendMessage({ type: 'GET_LOG', limit: 500 }).then(log => {
      if (!log || log.length === 0) { showToast('No data to export', true); return; }
      function csvEscape(str) {
        if (!str) return '';
        const s = String(str);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }
      const header = 'Domain,CMP,Vendors Unticked,Timestamp\n';
      const rows = log.map(e =>
        csvEscape(e.domain) + ',' + csvEscape(e.cmp) + ',' + (e.vendorsUnticked || 0) + ',' + csvEscape(new Date(e.timestamp).toISOString())
      ).join('\n');
      const blob = new Blob([header + rows], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cookiereject-activity-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('CSV exported');
    });
  }

  // ─── Theme Toggle (FEAT-7) ──────────────────────────────────────

  function toggleTheme() {
    const html = document.documentElement;
    const current = html.dataset.theme;
    const next = current === 'light' ? 'dark' : 'light';
    html.dataset.theme = next;
    $('themeToggle').textContent = next === 'light' ? '☀️' : '🌙';
    try {
      chrome.storage.local.set({ theme: next });
    } catch (e) { /* ignore */ }
  }

  function loadTheme() {
    try {
      chrome.storage.local.get('theme', (result) => {
        if (result && result.theme) {
          document.documentElement.dataset.theme = result.theme;
          $('themeToggle').textContent = result.theme === 'light' ? '☀️' : '🌙';
        }
      });
    } catch (e) { /* ignore */ }
  }

  // ─── Event Handlers ────────────────────────────────────────────────

  function initEventHandlers() {
    initMasterToggle();
    initSiteActions();
    initBlacklistBtn();
    initListHandlers();
    initSettingsHandlers();
    initResetStats();
    initClearLog();
    initImportExport();

    // FEAT-3: CSV export
    $('exportCsvBtn').addEventListener('click', exportCSV);

    // FEAT-7: Theme toggle
    $('themeToggle').addEventListener('click', toggleTheme);

    // FEAT-5: Report undetected banner
    $('reportBanner').addEventListener('click', async () => {
      const domain = $('siteDomain').textContent;
      const detectedCMP = $('siteCMP') ? $('siteCMP').textContent : 'None';
      const tabInfo = await sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
      const pageUrl = tabInfo ? tabInfo.url : domain;
      const url = `https://github.com/ErnestHysa/cookie-reject/issues/new?title=Undetected+banner+on+${encodeURIComponent(domain)}&body=${encodeURIComponent(`**URL:** ${pageUrl}\n**Browser:** ${navigator.userAgent}\n**Extension version:** ${$('version').textContent}\n**Detected CMP:** ${detectedCMP}\n\n**Description:**\nPlease describe the banner and any relevant details about the website.`)}`;
      chrome.tabs.create({ url });
    });

    // Enter key on list inputs
    $('whitelistInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('addWhitelistBtn').click();
    });
    $('blacklistInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('addBlacklistBtn').click();
    });

    // Fix #23: Load more activity entries
    $('loadMoreBtn').addEventListener('click', () => loadActivity(true));

    // UX-3: Activity sorting
    if ($('activitySort')) {
      $('activitySort').addEventListener('change', () => loadActivity());
    }

    // UX-4: List search
    if ($('whitelistSearch')) {
      $('whitelistSearch').addEventListener('input', () => loadLists());
    }
    if ($('blacklistSearch')) {
      $('blacklistSearch').addEventListener('input', () => loadLists());
    }

    // Activity search filter (Fix #13, Fix #24: debounced)
    $('activitySearch').addEventListener('input', () => {
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(() => {
        activityLimit = 30;
        const searchTerm = ($('activitySearch').value || '').trim();
        const filtered = filterActivityEntries(_allActivityEntries, searchTerm);
        const sortKey = $('activitySort') ? $('activitySort').value : 'time-desc';
        const sorted = sortActivityEntries(filtered, sortKey);
        const visible = sorted.slice(0, activityLimit);
        const container = $('activityList');
        if (visible.length === 0) {
          container.innerHTML = '<div class="empty-state">' +
            (_allActivityEntries.length === 0 ? 'No activity yet' : 'No matches for "' + escapeHTML(searchTerm) + '"') + '</div>';
          $('loadMoreBtn').style.display = 'none';
          return;
        }
        container.innerHTML = renderActivityItems(visible);
        $('loadMoreBtn').style.display = filtered.length > activityLimit ? 'block' : 'none';
      }, 150);
    });

    // UX-3: CMP coverage info
    if ($('showCMPListBtn')) {
      $('showCMPListBtn').addEventListener('click', async () => {
        const cmpStats = await sendMessage({ type: 'GET_CMP_STATS' });
        const handlers = ['onetrust','fides','ketch','cookiebot','didomi','sourcepoint','trustarc','quantcast','usercentrics','cookieyes','iubenda','consentmanager','sirdata','ezcookie','borlabs','lgcookieslaw','complianz','cookienotice','osano','termly','cookieinfo','realcookiebanner','moovegdpr','cookieadmin','beautifulcookie','pressidium','wplpcookie','axeptio','admiral','commandersact','cookiefirst','cookiehub','gravito','truendo','clickio','appconsent','cloudflare','securiti','transcend','civic','fastcmp','lawwwing','avacy','consentmo','pandectes','enzuzo','cookiescript','generic'];
        const listHtml = handlers.map(h => {
          const stats = cmpStats[h] || { success: 0, failed: 0 };
          return `<div class="cmp-list-item"><span>${h}</span><span class="cmp-stat">${stats.success}/${stats.success + stats.failed}</span></div>`;
        }).join('');
        showToast(`CMP list: ${handlers.length} handlers`);
      });
    }
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
    loadTheme();
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

    // UX-6: Show update notification if recently updated
    try {
      const meta = await sendMessage({ type: 'GET_VERSION' });
      const lastSeenVersion = localStorage.getItem('cr_lastSeenVersion');
      if (lastSeenVersion && lastSeenVersion !== meta.version) {
        showToast(`Updated to v${meta.version}! Check what's new.`);
      }
      localStorage.setItem('cr_lastSeenVersion', meta.version);
    } catch { /* ignore */ }
  }

  // ─── Boot ──────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
