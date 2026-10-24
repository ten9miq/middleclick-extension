(function () {
  "use strict";

  function install({ chrome, learning, save, open, cancelPassive }) {
    const pending = new Map();

    function tell(tabId, message) {
      return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});
    }
    function feedback(tabId, reason) { void tell(tabId, { type: "navigationProbeFeedback", reason }); }
    function remove(record) {
      if (pending.get(record.tabId) !== record) return;
      clearTimeout(record.expiry);
      clearTimeout(record.settle);
      pending.delete(record.tabId);
    }
    async function waitForSource(record, attempts, requireEntry = Boolean(record.entryKey)) {
      for (let attempt = 0; attempt < attempts && pending.get(record.tabId) === record; attempt++) {
        try {
          if ((await chrome.tabs.get(record.tabId)).url === record.sourceUrl) {
            if (!requireEntry) return true;
            const current = await tell(record.tabId, { type: "readConfirmedNavigationEntry" });
            if (current?.url === record.sourceUrl && current.entryKey === record.entryKey) return true;
          }
        }
        catch { return false; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    }
    async function restore(record) {
      const response = await tell(record.tabId, { type: "restoreConfirmedNavigationProbe",
        entryKey: record.entryKey, sourceUrl: record.sourceUrl });
      if (response?.traversing && await waitForSource(record, 15)) return true;
      if (pending.get(record.tabId) !== record) return false;
      // Replacement navigation may have removed the source history entry.
      await chrome.tabs.update(record.tabId, { url: record.sourceUrl });
      return waitForSource(record, 100, false);
    }
    async function finish(record) {
      if (pending.get(record.tabId) !== record || record.phase !== "observing") return;
      record.phase = "restoring";
      clearTimeout(record.expiry);
      clearTimeout(record.settle);
      try {
        // Storage I/O and source restoration are independent. Start both now;
        // opening depends only on a verified return to the source, not disk I/O.
        const saved = record.failure ? Promise.resolve(true) :
          Promise.resolve(save(entries => learning.remember(entries, record.origin, record.key, record.destination)))
            .then(result => result !== false, () => false);
        const restored = await restore(record).catch(() => false);
        if (pending.get(record.tabId) !== record) return;
        if (!restored) { remove(record); feedback(record.tabId, "restore-failed"); return; }
        if (record.failure) { remove(record); feedback(record.tabId, record.failure); return; }
        // Make the new mapping immediately usable in the restored page while
        // the durable write completes. The storage event remains authoritative.
        await tell(record.tabId, { type: "navigationProbeLearned", key: record.key, destination: record.destination });
        if (pending.get(record.tabId) !== record) return;
        remove(record); // One shot, including when tab creation fails.
        await open(record.destination, record.sourceTab);
        feedback(record.tabId, "opened");
        void saved.then(ok => { if (!ok) feedback(record.tabId, "save-failed"); });
      } catch {
        remove(record);
        feedback(record.tabId, "open-failed");
      }
    }
    function settle(record, url) {
      const destination = learning.learnableUrl(url);
      record.destination = destination?.href;
      record.failure = !destination || destination.origin !== record.origin ? "unsupported-destination" : null;
      clearTimeout(record.settle);
      record.settle = setTimeout(() => { void finish(record); }, 300);
    }
    function observe(details, committed = false) {
      if (details.frameId !== 0) return;
      const record = pending.get(details.tabId);
      if (!record || record.phase !== "observing") return;
      if (details.transitionQualifiers?.includes("forward_back") ||
        (committed && /^(typed|auto_bookmark|reload|form_submit)$/.test(details.transitionType || ""))) {
        remove(record); feedback(record.tabId, "cancelled"); return;
      }
      if (!committed && record.documentId && details.documentId && record.documentId !== details.documentId) return;
      if (committed) record.documentId = details.documentId;
      const observation = record.observation = (record.observation || 0) + 1;
      if (details.url === record.sourceUrl) {
        // Routers can push a new history entry without changing the URL.
        // Require a different entry key; unrelated same-entry state updates
        // must not turn an unresolved click into a duplicate of the page.
        if (!record.entryKey) return;
        void tell(record.tabId, { type: "readConfirmedNavigationEntry" }).then(current => {
          if (pending.get(record.tabId) !== record || record.phase !== "observing" || record.observation !== observation) return;
          if (current?.url === record.sourceUrl && current.entryKey && current.entryKey !== record.entryKey) {
            settle(record, details.url);
          }
        });
        return;
      }
      settle(record, details.url);
    }
    chrome.webNavigation.onHistoryStateUpdated.addListener(details => observe(details));
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => observe(details));
    chrome.webNavigation.onCommitted.addListener(details => observe(details, true));
    chrome.webNavigation.onErrorOccurred.addListener(details => {
      const record = details.frameId === 0 && pending.get(details.tabId);
      if (record?.phase === "observing") { remove(record); feedback(record.tabId, "navigation-failed"); }
    });
    chrome.tabs.onRemoved.addListener(tabId => { const record = pending.get(tabId); if (record) remove(record); });

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type === "cancelNavigationLearning" || message?.type === "observeNavigationClick") {
        const record = sender.frameId === 0 && pending.get(sender.tab?.id);
        if (record) { remove(record); feedback(record.tabId, "cancelled"); }
        return;
      }
      if (message?.type !== "beginConfirmedNavigationProbe") return;
      const source = learning.learnableUrl(message.sourceUrl);
      const document = learning.webUrl(sender.url);
      if (message.confirmed !== true || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || sender.tab.incognito ||
        !source || source.origin !== document?.origin || typeof message.key !== "string" ||
        !message.key || message.key.length > 2048 || typeof message.entryKey !== "string") {
        respond({ ok: false, reason: "unavailable" }); return;
      }
      if (pending.has(sender.tab.id)) { respond({ ok: false, reason: "busy" }); return; }
      const record = { tabId: sender.tab.id, sourceTab: sender.tab, sourceUrl: source.href,
        origin: source.origin, key: message.key, entryKey: message.entryKey,
        documentId: sender.documentId, phase: "checking" };
      pending.set(record.tabId, record);
      chrome.storage.local.get(learning.STORAGE_KEY).then(data => {
        if (pending.get(record.tabId) !== record) { respond({ ok: false, reason: "cancelled" }); return; }
        const entries = learning.clean(data[learning.STORAGE_KEY]);
        if (entries.some(entry => entry.origin === record.origin && entry.key === record.key && entry.ambiguous)) {
          remove(record); respond({ ok: false, reason: "ambiguous" }); return;
        }
        cancelPassive(`${record.tabId}:0`);
        record.phase = "observing";
        record.expiry = setTimeout(() => {
          if (record.destination || record.failure) void finish(record);
          else { remove(record); feedback(record.tabId, "no-navigation"); }
        }, 10000);
        respond({ ok: true });
      }).catch(() => { remove(record); respond({ ok: false, reason: "unavailable" }); });
      return true;
    });
    return {
      cancelOrigin(origin) {
        for (const record of pending.values()) if (record.origin === origin) {
          remove(record); feedback(record.tabId, "cancelled");
        }
      },
    };
  }
  globalThis.MiddleClickProbe = Object.freeze({ install });
})();
