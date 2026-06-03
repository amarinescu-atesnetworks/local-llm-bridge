const DEFAULT_BASE = "http://localhost:11434";
const BASE_KEY = "ollamaBaseUrl";
const LOG = (...a) => console.log("[local-llm-bridge]", ...a);
const LOGE = (...a) => console.error("[local-llm-bridge]", ...a);

let _reqCounter = 0;
const nextId = () => `#${++_reqCounter}`;

// Resolve the configured Ollama base URL from storage, falling back to the
// default. Trailing slashes are trimmed so callers can append "/api/...".
async function getBase() {
  try {
    const { [BASE_KEY]: v } = await chrome.storage.local.get(BASE_KEY);
    const url = (v && String(v).trim()) || DEFAULT_BASE;
    return url.replace(/\/+$/, "");
  } catch (_) {
    return DEFAULT_BASE;
  }
}

// declarativeNetRequest strips the Origin header so Ollama doesn't reject the
// request as cross-origin. The static rules.json only covers the localhost
// default; this dynamic rule re-targets whatever host the user configures.
const ORIGIN_RULE_ID = 1001;
async function syncOriginRule() {
  const base = await getBase();
  let urlFilter;
  try {
    const u = new URL(base);
    urlFilter = `|${u.protocol}//${u.host}/`;
  } catch (e) {
    LOGE("syncOriginRule: invalid base URL", base, e);
    return;
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ORIGIN_RULE_ID],
      addRules: [{
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "origin", operation: "remove" }]
        },
        condition: { urlFilter, resourceTypes: ["xmlhttprequest"] }
      }]
    });
    LOG("origin-strip rule synced for", urlFilter);
  } catch (e) {
    LOGE("syncOriginRule failed", e);
  }
}

// Keep the dynamic rule in step with the configured base URL.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[BASE_KEY]) syncOriginRule();
});
syncOriginRule();

// Quick reachability probe against the local LLM HTTP API.
// Aborts after 3s so a stalled connection doesn't keep the UI in limbo.
async function health() {
  const base = await getBase();
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    return {
      reachable: res.ok,
      httpStatus: res.status,
      latencyMs: Math.round(performance.now() - t0)
    };
  } catch (e) {
    return {
      reachable: false,
      error: e.name === "AbortError" ? "timeout" : String(e.message || e),
      latencyMs: Math.round(performance.now() - t0)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function listModels() {
  const base = await getBase();
  const id = nextId();
  LOG(id, "→ GET /api/tags");
  const t0 = performance.now();
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) {
    LOGE(id, `← ${res.status}`);
    throw new Error(`LLM /api/tags ${res.status}`);
  }
  const data = await res.json();
  const models = (data.models || []).map(m => m.name);
  LOG(id, `← ${res.status} in ${Math.round(performance.now() - t0)}ms`, models);
  return models;
}

async function generate({ model, prompt, system }) {
  const base = await getBase();
  const id = nextId();
  const body = {
    model: model || "qwen3:14b",
    prompt,
    stream: false,
    ...(system ? { system } : {})
  };
  LOG(id, "→ POST /api/generate", body);
  const t0 = performance.now();
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    LOGE(id, `← ${res.status}`, text);
    throw new Error(`LLM /api/generate ${res.status}: ${text}`);
  }
  const data = await res.json();
  LOG(id, `← ${res.status} in ${Math.round(performance.now() - t0)}ms`, {
    eval_count: data.eval_count,
    eval_duration_ms: data.eval_duration ? Math.round(data.eval_duration / 1e6) : undefined,
    response_preview: (data.response || "").slice(0, 200) + ((data.response || "").length > 200 ? "…" : "")
  });
  LOG(id, "full response:", data.response);
  return data.response;
}

async function streamGenerate({ model, prompt, system, signal }, onChunk, onStatus) {
  const base = await getBase();
  const id = nextId();
  const body = {
    model: model || "qwen3:14b",
    prompt,
    stream: true,
    ...(system ? { system } : {})
  };
  LOG(id, "→ POST /api/generate (stream)", body);
  const t0 = performance.now();
  onStatus && onStatus({ phase: "sending", message: "sending request to LLM…" });
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const text = await res.text();
    LOGE(id, `← ${res.status}`, text);
    throw new Error(`LLM /api/generate ${res.status}: ${text}`);
  }
  LOG(id, `← ${res.status} streaming… (HTTP open in ${Math.round(performance.now() - t0)}ms)`);
  onStatus && onStatus({
    phase: "waiting_first_token",
    message: "connected — model loading / processing prompt…",
    httpOpenMs: Math.round(performance.now() - t0)
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let chunkCount = 0;
  let accumulated = "";
  let firstTokenAt = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.response) {
          if (firstTokenAt === null) {
            firstTokenAt = performance.now();
            LOG(id, `first token in ${Math.round(firstTokenAt - t0)}ms`);
            onStatus && onStatus({
              phase: "streaming",
              message: "streaming tokens…",
              firstTokenMs: Math.round(firstTokenAt - t0)
            });
          }
          chunkCount++;
          accumulated += evt.response;
          onChunk(evt.response, false);
        }
        if (evt.done) {
          const totalMs = Math.round(performance.now() - t0);
          const tokSec = evt.eval_count && evt.eval_duration
            ? +(evt.eval_count / (evt.eval_duration / 1e9)).toFixed(1)
            : null;
          LOG(id, `← stream done in ${totalMs}ms, ${chunkCount} chunks`, {
            eval_count: evt.eval_count,
            eval_duration_ms: evt.eval_duration ? Math.round(evt.eval_duration / 1e6) : undefined,
            tok_per_sec: tokSec
          });
          LOG(id, "full response:", accumulated);
          onStatus && onStatus({
            phase: "done",
            message: "done",
            totalMs,
            evalCount: evt.eval_count,
            tokPerSec: tokSec
          });
          onChunk("", true);
        }
      } catch (e) {
        LOGE(id, "JSON parse error on line:", line, e);
      }
    }
  }
}

