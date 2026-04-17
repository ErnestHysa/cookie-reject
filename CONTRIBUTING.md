# Contributing to CookieReject

Thanks for your interest! Here's how to help.

## Reporting Issues

Found a site where CookieReject doesn't work? Open an issue with:

1. The **exact URL** of the site
2. What **browser and version** you're using
3. What you see vs. what you expected (screenshot if possible)
4. Whether it fails on auto-detection, manual "Reject Now", or both

## Submitting Changes

1. Fork the repo
2. Create a branch: `git checkout -b my-fix`
3. Make your changes
4. Test on at least one real site that uses the affected CMP
5. Commit with a descriptive message
6. Open a Pull Request

## Code Style

- Vanilla JavaScript (no build tools, no frameworks)
- 2-space indentation
- Single quotes for strings
- Comments explaining *why*, not *what*

## Adding a New CMP Handler

Handlers are registered via `registerHandler()` in `content.js`. You only need
to update **one place** -- the registration call. The detector and selectors
are auto-registered from the `opts` parameter.

```javascript
registerHandler(
  'mycmp',                    // unique ID (lowercase, no spaces)
  'MyCMP Framework',          // human-readable name
  function detect() {          // detection function
    return !!(
      document.getElementById('some-banner') ||
      document.querySelector('.some-consent-popup')
    );
  },
  async function reject() {    // rejection function
    let rejected = 0;
    let vendorsUnticked = 0;
    // 1. Try "Reject All" button
    // 2. If none, open preferences, untick vendors, save
    // 3. Return { rejected, vendorsUnticked }
    return { rejected, vendorsUnticked };
  },
  {
    // REQUIRED: selectors for primary detection (comma-separated)
    selectors: '#some-banner, .some-consent-popup',
    // REQUIRED: fast check for CMPDetector.detect()
    detectCheck: () =>
      document.getElementById('some-banner') ||
      document.querySelector('.some-consent-popup'),
  }
);
```

### Using Handler Helpers

For common rejection patterns, use `HandlerHelpers.standardReject()`:

```javascript
async function reject() {
  return HandlerHelpers.standardReject({
    rejectTexts: ['reject all', 'reject', 'decline'],
    prefsTexts: ['manage preferences', 'customize'],
    containerSelector: '#some-banner',
    saveTexts: ['save preferences', 'confirm choices'],
  });
}
```

### Handler Checklist

- [ ] `id` is unique and lowercase
- [ ] `detect()` checks both element existence AND visibility
- [ ] `reject()` returns `{ rejected: number, vendorsUnticked: number }`
- [ ] `selectors` targets the visible banner element (not a persistent wrapper)
- [ ] `detectCheck` matches what `detect()` looks for
- [ ] Tested on at least one real site

## Testing

Run unit tests with:

```bash
node tests/test-utils.js
```

Manual testing:

1. Load the extension unpacked in your browser
2. Visit sites known to use the CMP you're targeting
3. Verify auto-detection works (banner appears and gets rejected)
4. Check the popup dashboard for correct stats
5. Test the "Reject Now" manual trigger
