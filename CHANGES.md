# Changelog

## Unreleased

- Replace ChatGPT fixed routes, title matching and fetch/XHR inspection with generic passive navigation learning and local persistence.
- Learn identifiable controls from normal left clicks followed by same-origin SPA/hash or full-document navigation, without executing discovery clicks or modifying page APIs.
- Retain up to 500 mappings for 90 days, reject ambiguous mappings, and add a context menu to forget mappings for a site.
- Retain only the Codex mode initializer and the ChatGPT sidebar background-tab workaround as site-specific behavior.
- Exclude SVG resources and global metadata; bound URL detection to the clicked control.
- Add `storage` and `webNavigation` permissions and regression tests for persistence, ambiguity, navigation attribution and generic controls.

## 1.2.3

- Keep extension-created middle-click tabs in the source tab's group, while preserving background opening and placement directly to its right.
- Preserve the created tab without opening a duplicate if the source group disappears or grouping fails.

## 1.2.2

- Remove fallback tab requests for native links to prevent duplicates when destination URLs change through redirects (for example, Gmail links).

## 1.2.1

- Keep middle-click-created ChatGPT sidebar tabs in the background (`active: false`).
- Prevent ChatGPT/native sidebar handlers from winning the middle-click race and creating a foreground tab.
- Preserve insertion immediately to the right of the source tab.
- Preserve the ChatGPT conversation/project URL resolution improvements from 1.2.0.
- Leave ordinary native links on other sites to Chrome as before.

## 1.2.0

Changes from enhanced 1.1.0:

- Added ChatGPT sidebar-specific destination resolution.
- "New chat" now resolves to the ChatGPT root route instead of duplicating the current conversation URL.
- Chat and project names can be resolved from:
  - IDs/routes embedded in DOM attributes.
  - Existing sidebar links.
  - ChatGPT sidebar API responses already fetched by the page.
  - A fallback mapping learned after a normal left-click navigation.
- Added a ChatGPT-only MAIN-world bridge so existing page fetch/XHR responses can be inspected without making any additional network requests.
- Added XHR monitoring in addition to fetch monitoring for ChatGPT sidebar metadata.
- Added pointerdown handling for non-anchor pseudo-links to run before SPA click/auxclick handlers.
- Suppresses later middle-button events only after a destination has been resolved.
- Removed the incorrect generic behavior that duplicated the current page when a button had no safely detectable destination.
- Existing generic URL detection and adjacent-tab placement are retained.

Security notes:

- The MAIN-world bridge is restricted to chatgpt.com and www.chatgpt.com.
- It has no extension API access and performs no network requests of its own.
- Only ChatGPT conversation/project routes are accepted from the bridge.

## 1.1.0

Changes made to the supplied 1.0 source:

- Middle-click fallback tabs now open immediately to the right of the source tab.
- The new tab is associated with the source via `openerTabId` when possible.
- Destination detection now runs before the generic button/current-page fallback.
- Added/expanded detection for:
  - standard anchors and areas
  - Angular/SPA-style route attributes (`routerLink`, `to`, `data-route`, etc.)
  - navigation-looking custom `data-*` attributes
  - literal URLs in common inline `onclick` navigation patterns
  - cards/list items containing a single unambiguous descendant link
  - GET form/search submit buttons (without submitting the form)
  - Shadow DOM event paths where exposed through `composedPath()`
- Native HTTP(S) links get a delayed extension fallback if a site suppresses native middle-click.
- Multiple rapid middle-clicks are no longer collapsed into one pending request.
- Fallback-opened URLs are restricted to HTTP(S) to avoid arbitrary custom-scheme execution.

Deliberate limitation: the extension does not execute/simulate an element's left-click handler merely to discover its destination. Doing so could trigger side effects such as submit/delete/purchase actions. If a SPA keeps the destination only inside an opaque JavaScript closure and exposes no URL/route in the DOM, it cannot be inferred safely by this implementation.