const TOKEN_GENERATE_MODEL = "qwen3:14b";

// Two-phase timeouts. Video memory is shared with other GPU users, so a cold
// model load (qwen3:14b ≈ 9 GB) can take ~30 s before Ollama emits its first
// token. After the first token the model is resident and tokens should arrive
// steadily; a long gap then means Ollama got stuck.
const FIRST_TOKEN_TIMEOUT_MS = 300_000;  // cold-start budget (load + first token)
const STREAM_IDLE_TIMEOUT_MS = 30_000;   // max gap between tokens once streaming

// Server-pushed token_generate handler:
// Stream a completion from the local LLM for `payload.prompt`, accumulate the
// full response internally, and emit a single terminal message to the server:
//   {type:"token_generate_response", id, done:true, response, evalCount, tokPerSec, totalMs, ts}
// On failure or timeout the same envelope carries an `error` field instead of `response`.
// Per-token chunks are NOT forwarded to the server.
async function handle_token_generation(payload, tabId) {
  const id = payload && payload.id;
  const prompt = payload && payload.prompt;
  LOG("token_generate from server", { id, prompt, tabId });
  if (tabId == null) {
    LOGE("token_generate: no tabId — cannot route response back to server");
    return;
  }

  const wsSend = (obj) => {
    chrome.tabs.sendMessage(tabId, { target: "local-llm-bridge-page", wsSend: obj });
  };

  const ctrl = new AbortController();
  let firstTokenSeen = false;
  let timeoutReason = null;

  const firstTokenTimer = setTimeout(() => {
    if (firstTokenSeen) return;
    timeoutReason = `timeout: no first token within ${FIRST_TOKEN_TIMEOUT_MS / 1000}s (Ollama did not respond — model likely failed to load)`;
    LOGE("token_generate", timeoutReason);
    ctrl.abort();
  }, FIRST_TOKEN_TIMEOUT_MS);

  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutReason = `timeout: stream idle for ${STREAM_IDLE_TIMEOUT_MS / 1000}s (Ollama stalled mid-generation)`;
      LOGE("token_generate", timeoutReason);
      ctrl.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  let accumulated = "";
  let evalCount, tokPerSec, totalMs;
  try {
    await streamGenerate(
      { model: TOKEN_GENERATE_MODEL, prompt, signal: ctrl.signal },
      (chunk, done) => {
        if (chunk) {
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            clearTimeout(firstTokenTimer);
          }
          armIdleTimer();
          accumulated += chunk;
        }
        if (done) {
          clearTimeout(firstTokenTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      },
      (status) => {
        if (status && status.phase === "done") {
          evalCount = status.evalCount;
          tokPerSec = status.tokPerSec;
          totalMs = status.totalMs;
        }
      }
    );
    wsSend({
      type: "token_generate_response",
      id,
      done: true,
      response: accumulated,
      evalCount,
      tokPerSec,
      totalMs,
      ts: new Date().toISOString()
    });
  } catch (e) {
    const errMsg = timeoutReason || String(e.message || e);
    LOGE("token_generate LLM error:", errMsg);
    wsSend({
      type: "token_generate_response",
      id,
      done: true,
      error: errMsg,
      ts: new Date().toISOString()
    });
  } finally {
    clearTimeout(firstTokenTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "local-llm-bridge") return;

  (async () => {
    try {
      if (msg.action === "server_event") {
        if (msg.eventType === "token_generate") {
          handle_token_generation(msg.payload || {}, sender.tab && sender.tab.id);
        } else {
          LOG("ignoring unknown server event", msg.eventType);
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg.action === "health") {
        const h = await health();
        sendResponse({ ok: true, ...h });
        return;
      }
      if (msg.action === "list") {
        const models = await listModels();
        sendResponse({ ok: true, models });
        return;
      }
      if (msg.action === "generate") {
        const response = await generate(msg.payload || {});
        sendResponse({ ok: true, response });
        return;
      }
      if (msg.action === "stream") {
        const tabId = sender.tab && sender.tab.id;
        const requestId = msg.requestId;
        if (tabId == null) {
          sendResponse({ ok: false, error: "no tab id" });
          return;
        }
        // Ack immediately so the message channel can close. The actual
        // chunks flow via chrome.tabs.sendMessage and don't depend on
        // this channel staying open — long generations would otherwise
        // exceed the channel's lifetime and the page would see
        // "message channel closed before a response was received".
        sendResponse({ ok: true });
        streamGenerate(
          msg.payload || {},
          (chunk, done) => {
            chrome.tabs.sendMessage(tabId, {
              target: "local-llm-bridge-page",
              requestId,
              chunk,
              done
            });
          },
          (status) => {
            chrome.tabs.sendMessage(tabId, {
              target: "local-llm-bridge-page",
              requestId,
              status
            });
          }
        ).catch((err) => {
          LOGE("stream error:", err);
          chrome.tabs.sendMessage(tabId, {
            target: "local-llm-bridge-page",
            requestId,
            error: String(err.message || err),
            done: true
          });
        });
        return;
      }
      sendResponse({ ok: false, error: "unknown action" });
    } catch (e) {
      LOGE("handler error:", e);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true; // keep channel open for async sendResponse
});

getBase().then((base) => LOG("service worker ready, base =", base));
