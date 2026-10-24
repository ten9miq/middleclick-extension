# MiddleClick+ enhanced

This build extends middle-click navigation for JavaScript-driven buttons and SPA pseudo-links.

## Behavior

- Normal left-click behavior is not changed.
- Native links keep Chrome's normal middle-click behavior.
- Non-anchor elements with a safely detectable destination open in a background tab.
- New tabs created by the extension are inserted directly to the right of the source tab.
- If the source tab belongs to a tab group, extension-created middle-click tabs join that same group.
- Unresolved buttons are left alone instead of incorrectly duplicating the current page.

## Generic destination detection

The extension can resolve destinations from common href/router/data attributes, inline navigation handlers, GET forms, unique descendant links, and Shadow DOM event paths.

SVG drawing references (such as `<use href="...svg#icon">`), resource metadata and global URL attributes on `<html>` / `<body>` are excluded. Detection stops at the clicked control instead of borrowing another item's URL from a broad ancestor. Opaque data identifiers are not interpreted as relative URLs.

## Generic navigation learning

If a control has no detectable URL, use a normal left click once. The extension passively associates that identifiable control with the observed same-origin destination. It uses Chrome's `webNavigation` events for SPA history/hash updates and full document navigations; it does not wrap page JavaScript, inspect API responses, or simulate clicks to discover destinations.

- Results are stored in `chrome.storage.local` and survive page reloads, browser restarts, and extension reloads. They are not synced or sent to a server.
- Up to 500 mappings are retained, for 90 days after the last observed left-click navigation. Using a cached mapping does not extend that period.
- Identities include control identifiers, a short label and navigation context. Label-only identities also include the source path/query. Saving one control does not train unrelated controls.
- Duplicate controls and identities observed navigating to different destinations are not reused. Conflicting mappings stay blocked until expiry or manual clearing.
- Learning requires an unmodified, trusted left click followed within 2.5 seconds by a same-frame navigation. Submissions, form-associated controls, editable controls, disabled controls and popup menus are excluded. No learning occurs in incognito mode. Cross-origin and recognizable authentication/token URLs are not stored.
- Right-click the page and choose **MiddleClick+ → Forget learned destinations for this site** to clear that origin's mappings. Already-open pages receive the update.

An unlearned control without a detectable URL remains unhandled. Dynamic destinations, duplicate controls, slow or cross-origin navigation, new-tab navigation, closed Shadow DOM and URL-free state changes may remain unsupported. A site can change a previously learned destination before the extension observes another left click; clear that site's mappings if a result becomes stale.

## Minimal ChatGPT exceptions

Ordinary ChatGPT buttons, including Your dot, use the same detection and learning as other sites. Fixed sidebar routes, title-to-route guesses and the ChatGPT API response bridge have been removed.

Codex remains a specific exception because its home URL stores the product mode in navigation state. A new tab opens with an extension marker, selects the known Codex navigation button once ready, and removes the marker after selection. The existing workaround that keeps ChatGPT sidebar anchor tabs in the background is also retained.

## Permissions

`storage` stores learned mappings locally. `webNavigation` observes navigation following an eligible click. The existing `tabs` and `contextMenus` permissions manage adjacent background tabs and the context menu. Reload the unpacked extension and target pages after updating; Chrome may request approval for the added permission.

## Install

1. Extract this folder.
2. Open `chrome://extensions/`.
3. Enable Developer mode.
4. Disable/remove the older MiddleClick+ build to avoid double handling.
5. Choose `Load unpacked` and select this folder.


## 1.2.2 behavior note

- ChatGPT sidebar middle-click navigation is forced through the extension background-tab path (`active: false`) instead of allowing ChatGPT/native navigation to create an active tab.
- Normal links on other sites still use the browser's native middle-click behavior when available.
- Native links no longer schedule an extension fallback tab, preventing duplicate tabs when Gmail or another site redirects the destination.

## Changes

See [CHANGES.md](CHANGES.md) for the version history.

## Development and browser verification

See [Chrome DevTools MCP setup and verification](docs/CHROME_DEVTOOLS_MCP.md)
for Windows / PowerShell / Codex development using a project-specific Google Chrome profile.
This folder is the unpacked extension; no build step is required.
