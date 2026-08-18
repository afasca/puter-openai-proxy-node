// ============================================================================
//  Lightweight OpenAI-compatible proxy node (Puter Serverless Worker)
//  ---------------------------------------------------------------------------
//  - OpenAI-compatible routes mounted under both /v1/* and /api/v1/*
//  - Auth: Authorization: Bearer <PROXY_API_KEY>
//  - Upstream: Puter AI Cloud via me.puter.ai (billed to the worker deployer)
//  - Auto-pulls the upstream model list, converts to OpenAI format, and
//    injects `-thinking` variants for Claude models.
//
//  Deploy this with the Puter CLI / puter.workers.create(). See README.md.
// ============================================================================

// ---- Config ----------------------------------------------------------------
//
//  The outbound proxy key. For a real deployment, DO NOT hardcode a secret here:
//  store it in your Puter KV as `proxy_api_key` (see getApiKey below), which
//  overrides this default. This placeholder only exists so the node works out
//  of the box for local testing.
//
const DEFAULT_API_KEY = "CHANGE_ME";          // <-- set your own key (or use KV)
const MAX_OUTPUT_TOKENS = 64000;
const THINKING_BUDGET = 16000;
const MODELS_TTL_MS = 5 * 60 * 1000;          // model list cache: 5 minutes

// Upstream metadata (shown in plaintext on the status page).
const UPSTREAM_PROVIDER = "Puter AI Cloud";
const UPSTREAM_URL = "https://api.puter.com/puterai/chat/completions";
const UPSTREAM_KEY = "(managed by Puter — no external key required)";

// Resolve the proxy key: KV override (`proxy_api_key`) -> default constant.
async function getApiKey() {
  try {
    const k = await me.puter.kv.get("proxy_api_key");
    if (k && typeof k === "string" && k.trim()) return k.trim();
  } catch (e) {}
  return DEFAULT_API_KEY;
}

// ---- Helpers ---------------------------------------------------------------
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function notFound(path) {
  return json(
    {
      error: {
        message: "Not Found: " + (path || ""),
        type: "invalid_request_error",
        code: "not_found",
      },
    },
    404
  );
}

function unauthorized(msg) {
  return json(
    {
      error: {
        message: msg || "Invalid or missing API key.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    },
    401
  );
}

async function requireAuth(request) {
  const auth =
    request.headers.get("authorization") ||
    request.headers.get("Authorization") ||
    "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return unauthorized("Missing bearer token.");
  const key = await getApiKey();
  if (m[1].trim() !== key) return unauthorized("Invalid API key.");
  return null; // ok
}

function randId(prefix) {
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function isClaude(id) {
  return /claude/i.test(id);
}

// ---- Models ----------------------------------------------------------------
let _modelsCache = null;
let _modelsCacheTime = 0;

async function fetchModels() {
  const now = Date.now();
  if (_modelsCache && now - _modelsCacheTime < MODELS_TTL_MS) return _modelsCache;

  let raw = [];
  try {
    raw = await me.puter.ai.listModels();
  } catch (e) {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];

  const data = [];
  const seen = new Set();
  const created = 1700000000;

  for (const m of raw) {
    const id = m && (m.id || m.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const owned = (m && m.provider) || "puter";
    data.push({ id, object: "model", created, owned_by: owned });

    // Inject extended-thinking variant for Claude family models.
    if (isClaude(id) && !/-thinking$/.test(id)) {
      const tid = id + "-thinking";
      if (!seen.has(tid)) {
        seen.add(tid);
        data.push({ id: tid, object: "model", created, owned_by: owned });
      }
    }
  }

  _modelsCache = { object: "list", data };
  _modelsCacheTime = now;
  return _modelsCache;
}

// ---- Message normalization -------------------------------------------------
// Pass user messages through untouched (no role-prefix wrapping). puter.ai.chat
// accepts OpenAI-style content incl. { type:"image_url", image_url:{ url } }.
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    return msg; // direct passthrough
  });
}

// Extract plain text from a non-streaming chat result.
function extractText(result) {
  const msg = result && result.message ? result.message : result;
  if (!msg) return "";
  let content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (!block) continue;
      if (typeof block === "string") out += block;
      else if (block.type === "text" && block.text) out += block.text;
      else if (block.type === "thinking" && block.thinking)
        out += "<think>" + block.thinking + "</think>";
    }
    return out;
  }
  if (typeof result === "string") return result;
  return "";
}

