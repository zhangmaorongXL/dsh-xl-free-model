"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "proxy.config.json");
const PEB_SCRIPT = path.join(__dirname, "peb_env.ps1");
const SESSION_CACHE_MAX = 100;
const BACKEND_TIMEOUT_MS = 15 * 60 * 1000;
const SHORT_TIMEOUT_MS = 30 * 1000;
const SSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

const config = loadConfig();
const PROXY_HOST = config.proxyHost || "127.0.0.1";
const PROXY_PORT = config.proxyPort || 8787;
const API_KEY = config.apiKey || "";
// Workspace directory for the OpenCode backend. Priority:
//   1. OPENCODE_PROXY_DIRECTORY env (set by index.js from the dsh process cwd)
//   2. config.directory in proxy.config.json
//   3. process.cwd() as last resort
const DIRECTORY = process.env.OPENCODE_PROXY_DIRECTORY || config.directory || process.cwd();
const PROVIDER_ID = "opencode";

const CLI_CFG = (config.backend && config.backend.cli) || {};
const CLI_ENABLED = CLI_CFG.enabled !== false;
const CLI_PATH = path.resolve(
  __dirname,
  CLI_CFG.path || path.join("cli", "node_modules", "opencode-windows-x64", "bin", "opencode.exe")
);
const CLI_PORT = Number(CLI_CFG.port || 4097);
const CLI_HOST = "127.0.0.1";
const CLI_LOG = path.join(__dirname, "cli-serve.log");

let backend = null; // { base, authHeader, password }
let discovering = null;
let modelsCache = { time: 0, data: null };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

class BackendError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = !!retryable;
  }
}

function pebPassword() {
  if (!fs.existsSync(PEB_SCRIPT)) return null;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PEB_SCRIPT, "OPENCODE_SERVER_PASSWORD"],
    { encoding: "utf8", timeout: 15000, windowsHide: true }
  );
  if (r.status === 0 && r.stdout) {
    const v = r.stdout.trim();
    if (v) return v;
  }
  return null;
}

function openCodeListeningPorts() {
  const pids = new Set();
  const tl = spawnSync("tasklist", ["/FI", "IMAGENAME eq OpenCode.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (tl.stdout) {
    for (const line of tl.stdout.split(/\r?\n/)) {
      const parts = line.trim().replace(/^"|"$/g, "").split('","');
      if (parts.length >= 2 && /opencode/i.test(parts[0])) {
        const pid = parseInt(parts[1], 10);
        if (!isNaN(pid)) pids.add(pid);
      }
    }
  }
  const ns = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  const ports = [];
  if (ns.stdout) {
    for (const line of ns.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === "LISTENING") {
        const pid = parseInt(parts[4], 10);
        if (pids.has(pid)) {
          const port = parseInt(parts[1].split(":").pop(), 10);
          if (port > 0 && !ports.includes(port)) ports.push(port);
        }
      }
    }
  }
  return ports;
}

