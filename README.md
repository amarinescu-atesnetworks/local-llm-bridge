# Local LLM Bridge

A Chrome (Manifest V3) extension that lets any web page talk to a local
[Ollama](https://ollama.com) HTTP API (default `http://localhost:11434`) without
running into cross-origin restrictions. A bundled chat page demonstrates the
bridge end to end: pick a model, stream a completion, and preview generated
HTML/SVG in a sandboxed iframe.

## Why

Browsers block pages from calling a local LLM server directly: the request is
cross-origin, and Ollama rejects requests that carry a browser `Origin` header.
This extension sits in between. It uses `declarativeNetRequest` to strip the
`Origin` header on requests to the configured Ollama host, and relays calls from
the page to the LLM through the extension service worker.

```
web page  ──postMessage──▶  content.js  ──runtime msg──▶  background.js  ──fetch──▶  Ollama
   ▲                                                                                    │
   └──────────────────────── streamed tokens / response ◀───────────────────────────────┘
```

## Components

| Path | Role |
| --- | --- |
| `extension/manifest.json` | MV3 manifest (service worker, content script, DNR rules, options page) |
| `extension/background.js` | Service worker: talks to Ollama (`/api/tags`, `/api/generate`), streaming, health checks, server-pushed `token_generate` handler |
| `extension/content.js` | Bridges `window.postMessage` ⇄ `chrome.runtime` messaging; announces extension presence to pages |
| `extension/rules.json` | Static DNR rules that strip the `Origin` header for `localhost`/`127.0.0.1:11434` |
| `extension/options.html` / `options.js` | Settings page to point the bridge at a custom Ollama URL, with a connection test |
| `page/index.html` | Standalone chat client (model picker, streaming, `<think>` blocks, code fences, live HTML preview) |
| `deploy/` | Docker/nginx setup to serve `page/` as a static site |

## Install the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory.
4. Make sure Ollama is running locally:
   ```sh
   ollama serve
   ollama pull qwen3:14b   # default model used by the chat page
   ```

## Configure a non-default Ollama host

By default the bridge targets `http://localhost:11434`. To point it elsewhere
(e.g. an Ollama instance on another machine):

1. Right-click the extension → **Options** (or open the options page from
   `chrome://extensions`).
2. Enter the server URL, e.g. `http://192.168.1.50:11434`.
3. Click **Test connection**, then **Save**.

The setting is stored in `chrome.storage.local`; the service worker re-syncs the
`Origin`-stripping DNR rule to the new host automatically.

## Using the chat page

Open `page/index.html` directly in the browser (or serve it — see below) with the
extension installed. The page shows two status pills — extension presence and LLM
reachability — then lets you pick a model and send a prompt. `Ctrl`/`Cmd`+`Enter`
in the textarea sends. Streaming is on by default and surfaces live timing
(first-token latency, tokens/sec).

### Page → bridge protocol

The page communicates with the content script over `window.postMessage`:

```js
// page → bridge
window.postMessage({ source: "local-llm-page", action, payload, requestId }, "*");
// bridge → page
window.postMessage({ source: "local-llm-bridge", requestId, /* ... */ }, "*");
```

Supported `action` values: `health`, `list`, `generate`, and `stream`. The
content script also announces `{ source: "local-llm-bridge", ready: true }` on
load so pages can detect the extension.

## Serving the chat page (Docker)

The `deploy/` directory builds a small nginx image that serves `page/` as a
static site.

```sh
cd deploy
docker compose up -d --build
```

By default it binds to `10.10.13.75:3103` (mapped to container port 3000) — adjust
the `ports` mapping in `deploy/docker-compose.yml` for your environment. The entry
point is served with `Cache-Control: no-store` so page updates land on refresh.

## Notes & limitations

- **Timeouts** — a cold model load can take a while, so the server-pushed
  `token_generate` handler allows up to 300 s for the first token, then 30 s of
  idle between tokens before aborting.
- **Host permissions** — the manifest requests broad `http://*/*` and
  `https://*/*` access so any page can use the bridge. Tighten `host_permissions`
  and the content-script `matches` if you only need it on specific sites.
- **Context invalidation** — reloading/updating the extension orphans the content
  script in already-open tabs; the page is told to refresh (F5) when this happens.
