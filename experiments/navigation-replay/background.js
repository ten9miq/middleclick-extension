"use strict";
globalThis.replayProbeResults = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "replayProbeOpen") return;
  const job = { sourceId: sender.tab?.id, started: Date.now(), phase: "starting" };
  replayProbeResults.push(job);
  (async () => {
    if (sender.frameId !== 0 || !sender.tab || sender.tab.incognito || !message.identity) throw new Error("Invalid source");
    const source = await chrome.tabs.get(sender.tab.id);
    if (source.url !== message.sourceUrl || new URL(source.url).origin !== "https://chatgpt.com") throw new Error("Source changed");
    const child = await chrome.tabs.create({ url: source.url, active: false, index: source.index + 1, openerTabId: source.id });
    job.childId = child.id;
    if (source.groupId >= 0) {
      await chrome.tabs.group({ groupId: source.groupId, tabIds: child.id });
      await chrome.tabs.move(child.id, { index: source.index + 1 });
    }
    job.phase = "loading";
    let loaded = false;
    for (let i = 0; i < 150; i++) {
      const state = await chrome.tabs.get(child.id);
      if (state.status === "complete") { loaded = true; break; }
      await delay(100);
    }
    if (!loaded) throw new Error("Child load timeout");
    job.phase = "replaying";
    job.result = await chrome.tabs.sendMessage(child.id, { type: "replayProbeRun", identity: message.identity, sourceUrl: source.url });
    if (!job.result?.ok) throw new Error(job.result?.error || "Replay failed");
    const afterSource = await chrome.tabs.get(source.id);
    const afterChild = await chrome.tabs.get(child.id);
    job.tabs = { source: { id: source.id, index: afterSource.index, active: afterSource.active, groupId: afterSource.groupId, url: afterSource.url },
      child: { id: child.id, index: afterChild.index, active: afterChild.active, groupId: afterChild.groupId, url: afterChild.url } };
    job.phase = "complete";
    job.elapsedMs = Date.now() - job.started;
    return { ok: true, childId: child.id };
  })().then(respond, error => { job.phase = "failed"; job.error = String(error); respond({ ok: false, error: job.error }); });
  return true;
});