async function probeBackend(base, password, timeoutMs = SHORT_TIMEOUT_MS) {
  const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  let res;
  try {
    res = await fetch(base + "/config/providers?directory=" + encodeURIComponent(DIRECTORY), {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) return { auth, password, unauthorized: true };
  if (!res.ok) return null;
  try {
    await res.json();
  } catch {
    return null;
  }
  return { auth, password, unauthorized: false };
}

// ---------- headless CLI backend ----------

let cliChild = null;
let cliPassword = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeCli() {
  if (!cliPassword) return null;
  const base = `http://${CLI_HOST}:${CLI_PORT}`;
  const r = await probeBackend(base, cliPassword);
  if (r && !r.unauthorized) {
    return { base, authHeader: r.auth, password: cliPassword, source: "cli" };
  }
  return null;
}

function killCli() {
  if (cliChild) {
    try {
      cliChild.kill();
    } catch {
      /* ignore */
    }
    cliChild = null;
  }
}

async function ensureCliBackend() {
  if (!CLI_ENABLED) return null;
  const healthy = await probeCli();
  if (healthy) return healthy;
  if (!fs.existsSync(CLI_PATH)) {
    log("cli binary missing:", CLI_PATH);
    return null;
  }
  killCli();
  cliPassword = crypto.randomBytes(16).toString("hex");
  let logFd;
  try {
    logFd = fs.openSync(CLI_LOG, "a");
  } catch {
    logFd = "ignore";
  }
  cliChild = spawn(CLI_PATH, ["serve", "--hostname", CLI_HOST, "--port", String(CLI_PORT)], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: cliPassword },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  cliChild.on("exit", (code) => {
    log("cli backend exited, code=", code);
    cliChild = null;
  });
  cliChild.on("error", (e) => {
    log("cli backend spawn error:", e.message);
    cliChild = null;
  });
  process.on("exit", () => {
    try {
      if (cliChild) cliChild.kill();
    } catch {
      /* ignore */
    }
  });
  log("spawning headless cli server on", CLI_HOST + ":" + CLI_PORT);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (!cliChild) return null;
    const r = await probeCli();
    if (r) {
      log("headless cli backend ready:", r.base);
      return r;
    }
  }
  log("headless cli server start timeout");
  killCli();
  return null;
}

async function discoverBackend() {
  const cfg = config.backend || {};
  const host = cfg.host || "127.0.0.1";
  const passwords = [];
  const push = (p) => {
    if (p && !passwords.includes(p)) passwords.push(p);
  };
  push(cfg.password);
  push(process.env.OPENCODE_SERVER_PASSWORD);
  const envPassword = pebPassword();
  push(envPassword);

  let ports = [];
  if (cfg.port) ports.push(Number(cfg.port));
  else ports = openCodeListeningPorts();

  if (ports.length === 0) {
    if (CLI_ENABLED) {
      const cli = await ensureCliBackend();
      if (cli) return cli;
    }
    throw new BackendError(
      "未发现 opencode 后端：桌面版未运行且无头 CLI 启动失败", true
    );
  }

  let sawUnauthorized = false;
  for (const port of ports) {
    const base = `http://${host}:${port}`;
    for (const password of passwords.length ? passwords : [""]) {
      const r = await probeBackend(base, password);
      if (r && !r.unauthorized) {
        log(`backend discovered: ${base} (password source ok)`);
        return { base, authHeader: r.auth, password, source: "desktop" };
      }
      if (r && r.unauthorized) sawUnauthorized = true;
    }
    // 端口存在但密码未知：仍返回占位，让请求以 401 失败提示补密码
    if (passwords.length === 0 && sawUnauthorized) break;
  }

  if (CLI_ENABLED) {
    const cli = await ensureCliBackend();
    if (cli) return cli;
  }
  if (sawUnauthorized) {
    throw new BackendError(
      "已发现 opencode 后端端口但密码获取失败（请检查 python 是否可用，或在 proxy.config.json 的 backend.password 中填写 OPENCODE_SERVER_PASSWORD）",
      false
    );
  }
  throw new BackendError("opencode 后端端口存在但健康检查未通过", true);
}

async function ensureBackend() {
  if (backend) return backend;
  if (!discovering) {
    discovering = discoverBackend()
      .then((b) => {
        backend = b;
        return b;
      })
      .finally(() => {
        discovering = null;
      });
  }
  return discovering;
}

function invalidateBackend() {
  if (backend && backend.source === "cli") {
    killCli();
  }
  backend = null;
}

async function backendFetch(method, pathname, body, timeoutMs = SHORT_TIMEOUT_MS) {
  const b = await ensureBackend();
  let res;
  try {
    res = await fetch(b.base + pathname, {
      method,
      headers: {
        authorization: b.authHeader,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    invalidateBackend();
    throw new BackendError("无法连接 opencode 后端: " + e.message, true);
  }
  if (res.status === 401 || res.status === 403) {
    invalidateBackend();
    throw new BackendError("opencode 后端认证失败（密码可能已随桌面重启变化）", true);
  }
  return res;
}

async function backendJson(method, pathname, body, timeoutMs = SHORT_TIMEOUT_MS) {
  const res = await backendFetch(method, pathname, body, timeoutMs);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep null */
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function withBackendRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BackendError && e.retryable) {
      log("backend failure, rediscovering:", e.message);
      invalidateBackend();
      await ensureBackend();
      return fn();
    }
    throw e;
  }
}

// ---------- sessions ----------

const sessionCache = new Map(); // key -> sid

function hashKey(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function touchSession(key, sid) {
  if (sessionCache.has(key)) sessionCache.delete(key);
  sessionCache.set(key, sid);
  while (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    const sidToDrop = sessionCache.get(oldest);
    sessionCache.delete(oldest);
    backendJson("DELETE", `/session/${sidToDrop}?directory=` + encodeURIComponent(DIRECTORY)).catch(
      () => {}
    );
  }
}

async function createSession() {
  const r = await backendJson("POST", "/session?directory=" + encodeURIComponent(DIRECTORY), {});
  if (!r.ok || !r.json || !r.json.id) {
    throw new BackendError("创建 opencode session 失败: HTTP " + r.status + " " + (r.text || ""), true);
  }
  return r.json.id;
}

// ---------- message helpers ----------

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c.type === "text") return c.text || "";
        if (c.type === "image_url") return "[image]";
        if (c.type === "input_audio") return "[audio]";
        return "";
      })
      .join("");
  }
  if (typeof content === "object") return JSON.stringify(content);
  return String(content);
}

