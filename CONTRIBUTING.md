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

Each handler lives in `content.js` inside `CMPHandlers`. A handler needs:

```javascript
newcmp: {
  detect() {
    // Return true if this CMP's banner is present and visible
    return !!(document.getElementById('some-element'));
  },
  async reject() {
    let rejected = 0;
    let vendorsUnticked = 0;
    // 1. Try "Reject All" button
    // 2. If none, open preferences, untick vendors, save
    // 3. Return { rejected, vendorsUnticked }
    return { rejected, vendorsUnticked };
  },
},
```

Also add the detector to the `detectors` array in `CMPDetector.detect()`.

## Testing

There are no automated tests (the extension interacts with live websites).
Test manually:

1. Load the extension unpacked in your browser
2. Visit sites known to use the CMP you're targeting
3. Verify auto-detection works (banner appears and gets rejected)
4. Verify manual "Reject Now" works
5. Verify stats increment correctly
6. Verify no false positives on pages without banners

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
