"use strict";

function setupContextMenu() {
  chrome.contextMenus.create({ id: "openInNewTab", title: "New Tab", contexts: ["all"] });
  chrome.contextMenus.create({ id: "openInNewWindow", title: "New Window", contexts: ["all"] });
}

chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.removeAll(setupContextMenu));

chrome.contextMenus.onClicked.addListener((info) => {
  const newUrl = info.linkUrl || info.pageUrl;
  if (!newUrl) return;
  if (info.menuItemId === "openInNewTab") chrome.tabs.create({ url: newUrl, active: true });
  if (info.menuItemId === "openInNewWindow") chrome.windows.create({ url: newUrl, focused: true });
});

const PENDING = new Map();
const WINDOW_MS = 240;
let pendingSequence = 0;

function normalize(url) {
  try {
    return new URL(url).href;
  } catch {
    return url || "";
  }
}

async function createBackgroundTabNextToSource(url, sourceTab) {
  const createProperties = { url, active: false };

  if (sourceTab?.id !== undefined) {
    let currentSource = sourceTab;

    // The source tab may have moved during the short deduplication window.
    try {
      currentSource = await chrome.tabs.get(sourceTab.id);
    } catch {
      // If it disappeared, fall back to the sender snapshot where possible.
    }

    if (currentSource?.windowId !== undefined) {
      createProperties.windowId = currentSource.windowId;
    }
    if (Number.isInteger(currentSource?.index)) {
      createProperties.index = currentSource.index + 1;
    }
    if (currentSource?.id !== undefined) {
      createProperties.openerTabId = currentSource.id;
    }
  }

  try {
    return await chrome.tabs.create(createProperties);
  } catch {
    // openerTabId can fail if the source tab closed between tabs.get() and create().
    // Retry without opener/index rather than dropping the requested tab entirely.
    const fallback = { url, active: false };
    if (sourceTab?.windowId !== undefined) fallback.windowId = sourceTab.windowId;
    return chrome.tabs.create(fallback);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "maybeOpenOnMiddle" || !msg.url) return;

  const id = `${++pendingSequence}:${msg.requestId || ""}`;
  const record = {
    id,
    url: msg.url,
    normalizedUrl: normalize(msg.url),
    sourceTab: sender.tab || null,
    sourceTabId: sender.tab?.id,
    windowId: sender.tab?.windowId,
    createdAt: Date.now(),
    opening: false,
    timer: null
  };

  record.timer = setTimeout(async () => {
    const current = PENDING.get(id);
    if (!current) return;

    current.opening = true;
    try {
      await createBackgroundTabNextToSource(current.url, current.sourceTab);
    } finally {
      PENDING.delete(id);
    }
  }, WINDOW_MS);

  PENDING.set(id, record);
  sendResponse?.({ ok: true });
});

chrome.tabs.onCreated.addListener((tab) => {
  const created = normalize(tab.pendingUrl || tab.url || "");
  if (!created) return;

  // Cancel exactly one matching fallback. This preserves intentional rapid
  // double-middle-clicks while still preventing native/site-created duplicates.
  let best = null;
  for (const record of PENDING.values()) {
    if (record.opening) continue;
    if (record.normalizedUrl !== created) continue;
    if (record.windowId !== undefined && tab.windowId !== record.windowId) continue;
    if (!best || record.createdAt < best.createdAt) best = record;
  }

  if (!best) return;
  clearTimeout(best.timer);
  PENDING.delete(best.id);
});