function renderToolCall(tc) {
  const fn = (tc && tc.function) || {};
  return `[tool_call id=${tc && tc.id ? tc.id : "?"} name=${fn.name || "?"}] arguments=${fn.arguments || "{}"}`;
}

function renderToolResult(m) {
  return `[tool_result id=${m.tool_call_id || "?"}]\n${contentToText(m.content)}`;
}

// 归一化为确定性文本：session 缓存 key 依赖它（客户端回传 JSON 字段顺序可能不同）
function normalizedText(m) {
  const text = contentToText(m.content);
  if (m.role === "tool") return renderToolResult(m);
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    return (text ? text + "\n\n" : "") + m.tool_calls.map(renderToolCall).join("\n");
  }
  return text;
}

function normalizeForHash(m) {
  return { role: m.role, text: normalizedText(m) };
}

function messageToParts(m) {
  const parts = [];
  const pushText = (t) => {
    if (t) parts.push({ type: "text", text: t });
  };
  if (m.role === "tool") {
    pushText(renderToolResult(m));
  } else if (typeof m.content === "string") {
    pushText(m.content);
  } else if (Array.isArray(m.content)) {
    let buf = "";
    for (const c of m.content) {
      if (c.type === "text") {
        buf += c.text || "";
      } else if (c.type === "image_url") {
        pushText(buf);
        buf = "";
        const url = (c.image_url && c.image_url.url) || "";
        if (url) {
          const mime = url.startsWith("data:") ? url.slice(5, url.indexOf(";") || -1) || "image/png" : "image/png";
          parts.push({ type: "file", mime, url });
        }
      } else if (c.type === "input_audio") {
        pushText("[audio]");
      }
    }
    pushText(buf);
  }
  if (m.role !== "tool" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    for (const tc of m.tool_calls) pushText(renderToolCall(tc));
  }
  if (!parts.length) pushText("(empty)");
  return parts;
}

function splitSystem(messages) {
  const systemMsgs = [];
  const rest = [];
  let inSystem = true;
  for (const m of messages) {
    if (inSystem && m.role === "system") systemMsgs.push(m);
    else {
      inSystem = false;
      rest.push(m);
    }
  }
  const systemText = systemMsgs.map((m) => contentToText(m.content)).filter(Boolean).join("\n\n");
  return { systemText: systemText || null, rest };
}

function flattenHistory(messages) {
  const lines = [];
  for (const m of messages) {
    const role =
      m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : m.role === "tool" ? "Tool result" : "User";
    lines.push(`${role}:\n${normalizedText(m)}`);
  }
  return lines.join("\n\n");
}

// ---------- function calling bridge ----------

const TOOL_CALL_BEGIN = "<<<TOOL_CALL>>>";
const TOOL_CALL_END = "<<<END_TOOL_CALL>>>";

function buildToolsPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const defs = [];
  for (const t of tools) {
    const fn = t && t.function;
    if (!fn || !fn.name) continue;
    defs.push(
      `- name: ${fn.name}\n  description: ${fn.description || "(none)"}\n  parameters (JSON Schema): ${JSON.stringify(
        fn.parameters || { type: "object", properties: {} }
      )}`
    );
  }
  if (!defs.length) return null;
  return [
    "## External function calling (IMPORTANT)",
    "The following functions are provided by the API runtime OUTSIDE your current environment.",
    "They are NOT tools of your session. You cannot invoke them by any other means.",
    "The ONLY way to call them is to emit a tool call block in the required format below;",
    "the runtime will execute each function and send you the results in a follow-up message.",
    "",
    "Available functions:\n" + defs.join("\n"),
    "",
    "Tool call block format (emit EXACTLY this; you may write normal text before and after the block):",
    TOOL_CALL_BEGIN,
    '{"tool_calls":[{"id":"call_1","name":"<function_name>","arguments":{...}}]}',
    TOOL_CALL_END,
    "Rules:",
    "- id: a unique string per call, e.g. call_1, call_2.",
    "- arguments: a JSON OBJECT (not a string), matching the parameters schema.",
    "- You may include multiple calls in one tool_calls array.",
    "- If no function is needed, reply normally without any block.",
    "- Never claim a function is unavailable; if the user asks for something a function covers, call it.",
  ].join("\n");
}

function extractToolCalls(text) {
  if (!text) return { content: "", toolCalls: [] };
  const calls = [];
  const re = /<<<TOOL_CALL>>>\s*([\s\S]*?)\s*<<<END_TOOL_CALL>>>/g;
  let m;
  let found = false;
  while ((m = re.exec(text))) {
    found = true;
    try {
      const obj = JSON.parse(m[1]);
      const arr = Array.isArray(obj.tool_calls) ? obj.tool_calls : obj && obj.name ? [obj] : [];
      for (const tc of arr) {
        if (tc && tc.name) {
          calls.push({
            id: tc.id || "call_" + (calls.length + 1),
            type: "function",
            function: {
              name: String(tc.name),
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
          });
        }
      }
    } catch {
      /* malformed block, treat as text */
    }
  }
  const content = text.replace(re, "").trim();
  if (found) return { content, toolCalls: calls };
  // fallback: 整个回复就是一个 JSON 对象
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const obj = JSON.parse(t);
      const arr = Array.isArray(obj.tool_calls) ? obj.tool_calls : null;
      if (arr && arr.length && arr.every((tc) => tc && tc.name)) {
        return {
          content: "",
          toolCalls: arr.map((tc, i) => ({
            id: tc.id || "call_" + (i + 1),
            type: "function",
            function: {
              name: String(tc.name),
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
          })),
        };
      }
    } catch {
      /* not a tool-call json */
    }
  }
  return { content: text, toolCalls: [] };
}

function renderToolTurn(msgs) {
  const lines = [];
  for (const m of msgs) {
    if (m.role === "assistant") lines.push("Assistant requested tool calls:\n" + normalizedText(m));
    else lines.push("Tool result:\n" + normalizedText(m));
  }
  lines.push(
    "Continue based on the tool results above. If more tools are needed, emit tool calls in the required format; otherwise answer the user directly."
  );
  return lines.join("\n\n");
}

function normalizeModel(model) {
  if (!model) return "mimo-v2.6-flash-free";
  const m = String(model).trim();
  return m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
}

function usageOf(tokens) {
  const t = tokens || {};
  const prompt = t.input || 0;
  const completion = t.output || 0;
  const total = t.total || prompt + completion + (t.reasoning || 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function extractResponseText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && !p.ignored)
    .map((p) => p.text || "")
    .join("");
}

// ---------- http helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendOpenAiError(res, status, message, type) {
  sendJson(res, status, { error: { message, type: type || "invalid_request_error", param: null, code: null } });
}

function checkAuth(req, res) {
  if (!API_KEY) return true;
  const h = req.headers.authorization || "";
  if (h === "Bearer " + API_KEY) return true;
  sendOpenAiError(res, 401, "Invalid API key", "authentication_error");
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- models ----------

async function handleModels(res) {
  try {
    const fresh = modelsCache.data && Date.now() - modelsCache.time < 60000;
    if (!fresh) {
      const r = await backendJson("GET", "/config/providers?directory=" + encodeURIComponent(DIRECTORY));
      const providers = (r.json && r.json.providers) || [];
      const oc = providers.find((p) => p.id === PROVIDER_ID);
      const models = oc ? Object.values(oc.models || {}) : [];
      modelsCache = {
        time: Date.now(),
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: Math.floor((m.release_date ? new Date(m.release_date + "T00:00:00Z").getTime() : Date.now()) / 1000),
          owned_by: PROVIDER_ID,
        })),
      };
    }
    sendJson(res, 200, { object: "list", data: modelsCache.data });
  } catch (e) {
    sendOpenAiError(res, 502, e.message, "server_error");
  }
}

