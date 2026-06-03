// Bridges window.postMessage <-> chrome.runtime messaging.
// The page sends: window.postMessage({ source: "local-llm-page", action, payload, requestId }, "*")
// The page receives: window.postMessage({ source: "local-llm-bridge", requestId, ... }, "*")

function bridgeAlive() {
  // chrome.runtime.id becomes undefined once the extension context is
  // invalidated (extension was reloaded/updated/disabled while this page
  // kept the old content script in memory).
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
  catch (_) { return false; }
}

function notifyDead(requestId) {
  window.postMessage({
    source: "local-llm-bridge",
    requestId,
    ok: false,
    error: "Extension was reloaded — please refresh this page (F5).",
    contextInvalidated: true
  }, "*");
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "local-llm-page") return;

  const { action, payload, requestId } = data;

  if (!bridgeAlive()) { notifyDead(requestId); return; }

  try {
    chrome.runtime.sendMessage(
      { target: "local-llm-bridge", action, payload, requestId },
      (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          window.postMessage({
            source: "local-llm-bridge",
            requestId,
            ok: false,
            error: err.message,
            contextInvalidated: /context invalidated|Receiving end does not exist/i.test(err.message)
          }, "*");
          return;
        }
        if (action !== "stream") {
          window.postMessage({ source: "local-llm-bridge", requestId, ...resp }, "*");
        } else {
          window.postMessage({
            source: "local-llm-bridge",
            requestId,
            ok: resp && resp.ok,
            error: resp && resp.error,
            streamStarted: true
          }, "*");
        }
      }
    );
  } catch (_) {
    notifyDead(requestId);
  }
});

// Stream chunks from background -> page
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== "local-llm-bridge-page") return;
    // Outbound WS relay: background asks the page to forward a JSON message
    // over its open WebSocket (used by handle_token_generation to send chunks
    // and the final response back to the server).
    if (msg.wsSend) {
      window.postMessage({ source: "local-llm-bridge", wsSend: msg.wsSend }, "*");
      return;
    }
    window.postMessage({
      source: "local-llm-bridge",
      requestId: msg.requestId,
      chunk: msg.chunk,
      done: msg.done,
      error: msg.error,
      status: msg.status,
      streaming: true
    }, "*");
  });
} catch (_) { /* context already dead */ }

// Page-originated server events forwarded to the extension (e.g. the
// serverless-llm-api page posts {source: "local-llm-page-event", type: "token_generate", payload}).
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "local-llm-page-event") return;
  if (!bridgeAlive()) return;
  try {
    chrome.runtime.sendMessage({
      target: "local-llm-bridge",
      action: "server_event",
      eventType: data.type,
      payload: data.payload
    });
  } catch (_) { /* context dead */ }
});

// Announce presence so pages can detect the extension.
if (bridgeAlive()) {
  window.postMessage({ source: "local-llm-bridge", ready: true }, "*");
}
