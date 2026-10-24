# MiddleClick+ enhanced

This build extends middle-click navigation for JavaScript-driven buttons and SPA pseudo-links.

## Behavior

- Normal left-click behavior is not changed.
- Native links keep Chrome's normal middle-click behavior.
- Non-anchor elements with a safely detectable destination open in a background tab.
- New tabs created by the extension are inserted directly to the right of the source tab.
- If the source tab belongs to a tab group, extension-created middle-click tabs join that same group.
- Unlearned, identifiable controls offer a per-target confirmation before executing a discovery click. Cancellation never clicks the target.

## Generic destination detection

The extension can resolve destinations from common href/router/data attributes, inline navigation handlers, GET forms, unique descendant links, and Shadow DOM event paths.

SVG drawing references (such as `<use href="...svg#icon">`), resource metadata and global URL attributes on `<html>` / `<body>` are excluded. Detection stops at the clicked control instead of borrowing another item's URL from a broad ancestor. Opaque data identifiers are not interpreted as relative URLs.

## Generic navigation learning

The extension passively learns identifiable controls from normal left clicks. If an unlearned control is middle-clicked, it first asks permission to execute that specific control's left-click action. After approval it observes the destination, restores the original page, and opens the destination in an adjacent background tab. Subsequent middle clicks use the learned URL directly. Cancelling the prompt does not click, navigate, or create a tab.

Discovery clicks require confirmation every time until a usable destination has been learned. They are limited to identifiable controls in the top frame outside forms, editable areas, disabled controls and popup menus. A discovery click can run all of the target's handler, including data changes which cannot be undone by navigating back; the prompt explains this before approval. There is no automatic unconfirmed discovery click.

Navigation is observed through Chrome's `webNavigation` events for SPA history/hash updates and full document navigation. Page APIs and network responses are not intercepted.

- Results are stored in `chrome.storage.local` and survive page reloads, browser restarts, and extension reloads. They are not synced or sent to a server.
- Up to 500 mappings are retained, for 90 days after the last observed left-click navigation. Using a cached mapping does not extend that period.
- Identities include control identifiers, a short label and navigation context. Label-only identities also include the source path/query. Saving one control does not train unrelated controls.
- Equal labels are distinguished by stable surrounding section/region metadata when the basic identity collides. DOM position is not used, so reordering does not select another control. Controls that remain indistinguishable and identities observed navigating to different destinations are not reused. Existing unambiguous mapping keys are preserved. Conflicting mappings stay blocked until expiry or manual clearing.
- Passive learning requires an unmodified, trusted left click followed within 2.5 seconds by a same-frame navigation. Confirmed discovery waits up to 10 seconds for navigation, with a 300 ms settling period for route changes. Submissions, form-associated controls, editable controls, disabled controls and popup menus are excluded. No learning occurs in incognito mode. Cross-origin and recognizable authentication/token URLs are not stored.
- Right-click the page and choose **MiddleClick+ → Forget learned destinations for this site** to clear that origin's mappings. Already-open pages receive the update.

For confirmed discovery, local persistence and source restoration start in parallel. The new tab waits for the source URL to be restored, but not for storage I/O to finish; the restored page also receives the new mapping in memory. Restoration uses the exact original Navigation API history entry when available. If replacement navigation removed that entry, the source URL is reloaded. Scroll, draft and other application state cannot be guaranteed to survive a reload.

A confirmed router navigation can keep the same URL while pushing a new history entry. That case is recognized by a changed Navigation API entry key; an unchanged URL and unchanged entry are not sufficient evidence of navigation. History restoration checks the original entry key as well as the URL before opening the new tab.

Feedback explains unsuccessful discovery, ambiguous mappings, timeouts and restoration failures. Dynamic destinations, duplicate controls, slow or cross-origin navigation, new-tab navigation, closed Shadow DOM and URL-free state changes may remain unsupported. A site can change a previously learned destination before the extension observes another left click; clear that site's mappings if a result becomes stale.

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