// ---------- chat completions ----------

async function resolveSession(messages, toolsPrompt) {
  const { systemText: baseSystem, rest } = splitSystem(messages);
  const systemText = [baseSystem, toolsPrompt].filter(Boolean).join("\n\n") || null;
  if (!rest.length) {
    throw Object.assign(new Error("messages must contain at least one non-system message"), { status: 400 });
  }
  const last = rest[rest.length - 1];
  const history = rest.slice(0, -1);
  const key = hashKey({ s: systemText, h: history.map(normalizeForHash) });

  let sid = sessionCache.get(key);
  let parts;

  // 尾部连续 tool 结果 + 其前带 tool_calls 的 assistant 消息需一并发给模型
  let tailStart = rest.length;
  if (last.role === "tool") {
    tailStart = rest.length;
    while (tailStart > 0 && rest[tailStart - 1].role === "tool") tailStart--;
    const before = rest[tailStart - 1];
    if (before && before.role === "assistant" && Array.isArray(before.tool_calls) && before.tool_calls.length) {
      tailStart--;
    }
  }

  if (sid && last.role !== "assistant") {
    touchSession(key, sid);
    log("session cache hit:", sid);
    if (tailStart < rest.length) {
      parts = [{ type: "text", text: renderToolTurn(rest.slice(tailStart)) }];
    } else {
      parts = messageToParts(last);
    }
  } else {
    sid = await createSession();
    log("session created:", sid);
    const flat = flattenHistory(history);
    const prefix = flat ? `Conversation so far:\n${flat}\n\nLatest message:\n` : "";
    const lastParts = messageToParts(last);
    if (prefix) {
      parts = [{ type: "text", text: prefix + normalizedText(last) }];
      for (const p of lastParts) if (p.type === "file") parts.push(p);
    } else {
      parts = lastParts;
    }
  }
  return { sid, systemText, parts, rest };
}

function cacheNextTurnKey(systemText, rest, replyMsg, sid) {
  // 下一轮客户端会带上 assistant 回复（含 tool_calls），用归一化文本保证 key 一致
  touchSession(
    hashKey({ s: systemText, h: [...rest.map(normalizeForHash), normalizeForHash(replyMsg)] }),
    sid
  );
}

function buildPromptBody(systemText, parts, body) {
  const prompt = {
    model: { providerID: PROVIDER_ID, modelID: normalizeModel(body.model) },
    parts,
  };
  if (systemText) prompt.system = systemText;
  if (body.reasoning_effort && ["low", "medium", "high"].includes(body.reasoning_effort)) {
    prompt.variant = body.reasoning_effort;
  }
  return prompt;
}

