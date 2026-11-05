# Acorn 8.18.0

Pinned, bundled JavaScript parser, MIT licensed. Source project:
https://github.com/acornjs/acorn

`acorn.js` was copied from this environment's Node.js bundled Acorn 8.18.0
(`internal/deps/acorn/acorn/dist/acorn`) and enclosed in a small local wrapper.
The wrapper prevents a page's AMD/CommonJS globals from selecting the parser's
export target. It exposes `MiddleClickAcorn` in the MAIN world and CommonJS
exports in Node tests. No parser or executable code is downloaded at runtime.

See `LICENSE`. The parser processes site JavaScript as data; application
functions and downloaded JavaScript are never evaluated by the analyzer.
