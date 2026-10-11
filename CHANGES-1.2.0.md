# MiddleClick+ enhanced 1.2.0

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