async function handleChatCompletion(req, res, body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendOpenAiError(res, 400, "messages is required and must be a non-empty array");
  }

  const model = normalizeModel(body.model);
  const stream = !!body.stream;
  const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
  const toolsPrompt = buildToolsPrompt(body.tools);

  let resolved;
  try {
    resolved = await withBackendRetry(() =>
      resolveSession(body.messages, toolsPrompt).then((r) => ({ ...r, model }))
    );
  } catch (e) {
    if (e.status) return sendOpenAiError(res, e.status, e.message);
    return sendOpenAiError(res, 502, e.message, "server_error");
  }

  const { sid, systemText, parts, rest } = resolved;
  if (toolsPrompt && parts.length) {
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.type === "text") {
      lastPart.text +=
        "\n\n(Reminder: if an available function applies, emit the tool call block per the system prompt; the runtime will execute it.)";
    }
  }
  const promptBody = buildPromptBody(systemText, parts, body);
  const dirQ = "directory=" + encodeURIComponent(DIRECTORY);
  const id = "chatcmpl-" + crypto.randomBytes(8).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let r;
    try {
      r = await withBackendRetry(() =>
        backendJson("POST", `/session/${sid}/message?${dirQ}`, promptBody, BACKEND_TIMEOUT_MS)
      );
    } catch (e) {
      return sendOpenAiError(res, 502, e.message, "server_error");
    }
    if (!r.ok) {
      return sendOpenAiError(res, 502, "opencode backend error: HTTP " + r.status + " " + (r.text || ""), "server_error");
    }
    const info = (r.json && r.json.info) || {};
    if (info.error) {
      const msg =
        (info.error.data && info.error.data.message) || info.error.message || JSON.stringify(info.error);
      return sendOpenAiError(res, 502, "opencode model error: " + msg, "server_error");
    }
    const rawText = extractResponseText(r.json && r.json.parts);
    const parsed = extractToolCalls(rawText);
    if (toolsPrompt && !parsed.toolCalls.length) {
      log("tools requested but no tool_calls parsed, raw:", JSON.stringify(rawText).slice(0, 400));
    }
    const assistantMsg = parsed.toolCalls.length
      ? { role: "assistant", content: parsed.content, tool_calls: parsed.toolCalls }
      : { role: "assistant", content: rawText };
    cacheNextTurnKey(systemText, rest, assistantMsg, sid);
    const finish = parsed.toolCalls.length
      ? "tool_calls"
      : info.error && info.error.name === "MessageOutputLengthError"
        ? "length"
        : "stop";
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: body.model || model,
      choices: [
        {
          index: 0,
          message: assistantMsg,
          finish_reason: finish,
        },
      ],
      usage: usageOf(info.tokens),
    });
  }

  // ---- streaming ----
  let sse;
  try {
    sse = await backendFetch("GET", "/event?" + dirQ, undefined, SHORT_TIMEOUT_MS);
  } catch (e) {
    return sendOpenAiError(res, 502, e.message, "server_error");
  }
  if (!sse.ok || !sse.body) {
    return sendOpenAiError(res, 502, "failed to subscribe opencode event stream", "server_error");
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  const writeChunk = (obj) => {
    res.write("data: " + JSON.stringify(obj) + "\n\n");
  };
  const chunk = (delta, finish) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: body.model || model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: "" }, null)) + "\n\n");

  const reasoningParts = new Set();
  let lastTokens = null;
  let finished = false;
  let idleTimer = null;
  let reader = null;
  let normalEnd = false;
  let streamContent = "";
  const bufferMode = !!toolsPrompt; // 带 tools 时缓冲 content，结束统一输出，避免调用标记泄漏
  let finalToolCalls = [];
  let finalContent = "";
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finishStream("stream idle timeout"), SSE_IDLE_TIMEOUT_MS);
  };

  function finishStream(errorEvent) {
    if (finished) return;
    finished = true;
    normalEnd = !errorEvent;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      if (errorEvent) {
        const msg =
          (errorEvent.properties &&
            errorEvent.properties.error &&
            (errorEvent.properties.error.data && errorEvent.properties.error.data.message) ||
            (errorEvent.properties.error && errorEvent.properties.error.message)) ||
          (typeof errorEvent === "string" ? errorEvent : "opencode stream error");
        writeChunk({ error: { message: msg, type: "server_error", code: null } });
      } else {
        if (bufferMode) {
          const parsed = extractToolCalls(streamContent);
          finalToolCalls = parsed.toolCalls;
          finalContent = parsed.content;
          if (finalContent) writeChunk(chunk({ role: "assistant", content: finalContent }, null));
          if (finalToolCalls.length) {
            writeChunk(chunk({ tool_calls: finalToolCalls }, null));
            res.write("data: " + JSON.stringify(chunk({}, "tool_calls")) + "\n\n");
          } else {
            res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
          }
        } else {
          res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
        }
        if (includeUsage && lastTokens) {
          res.write(
            "data: " +
              JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model || model, choices: [], usage: usageOf(lastTokens) }) +
              "\n\n"
          );
        }
      }
    } catch {
      /* ignore */
    }
    res.write("data: [DONE]\n\n");
    res.end();
    if (normalEnd) {
      reader && reader.cancel().catch(() => {});
    } else {
      cleanup();
    }
  }

  function cleanup() {
    reader && reader.cancel().catch(() => {});
    if (sid) {
      backendFetch("POST", `/session/${sid}/abort?${dirQ}`, {}).catch(() => {});
    }
  }

  res.on("close", () => {
    if (!finished) {
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      cleanup();
    }
  });

  reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  resetIdle();

  let promptStatus = null;
  const promptPromise = backendFetch("POST", `/session/${sid}/message?${dirQ}`, promptBody, BACKEND_TIMEOUT_MS)
    .then((r) => {
      promptStatus = r.status;
      if (!r.ok && !finished) {
        return r.text().then((t) => {
          finishStream({
            properties: { error: { message: "opencode backend error: HTTP " + r.status + " " + t } },
          });
        });
      }
      return r.text().catch(() => "");
    })
    .catch((e) => {
      if (!finished) finishStream({ properties: { error: { message: e.message } } });
    });

  // 注意：这里使用同步 message 端点即可拿到流式事件（server 端一边生成一边发 /event），
  // 同时避免 prompt_async 与 /event 订阅之间的时序竞争。
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.type === "sync" && ev.syncEvent) ev = ev.syncEvent;
          const props = ev.properties || ev.data || {};
          if (props.sessionID && props.sessionID !== sid) continue;
          handleEvent(ev, props);
          if (finished) break;
        }
        if (finished) break;
      }
    }
  } catch (e) {
    if (!finished) finishStream({ properties: { error: { message: "event stream error: " + e.message } } });
  }
  await promptPromise;
  if (!finished) finishStream(null);
  if (normalEnd && streamContent) {
    if (!bufferMode) {
      cacheNextTurnKey(systemText, rest, { role: "assistant", content: streamContent }, sid);
    } else if (finalToolCalls.length) {
      cacheNextTurnKey(
        systemText,
        rest,
        { role: "assistant", content: finalContent, tool_calls: finalToolCalls },
        sid
      );
    } else {
      cacheNextTurnKey(systemText, rest, { role: "assistant", content: finalContent || streamContent }, sid);
    }
  }

  function handleEvent(ev, props) {
    resetIdle();
    switch (ev.type) {
      case "message.part.updated": {
        const p = props.part;
        if (p && p.type === "reasoning") reasoningParts.add(p.id);
        break;
      }
      case "message.part.delta": {
        if (props.field !== "text" && props.field !== undefined && props.field !== null) break;
        const delta = props.delta;
        if (typeof delta !== "string" || !delta) break;
        if (props.partID && reasoningParts.has(props.partID)) {
          writeChunk(chunk({ role: "assistant", reasoning_content: delta }, null));
        } else {
          streamContent += delta;
          if (!bufferMode) writeChunk(chunk({ role: "assistant", content: delta }, null));
        }
        break;
      }
      case "message.updated": {
        const msg = props.message || props.info;
        if (msg && msg.tokens) lastTokens = msg.tokens;
        break;
      }
      case "session.error": {
        finishStream(ev);
        break;
      }
      case "session.idle": {
        finishStream(null);
        break;
      }
      default:
        break;
    }
  }
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  res.on("finish", () => {
    log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  if (pathname === "/" || pathname === "/health") {
    return sendJson(res, 200, {
      name: "opencode-free-proxy",
      backend: backend ? backend.base : null,
      backendSource: backend ? backend.source || "desktop" : null,
      cli: CLI_ENABLED ? { path: CLI_PATH, port: CLI_PORT } : null,
      healthy: true,
    });
  }

  if (pathname.startsWith("/v1/")) {
    if (!checkAuth(req, res)) return;
  }

  try {
    if (req.method === "GET" && pathname === "/v1/models") {
      return await handleModels(res);
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendOpenAiError(res, 400, "invalid JSON body");
      }
      return await handleChatCompletion(req, res, body);
    }
    if (pathname.startsWith("/v1/")) {
      return sendOpenAiError(res, 404, "Not found: " + pathname, "invalid_request_error");
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    log("handler error:", e && e.stack ? e.stack : e);
    if (!res.headersSent) {
      sendOpenAiError(res, 500, e.message || "internal error", "server_error");
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
});

ensureBackend()
  .then(() => {
    server.listen(PROXY_PORT, PROXY_HOST, () => {
      log(`opencode-free-proxy listening on http://${PROXY_HOST}:${PROXY_PORT}`);
      log(`backend: ${backend.base}`);
      log(`api key: ${API_KEY ? "(configured)" : "(disabled)"}`);
    });
  })
  .catch((e) => {
    log("startup: backend discovery failed:", e.message);
    log("proxy will keep listening and retry discovery on first request");
    server.listen(PROXY_PORT, PROXY_HOST, () => {
      log(`opencode-free-proxy listening on http://${PROXY_HOST}:${PROXY_PORT} (backend not ready)`);
    });
  });

process.on("SIGINT", () => {
  log("shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
