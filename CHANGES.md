# Changelog

## 1.3.1

- Reuse existing learned URLs across source paths for explicitly labelled navigation controls, without site-specific routes. Keep section distinctions and path-local records, reject conflicting cross-path destinations, and leave text-only and main-content controls path scoped.
- Expand regression coverage to 80 tests, including cross-path reuse, legacy mappings, origin and expiry boundaries, and conflicting destinations.

## 1.3.0

- Replace ChatGPT fixed routes, title matching and fetch/XHR inspection with generic URL detection and passive learning from normal left-click navigation, without modifying page APIs.
- Store up to 500 learned destinations locally for 90 days, reject ambiguous mappings, and provide a context menu to forget mappings for a site.
- Ask once for explicit site-wide consent, saved per exact origin (scheme, hostname and port). Other eligible unknown controls on that site can then be discovered without another prompt. Check the grant before every discovery and provide a separate revocation menu.
- For authorized discovery, execute the left-click action, observe its destination, restore the source page, and open an adjacent background tab. Run persistence and source restoration concurrently, and use the learned URL directly on subsequent middle clicks.
- Fix New chat navigation from ChatGPT home by recognizing same-URL history pushes and verifying restoration to the original history entry. Ignore same-entry state updates and stale asynchronous observations.
- Distinguish equal control labels using stable section context, including ChatGPT's two New chat buttons. Keep indistinguishable controls blocked and preserve existing unambiguous mappings.
- Exclude SVG resources and global metadata, and bound URL detection to the clicked control to avoid opening icon assets or unrelated destinations.
- Keep the Codex mode initializer and the ChatGPT sidebar background-tab workaround as the remaining site-specific behavior.
- Add status feedback for cancellations, unsupported destinations, timeouts, permission failures and restoration errors.
- Add `storage` and `webNavigation` permissions, and expand regression coverage to 74 tests for navigation, persistence, consent, revocation, ambiguity and concurrency.

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
