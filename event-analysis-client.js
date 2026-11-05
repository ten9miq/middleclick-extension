(function () {
  'use strict';
  const QUERY = 'middleclick-plus:event-query:v1', REPLY = 'middleclick-plus:event-reply:v1';
  let sequence = 0;
  function resolve(control, sourceUrl) {
    if (window !== top || chrome.extension?.inIncognitoContext || typeof CustomEvent !== 'function' || !control?.isConnected) return Promise.resolve(null);
    return new Promise(done => {
      const id = Date.now() + ':' + (++sequence);
      const finish = url => { clearTimeout(timer); document.removeEventListener(REPLY, receive, true); done(url); };
      const receive = event => {
        if (event.target !== control) return;
        let response;
        try { response = JSON.parse(event.detail); } catch { return; }
        if (response?.id !== id || response.sourceUrl !== sourceUrl || location.href !== sourceUrl) return;
        const url = MiddleClickLearning.learnableUrl(response.url);
        finish(url?.origin === location.origin ? url.href : null);
      };
      const timer = setTimeout(() => finish(null), 1500);
      document.addEventListener(REPLY, receive, true);
      control.dispatchEvent(new CustomEvent(QUERY, { bubbles: true, detail: JSON.stringify({ id, sourceUrl }) }));
    });
  }
  globalThis.MiddleClickEventClient = Object.freeze({ resolve });
})();
