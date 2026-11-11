/**
 * Structural LlmAdapter for the local OpenAI-compatible proxy.
 *
 * Implements the dsh-llm adapter contract by calling methods (no instanceof,
 * no @deepseek-ai/* import outside the lazy attribution seam). OpenAI Chat
 * Completions SSE from the proxy is projected onto the harness StreamChunk
 * vocabulary: block-start / deltas / block-end / usage / finish.
 */

import crypto from "node:crypto";

const PROVIDER = "xl-free-model";
const PROVIDER_LABEL = "XL Free Model";
const FALLBACK_MODELS = ["mimo-v2.6-flash-free"];

// Matches dsh-llm-pi-ai's DEFAULT_CONTEXT_WINDOW / DEFAULT_MAX_TOKENS.
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;

// OpenCode exposes reasoning levels as model variants. Present the backend's
// own ids (in backend order, least to greatest) so dsh's picker can offer
// exactly the levels the selected model supports.
const EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function variantIdOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

/**
 * OpenCode 2.x returns `variants` as an array of `{ id, settings }`; 1.x
 * returns an object keyed by variant id. Accept both shapes.
 */
function variantIdsOf(value) {
  const ids = [];
  const push = (candidate) => {
    const id = variantIdOf(candidate);
    if (id !== "" && !ids.includes(id)) ids.push(id);
  };
  if (Array.isArray(value)) {
    for (const candidate of value) push(candidate);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) push(key);
  }
  return ids;
}

function reasoningOf(entry) {
  if (!entry || !Array.isArray(entry.variants) || entry.variants.length === 0) {
    return undefined;
  }
  const efforts = entry.variants.map((id) => ({
    id,
    name: EFFORT_LABELS[id.toLowerCase()] || id,
  }));
  if (entry.defaultEffort && efforts.some((effort) => effort.id === entry.defaultEffort)) {
    return { efforts, defaultEffort: entry.defaultEffort };
  }
  // No explicit backend default: dsh adds a "provider default" choice, which
  // is exactly OpenCode's behavior when the session carries no variant.
  return { efforts };
}

/** Lazy attribution headers; dsh-llm is resolved only on first call so hot
 *  reload does not fail on static @deepseek-ai/* imports. */
async function attributionHeaders() {
  try {
    const mod = await import("@deepseek-ai/dsh-llm");
    const headers = typeof mod.attributionHeaders === "function" ? mod.attributionHeaders() : undefined;
    if (headers && typeof headers === "object") return headers;
  } catch {
    /* kernel helper unavailable — fall through */
  }
  return { "user-agent": "deepseek-harness/1.0.0 (+https://github.com/deepseek-ai/deepseek-harness)" };
}

