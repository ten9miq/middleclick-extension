(() => {
  "use strict";

  if (window.__middleClickPlusChatGPTBridgeInstalled) return;
  Object.defineProperty(window, "__middleClickPlusChatGPTBridgeInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const SOURCE = "middleclick-plus-chatgpt-bridge-v1";
  const PROJECT_ID_RE = /^g-p-[0-9a-z-]+$/i;
  const CONVERSATION_ID_RE = /^[0-9a-f-]{20,}$/i;
  const cache = new Map();

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function routeFromValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const projectRoute = raw.match(/\/g\/(g-p-[0-9a-z-]+)\/project(?:[/?#]|$)/i);
    if (projectRoute) return `/g/${projectRoute[1]}/project`;

    const conversationRoute = raw.match(/\/c\/([0-9a-f-]{20,})(?:[/?#]|$)/i);
    if (conversationRoute) return `/c/${conversationRoute[1]}`;

    if (PROJECT_ID_RE.test(raw)) return `/g/${raw}/project`;
    if (CONVERSATION_ID_RE.test(raw)) return `/c/${raw}`;

    return null;
  }

  function emit(name, route) {
    name = normalizeText(name);
    route = routeFromValue(route);
    if (!name || name.length > 300 || !route) return;

    const key = `${name.toLocaleLowerCase()}\n${route}`;
    if (!cache.has(key)) cache.set(key, { name, route });

    window.postMessage({
      source: SOURCE,
      type: "mapping",
      name,
      url: route
    }, location.origin);
  }

  function inspectObject(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value !== "object" || depth > 12) return;
    if (seen.has(value)) return;
    seen.add(value);

    const title =
      value.display?.name ??
      value.title ??
      value.name ??
      value.conversation_title ??
      value.conversationTitle ??
      value.thread_title ??
      value.threadTitle ??
      value.project_name ??
      value.projectName ??
      null;

    if (typeof title === "string") {
      const ids = [
        value.id,
        value.conversation_id,
        value.conversationId,
        value.thread_id,
        value.threadId,
        value.project_id,
        value.projectId,
        value.gizmo_id,
        value.gizmoId
      ];

      for (const id of ids) {
        const route = routeFromValue(id);
        if (route) {
          emit(title, route);
          break;
        }
      }

      const routes = [
        value.href,
        value.url,
        value.path,
        value.route,
        value.permalink,
        value.conversation_url,
        value.conversationUrl,
        value.project_url,
        value.projectUrl
      ];

      for (const candidate of routes) {
        const route = routeFromValue(candidate);
        if (route) {
          emit(title, route);
          break;
        }
      }
    }

    for (const child of Object.values(value)) {
      try {
        inspectObject(child, depth + 1, seen);
      } catch {
        // Ignore malformed/unusual objects from host responses.
      }
    }
  }

  function inspectText(text) {
    if (!text) return;

    try {
      inspectObject(JSON.parse(text));
      return;
    } catch {
      // The response may be SSE; continue below.
    }

    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        inspectObject(JSON.parse(payload));
      } catch {
        // Ignore non-JSON SSE chunks.
      }
    }
  }

  function shouldInspectUrl(url) {
    const s = String(url ?? "");
    return (
      s.includes("/backend-api/sidebar/conversation") ||
      s.includes("/backend-api/conversations") ||
      s.includes("/backend-api/gizmos/snorlax/sidebar") ||
      /\/backend-api\/gizmos\/[^/?#]+\/conversations(?:[/?#]|$)/i.test(s) ||
      /\/backend-api\/(?:sidebar\/)?projects?(?:[/?#]|$)/i.test(s) ||
      /\/backend-api\/gizmos\/[^/?#]+\/sidebar(?:[/?#]|$)/i.test(s)
    );
  }

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await Reflect.apply(nativeFetch, this, args);

      try {
        const request = args[0];
        const url = typeof request === "string" ? request : request?.url ?? "";
        if (shouldInspectUrl(url)) {
          response.clone().text().then(inspectText).catch(() => {});
        }
      } catch {
        // Never affect ChatGPT's own fetch path.
      }

      return response;
    };
  }

  if (typeof window.XMLHttpRequest === "function") {
    const NativeXHR = window.XMLHttpRequest;
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__middleClickPlusUrl = String(url ?? "");
      } catch {
        // Ignore.
      }
      return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
    };

    NativeXHR.prototype.send = function (...args) {
      try {
        if (shouldInspectUrl(this.__middleClickPlusUrl)) {
          this.addEventListener("load", () => {
            try {
              if (typeof this.responseText === "string") inspectText(this.responseText);
            } catch {
              // Some response types do not expose responseText.
            }
          }, { once: true });
        }
      } catch {
        // Never affect ChatGPT's own XHR path.
      }

      return Reflect.apply(nativeSend, this, args);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== SOURCE || event.data?.type !== "ready") return;

    for (const entry of cache.values()) {
      window.postMessage({
        source: SOURCE,
        type: "mapping",
        name: entry.name,
        url: entry.route
      }, location.origin);
    }
  });
})();
