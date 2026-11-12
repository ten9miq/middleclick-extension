(function () {
  "use strict";

  function install({ chrome, adopt, navigate, cancelPassive = () => {} }) {
    const pending = new Map();
    function remove(record) {
      if (pending.get(record.sourceTab.id) !== record) return;
      clearTimeout(record.timer);
      clearTimeout(record.settle);
      pending.delete(record.sourceTab.id);
    }
    function feedback(record, reason) {
      void chrome.tabs.sendMessage(record.sourceTab.id,
        { type: 'driveOpenFeedback', requestId: record.requestId, reason }, { frameId: 0 }).catch(() => {});
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!['beginDriveDefaultOpen', 'cancelDriveDefaultOpen'].includes(message?.type)) return;
      if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0) { respond({ ok: false }); return; }
      let source;
      try { source = new URL(sender.url); } catch { respond({ ok: false }); return; }
      if (source.origin !== 'https://drive.google.com' || !/^\/drive(?:\/|$)/.test(source.pathname)) {
        respond({ ok: false }); return;
      }
      const previous = pending.get(sender.tab.id);
      if (message.type === 'cancelDriveDefaultOpen') {
        if (previous?.requestId === message.requestId) remove(previous);
        respond({ ok: true }); return;
      }
      if (previous) { respond({ ok: false, reason: 'drive-registration-busy' }); return; }
      if (message.sourceUrl !== source.href) {
        respond({ ok: false, reason: 'drive-registration-stale-source' }); return;
      }
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(message.itemId || '') ||
        typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) {
        respond({ ok: false }); return;
      }
      if (message.entryKey !== undefined && (typeof message.entryKey !== 'string' || message.entryKey.length > 200)) {
        respond({ ok: false }); return;
      }
      const record = { sourceTab: sender.tab, sourceUrl: source.href, requestId: message.requestId,
        entryKey: message.entryKey || '', phase: 'observing' };
      record.timer = setTimeout(() => { remove(record); feedback(record, 'drive-open-timeout'); }, 10000);
      pending.set(sender.tab.id, record);
      cancelPassive(`${sender.tab.id}:0`);
      respond({ ok: true });
    });
    chrome.tabs.onCreated.addListener(tab => {
      const record = pending.get(tab.openerTabId);
      if (!record || record.phase !== 'observing' || tab.windowId !== record.sourceTab.windowId || !Number.isInteger(tab.id)) return;
      remove(record); // Adopt Drive's tab once; never manufacture a fallback URL/tab.
      Promise.resolve().then(() => adopt(tab, record)).then(
        () => feedback(record, 'drive-opened'),
        () => feedback(record, 'drive-open-failed'));
    });
    function observe(details) {
      const record = pending.get(details.tabId);
      if (!record || record.phase !== 'observing' || details.frameId !== 0 || details.url === record.sourceUrl) return;
      let destination;
      try { destination = new URL(details.url); } catch { return; }
      if (!/^https?:$/.test(destination.protocol)) return;
      clearTimeout(record.settle);
      record.settle = setTimeout(async () => {
        if (pending.get(details.tabId) !== record) return;
        record.phase = 'restoring';
        try {
          await navigate(record, destination.href, () => pending.get(details.tabId) === record);
          if (pending.get(details.tabId) !== record) return;
          remove(record); feedback(record, 'drive-opened');
        } catch {
          if (pending.get(details.tabId) !== record) return;
          remove(record); feedback(record, 'drive-open-failed');
        }
      }, 300);
    }
    chrome.webNavigation.onHistoryStateUpdated.addListener(observe);
    chrome.webNavigation.onCommitted.addListener(observe);
    chrome.tabs.onRemoved.addListener(tabId => {
      const record = pending.get(tabId);
      if (record) remove(record);
    });
  }
  globalThis.MiddleClickDrive = Object.freeze({ install });
})();