/** Mint a tool-call id for calls that stream arguments without one. */
function mintToolCallId() {
  return `call_${crypto.randomBytes(12).toString("hex")}`;
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * dsh injects the session workspace as a runtime-context message whose section
 * text is `Current working directory: "<JSON-quoted absolute path>".` The
 * proxy needs this per request: OpenCode's native tool permission root and its
 * environment block are derived from the CLI process cwd, not from the
 * `directory=` query parameter.
 */
function parseWorkingDirectoryText(text) {
  if (typeof text !== "string" || text === "") return null;
  const match = text.match(/Current working directory:\s*("(?:[^"\\]|\\.)*")/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

export function workingDirectoryOf(messages) {
  if (!Array.isArray(messages)) return null;
  // Runtime-context snapshots supersede earlier ones, so scan newest first and
  // prefer the structured section over a text scrape.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const source = msg.source || (msg.data && msg.data.source);
    if (source && source.kind === "runtime-context" && Array.isArray(source.sections)) {
      for (const section of source.sections) {
        if (section && section.name === "working-directory:current") {
          const parsed = parseWorkingDirectoryText(section.text);
          if (parsed) return parsed;
        }
      }
    }
    const text =
      typeof msg.content === "string" ? msg.content : blocksText(msg.content);
    const parsed = parseWorkingDirectoryText(text);
    if (parsed) return parsed;
  }
  return null;
}

function toolResultsOf(msg) {
  if (msg && msg.role === "tool") {
    const callId = (msg.source && msg.source.callId) || msg.toolCallId || "";
    return callId === ""
      ? []
      : [{ callId, content: msg.content, isError: msg.isError === true }];
  }
  const out = [];
  for (const b of Array.isArray(msg && msg.content) ? msg.content : []) {
    if (b && b.type === "tool-result") {
      const callId =
        b.toolCallId || (msg.source && msg.source.callId) || "";
      if (callId !== "") {
        out.push({ callId, content: b.content, isError: b.isError === true });
      }
    }
  }
  return out;
}

/**
 * Drop tool calls that were never answered, and answers with no call.
 *
 * A turn aborted between the call and its result leaves exactly that in the
 * durable history; an OpenAI wire answers such a payload 400 and then fails
 * every later turn of the session — the same shape the reference projector
 * (repairToolPairing) repairs before any wire sees it.
 */
function repairToolPairing(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const answered = new Set();
  for (const msg of list) {
    for (const r of toolResultsOf(msg)) answered.add(r.callId);
  }

  const keptCalls = new Set();
  const out = [];
  for (const msg of list) {
    const role = msg && msg.role;
    const results = toolResultsOf(msg);
    if (results.length > 0) {
      if (role === "tool") {
        if (keptCalls.has(results[0].callId)) out.push(msg);
        continue;
      }
      const kept = new Set(
        results.filter((r) => keptCalls.has(r.callId)).map((r) => r.callId)
      );
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const rest = blocks.filter(
        (b) =>
          !b ||
          b.type !== "tool-result" ||
          kept.has(b.toolCallId || (msg.source && msg.source.callId) || "")
      );
      if (rest.length === blocks.length) out.push(msg);
      else if (rest.length > 0) out.push({ ...msg, content: rest });
      continue;
    }
    if (role === "tool") continue; // answer with no resolvable call id
    if (role !== "assistant") {
      out.push(msg);
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const toolBlocks = blocks.filter((b) => b && b.type === "tool-call");
    // A nameless call is not executable — the host answers it as an error
    // *and keeps it in history*, so it 400s every later turn too.
    const calls = toolBlocks.filter(
      (b) => answered.has(String(b.id ?? "")) && String(b.name ?? "") !== ""
    );
    for (const call of calls) keptCalls.add(String(call.id));
    if (calls.length === toolBlocks.length) {
      if (calls.length > 0 || blocks.some((b) => b && b.type === "text" && b.text)) {
        out.push(msg);
      }
      continue;
    }
    if (calls.length === 0) {
      if (blocks.some((b) => b && b.type === "text" && b.text)) {
        out.push({
          ...msg,
          content: blocks.filter((b) => !b || b.type !== "tool-call"),
        });
      }
      continue;
    }
    out.push({
      ...msg,
      content: blocks.filter((b) => !b || b.type !== "tool-call" || calls.includes(b)),
    });
  }
  return out;
}

function toOpenAiMessages(messages, system) {
  const out = [];
  if (typeof system === "string" && system !== "") {
    out.push({ role: "system", content: system });
  }
  const list = repairToolPairing(messages);
  for (const msg of list) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const text = blocksText(msg.content);
      if (text) out.push({ role: "system", content: text });
      continue;
    }
    if (role === "user") {
      const results = toolResultsOf(msg);
      // One wire turn carries the answers first, then the user text — the
      // split the kernel adapter itself makes when a tool returned nothing.
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: r.callId, content: blocksText(r.content) || "(no output)" });
      }
      const present = Array.isArray(msg.content)
        ? msg.content.filter((b) => b && b.type !== "tool-result")
        : msg.content;
      const text = Array.isArray(present) ? blocksText(present) : present;
      if (!results.length || text) out.push({ role: "user", content: text || "" });
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
              function: {
                name: b.name || "",
                arguments:
                  typeof b.arguments === "string" && b.arguments !== ""
                    ? b.arguments
                    : "{}",
              },
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
      if (callId === "") continue;
      out.push({
        role: "tool",
        tool_call_id: callId,
        content: blocksText(msg.content) || "(no output)",
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
function streamFailure(message, code, status) {
  const err = new Error(message);
  err.code = code;
  const failure = { message, code };
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    failure.status = status;
    err.status = status;
  }
  err.failure = failure;
  return err;
}

export class XlFreeModelAdapter {
  constructor({ port, apiKey, logger }) {
    this.port = port;
    this.apiKey = apiKey;
    this.logger = logger;
    this.modelsCache = { time: 0, list: null, failedAt: 0 };
    this.modelsPromise = null;
  }

  log(level, message) {
    const fn = this.logger && this.logger[level];
    if (typeof fn === "function") fn.call(this.logger, message);
  }

  /**
   * Fetch the proxy's model list once per 30s window and keep the reasoning
   * metadata alongside the ids. A failed lookup keeps the previous list and
   * cools down for 5s so `resolveModel()` isn't repeated for every model on a
   * cold/failed proxy.
   */
  async fetchModels() {
    const now = Date.now();
    if (this.modelsCache.list && now - this.modelsCache.time < 30000) {
      return this.modelsCache.list;
    }
    if (now - this.modelsCache.failedAt < 5000) {
      return this.modelsCache.list || null;
    }
    if (this.modelsPromise) return this.modelsPromise;

    this.modelsPromise = (async () => {
      const previous = this.modelsCache.list;
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/v1/models`, {
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(await attributionHeaders()),
          },
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const list = [];
        for (const model of Array.isArray(body.data) ? body.data : []) {
          if (!model || typeof model.id !== "string" || model.id === "") continue;
          list.push({
            id: model.id,
            name:
              typeof model.name === "string" && model.name !== "" ? model.name : model.id,
            variants: variantIdsOf(model.variants),
            defaultEffort:
              variantIdOf(model.default_variant) || variantIdOf(model.defaultVariant) || null,
          });
        }
        if (list.length === 0) throw new Error("proxy returned no models");
        this.modelsCache = { time: Date.now(), list, failedAt: 0 };
        return list;
      } catch (e) {
        this.log("debug", `listModels proxy fetch failed: ${e && e.message}`);
        this.modelsCache = { ...this.modelsCache, failedAt: Date.now() };
        return previous || null;
      } finally {
        this.modelsPromise = null;
      }
    })();
    return this.modelsPromise;
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
    const entries = await this.fetchModels();
    const list =
      entries && entries.length
        ? entries
        : FALLBACK_MODELS.map((id) => ({
            id,
            name: id,
            variants: [],
            defaultEffort: null,
          }));
    return list.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name || entry.id,
      inputModalities: ["text"],
    }));
  }

  async resolveModel(provider, model, _signal) {
    // Never throw — a rejected resolveModel turns the whole provider into a
    // picker failure group (buildModelCatalog isolates per-provider errors).
    const id = typeof model === "string" && model !== "" ? model : FALLBACK_MODELS[0];
    const entries = await this.fetchModels();
    const entry = entries ? entries.find((candidate) => candidate.id === id) : null;
    const resolved = {
      provider,
      id,
      name: entry && entry.name ? entry.name : id,
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      inputModalities: ["text"],
    };
    // Only declare reasoning when the backend actually exposes variants for
    // this exact model; otherwise dsh would offer levels the model rejects.
    const reasoning = reasoningOf(entry);
    if (reasoning) resolved.reasoning = reasoning;
    return resolved;
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  async * stream(options) {
    const body = {
      model: options.model,
      messages: toOpenAiMessages(options.messages, options.system),
      stream: true,
      // Ask the proxy for the final usage chunk; without it the harness never
      // receives token accounting for the turn.
      stream_options: { include_usage: true },
    };
    const tools = toOpenAiTools(options.tools);
    if (tools) body.tools = tools;
    if (typeof options.temperature === "number") body.temperature = options.temperature;
    if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
    if (Array.isArray(options.stop) && options.stop.length) {
      const list = options.stop.filter((s) => typeof s === "string" && s !== "");
      if (list.length) body.stop = list;
    }
    // Forward every declared level, including `none`: OpenCode's variant ids
    // are not OpenAI's off/none aliases, so dropping them would silently fall
    // back to the provider default. dsh already validates the id against the
    // efforts returned by resolveModel().
    if (typeof options.reasoningEffort === "string" && options.reasoningEffort.trim() !== "") {
      body.reasoning_effort = options.reasoningEffort.trim();
    }

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...(await attributionHeaders()),
    };
    const workingDirectory = workingDirectoryOf(options.messages);
    if (workingDirectory) {
      // Percent-encoded so non-ASCII workspace paths remain a legal header.
      headers["x-dsh-working-directory"] = encodeURIComponent(workingDirectory);
    }
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep null */ }
      const payload = parsed && parsed.error ? parsed.error : null;
      const detail = payload && payload.message ? String(payload.message) : text.slice(0, 400);
      const err = streamFailure(
        `proxy HTTP ${res.status}: ${detail}`,
        (payload && typeof payload.code === "string" && payload.code !== "" && payload.code) ||
          "PROXY_HTTP_" + res.status,
        (payload && payload.status) || res.status
      );
      if (payload) {
        err.opencode = payload.opencode ?? null;
        err.sessionId = payload.sessionId ?? null;
        err.backend = payload.backend ?? null;
        err.backendSource = payload.backendSource ?? null;
        err.model = payload.model ?? null;
      }
      throw err;
    }

    const blocks = new Map();
    let nextIndex = 0;
    const emitQueue = [];
    const toolBlocksByIndex = new Map();
    let lastToolBlock = null;

    const createBlock = (kind, id) => {
      const block = {
        index: nextIndex++,
        kind,
        text: "",
        id: id || "",
        name: "",
        args: "",
        closed: false,
      };
      blocks.set(block.index, block);
      emitQueue.push({ type: "block-start", index: block.index, blockType: kind });
      return block;
    };

    // Text and reasoning are single logical blocks per turn.
    const openBlockQ = (kind) => {
      for (const b of blocks.values()) if (b.kind === kind && !b.closed) return b;
      return createBlock(kind);
    };

    // Parallel tool calls stream as several independent argument strings. The
    // OpenAI delta `index` is the stable identity; the id is the fallback, and
    // an argument-only continuation without either belongs to the last call.
    const openToolCallBlock = (call) => {
      const callIndex = call && Number.isInteger(call.index) ? call.index : null;
      const callId = call && typeof call.id === "string" && call.id !== "" ? call.id : "";
      if (callIndex !== null) {
        const existing = toolBlocksByIndex.get(callIndex);
        if (existing && !existing.closed) return existing;
      }
      if (callId !== "") {
        for (const b of blocks.values()) {
          if (b.kind === "tool-call" && !b.closed && b.id === callId) {
            if (callIndex !== null) toolBlocksByIndex.set(callIndex, b);
            return b;
          }
        }
      }
      if (callIndex === null && callId === "" && lastToolBlock && !lastToolBlock.closed) {
        return lastToolBlock;
      }
      // Mint a stand-in id so an id-less call can still be paired with its
      // result on the next turn; a provider id arriving later overrides it.
      const block = createBlock("tool-call", callId || mintToolCallId());
      if (callIndex !== null) toolBlocksByIndex.set(callIndex, block);
      lastToolBlock = block;
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
        pendingError = streamFailure(message, code, payload.error.status || undefined);
        pendingError.opencode = payload.error.opencode ?? null;
        pendingError.sessionId = payload.error.sessionId ?? null;
        pendingError.backend = payload.error.backend ?? null;
        pendingError.backendSource = payload.error.backendSource ?? null;
        pendingError.model = payload.error.model ?? null;
        // 标记错误状态，确保后续 throw pendingError 时能携全错误链转发给 dsh
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
          const b = openToolCallBlock(call);
          if (call.id) b.id = call.id;
          const name = call.function && call.function.name ? call.function.name : "";
          const argsDelta = (call.function && call.function.arguments) || "";
          if (name) b.name = name;
          if (argsDelta) b.args += argsDelta;
          emitQueue.push({
            type: "tool-call-delta",
            index: b.index,
            id: b.id,
            name: name || undefined,
            argumentsDelta: argsDelta,
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
    // 空回复兜底：代理若在没有内容、没有工具调用、也没有显式 error chunk 的情况下
    // 结束流，这里必须变成一个可见的失败，而不是让 dsh 静默显示「无信息回复」。
    const hasVisible = [...blocks.values()].some(
      (b) =>
        (b.kind === "text" && b.text !== "") ||
        (b.kind === "reasoning" && b.text !== "") ||
        b.kind === "tool-call"
    );
    if (!hasVisible) {
      throw streamFailure(
        "XL Free Model 代理返回了空回复（无文本、无工具调用、无错误信息），请检查 opencode 后端日志",
        "PROXY_EMPTY_REPLY"
      );
    }
    if (usage) yield { type: "usage", usage };
    if (!sawFinish) {
      throw streamFailure("proxy stream ended without a finish reason", "PROXY_STREAM_TRUNCATED");
    }
    yield { type: "finish", reason: finishReason };
  }
}

export { PROVIDER, PROVIDER_LABEL };
