/**
 * Structural LlmAdapter for the local OpenAI-compatible proxy.
 *
 * Implements the dsh-llm adapter contract by calling methods (no instanceof,
 * no @deepseek-ai/* import outside the lazy attribution seam). OpenAI Chat
 * Completions SSE from the proxy is projected onto the harness StreamChunk
 * vocabulary: block-start / deltas / block-end / usage / finish.
 */

const PROVIDER = "xl-free-model";
const PROVIDER_LABEL = "XL Free Model";
const FALLBACK_MODELS = ["mimo-v2.6-flash-free"];

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function toOpenAiMessages(messages, system) {
  const out = [];
  if (typeof system === "string" && system !== "") {
    out.push({ role: "system", content: system });
  }
  for (const msg of messages ?? []) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const text = blocksText(msg.content);
      if (text) out.push({ role: "system", content: text });
      continue;
    }
    if (role === "user") {
      const text = blocksText(msg.content);
      out.push({ role: "user", content: text });
      continue;
    }
    if (role === "assistant") {
      const text = blocksText(msg.content);
      const toolCalls = [];
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === "tool-call") {
            toolCalls.push({
              id: b.id || "",
              type: "function",
              function: { name: b.name || "", arguments: b.arguments || "" },
            });
          }
        }
      }
      const entry = { role: "assistant", content: text || null };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      if (entry.content !== null || toolCalls.length) out.push(entry);
      continue;
    }
    if (role === "tool") {
      const callId = (msg.source && msg.source.callId) || msg.toolCallId || "";
      out.push({
        role: "tool",
        tool_call_id: callId,
        content: blocksText(msg.content),
      });
      continue;
    }
  }
  return out;
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || { type: "object", properties: {} },
    },
  }));
}

function finishFromToken(token) {
  if (token === "tool_calls" || token === "function_call") return { kind: "tool-calls" };
  if (token === "length" || token === "max_tokens") return { kind: "max-tokens" };
  return { kind: "stop" };
}

/**
 * Build an Error whose own `code` + `failure` properties survive
 * dsh-llm normalizeLlmFailure, so the terminal finish chunk carries a typed
 * provider failure instead of `code: UNKNOWN`.
 */
function streamFailure(message, code) {
  const err = new Error(message);
  err.code = code;
  err.failure = { message, code };
  return err;
}

async function resolveUserAgent() {
  try {
    const mod = await import("@deepseek-ai/dsh-llm");
    const headers =
      typeof mod.attributionHeaders === "function" ? mod.attributionHeaders() : undefined;
    const ua = headers && (headers["user-agent"] || headers["User-Agent"]);
    if (typeof ua === "string" && ua !== "") return ua;
  } catch {
    /* kernel helper unavailable — fall through */
  }
  return "dsh-xl-free-model/1.2.0";
}

export class XlFreeModelAdapter {
  constructor({ port, apiKey, logger }) {
    this.port = port;
    this.apiKey = apiKey;
    this.logger = logger;
    this.userAgent = null;
    this.modelsCache = { time: 0, list: null };
  }

