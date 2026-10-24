(function () {
  "use strict";
  let host;
  let timer;
  const messages = {
    checking: "移動先を確認しています。移動後に元のページへ戻ります。",
    opened: "元のページへ戻り、移動先を別タブで開きました。",
    unavailable: "この対象は自動学習できません。通常の左クリックを使ってください。",
    ambiguous: "移動先を一つに特定できません。自動クリックは行いません。",
    busy: "別の移動先を確認中です。完了後にもう一度操作してください。",
    "permission-required": "このサイトの自動学習許可がありません。もう一度操作して許可を確認してください。",
    "permission-save-failed": "このサイトの許可を保存できませんでした。対象のクリックは実行していません。",
    "permission-revoked": "このサイトの自動学習許可を取り消しました。学習済みのリンクは引き続き使えます。",
    "permission-revoke-failed": "このサイトの許可を取り消せませんでした。もう一度操作してください。",
    cancelled: "別の操作が行われたため、移動先の確認を中止しました。",
    "no-navigation": "URLの変化を検出できませんでした。この操作は自動学習できません。",
    "unsupported-destination": "元のページへ戻りました。別サイトや認証に関わる移動先は自動で開きません。",
    "restore-failed": "元のページへ戻れませんでした。タブの状態を確認してください。",
    "open-failed": "新しいタブを開けませんでした。タブの状態を確認してください。",
    "save-failed": "移動先を開きましたが、学習結果を保存できませんでした。",
    "navigation-failed": "ページ移動が完了しませんでした。タブの状態を確認してください。",
  };
  function hide() { clearTimeout(timer); host?.remove(); host = null; }
  function show(reason) {
    hide();
    if (!document.documentElement) return;
    host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ':host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:min(380px,calc(100vw - 40px));font:14px/1.6 system-ui,sans-serif;color:white}div{display:flex;gap:12px;padding:14px 16px;background:#242424;border-radius:10px;box-shadow:0 4px 20px #0005}button{align-self:flex-start;border:0;background:transparent;color:inherit;cursor:pointer;font:20px/1.2 system-ui;padding:0 2px}button:focus-visible{outline:2px solid white;outline-offset:3px}';
    const panel = document.createElement("div");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    const text = document.createElement("span");
    text.textContent = "MiddleClick+: " + (messages[reason] || messages.unavailable);
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "閉じる");
    close.textContent = "×";
    close.addEventListener("click", hide);
    panel.append(text, close);
    shadow.append(style, panel);
    document.documentElement.append(host);
    timer = setTimeout(hide, reason === "checking" ? 12000 : 7000);
  }
  globalThis.MiddleClickFeedback = Object.freeze({ show, hide });
})();
