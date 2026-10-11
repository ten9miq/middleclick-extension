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

## ChatGPT support

ChatGPT sidebar items sometimes have no usable href in the clicked DOM element. This build adds ChatGPT-specific resolution for:

- New chat / Home.
- Conversation titles.
- Project names.
- Plugins and Schedules fixed routes.

It learns conversation/project mappings from DOM attributes, sidebar links, ChatGPT's already-fetched sidebar API responses, and normal left-click navigation as a fallback.

The ChatGPT response bridge runs only on chatgpt.com in the page's MAIN JavaScript world. It does not issue additional requests and does not expose Chrome extension APIs to the page.

## Install

1. Extract this folder.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Disable/remove the older MiddleClick+ build to avoid double handling.
5. Choose `Load unpacked` and select this folder.


## 1.2.1 behavior note

- ChatGPT sidebar middle-click navigation is forced through the extension background-tab path (`active: false`) instead of allowing ChatGPT/native navigation to create an active tab.
- Normal links on other sites still use the browser's native middle-click behavior when available.
- Native links no longer schedule an extension fallback tab, preventing duplicate tabs when Gmail or another site redirects the destination.
