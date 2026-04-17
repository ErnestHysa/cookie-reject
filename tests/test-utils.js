/**
 * CookieReject - Test Suite
 * 
 * NOTE: The main source files (content.js, background.js) use IIFEs (Immediately
 * Invoked Function Expressions) to avoid polluting the global scope. This means
 * their internal functions cannot be imported or required in a test file.
 * 
 * To test the logic, we re-implement the pure functions here. This means tests
 * validate the logic, not the actual production code. When updating production
 * code, update the corresponding test implementations here as well.
 * 
 * For integration testing, use the browser's developer tools or a framework
 * like Puppeteer/Playwright to test the actual extension in a real browser.
 *
 * Run with: node tests/test-utils.js
 *
 * SYNC CHECKLIST: When updating source, verify these match:
 *   - extractBaseDomain() <-> background.js ListManager.extractBaseDomain
 *   - domainMatches() <-> background.js ListManager.domainMatches  
 *   - escapeHTML() <-> content.js Utils.escapeHTML / popup.js escapeHTML
 *   - isValidLogEntry() <-> background.js import validator logic
 *   - CONFIG <-> content.js CONFIG
 *   - isVisible() <-> content.js Utils.isVisible
 *   - validateImportData() <-> background.js ImportExport.validateImportData
 *   - calculateTimeSaved() <-> background.js StatsManager.calculateTimeSaved
 *   - formatTime() <-> background.js StatsManager.formatTime
 *   - SYNC_KEYS <-> background.js SYNC_KEYS
 */

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function assertEqual(name, actual, expected) {
  assert(name, actual === expected);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXISTING TESTS (34 original tests preserved below)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── ListManager.extractBaseDomain ───
console.log('\nListManager.extractBaseDomain:');

// We need to extract the function. Since it's inside an IIFE in background.js,
// we'll test the logic pattern directly:
function extractBaseDomain(url) {
  try {
    const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname;
    // Handle IP addresses (IPv4) - return as-is
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
    // Handle IPv6 - return as-is
    if (hostname.startsWith('[')) return hostname;
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    // Handle co.uk, com.au, etc.
    const ccSlds = ['co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.mx',
      'org.uk', 'net.au', 'co.za', 'com.sg', 'co.nz', 'com.hk'];
    const lastTwo = parts.slice(-2).join('.');
    if (ccSlds.includes(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch {
    return url;
  }
}

// 1-7: Original extractBaseDomain tests
assertEqual('simple domain', extractBaseDomain('example.com'), 'example.com');
assertEqual('subdomain', extractBaseDomain('www.example.com'), 'example.com');
assertEqual('deep subdomain', extractBaseDomain('a.b.c.example.com'), 'example.com');
assertEqual('co.uk', extractBaseDomain('www.example.co.uk'), 'example.co.uk');
assertEqual('com.au', extractBaseDomain('shop.example.com.au'), 'example.com.au');
assertEqual('with protocol', extractBaseDomain('https://www.example.com/path'), 'example.com');
assertEqual('bare domain', extractBaseDomain('localhost'), 'localhost');

// ─── ListManager.domainMatches ───
console.log('\nListManager.domainMatches:');

function domainMatches(domain, pattern) {
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
}

// 8-18: Original domainMatches tests
assert('exact match', domainMatches('example.com', 'example.com'));
assert('subdomain match', domainMatches('www.example.com', 'example.com'));
assert('deep subdomain match', domainMatches('a.b.example.com', 'example.com'));
assert('no partial match', !domainMatches('notexample.com', 'example.com'));
assert('no partial match reverse', !domainMatches('example.com', 'www.example.com'));
assert('case insensitive domain', domainMatches('Example.COM', 'example.com'));
assert('case insensitive pattern', domainMatches('example.com', 'EXAMPLE.COM'));
assert('wildcard matches exact', domainMatches('example.com', '*.example.com'));
assert('wildcard matches subdomain', domainMatches('www.example.com', '*.example.com'));
assert('null domain returns false', !domainMatches(null, 'example.com'));
assert('null pattern returns false', !domainMatches('example.com', null));

// ─── HTML Escape ───
console.log('\nHTML Escape:');

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 19-26: Original escapeHTML tests
assertEqual('ampersand', escapeHTML('a&b'), 'a&amp;b');
assertEqual('less than', escapeHTML('a<b'), 'a&lt;b');
assertEqual('greater than', escapeHTML('a>b'), 'a&gt;b');
assertEqual('quotes', escapeHTML('a"b'), 'a&quot;b');
assertEqual('combined', escapeHTML('<script>"x"&y</script>'), '&lt;script&gt;&quot;x&quot;&amp;y&lt;/script&gt;');
assertEqual('empty string', escapeHTML(''), '');
assertEqual('null', escapeHTML(null), '');
assertEqual('normal text', escapeHTML('hello world'), 'hello world');

// ─── Import Validation Pattern ───
console.log('\nImport Validation:');

function isValidLogEntry(entry) {
  return entry &&
    typeof entry === 'object' &&
    typeof entry.domain === 'string' && entry.domain.length > 0 &&
    typeof entry.timestamp === 'number' && entry.timestamp > 0;
}

// 27-34: Original isValidLogEntry tests
assert('valid entry', isValidLogEntry({ domain: 'example.com', timestamp: Date.now(), cmp: 'OneTrust' }));
assert('valid minimal', isValidLogEntry({ domain: 'example.com', timestamp: 1000 }));
assert('missing domain', !isValidLogEntry({ timestamp: 1000 }));
assert('missing timestamp', !isValidLogEntry({ domain: 'example.com' }));
assert('empty domain', !isValidLogEntry({ domain: '', timestamp: 1000 }));
assert('negative timestamp', !isValidLogEntry({ domain: 'example.com', timestamp: -1 }));
assert('null', !isValidLogEntry(null));
assert('string', !isValidLogEntry('not an object'));

// ═══════════════════════════════════════════════════════════════════════════════
// NEW TESTS (20+ additional tests)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Config defaults ───
console.log('\nConfig defaults:');

// Re-implementation of content.js CONFIG
const CONFIG = {
  retryInterval: 500,
  maxRetries: 60,
  vendorToggleDelay: 50,
  dynamicLoadDelay: 800,
  scrollDelay: 300,
  maxVendors: 2000,
  observerThrottle: 300,
  failedCooldown: 3000,
  preRejectDelay: 800,
  observerTimeout: 35000,
  settingsWaitTimeout: 2000,
  handlerWaitDelay: 800,
  topCMPs: ['onetrust', 'didomi', 'cookieyes', 'usercentrics', 'sourcepoint'],
};

// 35-47: Config key/type tests
assert('CONFIG has retryInterval', typeof CONFIG.retryInterval === 'number');
assert('CONFIG has maxRetries', typeof CONFIG.maxRetries === 'number');
assert('CONFIG has vendorToggleDelay', typeof CONFIG.vendorToggleDelay === 'number');
assert('CONFIG has dynamicLoadDelay', typeof CONFIG.dynamicLoadDelay === 'number');
assert('CONFIG has scrollDelay', typeof CONFIG.scrollDelay === 'number');
assert('CONFIG has maxVendors', typeof CONFIG.maxVendors === 'number');
assert('CONFIG has observerThrottle', typeof CONFIG.observerThrottle === 'number');
assert('CONFIG has failedCooldown', typeof CONFIG.failedCooldown === 'number');
assert('CONFIG has preRejectDelay', typeof CONFIG.preRejectDelay === 'number');
assert('CONFIG has observerTimeout', typeof CONFIG.observerTimeout === 'number');
assert('CONFIG has settingsWaitTimeout', typeof CONFIG.settingsWaitTimeout === 'number');
assert('CONFIG has handlerWaitDelay', typeof CONFIG.handlerWaitDelay === 'number');
assert('CONFIG.topCMPs is array', Array.isArray(CONFIG.topCMPs));

// ─── isVisible logic ───
console.log('\nisVisible logic:');

// Simplified re-implementation of Utils.isVisible from content.js
// Tests the core logic: offsetHeight > 0 && offsetWidth > 0
function isVisible(el) {
  if (!el) return false;
  // Fast path: element has non-zero size and is in layout
  if (el.offsetHeight > 0 && el.offsetWidth > 0 && el.offsetParent !== null) {
    return true;
  }
  // For testing purposes, we simulate the style-based checks
  if (el._displayNone) return false;
  if (el._visibilityHidden) return false;
  if (el._opacityZero) return false;
  // Fixed position elements have offsetParent === null but may still be visible
  if (el._positionFixed && el.offsetHeight > 0 && el.offsetWidth > 0) return true;
  return false;
}

// 48-52: isVisible tests
assert('null element is not visible', !isVisible(null));
assert('element with size is visible', isVisible({ offsetHeight: 100, offsetWidth: 200, offsetParent: {} }));
assert('zero-height element is not visible', !isVisible({ offsetHeight: 0, offsetWidth: 200, offsetParent: {} }));
assert('zero-width element is not visible', !isVisible({ offsetHeight: 100, offsetWidth: 0, offsetParent: {} }));
assert('display:none element is not visible',
  !isVisible({ offsetHeight: 100, offsetWidth: 200, offsetParent: null, _displayNone: true }));

// ─── Storage key validation (validateImportData) ───
console.log('\nStorage key validation:');

// Re-implementation of background.js ImportExport.validateImportData
// STORAGE_KEYS constants from background.js
const STORAGE_KEYS = {
  STATS: 'cr_stats',
  LOG: 'cr_log',
  WHITELIST: 'cr_whitelist',
  BLACKLIST: 'cr_blacklist',
  SETTINGS: 'cr_settings',
  UNIQUE_DOMAINS: 'cr_unique_domains',
  META: 'cr_meta',
};

function validateImportData(key, value) {
  if (key === STORAGE_KEYS.STATS) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { valid: false, sanitizedValue: null };
    }
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

  if (key === STORAGE_KEYS.UNIQUE_DOMAINS) {
    if (!Array.isArray(value)) {
      return { valid: false, sanitizedValue: null };
    }
    const sanitized = value.filter(item => typeof item === 'string');
    return { valid: true, sanitizedValue: sanitized };
  }

  return { valid: true, sanitizedValue: value };
}

// 53: Array instead of object for stats
assert('stats: array rejected', !validateImportData('cr_stats', [1, 2, 3]).valid);

// 54: String instead of number for stats count
assert('stats: string count rejected',
  !validateImportData('cr_stats', { totalRejected: 'five' }).valid);

// 55: Missing domain in log entries (sanitized away)
const logResult = validateImportData('cr_log', [
  { domain: 'example.com', timestamp: 1000 },
  { timestamp: 2000 }, // missing domain
]);
assert('log: missing domain entry sanitized out', logResult.sanitizedValue.length === 1);

// 56: Non-string items in unique_domains (sanitized away)
const domainResult = validateImportData('cr_unique_domains', ['example.com', 42, null, 'test.com']);
assert('unique_domains: non-strings sanitized out', domainResult.sanitizedValue.length === 2);

// 57: Valid stats pass
assert('stats: valid object accepted',
  validateImportData('cr_stats', { totalRejected: 5, totalUniqueSites: 3 }).valid);

// 58: Valid log entries pass
assert('log: valid entries accepted',
  validateImportData('cr_log', [{ domain: 'a.com', timestamp: 1 }]).valid);

// ─── extractBaseDomain edge cases ───
console.log('\nextractBaseDomain edge cases:');

// 59-64: Additional edge case tests
assertEqual('localhost returns localhost', extractBaseDomain('localhost'), 'localhost');
assertEqual('IP address returns as-is', extractBaseDomain('192.168.1.1'), '192.168.1.1');
assertEqual('IPv6 loopback', extractBaseDomain('[::1]'), '[::1]');
assertEqual('port stripped', extractBaseDomain('example.com:8080'), 'example.com');
assertEqual('deep subdomain collapses', extractBaseDomain('sub.sub.example.com'), 'example.com');
assertEqual('co.jp handled', extractBaseDomain('sub.example.co.jp'), 'example.co.jp');

// ─── SyncStorage key detection ───
console.log('\nSyncStorage key detection:');

// Re-implementation of background.js SYNC_KEYS
const SYNC_KEYS = new Set(['cr_settings', 'cr_whitelist', 'cr_blacklist']);

// 65-69: SYNC_KEYS tests
assert('cr_settings is sync key', SYNC_KEYS.has('cr_settings'));
assert('cr_whitelist is sync key', SYNC_KEYS.has('cr_whitelist'));
assert('cr_blacklist is sync key', SYNC_KEYS.has('cr_blacklist'));
assert('cr_stats is NOT sync key', !SYNC_KEYS.has('cr_stats'));
assert('cr_log is NOT sync key', !SYNC_KEYS.has('cr_log'));

// ─── Stats calculation ───
console.log('\nStats calculation:');

// Re-implementation of background.js StatsManager.calculateTimeSaved
function calculateTimeSaved(stats) {
  const siteTime = (stats.totalUniqueSites || 0) * 8;
  const vendorTime = (stats.totalVendorsUnticked || 0) * 2;
  return siteTime + vendorTime;
}

// 70-73: calculateTimeSaved tests
assertEqual('zero stats = 0s', calculateTimeSaved({}), 0);
assertEqual('1 site = 8s', calculateTimeSaved({ totalUniqueSites: 1 }), 8);
assertEqual('1 site + 5 vendors = 18s', calculateTimeSaved({ totalUniqueSites: 1, totalVendorsUnticked: 5 }), 18);
assertEqual('10 sites + 100 vendors = 280s', calculateTimeSaved({ totalUniqueSites: 10, totalVendorsUnticked: 100 }), 280);

// ─── formatTime ───
console.log('\nformatTime:');

// Re-implementation of background.js StatsManager.formatTime
function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// 74-79: formatTime tests
assertEqual('0 seconds', formatTime(0), '0s');
assertEqual('30 seconds', formatTime(30), '30s');
assertEqual('59 seconds', formatTime(59), '59s');
assertEqual('60 seconds = 1m 0s', formatTime(60), '1m 0s');
assertEqual('90 seconds = 1m 30s', formatTime(90), '1m 30s');
assertEqual('3600 seconds = 1h 0m', formatTime(3600), '1h 0m');
assertEqual('3661 seconds = 1h 1m', formatTime(3661), '1h 1m');

// ─── Summary ───
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('\nSome tests FAILED!');
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
}
