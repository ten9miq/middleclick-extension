# MiddleClick+ enhanced

This build extends middle-click navigation for JavaScript-driven buttons and SPA pseudo-links.

## Behavior

- Normal left-click behavior is not changed.
- Native links keep Chrome's normal middle-click behavior.
- Non-anchor elements with a safely detectable destination open in a background tab.
- New tabs created by the extension are inserted directly to the right of the source tab.
- Unresolved buttons are left alone instead of incorrectly duplicating the current page.

## Generic destination detection

The extension can resolve destinations from common href/router/data attributes, inline navigation handlers, GET forms, unique descendant links, and Shadow DOM event paths.

## Install

1. Extract this folder.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Disable/remove the older MiddleClick+ build to avoid double handling.
5. Choose `Load unpacked` and select this folder.