// ---- Chat completions ------------------------------------------------------
async function handleChat(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(
      { error: { message: "Invalid JSON body.", type: "invalid_request_error" } },
      400
    );
  }

  let model = body.model || "gpt-5-nano";
  let thinking = false;
  if (/-thinking$/.test(model)) {
    thinking = true;
    model = model.replace(/-thinking$/, "");
  }

  const stream = !!body.stream;
  const claude = isClaude(model);

  // Build options.
  const options = { model };
  let maxTok = body.max_tokens != null ? Number(body.max_tokens) : MAX_OUTPUT_TOKENS;
  if (!Number.isFinite(maxTok) || maxTok <= 0) maxTok = MAX_OUTPUT_TOKENS;
  if (maxTok > MAX_OUTPUT_TOKENS) maxTok = MAX_OUTPUT_TOKENS;
  options.max_tokens = maxTok;

  if (body.temperature != null) options.temperature = body.temperature;
  if (body.top_p != null) options.top_p = body.top_p;
  if (body.reasoning_effort != null) options.reasoning_effort = body.reasoning_effort;

  if (thinking) {
    options.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET };
  }

  const messages = normalizeMessages(body.messages);
  const created = Math.floor(Date.now() / 1000);
  const cmplId = randId("chatcmpl-");
  const outModel = body.model || model;

  // ------------------ Streaming ------------------
  if (stream) {
    options.stream = true;
    if (!claude) {
      // OpenAI-style: request usage in the stream.
      options.stream_options = { include_usage: true };
    }

    let iterable;
    try {
      iterable = await me.puter.ai.chat(messages, options);
    } catch (e) {
      return json(
        { error: { message: String(e && e.message ? e.message : e), type: "api_error" } },
        502
      );
    }

    const encoder = new TextEncoder();
    const rs = new ReadableStream({
      async start(controller) {
        let ping = null;
        const enc = (s) => {
          try {
            controller.enqueue(encoder.encode(s));
          } catch (e) {}
        };
        const send = (delta, finish) => {
          const chunk = {
            id: cmplId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }],
          };
          enc("data: " + JSON.stringify(chunk) + "\n\n");
        };

        // Claude keepalive during extended thinking to avoid gateway timeout.
        if (claude || thinking) {
          ping = setInterval(() => enc(": ping\n\n"), 5000);
        }

        send({ role: "assistant", content: "" }, null);

        let inThink = false;
        let usage = null;
        try {
          for await (const part of iterable) {
            if (!part) continue;
            const t = part.type;

            if (t === "reasoning" || (part.reasoning != null && !part.text)) {
              let r = part.reasoning || "";
              if (!r) continue;
              if (!inThink) {
                r = "<think>" + r;
                inThink = true;
              }
              send({ content: r }, null);
            } else if (t === "text" || part.text != null) {
              let txt = part.text || "";
              if (inThink) {
                txt = "</think>" + txt;
                inThink = false;
              }
              if (txt) send({ content: txt }, null);
            } else if (t === "usage") {
              usage = part.usage || null;
            } else if (t === "error") {
              const em = part.message || "stream error";
              if (inThink) {
                send({ content: "</think>" }, null);
                inThink = false;
              }
              send({ content: "\n[error]: " + em }, null);
            }
          }
          if (inThink) {
            send({ content: "</think>" }, null);
            inThink = false;
          }
          send({}, "stop");
          if (usage) {
            enc(
              "data: " +
                JSON.stringify({
                  id: cmplId,
                  object: "chat.completion.chunk",
                  created,
                  model: outModel,
                  choices: [],
                  usage,
                }) +
                "\n\n"
            );
          }
          enc("data: [DONE]\n\n");
        } catch (e) {
          if (inThink) send({ content: "</think>" }, null);
          send(
            { content: "\n[error]: " + String(e && e.message ? e.message : e) },
            "stop"
          );
          enc("data: [DONE]\n\n");
        } finally {
          if (ping) clearInterval(ping);
          try {
            controller.close();
          } catch (e) {}
        }
      },
    });

    return new Response(rs, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ------------------ Non-streaming ------------------
  let result;
  try {
    result = await me.puter.ai.chat(messages, options);
  } catch (e) {
    return json(
      { error: { message: String(e && e.message ? e.message : e), type: "api_error" } },
      502
    );
  }

  const content = extractText(result);
  const usage = (result && result.usage) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  return json({
    id: cmplId,
    object: "chat.completion",
    created,
    model: outModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage,
  });
}

// ============================================================================
//  Routes
// ============================================================================

// Health check (no auth).
router.get("/api/healthz", async () => json({ status: "ok" }));
router.get("/healthz", async () => json({ status: "ok" }));

// Public info for the status page (no auth).
router.get("/api/nodeinfo", async ({ request }) => {
  const url = new URL(request.url);
  const origin = url.origin;
  const key = await getApiKey();
  return json({
    base_url: origin + "/v1",
    key,
    upstream: {
      provider: UPSTREAM_PROVIDER,
      url: UPSTREAM_URL,
      key: UPSTREAM_KEY,
    },
  });
});

// Public model list for the status page (no auth, ids only for display).
router.get("/api/models-public", async () => {
  const m = await fetchModels();
  return json(m);
});

// --- Protected: models + chat, mounted under /v1 and /api/v1 ---
async function modelsRoute(ctx) {
  const err = await requireAuth(ctx.request);
  if (err) return err;
  return json(await fetchModels());
}
async function chatRoute(ctx) {
  const err = await requireAuth(ctx.request);
  if (err) return err;
  return handleChat(ctx.request);
}

router.get("/v1/models", modelsRoute);
router.get("/api/v1/models", modelsRoute);
router.post("/v1/chat/completions", chatRoute);
router.post("/api/v1/chat/completions", chatRoute);

// Catch-all -> JSON 404 (never HTML).
router.get("/*path", async ({ params }) => notFound("/" + (params.path || "")));
router.post("/*path", async ({ params }) => notFound("/" + (params.path || "")));
router.put("/*path", async ({ params }) => notFound("/" + (params.path || "")));
router.delete("/*path", async ({ params }) => notFound("/" + (params.path || "")));
