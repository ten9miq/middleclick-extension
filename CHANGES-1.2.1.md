# Changes in 1.2.1

- Keep middle-click-created ChatGPT sidebar tabs in the background (`active: false`).
- Prevent ChatGPT/native sidebar handlers from winning the middle-click race and creating a foreground tab.
- Preserve insertion immediately to the right of the source tab.
- Preserve the ChatGPT conversation/project URL resolution improvements from 1.2.0.
- Leave ordinary native links on other sites to Chrome as before.
- Remove fallback tab requests for native links to prevent duplicates when destination URLs change through redirects (for example, Gmail links).
