# Puter OpenAI-Compatible Proxy Node

A lightweight **OpenAI-compatible proxy** that runs entirely on [Puter](https://puter.com)
Serverless Workers. It exposes the standard OpenAI API surface (`/v1/chat/completions`,
`/v1/models`) and forwards requests to **Puter AI Cloud** — so you get access to 500+
models (OpenAI, Anthropic, Google, xAI, DeepSeek, …) **without bringing your own upstream
API keys**. Usage is billed to the worker owner's Puter Cloud Credits.

Designed to act as a backend node in a shared AI proxy pool.

> ⚠️ **Security note:** This repository is desensitized. No real API keys, tokens, or
> deployed worker URLs are included. Set your own secrets before deploying (see below).

---

## Features

- **OpenAI-compatible** routes mounted under **both** `/v1/*` and `/api/v1/*`.
- `GET /v1/models` — auto-pulls the live upstream model list, converts it to standard
  OpenAI format, caches it in memory (5 min), and **auto-injects `-thinking` variants**
  for Claude models.
- `POST /v1/chat/completions` — streaming **and** non-streaming.
- `GET /api/healthz` — health check returning `{ "status": "ok" }`.
- **Bearer auth** on all `/v1` and `/api/v1` endpoints (`Authorization: Bearer <key>`),
  JSON `401` on failure. Any unmatched path returns a JSON `404` (never HTML).
- **Extended thinking**: requesting a `*-thinking` model strips the suffix, enables
  `thinking: { type: "enabled", budget_tokens: 16000 }`, and wraps reasoning output in
  `<think>…</think>` tags in the streamed content.
- **Output cap**: `max_tokens` is clamped to a maximum of `64000`.
- **Robust SSE**: correct event-stream headers, a `: ping` keepalive every 5 s (to keep
  Claude extended-thinking connections alive through the gateway), and a final
  `data: [DONE]`.
- **Minimal dark status page** showing live online status, the node's Base URL + key,
  the upstream, and the available models grouped by provider.

---

## Repository layout

```
.
├── backend/
│   └── worker.js        # The Puter Serverless Worker (deploy this)
├── web/
│   └── index.html       # Minimal dark status page (static)
├── .env.example         # Documents the configurable secret
├── .gitignore
└── LICENSE
```

---

## Configuration

The proxy needs exactly **one** secret — the key clients use to authenticate against
*this* node:

| Name             | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `PROXY_API_KEY`  | Bearer key required on every `/v1` request     |

You do **not** need any upstream/third-party API key — calls go through Puter AI Cloud.

### Setting the key

In `backend/worker.js` the key is resolved as **Puter KV (`proxy_api_key`) → default
constant**. The recommended approach is to store it in your worker owner's KV so it never
lives in source control:

```js
// run once, as the worker owner
await puter.kv.set("proxy_api_key", "your-strong-secret-here");
```

If you skip that, edit the `DEFAULT_API_KEY` constant in `backend/worker.js` (it ships as
`"CHANGE_ME"`).

---

## Deploy the backend

Deploy `backend/worker.js` as a Puter Serverless Worker. The `router`, `me`, and `user`
globals are provided by the Puter runtime — no `npm install` or build step is required.

**Option A — Puter CLI**

```bash
npm i -g puter
puter login
puter worker deploy backend/worker.js --name my-proxy-node
```

**Option B — puter.workers.create() from a Puter app/page**

```js
await puter.workers.create("my-proxy-node", "backend/worker.js");
```

After deployment you'll get a URL like `https://my-proxy-node.puter.work`.

---

## Deploy the status page

`web/index.html` is a single static file. Edit the `WORKER_URL` constant near the bottom
to point at your deployed worker:

```js
const WORKER_URL = "https://my-proxy-node.puter.work";
```

Then host it anywhere static (Puter Hosting, GitHub Pages, Netlify, …).

---

## Usage

```bash
curl https://my-proxy-node.puter.work/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{ "role": "user", "content": "Hello!" }],
    "stream": true
  }'
```

Point any OpenAI-compatible client at the base URL `https://my-proxy-node.puter.work/v1`
with your `PROXY_API_KEY`.

- Add the `-thinking` suffix to a Claude model id (e.g. `claude-opus-4-8-thinking`) to
  enable extended thinking; the reasoning is streamed inside `<think>…</think>`.
- `GET /v1/models` returns the live model list, including the injected `-thinking`
  variants.

---

## Not included (by design)

Usage accounting / billing (handled by Puter Cloud Credits), request-log persistence,
an admin panel, and hardcoded model lists — the model list is always pulled live from
upstream.

---

## License

MIT — see [LICENSE](./LICENSE).

Powered by [Puter](https://developer.puter.com).
