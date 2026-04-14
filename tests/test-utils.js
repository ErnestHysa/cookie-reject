/**
 * CookieReject - Unit Tests for Utility Functions
 * Run with: node tests/test-utils.js
 * 
 * These tests cover pure functions that don't need a browser environment.
 * For full integration testing, load the extension in a browser.
 *
 * NOTE: Functions like extractBaseDomain, domainMatches, escapeHTML, and
 * isValidLogEntry are re-implemented here rather than imported from
 * background.js / content.js because Manifest V3 extensions don't use ES
 * modules. If the source implementations change, update these copies too.
 * 
 * SYNC CHECKLIST: When updating source, verify these match:
 *   - extractBaseDomain() <-> background.js ListManager.extractBaseDomain
 *   - domainMatches() <-> background.js ListManager.domainMatches  
 *   - escapeHTML() <-> content.js Utils.escapeHTML / popup.js escapeHTML
 *   - isValidLogEntry() <-> background.js import validator logic
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

// ─── ListManager.extractBaseDomain ───
console.log('\nListManager.extractBaseDomain:');

// We need to extract the function. Since it's inside an IIFE in background.js,
// we'll test the logic pattern directly:
function extractBaseDomain(url) {
  try {
    const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname;
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    // Handle co.uk, com.au, etc.
    const ccSlds = ['co.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'com.sg', 'org.uk', 'net.au'];
    const lastTwo = parts.slice(-2).join('.');
    if (ccSlds.includes(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch {
    return url;
  }
}

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
  if (domain === pattern) return true;
  return domain.endsWith('.' + pattern);
}

assert('exact match', domainMatches('example.com', 'example.com'));
assert('subdomain match', domainMatches('www.example.com', 'example.com'));
assert('deep subdomain match', domainMatches('a.b.example.com', 'example.com'));
assert('no partial match', !domainMatches('notexample.com', 'example.com'));
assert('no partial match reverse', !domainMatches('example.com', 'www.example.com'));

// ─── HTML Escape ───
console.log('\nHTML Escape:');

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

assert('valid entry', isValidLogEntry({ domain: 'example.com', timestamp: Date.now(), cmp: 'OneTrust' }));
assert('valid minimal', isValidLogEntry({ domain: 'example.com', timestamp: 1000 }));
assert('missing domain', !isValidLogEntry({ timestamp: 1000 }));
assert('missing timestamp', !isValidLogEntry({ domain: 'example.com' }));
assert('empty domain', !isValidLogEntry({ domain: '', timestamp: 1000 }));
assert('negative timestamp', !isValidLogEntry({ domain: 'example.com', timestamp: -1 }));
assert('null', !isValidLogEntry(null));
assert('string', !isValidLogEntry('not an object'));

// ─── Summary ───
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error('\nSome tests FAILED!');
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
}
