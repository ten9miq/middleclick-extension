# MiddleClick+ local enhancements (1.1.0)

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