  log(level, message) {
    const fn = this.logger && this.logger[level];
    if (typeof fn === "function") fn.call(this.logger, message);
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL };
  }

  /** Default retry policy — required by prepareRoutes during registration. */
  providerRetryPolicy(_provider) {
    return undefined;
  }

  /** No image pricing declared. */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  async listModels(provider) {
    const now = Date.now();
    if (this.modelsCache.list && now - this.modelsCache.time < 30000) {
      return this.modelsCache.list.map((id) => ({
        provider,
        id,
        name: id,
        inputModalities: ["text"],
      }));
    }
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/v1/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = await res.json();
        const ids = (Array.isArray(body.data) ? body.data : [])
          .map((m) => m && m.id)
          .filter((id) => typeof id === "string" && id !== "");
        if (ids.length) {
          this.modelsCache = { time: now, list: ids };
          return ids.map((id) => ({
            provider,
            id,
            name: id,
            inputModalities: ["text"],
          }));
        }
      }
    } catch (e) {
      this.log("debug", `listModels proxy fetch failed: ${e && e.message}`);
    }
    // Always return at least the fallback so the provider group never goes empty.
    return FALLBACK_MODELS.map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ["text"],
    }));
  }

  async resolveModel(provider, model) {
    // Never throw — a rejected resolveModel turns the whole provider into a
    // picker failure group (buildModelCatalog isolates per-provider errors).
    const id = typeof model === "string" && model !== "" ? model : FALLBACK_MODELS[0];
    return {
      provider,
      id,
      name: id,
      context: { contextWindow: 131072 },
      defaultMaxTokens: 8192,
      inputModalities: ["text"],
    };
  }

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    };
  }

  async * stream(options) {
    if (!this.userAgent) this.userAgent = await resolveUserAgent();

    const body = {
      model: options.model,
      messages: toOpenAiMessages(options.messages, options.system),
      stream: true,
    };
    const tools = toOpenAiTools(options.tools);
    if (tools) body.tools = tools;
    if (typeof options.temperature === "number") body.temperature = options.temperature;
    if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;

    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": this.userAgent,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw streamFailure(
        `proxy HTTP ${res.status}: ${text.slice(0, 400)}`,
        "PROXY_HTTP_" + res.status
      );
    }

    const blocks = new Map();
    let nextIndex = 0;
    const emitQueue = [];
    const openBlockQ = (kind) => {
      for (const b of blocks.values()) if (b.kind === kind && !b.closed) return b;
      const block = { index: nextIndex++, kind, text: "", id: "", name: "", args: "", closed: false };
      blocks.set(block.index, block);
      emitQueue.push({ type: "block-start", index: block.index, blockType: kind });
      return block;
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawFinish = false;
    let finishReason = null;
    let usage = null;

    let pendingError = null;
    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      if (payload.error) {
        const message = payload.error.message ? String(payload.error.message) : "proxy stream error";
        const code =
          typeof payload.error.code === "string" && payload.error.code !== ""
            ? payload.error.code
            : "PROXY_STREAM_ERROR";
        pendingError = streamFailure(message, code);
        reader.cancel().catch(() => {});
        return;
      }
      if (payload.usage) {
        usage = {
          inputTokens: payload.usage.prompt_tokens ?? 0,
          outputTokens: payload.usage.completion_tokens ?? 0,
        };
        if (payload.usage.prompt_tokens_details && payload.usage.prompt_tokens_details.cached_tokens) {
          usage.cacheReadTokens = payload.usage.prompt_tokens_details.cached_tokens;
          usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
        }
        if (payload.usage.total_tokens != null) usage.totalTokens = payload.usage.total_tokens;
      }
      for (const choice of payload.choices ?? []) {
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          const b = openBlockQ("reasoning");
          b.text += delta.reasoning_content;
          emitQueue.push({ type: "reasoning-delta", index: b.index, text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content) {
          const b = openBlockQ("text");
          b.text += delta.content;
          emitQueue.push({ type: "text-delta", index: b.index, text: delta.content });
        }
        for (const call of delta.tool_calls ?? []) {
          const b = openBlockQ("tool-call");
          if (call.id) b.id = call.id;
          if (call.function && call.function.name) b.name = call.function.name;
          if (call.function && call.function.arguments) b.args += call.function.arguments;
          emitQueue.push({
            type: "tool-call-delta",
            index: b.index,
            id: b.id,
            name: call.function && call.function.name ? call.function.name : undefined,
            argumentsDelta: (call.function && call.function.arguments) || "",
          });
        }
        if (choice.finish_reason) {
          sawFinish = true;
          finishReason = finishFromToken(choice.finish_reason);
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
        if (pendingError) break;
      }
      while (emitQueue.length) yield emitQueue.shift();
      if (pendingError) throw pendingError;
    }
    if (buffer) processLine(buffer);
    while (emitQueue.length) yield emitQueue.shift();
    if (pendingError) throw pendingError;

    for (const block of blocks.values()) {
      if (block.closed) continue;
      block.closed = true;
      if (block.kind === "text" && block.text !== "") {
        yield { type: "block-end", index: block.index, block: { type: "text", text: block.text } };
      } else if (block.kind === "reasoning" && block.text !== "") {
        yield { type: "block-end", index: block.index, block: { type: "reasoning", text: block.text } };
      } else if (block.kind === "tool-call") {
        yield {
          type: "block-end",
          index: block.index,
          block: {
            type: "tool-call",
            id: block.id || "",
            name: block.name || "",
            arguments: block.args || "{}",
          },
        };
      }
    }
    if (usage) yield { type: "usage", usage };
    if (!sawFinish) {
      throw streamFailure("proxy stream ended without a finish reason", "PROXY_STREAM_TRUNCATED");
    }
    yield { type: "finish", reason: finishReason };
  }
}

export { PROVIDER, PROVIDER_LABEL };
