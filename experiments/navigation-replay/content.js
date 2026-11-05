"use strict";
const normalize = text => String(text || "").replace(/\s+/g, " ").trim();
const allowedControl = control => control?.tagName === "BUTTON" &&
  /(?:で新しいチャット$|^New chat in .+)/i.test(control.getAttribute("aria-label") || "") &&
  !control.closest("form") && !control.form && !control.disabled && !control.hasAttribute("aria-haspopup");

// Generic identity: semantic control label plus stable ancestor data IDs.
// No route construction, project-name lookup table, or learned destination.
function identity(control) {
  const owners = [];
  for (let parent = control.parentElement, depth = 0; parent && depth < 20; parent = parent.parentElement, depth++) {
    const ids = [...parent.attributes].filter(a => /^data-(?:[a-z0-9]+-)*(?:id|key)$/i.test(a.name) &&
      !/^data-(?:test|radix|react)/i.test(a.name) && a.value && a.value.length < 180).map(a => [a.name, a.value]);
    if (ids.length) owners.push(ids.sort((a, b) => a[0].localeCompare(b[0])));
    if (/^(NAV|ASIDE|BODY)$/.test(parent.tagName)) break;
  }
  return JSON.stringify([control.tagName, normalize(control.getAttribute("aria-label")), owners]);
}

let previous = { target: null, at: 0 };
for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]) {
  window.addEventListener(type, event => {
    if (event.button !== 1 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const control = event.composedPath().find(el => el instanceof Element && el.matches("button"));
    if (!allowedControl(control)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (type !== "pointerdown") return;
    if (previous.target === control && Date.now() - previous.at < 250) return;
    previous = { target: control, at: Date.now() };
    void chrome.runtime.sendMessage({ type: "replayProbeOpen", sourceUrl: location.href, identity: identity(control) });
  }, true);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "replayProbeRun" || sender.id !== chrome.runtime.id) return;
  (async () => {
    if (location.href !== message.sourceUrl) throw new Error("Child source URL differs");
    let target;
    let attempts = 0;
    for (; attempts < 150; attempts++) {
      const matches = [...document.querySelectorAll("button")].filter(allowedControl).filter(el => identity(el) === message.identity);
      if (matches.length > 1) throw new Error("Ambiguous control");
      if (matches.length === 1 && document.readyState === "complete") { target = matches[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!target) throw new Error("Target not found");
    const before = location.href;
    target.click();
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { ok: true, clickCount: 1, attempts, before, after: location.href,
      visibleTextboxes: [...document.querySelectorAll('[role="textbox"]')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.getAttribute("aria-label")) };
  })().then(respond, error => respond({ ok: false, error: String(error) }));
  return true;
});
