// Settings page for the Local LLM Bridge.
// Reads/writes the Ollama base URL in chrome.storage.local; the background
// service worker picks up changes via chrome.storage.onChanged.

const DEFAULT_BASE = "http://localhost:11434";
const BASE_KEY = "ollamaBaseUrl";

const urlEl = document.getElementById("url");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("test");
const resetBtn = document.getElementById("reset");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
const dot = document.getElementById("dot");

function setStatus(state, text) {
  statusEl.classList.remove("ok", "bad");
  dot.classList.remove("ok", "bad", "pending");
  if (state) {
    // statusEl only styles ok/bad; the pending colour lives on the dot.
    if (state === "ok" || state === "bad") statusEl.classList.add(state);
    dot.classList.add(state);
  }
  statusText.textContent = text || "";
}

// Normalize and validate a user-entered URL. Returns the cleaned http(s) URL
// (trailing slashes trimmed) or null if it isn't a usable http endpoint.
function normalizeUrl(raw) {
  let v = (raw || "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = "http://" + v; // tolerate a bare host:port
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`.replace(/\/+$/, "");
  } catch (_) {
    return null;
  }
}

async function load() {
  const { [BASE_KEY]: v } = await chrome.storage.local.get(BASE_KEY);
  urlEl.value = v || DEFAULT_BASE;
}

saveBtn.addEventListener("click", async () => {
  const clean = normalizeUrl(urlEl.value);
  if (!clean) {
    setStatus("bad", "Enter a valid http(s) URL, e.g. http://192.168.1.50:11434");
    return;
  }
  urlEl.value = clean;
  await chrome.storage.local.set({ [BASE_KEY]: clean });
  setStatus("ok", "Saved.");
});

resetBtn.addEventListener("click", async () => {
  urlEl.value = DEFAULT_BASE;
  await chrome.storage.local.set({ [BASE_KEY]: DEFAULT_BASE });
  setStatus("ok", "Reset to default.");
});

// Save first (so the background uses the new URL), then ask it to probe.
testBtn.addEventListener("click", async () => {
  const clean = normalizeUrl(urlEl.value);
  if (!clean) {
    setStatus("bad", "Enter a valid http(s) URL first.");
    return;
  }
  urlEl.value = clean;
  await chrome.storage.local.set({ [BASE_KEY]: clean });

  setStatus("pending", "Testing " + clean + " …");
  testBtn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ target: "local-llm-bridge", action: "health" });
    if (r && r.reachable) {
      setStatus("ok", `Reachable (${r.latencyMs}ms).`);
    } else {
      const reason = (r && r.error) || (r && r.httpStatus ? `HTTP ${r.httpStatus}` : "unreachable");
      setStatus("bad", `Not reachable: ${reason}`);
    }
  } catch (e) {
    setStatus("bad", "Test failed: " + (e.message || e));
  } finally {
    testBtn.disabled = false;
  }
});

load();
