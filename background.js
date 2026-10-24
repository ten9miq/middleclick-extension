"use strict";

importScripts("navigation-learning.js");
importScripts("navigation-probe.js");

function setupContextMenu() {
  chrome.contextMenus.create({ id: "openInNewTab", title: "New Tab", contexts: ["all"] });
  chrome.contextMenus.create({ id: "openInNewWindow", title: "New Window", contexts: ["all"] });
  chrome.contextMenus.create({ id: "forgetLearnedNavigation", title: "Forget learned destinations for this site", contexts: ["all"] });
}

chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.removeAll(setupContextMenu));

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "forgetLearnedNavigation") {
    const origin = MiddleClickLearning.webUrl(info.frameUrl || info.pageUrl)?.origin;
    if (origin) {
      navigationProbes.cancelOrigin(origin);
      for (const [key, pending] of LEARNING_CLICKS) if (pending.origin === origin) cancelLearning(key);
      updateLearning(entries => entries.filter(entry => entry.origin !== origin));
    }
    return;
  }
  const newUrl = info.linkUrl || info.pageUrl;
  if (!newUrl) return;
  if (info.menuItemId === "openInNewTab") chrome.tabs.create({ url: newUrl, active: true });
  if (info.menuItemId === "openInNewWindow") chrome.windows.create({ url: newUrl, focused: true });
});

const PENDING = new Map();
const WINDOW_MS = 240;
let pendingSequence = 0;

const LEARNING_CLICKS = new Map();
const LEARNING_WINDOW_MS = 2500;
let learningWrites = Promise.resolve();

function updateLearning(transform) {
  learningWrites = learningWrites.then(async () => {
    const { STORAGE_KEY, clean } = MiddleClickLearning;
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const entries = transform(clean(data[STORAGE_KEY]));
    await chrome.storage.local.set({ [STORAGE_KEY]: { version: 1, entries } });
    return true;
  }).catch(error => { console.warn("MiddleClick+: could not save learned destinations.", error); return false; });
  return learningWrites;
}

function cancelLearning(key) {
  const pending = LEARNING_CLICKS.get(key);
  if (!pending) return;
  clearTimeout(pending.expiry);
  clearTimeout(pending.settle);
  LEARNING_CLICKS.delete(key);
}

function observeNavigation(details, committed = false) {
  const key = `${details.tabId}:${details.frameId}`;
  const pending = LEARNING_CLICKS.get(key);
  if (!pending || Date.now() - pending.startedAt > LEARNING_WINDOW_MS) return;
  if (committed && /^(typed|auto_bookmark|reload|form_submit)$/.test(details.transitionType || "")) {
    cancelLearning(key);
    return;
  }
  if (!committed && pending.documentId && details.documentId && pending.documentId !== details.documentId) return;
  if (committed) pending.documentId = details.documentId;
  const destination = MiddleClickLearning.learnableUrl(details.url);
  if (!destination || destination.origin !== pending.origin) { cancelLearning(key); return; }
  if (destination.href === pending.sourceUrl) return;
  if (details.transitionQualifiers?.includes("forward_back")) { cancelLearning(key); return; }
  clearTimeout(pending.settle);
  pending.settle = setTimeout(() => {
    if (LEARNING_CLICKS.get(key) !== pending) return;
    updateLearning(entries => MiddleClickLearning.remember(entries, pending.origin, pending.key, destination.href));
  }, 300);
}

chrome.webNavigation.onHistoryStateUpdated.addListener(details => observeNavigation(details));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => observeNavigation(details));
chrome.webNavigation.onCommitted.addListener(details => observeNavigation(details, true));
chrome.webNavigation.onErrorOccurred.addListener(details => cancelLearning(`${details.tabId}:${details.frameId}`));
chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of LEARNING_CLICKS.keys()) if (key.startsWith(`${tabId}:`)) cancelLearning(key);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "observeNavigationClick" && message?.type !== "cancelNavigationLearning") return;
  if (!Number.isInteger(sender.tab?.id)) return;
  const key = `${sender.tab.id}:${sender.frameId ?? 0}`;
  cancelLearning(key);
  if (message.type === "cancelNavigationLearning" || sender.tab.incognito) return;
  const source = MiddleClickLearning.learnableUrl(message.sourceUrl);
  const documentUrl = MiddleClickLearning.webUrl(sender.url);
  if (!source || !documentUrl || source.origin !== documentUrl.origin) return;
  if (typeof message.key !== "string" || !message.key || message.key.length > 2048) return;
  const pending = { key: message.key, sourceUrl: source.href, origin: source.origin,
    documentId: sender.documentId, startedAt: Date.now(), settle: null };
  pending.expiry = setTimeout(() => cancelLearning(key), LEARNING_WINDOW_MS);
  LEARNING_CLICKS.set(key, pending);
});

function normalize(url) {
  try {
    return new URL(url).href;
  } catch {
    return url || "";
  }
}

async function inheritSourceTabGroup(createdTab, sourceTab) {
  if (createdTab?.id === undefined || sourceTab?.id === undefined) return;

  try {
    // Read after creation: the source may have changed groups or disappeared.
    const source = await chrome.tabs.get(sourceTab.id);
    if (!Number.isInteger(source.groupId) || source.groupId < 0) return;
    if (createdTab.windowId !== source.windowId) return;

    await chrome.tabs.group({ groupId: source.groupId, tabIds: createdTab.id });

    // Grouping can reposition the tab. Restore adjacency within the group.
    const [currentSource, currentTab] = await Promise.all([
      chrome.tabs.get(source.id),
      chrome.tabs.get(createdTab.id)
    ]);
    if (currentSource.groupId !== source.groupId || currentTab.groupId !== source.groupId) return;
    if (currentSource.windowId !== currentTab.windowId) return;
    const index = currentSource.index + (currentTab.index < currentSource.index ? 0 : 1);
    if (currentTab.index !== index) await chrome.tabs.move(createdTab.id, { index });
  } catch (error) {
    // Never retry tab creation when grouping fails: that would open duplicates.
    console.warn("MiddleClick+: could not inherit source tab group.", error);
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

  let createdTab;
  try {
    createdTab = await chrome.tabs.create(createProperties);
  } catch {
    // openerTabId can fail if the source tab closed between tabs.get() and create().
    // Retry without opener/index rather than dropping the requested tab entirely.
    const fallback = { url, active: false };
    if (sourceTab?.windowId !== undefined) fallback.windowId = sourceTab.windowId;
    createdTab = await chrome.tabs.create(fallback);
  }

  await inheritSourceTabGroup(createdTab, sourceTab);
  return createdTab;
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

const navigationProbes = MiddleClickProbe.install({ chrome, learning: MiddleClickLearning, save: updateLearning,
  open: createBackgroundTabNextToSource, cancelPassive: cancelLearning });
