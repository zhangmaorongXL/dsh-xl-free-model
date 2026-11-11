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
// prompt 返回后等待 /event 尾部增量的宽限时间（超时即按已收到的内容收尾）
const EVENTS_GRACE_MS = 1500;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

const config = loadConfig();
// index.js resolves the effective options (plugin options or proxy.config.json)
// and passes them to the child process through the environment. Honour those
// first so the spawned proxy and the registered adapter always agree.
const PROXY_HOST = process.env.OPENCODE_PROXY_FREE_HOST || config.proxyHost || "127.0.0.1";
const RAW_PROXY_PORT = Number(process.env.OPENCODE_PROXY_FREE_PORT || config.proxyPort || 8787);
const PROXY_PORT =
  Number.isInteger(RAW_PROXY_PORT) && RAW_PROXY_PORT > 0 && RAW_PROXY_PORT < 65536
    ? RAW_PROXY_PORT
    : 8787;
const API_KEY = process.env.OPENCODE_PROXY_FREE_API_KEY || config.apiKey || "";
// Workspace directory for the OpenCode backend. Priority:
//   1. OPENCODE_PROXY_DIRECTORY env (set by index.js from the dsh process cwd)
//   2. config.directory in proxy.config.json
//   3. process.cwd() as last resort
const DIRECTORY = process.env.OPENCODE_PROXY_DIRECTORY || config.directory || process.cwd();
const PROVIDER_ID = "opencode";

const BACKEND_CFG = (config.backend && config.backend) || {};
const CLI_CFG = (config.backend && config.backend.cli) || {};
const CLI_ENABLED = CLI_CFG.enabled !== false;
const CLI_PKG_VERSION = "1.19.0";
const CLI_PATH = path.resolve(
  __dirname,
  CLI_CFG.path ||
    path.join(
      "CLI",
      CLI_PKG_VERSION,
      "node_modules",
      "opencode-windows-x64",
      "bin",
      "opencode.exe"
    )
);
const CLI_PORT = Number(process.env.OPENCODE_PROXY_CLI_PORT || CLI_CFG.port || 4097);
const CLI_HOST = "127.0.0.1";
const CLI_LOG = path.join(__dirname, "cli-serve.log");
// One backend per distinct dsh workspace: OpenCode derives native tool
// permissions and its environment block from the CLI process cwd.
const CLI_POOL_MAX = 8;
const BACKEND_HOST = BACKEND_CFG.host || "127.0.0.1";
const BACKEND_PORT = Number(process.env.OPENCODE_PROXY_BACKEND_PORT || BACKEND_CFG.port || 0);
const BACKEND_PASSWORD = process.env.OPENCODE_PROXY_BACKEND_PASSWORD || BACKEND_CFG.password || "";
// 2.x sessions carry a permission ruleset instead of the 1.x prompt `tools`
// map. The text-based function-calling bridge needs native side-effect tools
// disabled; keep only read (matching the 1.x GATEWAY_SAFE_TOOLS policy), and
// explicitly allow the request's workspace so an equivalent `directory=` query
// still works when the backend was started elsewhere.
function v2SessionPermissions(directory) {
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ];
  const back = String(directory || "").replace(/\//g, "\\").replace(/\\+$/, "");
  if (back) {
    permissions.push({ action: "external_directory", resource: back + "\\*", effect: "allow" });
    permissions.push({
      action: "external_directory",
      resource: back.replace(/\\/g, "/") + "/*",
      effect: "allow",
    });
  }
  return permissions;
}

let backend = null; // { base, authHeader, password, source, api, version, dir? }
let backendIdentity = null;
let discovering = null;
let modelsCache = { time: 0, base: null, data: null };
let installedCliCache = null;
const cliPool = new Map(); // cwd key -> { child, password, port, backend, dir, lastUsed }
const cliStarting = new Map(); // cwd key -> Promise<backend|null>
const cliChildren = new Set();
const cliPendingPorts = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

class BackendError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = !!retryable;
  }
}

const pebCache = new Map();

function pebPassword(pid) {
  if (!fs.existsSync(PEB_SCRIPT)) return null;
  if (pid && pebCache.has(pid)) return pebCache.get(pid);
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PEB_SCRIPT, "OPENCODE_SERVER_PASSWORD"];
  if (pid) args.push(String(pid));
  const r = spawnSync("powershell", args, { encoding: "utf8", timeout: 20000, windowsHide: true });
  const value = r.status === 0 && r.stdout ? r.stdout.trim() : null;
  if (pid) pebCache.set(pid, value);
  return value || null;
}

function listOpenCodeProcesses() {
  const procs = [];
  try {
    const tl = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    if (tl.stdout) {
      for (const line of tl.stdout.split(/\r?\n/)) {
        const m = line.trim().match(/^"([^"]+)","(\d+)"/);
        if (!m) continue;
        const name = m[1];
        if (/^(opencode|opencode-cli)\.exe$/i.test(name)) {
          const pid = parseInt(m[2], 10);
          if (!isNaN(pid)) procs.push({ pid, name });
        }
      }
    }
  } catch {
    /* ignore */
  }
  return procs;
}

function listeningPortsForPids(pids) {
  const wanted = new Set(pids);
  const out = [];
  const ns = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  if (ns.stdout) {
    for (const line of ns.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[3] !== "LISTENING") continue;
      const pid = parseInt(parts[4], 10);
      if (!wanted.has(pid)) continue;
      const local = parts[1];
      if (!/^(127\.|0\.0\.0\.0:|\[::\]:|\[::1\]:)/.test(local)) continue;
      const port = parseInt(local.split(":").pop(), 10);
      if (port > 0 && !out.some((x) => x.port === port)) out.push({ port, pid });
    }
  }
  return out;
}

function compareVersionsDesc(a, b) {
  return b.localeCompare(a, undefined, { numeric: true });
}

/**
 * Prefer an already-installed OpenCode desktop CLI (2.x) and fall back to the
 * bundled pinned 1.19 binary. Results are cached for the process lifetime.
 */
function getInstalledCliPaths() {
  if (installedCliCache) return installedCliCache;
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "ai.opencode.desktop", "cli") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ai.opencode.desktop", "cli") : null,
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(compareVersionsDesc);
    } catch {
      continue;
    }
    for (const name of entries) {
      push(path.join(root, name, "opencode-cli.exe"));
      push(path.join(root, name, "opencode.exe"));
    }
  }

  for (const name of ["opencode-cli.exe", "opencode.exe"]) {
    try {
      const r = spawnSync("where", [name], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (r.status === 0 && r.stdout) {
        for (const line of r.stdout.split(/\r?\n/)) {
          const p = line.trim();
          if (p) push(p);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // The bundled 1.19 binary is the last resort: prefer every installed
  // desktop/standalone CLI (newest first) above.
  push(CLI_PATH);

  installedCliCache = out.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  return installedCliCache;
}

function makeBackend(base, probe, source) {
  return {
    base,
    authHeader: probe.auth,
    password: probe.password,
    source,
    api: probe.api || "v1",
    version: probe.version || null,
  };
}

/**
 * Detect the backend API generation. 2.x exposes /api/info and the /api/*
 * surface; 1.x exposes /config/providers. Both use Basic auth
 * (opencode:<OPENCODE_SERVER_PASSWORD>).
 */
async function probeBackend(base, password, timeoutMs = SHORT_TIMEOUT_MS) {
  const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  let sawUnauthorized = false;

  // 2.x probe
  try {
    const res = await fetch(base + "/api/info", {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      sawUnauthorized = true;
    } else if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const json = await res.json().catch(() => null);
        if (json && typeof json.version === "string") {
          return { auth, password, unauthorized: false, api: "v2", version: json.version };
        }
      }
    }
  } catch {
    /* fall through to 1.x probe */
  }

  // 1.x probe
  try {
    const res = await fetch(base + "/config/providers?directory=" + encodeURIComponent(DIRECTORY), {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { auth, password, unauthorized: true };
    }
    if (!res.ok) return sawUnauthorized ? { auth, password, unauthorized: true } : null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return null;
    const json = await res.json().catch(() => null);
    if (json && Array.isArray(json.providers)) {
      return { auth, password, unauthorized: false, api: "v1", version: null };
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------- headless CLI backend ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cliDirKey(directory) {
  return path.resolve(directory || DIRECTORY).toLowerCase();
}

function cliPortUsed(port) {
  if (cliPendingPorts.has(port)) return true;
  for (const entry of cliPool.values()) {
    if (entry && entry.port === port) return true;
  }
  return false;
}

function killCliPoolEntry(key) {
  const entry = cliPool.get(key);
  if (!entry) return;
  cliPool.delete(key);
  try {
    entry.child.kill();
  } catch {
    /* ignore */
  }
  if (backend === entry.backend) {
    backend = null;
    backendIdentity = null;
  }
}

function killAllCliChildren() {
  for (const child of cliChildren) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  cliChildren.clear();
}

/**
 * Spawn a headless OpenCode server with cwd = the dsh workspace. OpenCode
 * derives native tool permissions and its environment block from that cwd, so
 * one process per workspace is the only reliable way to keep them aligned.
 * Prefer the installed desktop CLI (2.x); the bundled 1.19 binary is the last
 * candidate.
 */
async function startCliBackend(directory) {
  const exes = getInstalledCliPaths();
  if (!exes.length) {
    log("no OpenCode CLI binary found (installed or bundled)");
    return null;
  }

  for (const exe of exes.slice(0, 4)) {
    for (let offset = 0; offset < 6; offset++) {
      const port = CLI_PORT + offset;
      if (cliPortUsed(port)) continue;
      cliPendingPorts.add(port);
      const password = crypto.randomBytes(16).toString("hex");
      let logFd = "ignore";
      try {
        logFd = fs.openSync(CLI_LOG, "a");
      } catch {
        /* ignore */
      }
      log(`spawning headless cli backend: ${exe} (${CLI_HOST}:${port}, cwd=${directory})`);
      let child;
      try {
        child = spawn(exe, ["serve", "--hostname", CLI_HOST, "--port", String(port)], {
          cwd: directory,
          env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        });
      } catch (e) {
        log("cli spawn failed:", e.message);
        cliPendingPorts.delete(port);
        if (typeof logFd === "number") {
          try { fs.closeSync(logFd); } catch { /* ignore */ }
        }
        continue;
      }

      cliChildren.add(child);
      let exited = false;
      child.on("exit", (code) => {
        exited = true;
        cliChildren.delete(child);
        log("cli backend exited, code=", code, "cwd=", directory);
      });
      child.on("error", (e) => {
        exited = true;
        cliChildren.delete(child);
        log("cli backend spawn error:", e.message);
      });

      let ready = null;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (!exited) {
          const r = await probeBackend(`http://${CLI_HOST}:${port}`, password);
          if (r && !r.unauthorized) {
            ready = r;
            break;
          }
        }
        if (exited && i > 3) break;
      }
      if (typeof logFd === "number") {
        try { fs.closeSync(logFd); } catch { /* ignore */ }
      }
      if (ready) {
        cliPendingPorts.delete(port);
        const b = makeBackend(`http://${CLI_HOST}:${port}`, { ...ready, password }, "cli");
        b.dir = directory;
        b.child = child;
        log(
          `headless cli backend ready: ${b.base} api=${b.api} version=${b.version || "?"} cwd=${directory}`
        );
        return b;
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      cliPendingPorts.delete(port);
      // A dead child usually means the binary is incompatible or the port is
      // taken; try the next port, then the next binary.
      if (!exited) log(`cli backend did not become ready on port ${port}; trying next port`);
    }
  }
  // The CLI may have been updated/removed while we were running; rescan on
  // the next discovery attempt instead of pinning stale paths forever.
  installedCliCache = null;
  log("headless cli backend failed to start for cwd=", directory);
  return null;
}

function evictCliPool() {
  while (cliPool.size > CLI_POOL_MAX) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [key, entry] of cliPool) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    log("evicting idle cli backend:", oldestKey);
    killCliPoolEntry(oldestKey);
  }
}

async function ensureCliBackendFor(directory) {
  const dir = path.resolve(directory || DIRECTORY);
  const key = cliDirKey(dir);

  // The globally discovered CLI may already serve this workspace.
  if (backend && backend.source === "cli" && backend.dir && cliDirKey(backend.dir) === key) {
    return backend;
  }

  const existing = cliPool.get(key);
  if (existing) {
    const alive = await probeBackend(existing.backend.base, existing.password);
    if (alive && !alive.unauthorized) {
      existing.lastUsed = Date.now();
      existing.backend = makeBackend(existing.backend.base, { ...alive, password: existing.password }, "cli");
      existing.backend.dir = dir;
      return existing.backend;
    }
    killCliPoolEntry(key);
  }

  const starting = cliStarting.get(key);
  if (starting) return starting;

  const promise = (async () => {
    const b = await startCliBackend(dir);
    if (b) {
      cliPool.set(key, {
        child: b.child,
        password: b.password,
        port: Number(new URL(b.base).port),
        backend: b,
        dir,
        lastUsed: Date.now(),
      });
      evictCliPool();
    }
    return b;
  })().finally(() => {
    cliStarting.delete(key);
  });
  cliStarting.set(key, promise);
  return promise;
}

async function ensureCliBackend() {
  if (!CLI_ENABLED) return null;
  return ensureCliBackendFor(DIRECTORY);
}

async function discoverBackend() {
  const passwords = [];
  const push = (p) => {
    if (p && !passwords.includes(p)) passwords.push(p);
  };
  push(BACKEND_PASSWORD);
  push(process.env.OPENCODE_SERVER_PASSWORD);

  let candidates = [];
  if (BACKEND_PORT) {
    candidates = [{ port: BACKEND_PORT, pid: null }];
  } else {
    const procs = listOpenCodeProcesses();
    candidates = listeningPortsForPids(procs.map((p) => p.pid));
    // PEB extraction is the slow part (one PowerShell/C# compile per call).
    // Inspect the port owners first; the single global scan below already
    // covers the Electron parent process that spawned the server.
    const ownerPids = new Set(candidates.map((c) => c.pid).filter(Boolean));
    for (const proc of procs) {
      if (ownerPids.has(proc.pid)) push(pebPassword(proc.pid));
    }
  }
  // The global scan is cheap enough and covers the Electron parent process.
  push(pebPassword(null));

  let sawUnauthorized = false;
  let foundV1 = null;
  for (const cand of candidates) {
    const base = `http://${BACKEND_HOST}:${cand.port}`;
    for (const password of passwords.length ? passwords : [""]) {
      const r = await probeBackend(base, password);
      if (r && !r.unauthorized) {
        if (r.api === "v2") {
          log(`backend discovered: ${base} api=v2 version=${r.version || "?"}`);
          return makeBackend(base, r, "desktop");
        }
        // Keep looking for a 2.x backend, but remember this 1.x fallback.
        if (!foundV1) foundV1 = makeBackend(base, r, "desktop");
        break;
      }
      if (r && r.unauthorized) sawUnauthorized = true;
    }
  }
  if (foundV1) {
    log(`backend discovered: ${foundV1.base} api=v1 (fallback)`);
    return foundV1;
  }

  if (CLI_ENABLED) {
    const cli = await ensureCliBackend();
    if (cli) return cli;
  }
  if (sawUnauthorized) {
    throw new BackendError(
      "已发现 opencode 后端端口但密码获取失败（可在 proxy.config.json 的 backend.password 中填写 OPENCODE_SERVER_PASSWORD）",
      false
    );
  }
  throw new BackendError("未发现 opencode 后端：桌面版未运行且无头 CLI 启动失败", true);
}

async function ensureBackend() {
  if (backend) return backend;
  if (!discovering) {
    discovering = discoverBackend()
      .then((b) => {
        const identity = b.base + "|" + (b.api || "v1") + "|" + (b.password || "");
        if (backendIdentity !== identity) {
          // A new backend process owns a fresh set of session ids: cached
          // sessions from the previous process would 404.
          backendIdentity = identity;
          sessionCache.clear();
          modelsCache = { time: 0, base: b.base, data: null };
        }
        backend = b;
        return b;
      })
      .finally(() => {
        discovering = null;
      });
  }
  return discovering;
}

/**
 * Resolve the backend that owns a dsh workspace. A per-workspace CLI is
 * preferred even when the desktop backend is discoverable: `directory=` only
 * selects the API project, while native tools and the environment block stay
 * rooted at the CLI process cwd.
 */
async function ensureBackendFor(directory) {
  const dir = path.resolve(directory || DIRECTORY);
  if (CLI_ENABLED) {
    const cli = await ensureCliBackendFor(dir);
    if (cli) return cli;
  }
  return ensureBackend();
}

process.on("exit", () => {
  killAllCliChildren();
});

function invalidateBackend() {
  if (backend && backend.source === "cli" && backend.dir) {
    killCliPoolEntry(cliDirKey(backend.dir));
  }
  backend = null;
  // Force a session-cache reset on the next discovery: a rediscovered backend
  // may be a different process with different session ids.
  backendIdentity = null;
}

function invalidateBackendObj(b) {
  if (b && b.source === "cli" && b.dir) {
    killCliPoolEntry(cliDirKey(b.dir));
    if (backend === b) {
      backend = null;
      backendIdentity = null;
    }
    return;
  }
  if (!b || b === backend) invalidateBackend();
}

async function backendFetchWith(b, method, pathname, body, timeoutMs = SHORT_TIMEOUT_MS) {
  let res;
  const opts = {
    method,
    headers: {
      authorization: b.authHeader,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  // timeoutMs <= 0 disables the absolute timeout (used for long-lived SSE such
  // as GET /event, which must not be aborted on a fixed clock).
  if (timeoutMs > 0) opts.signal = AbortSignal.timeout(timeoutMs);
  try {
    res = await fetch(b.base + pathname, opts);
  } catch (e) {
    invalidateBackendObj(b);
    throw new BackendError("无法连接 opencode 后端: " + e.message, true);
  }
  if (res.status === 401 || res.status === 403) {
    invalidateBackendObj(b);
    throw new BackendError("opencode 后端认证失败（密码可能已随桌面重启变化）", true);
  }
  return res;
}

async function backendFetch(method, pathname, body, timeoutMs = SHORT_TIMEOUT_MS) {
  return backendFetchWith(await ensureBackend(), method, pathname, body, timeoutMs);
}

async function backendJsonWith(b, method, pathname, body, timeoutMs = SHORT_TIMEOUT_MS) {
  const res = await backendFetchWith(b, method, pathname, body, timeoutMs);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep null */
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function backendJson(method, pathname, body, timeoutMs = SHORT_TIMEOUT_MS) {
  return backendJsonWith(await ensureBackend(), method, pathname, body, timeoutMs);
}

// ---------- OpenCode 2.x adapters ----------

function apiOf(b) {
  return (b && b.api) || "v1";
}

function toV2ModelRef(model, variant) {
  const ref = { id: normalizeModel(model), providerID: PROVIDER_ID };
  if (typeof variant === "string" && variant) ref.variant = variant;
  return ref;
}

/**
 * 2.x errors are { type, message, status, response:{body}, retryAfterMs };
 * normalize them to the descriptor shape used by the OpenAI response layer.
 */
function v2ErrorDescriptor(err) {
  if (!err || typeof err !== "object") {
    return {
      code: "OPENCODE_UNKNOWN",
      name: "UnknownError",
      message: typeof err === "string" && err ? err : "opencode 未提供错误详情",
      statusCode: null,
      detail: err || null,
    };
  }
  let message = typeof err.message === "string" ? err.message : "";
  if (!message && err.response && typeof err.response.body === "string") {
    const parsed = safeJson(err.response.body);
    const inner = parsed && parsed.error;
    if (inner && typeof inner.message === "string") message = inner.message;
  }
  const name = err.type || err.name || "UnknownError";
  const code =
    "OPENCODE_" +
    String(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return {
    code,
    name,
    message: message || String(name),
    statusCode: typeof err.status === "number" ? err.status : null,
    detail: err,
  };
}

function extractV2Text(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

function extractV2Reasoning(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

async function fetchV2AssistantMessage(sid, startedAt, assistantMessageID, ctx) {
  const r = await backendJsonWith(
    ctx.b,
    "GET",
    `/api/session/${sid}/message?order=desc&limit=20&` + dirQuery(ctx.dir)
  );
  if (!r.ok || !r.json) return null;
  const list = Array.isArray(r.json.data) ? r.json.data : [];
  if (assistantMessageID) {
    const match = list.find((msg) => msg && msg.type === "assistant" && msg.id === assistantMessageID);
    if (match) return match;
  }
  for (const msg of list) {
    if (!msg || msg.type !== "assistant") continue;
    const created = msg.time && msg.time.created;
    if (startedAt && typeof created === "number" && created < startedAt - 5000) continue;
    return msg;
  }
  return null;
}

/**
 * 2.x prompt body: text + file attachments only. Model selection happens at
 * session creation / switch time; the system prompt is folded into the first
 * user text because 2.x has no per-prompt `system` field.
 */
function buildPromptBodyV2(systemText, parts, created) {
  const texts = [];
  const files = [];
  if (created && systemText) texts.push(systemText);
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p) continue;
    if (p.type === "text" && p.text) {
      texts.push(p.text);
      continue;
    }
    if (p.type === "file" && typeof p.url === "string" && p.url) {
      // 2.x PromptInput.FileAttachment uses a single `uri` string (data: URI,
      // http(s) URL or local path). The older {data,mime,source} shape is only
      // used in persisted message payloads, not in prompt requests.
      const file = { uri: p.url };
      if (typeof p.filename === "string" && p.filename) file.name = p.filename;
      files.push(file);
    }
  }
  const out = {
    text: texts.join("\n\n"),
    delivery: "steer",
    resume: true,
  };
  if (files.length) out.files = files;
  return out;
}

async function withBackendRetry(fn, ctx) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BackendError && e.retryable) {
      log("backend failure, rediscovering:", e.message);
      if (ctx) {
        const old = ctx.b;
        if (old && old.source === "cli" && old.dir) {
          killCliPoolEntry(cliDirKey(old.dir));
        }
        if (backend === old) {
          backend = null;
          backendIdentity = null;
        }
        ctx.b = await ensureBackendFor(ctx.dir);
      } else {
        invalidateBackend();
        await ensureBackend();
      }
      return fn();
    }
    throw e;
  }
}

// ---------- sessions ----------

const sessionCache = new Map(); // key -> { sid, base }

function hashKey(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function dirQuery(directory) {
  return "directory=" + encodeURIComponent(directory || DIRECTORY);
}

function sessionDeletePath(sid, ctx) {
  return apiOf(ctx.b) === "v2" ? `/api/session/${sid}` : `/session/${sid}?${dirQuery(ctx.dir)}`;
}

function touchSession(key, sid, ctx) {
  if (sessionCache.has(key)) sessionCache.delete(key);
  sessionCache.set(key, { sid, base: ctx.b.base });
  while (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    const dropped = sessionCache.get(oldest);
    sessionCache.delete(oldest);
    if (dropped && dropped.base === ctx.b.base) {
      backendJsonWith(ctx.b, "DELETE", sessionDeletePath(dropped.sid, ctx)).catch(() => {});
    }
  }
}

async function createSession(model, variant, ctx) {
  const b = ctx.b;

  if (apiOf(b) === "v2") {
    const body = {
      model: toV2ModelRef(model, variant),
      permissions: v2SessionPermissions(ctx.dir),
    };
    let r = await backendJsonWith(b, "POST", "/api/session?" + dirQuery(ctx.dir), body);
    // A reasoning effort that the selected model does not expose is rejected
    // with 400. Retry once with the model's default variant rather than
    // failing the whole request.
    if (r.status === 400 && body.model.variant) {
      log("2.x session rejected variant", body.model.variant, "retrying with model default");
      const fallback = { ...body, model: toV2ModelRef(model, null) };
      r = await backendJsonWith(b, "POST", "/api/session?" + dirQuery(ctx.dir), fallback);
    }
    const sid = r.json && r.json.data && r.json.data.id;
    if (!r.ok || !sid) {
      throw new BackendError(
        "创建 opencode 2.x session 失败: HTTP " + r.status + " " + (r.text || ""),
        true
      );
    }
    return sid;
  }

  // 会话级权限：显式放行工作区外部目录 + read（原生 read 为网关校验所必需，
  // 同时避免 external_directory 默认 deny 污染模型）；其余副作用工具一律 deny（双保险）。
  const dirBack = (ctx.dir || "").replace(/\//g, "\\").replace(/\\+$/, "");
  const dirFwd = dirBack.replace(/\\/g, "/");
  const permission = [
    { permission: "external_directory", pattern: dirBack + "\\*", action: "allow" },
    { permission: "external_directory", pattern: dirFwd + "/*", action: "allow" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
  ];
  const r = await backendJsonWith(b, "POST", "/session?" + dirQuery(ctx.dir), { permission });
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
    "- The native session tool list is IRRELEVANT to the functions above: it does NOT make a function unavailable, denied, or 'not usable'. The functions above are ALWAYS available via the block format.",
    "- You may have ONE native session tool: read (file reading). You may use it directly to read files; it is a convenience only and does NOT replace the functions above.",
    "- ALL other functions (write, bash, glob, grep, edit, search/fetch, any custom function) are NOT native session tools: native API-level calls to them will be rejected. The ONLY valid mechanism is the block format below — the block format ALWAYS works for every listed function.",
    "- If any message says a function/tool is 'unavailable', 'denied', mentions a policy/permission failure, or lists 'available tools', that describes the native session environment only — it does NOT cancel these rules; still emit the block for the listed functions.",
    "- If the user's request matches a function above, emitting the block is MANDATORY — never refuse, never say the function cannot be used or is unavailable, and never pretend you already performed the action without emitting the block.",
  ].join("\n");
}

function collectToolCalls(obj, calls) {
  const arr = Array.isArray(obj.tool_calls) ? obj.tool_calls : obj && obj.name ? [obj] : [];
  let n = 0;
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
      n++;
    }
  }
  return n;
}

// 从 start（'{' 处）做字符串感知的平衡 JSON 扫描，返回 '}' 后一位下标；不闭合返回 -1
function scanJsonEnd(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractToolCalls(text) {
  if (!text) return { content: "", toolCalls: [] };
  // 归一化：剔除零宽/不可见字符，模型偶发在标记内部插入 U+200B 等导致正则失配
  const cleaned = text.replace(/[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]/g, "");
  const calls = [];
  const re = /<<<TOOL_CALL>>>\s*([\s\S]*?)\s*<<<END_TOOL_CALL>>>/g;
  let m;
  let found = false;
  while ((m = re.exec(cleaned))) {
    found = true;
    try {
      collectToolCalls(JSON.parse(m[1]), calls);
    } catch {
      /* malformed block, try salvage */
    }
  }
  if (calls.length) return { content: cleaned.replace(re, "").trim(), toolCalls: calls };

  // salvage：模型偶发截断结束标记（如 <<<END_TOOL_CALL>> 少一个 '>'）或只输出 JSON，
  // 对 BEGIN 之后（或全串）做平衡扫描定位完整 JSON 解析
  const bi = cleaned.lastIndexOf(TOOL_CALL_BEGIN);
  if (bi >= 0) {
    const after = cleaned.slice(bi + TOOL_CALL_BEGIN.length);
    let js = after.indexOf("{");
    while (js >= 0) {
      const end = scanJsonEnd(after, js);
      if (end < 0) break;
      try {
        const salvaged = [];
        if (collectToolCalls(JSON.parse(after.slice(js, end)), salvaged) && salvaged.length) {
          const rest = (cleaned.slice(0, bi) + after.slice(end))
            .replace(/\s*<*\s*END_TOOL_CALL\s*>*\s*$/i, "")
            .replace(/[\s<>]+$/, "")
            .trim();
          return { content: rest, toolCalls: salvaged };
        }
      } catch {
        /* not the payload object, try next '{' */
      }
      js = after.indexOf("{", js + 1);
    }
  } else {
    // 无 BEGIN：整串是 JSON（可能带尾部残留字符）
    const js = cleaned.indexOf("{");
    if (js >= 0) {
      const end = scanJsonEnd(cleaned, js);
      if (end > 0) {
        try {
          const salvaged = [];
          const obj = JSON.parse(cleaned.slice(js, end));
          if (Array.isArray(obj.tool_calls) && collectToolCalls(obj, salvaged) && salvaged.length) {
            return { content: "", toolCalls: salvaged };
          }
        } catch {
          /* not a tool-call json */
        }
      }
    }
  }
  if (found) return { content: cleaned.replace(re, "").trim(), toolCalls: [] };
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

function safeJson(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// opencode 的错误对象形如 { name: "APIError", data: { message, statusCode, ... } }，
// 也可能只是 { message } 或字符串。统一抽取成 dsh 可直接展示的结构，
// 保证「免费额度用尽」这类后端错误不再被吞成空回复。
function opencodeErrorDescriptor(err, fallbackName) {
  const name =
    err && typeof err === "object" && typeof err.name === "string" && err.name !== ""
      ? err.name
      : fallbackName || "UnknownError";
  let message = "";
  let detail = null;
  if (typeof err === "string") {
    message = err;
  } else if (err && typeof err === "object") {
    detail = err;
    const data = err.data && typeof err.data === "object" ? err.data : null;
    if (data && typeof data.message === "string" && data.message) message = data.message;
    else if (typeof err.message === "string" && err.message) message = err.message;
    if (!message && data) {
      const { message: _omit, ...rest } = data;
      const json = JSON.stringify(rest);
      if (json && json !== "{}") message = json;
    }
    if (!message) message = name;
  } else {
    message = "opencode 未提供错误详情";
  }
  const statusCode =
    (err && typeof err === "object" && typeof err.statusCode === "number" && err.statusCode) ||
    (err &&
      typeof err === "object" &&
      err.data &&
      typeof err.data.statusCode === "number" &&
      err.data.statusCode) ||
    null;
  const code =
    "OPENCODE_" +
    String(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return { code, name, message, statusCode, detail };
}

// 从事件帧 / 已规范化的错误 / 字符串里取出 opencode 错误描述；无错误返回 null。
function errorFromEvent(input) {
  if (!input) return null;
  if (input.__xlError === true) return input;
  if (typeof input === "string") return opencodeErrorDescriptor(input, "StreamError");
  const props = input.properties || {};
  if (props.error) return opencodeErrorDescriptor(props.error);
  if (input.error) return opencodeErrorDescriptor(input.error);
  return null;
}

// 事件里的 sessionID 可能位于顶层，也可能嵌在 info / message / part 中。
// 只过滤能明确归属到其它会话的事件，避免误丢没有 sessionID 的全局事件。
function eventSessionId(props) {
  if (!props || typeof props !== "object") return null;
  const candidates = [
    props.sessionID,
    props.sessionId,
    props.info && (props.info.sessionID || props.info.sessionId),
    props.message && (props.message.sessionID || props.message.sessionId),
    props.part && (props.part.sessionID || props.part.sessionId),
  ];
  for (const id of candidates) {
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

function isLoopbackRequest(req) {
  const address = (req && req.socket && req.socket.remoteAddress) || "";
  return address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address);
}

/**
 * dsh passes the session workspace in a request header (percent-encoded).
 * Validate it before using it as a child-process cwd; fall back to the
 * deployment directory so a malformed/removed workspace cannot wedge requests.
 */
function requestDirectory(req) {
  const raw = req.headers["x-dsh-working-directory"];
  if (typeof raw === "string" && raw !== "") {
    try {
      const decoded = decodeURIComponent(raw);
      const abs = path.resolve(decoded);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
      log("ignoring workspace directory that is not a directory:", abs);
    } catch (e) {
      log("invalid x-dsh-working-directory header:", e.message);
    }
  }
  return DIRECTORY;
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

function variantIdOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return "";
}

/** 2.x publishes variants as `[{ id, settings }]`; 1.x as an object keyed by id. */
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

function modelCreatedSeconds(model) {
  if (model && model.time && typeof model.time.released === "number") {
    return Math.floor(model.time.released / 1000);
  }
  if (model && typeof model.release_date === "string" && model.release_date !== "") {
    const time = new Date(model.release_date + "T00:00:00Z").getTime();
    if (Number.isFinite(time)) return Math.floor(time / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Keep the OpenAI model shape, but expose the fields the dsh adapter needs to
 * mirror OpenCode's reasoning levels (variants) instead of guessing them.
 */
function toWireModel(model, fallbackProvider) {
  if (!model || typeof model.id !== "string" || model.id === "") return null;
  const wire = {
    id: model.id,
    object: "model",
    created: modelCreatedSeconds(model),
    owned_by: model.providerID || fallbackProvider,
    name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
  };
  const variants = variantIdsOf(model.variants);
  if (variants.length) wire.variants = variants;
  const defaultVariant =
    variantIdOf(model.defaultVariant) || variantIdOf(model.default_variant);
  if (defaultVariant !== "" && variants.includes(defaultVariant)) {
    wire.default_variant = defaultVariant;
  }
  return wire;
}

async function listModels(b) {
  if (apiOf(b) === "v2") {
    const r = await backendJsonWith(b, "GET", "/api/model?" + dirQuery(b.dir || DIRECTORY));
    if (!r.ok || !r.json) {
      throw new BackendError(
        "获取 opencode 2.x 模型列表失败: HTTP " + r.status + " " + (r.text || "").slice(0, 300),
        true
      );
    }
    const list = Array.isArray(r.json.data) ? r.json.data : [];
    return list
      .filter((m) => m && m.providerID === PROVIDER_ID && m.enabled !== false)
      .map((m) => toWireModel(m, PROVIDER_ID))
      .filter(Boolean);
  }

  const r = await backendJsonWith(b, "GET", "/config/providers?" + dirQuery(b.dir || DIRECTORY));
  if (!r.ok || !r.json) {
    throw new BackendError(
      "获取 opencode 模型列表失败: HTTP " + r.status + " " + (r.text || "").slice(0, 300),
      true
    );
  }
  const providers = r.json.providers || [];
  const oc = providers.find((p) => p.id === PROVIDER_ID);
  const models = oc ? Object.values(oc.models || {}) : [];
  return models.map((m) => toWireModel(m, PROVIDER_ID)).filter(Boolean);
}

async function prefetchModels() {
  const b = backend;
  if (!b) return;
  if (modelsCache.data && modelsCache.base === b.base) return;
  try {
    const data = await listModels(b);
    modelsCache = { time: Date.now(), base: b.base, data };
    log(`models prefetched: ${data.length}`);
  } catch (e) {
    log("startup: model prefetch failed:", e.message);
  }
}

async function handleModels(res) {
  try {
    const b = await ensureBackend();
    const fresh =
      modelsCache.data && modelsCache.base === b.base && Date.now() - modelsCache.time < 60000;
    if (!fresh) {
      modelsCache = {
        time: Date.now(),
        base: b.base,
        data: await listModels(b),
      };
    }
    sendJson(res, 200, { object: "list", data: modelsCache.data });
  } catch (e) {
    sendOpenAiError(res, 502, e.message, "server_error");
  }
}

// ---------- chat completions ----------

async function resolveSession(messages, toolsPrompt, model, variant, ctx) {
  const { systemText: baseSystem, rest } = splitSystem(messages);
  const systemText = [baseSystem, toolsPrompt].filter(Boolean).join("\n\n") || null;
  if (!rest.length) {
    throw Object.assign(new Error("messages must contain at least one non-system message"), { status: 400 });
  }
  const last = rest[rest.length - 1];
  const history = rest.slice(0, -1);
  // Include the workspace + model/variant: sessions are owned by one backend
  // process and 2.x pins a model at creation time.
  const key = hashKey({
    d: (ctx.dir || "").toLowerCase(),
    s: systemText,
    m: model,
    v: variant || null,
    h: history.map(normalizeForHash),
  });

  let cached = sessionCache.get(key);
  if (cached && cached.base !== ctx.b.base) {
    // A restarted workspace backend owns a fresh set of session ids.
    sessionCache.delete(key);
    cached = null;
  }
  let sid = cached ? cached.sid : null;
  let parts;
  let created = false;

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
    touchSession(key, sid, ctx);
    log("session cache hit:", sid, "dir:", ctx.dir);
    if (tailStart < rest.length) {
      parts = [{ type: "text", text: renderToolTurn(rest.slice(tailStart)) }];
    } else {
      parts = messageToParts(last);
    }
  } else {
    sid = await createSession(model, variant, ctx);
    created = true;
    log("session created:", sid, "dir:", ctx.dir);
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
  return { sid, systemText, parts, rest, created };
}

function cacheNextTurnKey(systemText, rest, replyMsg, sid, model, variant, ctx) {
  // 下一轮客户端会带上 assistant 回复（含 tool_calls），用归一化文本保证 key 一致
  touchSession(
    hashKey({
      d: (ctx.dir || "").toLowerCase(),
      s: systemText,
      m: model,
      v: variant || null,
      h: [...rest.map(normalizeForHash), normalizeForHash(replyMsg)],
    }),
    sid,
    ctx
  );
}

// 网关放行要求最终工具集必须包含 read（实测 *+glob/*+write/*+todowrite 等均 403）；
// 仅保留原生 read（无副作用），write/bash/glob/grep 等一律不给原生入口，强制走文本协议由 dsh 执行。
const GATEWAY_SAFE_TOOLS = { "*": false, read: true };

function buildPromptBody(systemText, parts, body) {
  const prompt = {
    model: { providerID: PROVIDER_ID, modelID: normalizeModel(body.model) },
    parts,
    tools: { ...GATEWAY_SAFE_TOOLS },
  };
  if (systemText) prompt.system = systemText;
  // OpenCode variants are not limited to low/medium/high: free models also
  // expose none/minimal/xhigh/max. Pass any declared id through; unsupported
  // ids are surfaced by the backend instead of being silently downgraded.
  if (
    typeof body.reasoning_effort === "string" &&
    body.reasoning_effort.trim() !== ""
  ) {
    prompt.variant = body.reasoning_effort.trim();
  }
  return prompt;
}

function addTurnTokens(acc, tokens) {
  const t = tokens || {};
  const out = acc || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  out.input += t.input || 0;
  out.output += t.output || 0;
  out.reasoning += t.reasoning || 0;
  out.cache.read += (t.cache && t.cache.read) || 0;
  out.cache.write += (t.cache && t.cache.write) || 0;
  return out;
}

function finishReasonV2(finish) {
  switch (finish) {
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Execute one OpenCode 2.x turn.
 *
 * `POST /api/session/{id}/prompt` only admits input into the session inbox;
 * the assistant reply is delivered asynchronously on `GET /api/event`.
 * Subscribe first, wait for the execution terminator, accumulate text /
 * reasoning / tokens, then use the persisted assistant message as the
 * authoritative final value (the event stream may omit `*.ended` frames).
 */
async function runV2Turn(sid, promptBody, handlers = {}, ctx) {
  const onText = typeof handlers.onText === "function" ? handlers.onText : null;
  const onReasoning = typeof handlers.onReasoning === "function" ? handlers.onReasoning : null;
  const isAborted = typeof handlers.isAborted === "function" ? handlers.isAborted : () => false;

  const sse = await backendFetchWith(ctx.b, "GET", "/api/event?" + dirQuery(ctx.dir), undefined, 0);
  if (!sse.ok || !sse.body) {
    throw new BackendError("订阅 opencode 2.x 事件流失败: HTTP " + sse.status, true);
  }

  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  let readyDone = false;
  let readyResolve = null;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const state = {
    texts: new Map(),
    textOrder: [],
    reasonings: new Map(),
    reasoningOrder: [],
    assistantMessageID: null,
    finish: null,
    tokens: null,
    tokensSeen: new Set(),
    stepError: null,
    started: false,
    lastStatus: "",
    error: null,
  };

  let idleTimer = null;
  let overallTimer = null;

  const finishTurn = (error) => {
    if (finished) return;
    finished = true;
    state.error = error || null;
    if (idleTimer) clearTimeout(idleTimer);
    if (overallTimer) clearTimeout(overallTimer);
    resolveDone(state);
  };

  const markReady = () => {
    if (readyDone) return;
    readyDone = true;
    readyResolve();
  };

  const recordPart = (map, order, key, value, authoritative) => {
    let entry = map.get(key);
    if (!entry) {
      entry = { text: "" };
      map.set(key, entry);
      order.push(key);
    }
    if (authoritative) entry.text = value;
    else entry.text += value;
  };

  const partKey = (data) => {
    const mid = data.assistantMessageID || state.assistantMessageID || "turn";
    const ordinal = Number.isInteger(data.ordinal) ? data.ordinal : 0;
    return mid + ":" + ordinal;
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      finishTurn(
        state.stepError || {
          code: "OPENCODE_TIMEOUT",
          name: "TurnTimeout",
          message:
            "opencode 2.x 会话在 " + Math.round(SSE_IDLE_TIMEOUT_MS / 1000) + " 秒内没有响应",
          statusCode: null,
          detail: null,
        }
      );
      reader.cancel().catch(() => {});
    }, SSE_IDLE_TIMEOUT_MS);
  };

  const handleEvent = (ev) => {
    const type = typeof ev.type === "string" ? ev.type : "";
    if (!type) return;
    if (type === "server.connected" || type === "server.heartbeat") return;
    const data = ev.data && typeof ev.data === "object" ? ev.data : ev.properties || {};
    const evSid = eventSessionId(data);
    if (evSid && evSid !== sid) return;

    resetIdle();

    if (type === "session.execution.started") {
      state.started = true;
      return;
    }
    if (type === "session.step.started" || type === "session.text.started") {
      state.started = true;
      if (data.assistantMessageID) state.assistantMessageID = data.assistantMessageID;
      return;
    }
    if (type === "session.text.delta") {
      if (typeof data.delta !== "string" || !data.delta) return;
      if (data.assistantMessageID) state.assistantMessageID = data.assistantMessageID;
      recordPart(state.texts, state.textOrder, partKey(data), data.delta, false);
      if (onText) onText(data.delta, data);
      return;
    }
    if (type === "session.text.ended") {
      if (typeof data.text !== "string") return;
      recordPart(state.texts, state.textOrder, partKey(data), data.text, true);
      return;
    }
    if (type === "session.reasoning.started") {
      if (data.assistantMessageID) state.assistantMessageID = data.assistantMessageID;
      return;
    }
    if (type === "session.reasoning.delta") {
      if (typeof data.delta !== "string" || !data.delta) return;
      if (data.assistantMessageID) state.assistantMessageID = data.assistantMessageID;
      recordPart(state.reasonings, state.reasoningOrder, partKey(data), data.delta, false);
      if (onReasoning) onReasoning(data.delta, data);
      return;
    }
    if (type === "session.reasoning.ended") {
      if (typeof data.text !== "string") return;
      recordPart(state.reasonings, state.reasoningOrder, partKey(data), data.text, true);
      return;
    }
    if (type === "session.step.ended") {
      if (data.assistantMessageID) state.assistantMessageID = data.assistantMessageID;
      if (typeof data.finish === "string" && data.finish) state.finish = data.finish;
      if (data.tokens) {
        const tokenKey = data.assistantMessageID || "step:" + state.tokensSeen.size;
        if (!state.tokensSeen.has(tokenKey)) {
          state.tokensSeen.add(tokenKey);
          state.tokens = addTurnTokens(state.tokens, data.tokens);
        }
      }
      return;
    }
    if (type === "session.step.failed") {
      if (data.error) state.stepError = v2ErrorDescriptor(data.error);
      return;
    }
    if (type === "session.execution.succeeded") {
      finishTurn(null);
      return;
    }
    if (type === "session.execution.failed") {
      finishTurn(v2ErrorDescriptor(data.error || { message: "opencode 2.x 执行失败" }));
      return;
    }
    if (type === "session.execution.interrupted") {
      if (isAborted()) finishTurn(null);
      else {
        finishTurn({
          code: "OPENCODE_INTERRUPTED",
          name: "ExecutionInterrupted",
          message: "opencode 2.x 会话执行被中断",
          statusCode: null,
          detail: data,
        });
      }
      return;
    }
    if (type === "provider.free-limit") {
      // Terminal quota error: `session.execution.failed` usually follows, but
      // do not risk waiting for it (and hanging until the idle timeout).
      finishTurn(v2ErrorDescriptor(data.error || data));
      return;
    }
    if (type === "session.retry.scheduled") {
      if (typeof data.message === "string" && data.message) state.lastStatus = data.message;
      return;
    }
    if (type === "session.idle") {
      if (state.started) finishTurn(state.stepError || null);
      return;
    }
    if (type === "session.status") {
      const status = data.status || {};
      if (status.type === "idle" && state.started) finishTurn(state.stepError || null);
      else if (status.type === "retry" && typeof status.message === "string") {
        state.lastStatus = status.message;
      }
      return;
    }
    if (type === "session.error") {
      finishTurn(v2ErrorDescriptor(data.error || data));
    }
  };

  const pump = (async () => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        markReady();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let ev = null;
            try {
              ev = JSON.parse(payload);
            } catch {
              continue;
            }
            handleEvent(ev);
            if (finished) return;
          }
        }
      }
      if (!finished) {
        finishTurn(
          state.stepError || {
            code: "OPENCODE_EVENT_STREAM_CLOSED",
            name: "EventStreamClosed",
            message: "opencode 2.x 事件流意外结束",
            statusCode: null,
            detail: null,
          }
        );
      }
    } catch (e) {
      if (!finished) {
        finishTurn({
          code: "OPENCODE_EVENT_STREAM_ERROR",
          name: "EventStreamError",
          message: "opencode 2.x 事件流错误: " + e.message,
          statusCode: null,
          detail: null,
        });
      }
    } finally {
      markReady();
      if (idleTimer) clearTimeout(idleTimer);
      if (overallTimer) clearTimeout(overallTimer);
    }
  })();

  resetIdle();
  overallTimer = setTimeout(() => {
    finishTurn({
      code: "OPENCODE_TIMEOUT",
      name: "TurnTimeout",
      message:
        "opencode 2.x 会话超过 " + Math.round(BACKEND_TIMEOUT_MS / 1000) + " 秒未完成",
      statusCode: null,
      detail: null,
    });
    reader.cancel().catch(() => {});
  }, BACKEND_TIMEOUT_MS);

  // Wait briefly for the SSE handshake so the first deltas are not missed.
  await Promise.race([ready, sleep(2000)]);

  const promptStartedAt = Date.now();
  try {
    const pr = await backendJsonWith(ctx.b, "POST", `/api/session/${sid}/prompt?${dirQuery(ctx.dir)}`, promptBody);
    if (!pr.ok) {
      const payload = pr.json ? pr.json.error || pr.json : null;
      finishTurn(
        v2ErrorDescriptor(
          payload || {
            message: "提交 opencode 2.x prompt 失败: HTTP " + pr.status + " " + (pr.text || ""),
          }
        )
      );
    }
  } catch (e) {
    finishTurn({
      code: "OPENCODE_PROMPT_FAILED",
      name: "PromptFailed",
      message: "提交 opencode 2.x prompt 失败: " + e.message,
      statusCode: null,
      detail: null,
    });
  }

  const result = await done;
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }

  result.text = state.textOrder.map((k) => state.texts.get(k).text).join("");
  result.reasoning = state.reasoningOrder.map((k) => state.reasonings.get(k).text).join("");

  if (!result.error) {
    let final = null;
    try {
      final = await fetchV2AssistantMessage(sid, promptStartedAt, state.assistantMessageID, ctx);
    } catch {
      /* ignore: accumulated event text is enough */
    }
    if (final) {
      const finalText = extractV2Text(final.content);
      const finalReasoning = extractV2Reasoning(final.content);
      if (finalText && finalText.length >= result.text.length) result.text = finalText;
      if (finalReasoning && finalReasoning.length >= result.reasoning.length) {
        result.reasoning = finalReasoning;
      }
      if (typeof final.finish === "string" && final.finish) result.finish = final.finish;
      if (final.tokens) result.tokens = final.tokens;
      if (final.error) result.error = v2ErrorDescriptor(final.error);
    }
  }

  await pump.catch(() => {});
  return result;
}

async function handleChatCompletionV2(res, resolved, body) {
  const { sid, systemText, parts, rest, created, model, variant, stream, includeUsage, toolsPrompt, ctx } =
    resolved;
  const promptBody = buildPromptBodyV2(systemText, parts, created);
  const id = "chatcmpl-" + crypto.randomBytes(8).toString("hex");
  const createdSec = Math.floor(Date.now() / 1000);
  const bufferMode = !!toolsPrompt;
  const meta = () => ({
    sessionId: sid,
    backend: ctx.b ? ctx.b.base : null,
    backendSource: ctx.b ? ctx.b.source : null,
    model,
  });
  const errorPayload = (desc) => ({
    message: desc.message,
    type: "server_error",
    param: null,
    code: desc.code || null,
    upstream: desc.name || null,
    status: typeof desc.statusCode === "number" ? desc.statusCode : null,
    opencode: desc.detail ?? null,
    ...meta(),
  });

  if (!stream) {
    let result;
    try {
      result = await runV2Turn(sid, promptBody, {}, ctx);
    } catch (e) {
      return sendJson(res, 502, {
        error: errorPayload({
          message: e.message,
          code: e.code || "OPENCODE_BACKEND_ERROR",
          name: e.name || "BackendError",
          statusCode: e.status || null,
          detail: e.opencode ?? null,
        }),
      });
    }
    if (result.error) {
      log("opencode 2.x model error:", result.error.code, "|", result.error.message);
      return sendJson(res, 502, { error: errorPayload(result.error) });
    }
    const rawText = result.text || "";
    const parsed = extractToolCalls(rawText);
    const hasToolCalls = parsed.toolCalls.length > 0;
    if (!rawText && !hasToolCalls && !result.reasoning) {
      log("opencode 2.x returned an empty reply (no content, no tool calls, no error)");
      return sendJson(res, 502, {
        error: errorPayload({
          message: "opencode 返回了空回复（无内容、无工具调用、无错误信息）",
          code: "OPENCODE_EMPTY_REPLY",
          name: "EmptyReply",
          statusCode: null,
          detail: null,
        }),
      });
    }
    const assistantMsg = hasToolCalls
      ? { role: "assistant", content: parsed.content, tool_calls: parsed.toolCalls }
      : { role: "assistant", content: rawText };
    if (toolsPrompt && !hasToolCalls) {
      log("tools requested but no tool_calls parsed, raw:", JSON.stringify(rawText).slice(0, 400));
    }
    cacheNextTurnKey(systemText, rest, assistantMsg, sid, model, variant, ctx);
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created: createdSec,
      model: body.model || model,
      choices: [
        {
          index: 0,
          message: assistantMsg,
          finish_reason: hasToolCalls ? "tool_calls" : finishReasonV2(result.finish),
        },
      ],
      usage: usageOf(result.tokens),
    });
  }

  // ---- streaming ----
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  const writeChunk = (delta, finish) => {
    res.write(
      "data: " +
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: createdSec,
          model: body.model || model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        "\n\n"
    );
  };
  writeChunk({ role: "assistant", content: "" }, null);

  let streamFinished = false;
  let clientClosed = false;
  let streamContent = "";

  res.on("close", () => {
    if (streamFinished) return;
    clientClosed = true;
    // Client went away: stop the 2.x execution instead of letting it run on.
    backendJsonWith(ctx.b, "POST", `/api/session/${sid}/interrupt?${dirQuery(ctx.dir)}&resume=false`, {}).catch(
      () => {}
    );
  });

  let result;
  try {
    result = await runV2Turn(sid, promptBody, {
      onText: (delta) => {
        if (streamFinished || clientClosed) return;
        streamContent += delta;
        if (!bufferMode) writeChunk({ role: "assistant", content: delta }, null);
      },
      onReasoning: (delta) => {
        if (streamFinished || clientClosed) return;
        writeChunk({ role: "assistant", reasoning_content: delta }, null);
      },
      isAborted: () => clientClosed,
    }, ctx);
  } catch (e) {
    if (clientClosed) return;
    streamFinished = true;
    writeChunk(
      {
        error: errorPayload({
          message: e.message,
          code: e.code || "OPENCODE_BACKEND_ERROR",
          name: e.name || "BackendError",
          statusCode: e.status || null,
          detail: e.opencode ?? null,
        }),
      },
      null
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (clientClosed) return;
  streamFinished = true;

  if (result.error) {
    log("stream error (v2):", result.error.code, "|", result.error.message);
    writeChunk({ error: errorPayload(result.error) }, null);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const fullText = result.text || streamContent;
  let normal = true;
  if (bufferMode) {
    const parsed = extractToolCalls(fullText);
    const hasToolCalls = parsed.toolCalls.length > 0;
    if (!hasToolCalls && fullText.includes(TOOL_CALL_BEGIN)) {
      log(
        "stream (v2): block marker present but no tool_calls parsed, raw:",
        JSON.stringify(fullText).slice(0, 400),
        "| len:",
        fullText.length
      );
    }
    if (parsed.content) writeChunk({ role: "assistant", content: parsed.content }, null);
    if (hasToolCalls) {
      writeChunk({ tool_calls: parsed.toolCalls.map((tc, index) => ({ index, ...tc })) }, null);
      writeChunk({}, "tool_calls");
    } else if (fullText || result.reasoning) {
      writeChunk({}, finishReasonV2(result.finish));
    } else {
      normal = false;
    }
    if (normal) {
      const assistantMsg = hasToolCalls
        ? { role: "assistant", content: parsed.content, tool_calls: parsed.toolCalls }
        : { role: "assistant", content: parsed.content || fullText };
      cacheNextTurnKey(systemText, rest, assistantMsg, sid, model, variant, ctx);
    }
  } else {
    if (!streamContent && fullText) writeChunk({ role: "assistant", content: fullText }, null);
    if (streamContent || fullText || result.reasoning) {
      writeChunk({}, finishReasonV2(result.finish));
      cacheNextTurnKey(systemText, rest, { role: "assistant", content: fullText }, sid, model, variant, ctx);
    } else {
      normal = false;
    }
  }

  if (!normal) {
    const message = "opencode 返回了空回复（无内容、无工具调用、无错误信息）";
    log("stream error (v2): OPENCODE_EMPTY_REPLY |", message);
    writeChunk(
      {
        error: errorPayload({
          message,
          code: "OPENCODE_EMPTY_REPLY",
          name: "EmptyReply",
          statusCode: null,
          detail: null,
        }),
      },
      null
    );
  } else if (includeUsage && result.tokens) {
    res.write(
      "data: " +
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: createdSec,
          model: body.model || model,
          choices: [],
          usage: usageOf(result.tokens),
        }) +
        "\n\n"
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleChatCompletion(req, res, body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendOpenAiError(res, 400, "messages is required and must be a non-empty array");
  }

  const model = normalizeModel(body.model);
  // `reasoning_effort` carries an OpenCode variant id here, not OpenAI's
  // off/none alias. Keep `none` (a real variant on several free models) and
  // let createSession() fall back to the provider default if the backend
  // rejects an unknown id.
  const variant =
    typeof body.reasoning_effort === "string" && body.reasoning_effort.trim() !== ""
      ? body.reasoning_effort.trim()
      : null;
  const stream = !!body.stream;
  const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
  const toolsPrompt = buildToolsPrompt(body.tools);
  const directory = requestDirectory(req);
  log(
    "chat", stream ? "stream" : "sync",
    "tools:", Array.isArray(body.tools) ? body.tools.length : 0,
    "toolsPrompt:", !!toolsPrompt,
    "dir:", directory
  );

  let resolved;
  let api = "v1";
  let ctx;
  try {
    const b = await ensureBackendFor(directory);
    ctx = { b, dir: directory };
    api = apiOf(b);
    resolved = await withBackendRetry(
      () =>
        resolveSession(body.messages, toolsPrompt, model, variant, ctx).then((r) => ({
          ...r,
          model,
          variant,
          ctx,
        })),
      ctx
    );
  } catch (e) {
    const errBody = {
      error: {
        message: e.message,
        type: "server_error",
        param: null,
        code: null,
        opencode: e.opencode ?? null,
        sessionId: e.sessionId ?? null,
        backend: ctx && ctx.b ? ctx.b.base : null,
        backendSource: ctx && ctx.b ? ctx.b.source : null,
        model: model
      }
    };
    if (e.status) return sendJson(res, e.status, errBody);
    return sendJson(res, 502, errBody);
  }

  const { sid, systemText, parts, rest } = resolved;
  if (toolsPrompt && parts.length) {
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.type === "text") {
      lastPart.text +=
        "\n\n(Reminder: if an available function applies, emit the tool call block per the system prompt; the runtime will execute it.)";
    }
  }
  if (api === "v2") {
    return handleChatCompletionV2(
      res,
      { ...resolved, stream, includeUsage, toolsPrompt, ctx },
      body
    );
  }
  const promptBody = buildPromptBody(systemText, parts, body);
  const dirQ = dirQuery(ctx.dir);
  const id = "chatcmpl-" + crypto.randomBytes(8).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let r;
    try {
      r = await withBackendRetry(() =>
        backendJsonWith(ctx.b, "POST", `/session/${sid}/message?${dirQ}`, promptBody, BACKEND_TIMEOUT_MS),
        ctx
      );
    } catch (e) {
      return sendJson(res, 502, {
        error: {
          message: e.message,
          type: "server_error",
          param: null,
          code: null,
          opencode: e.opencode ?? null,
          sessionId: sid,
          backend: ctx.b ? ctx.b.base : null,
          backendSource: ctx.b ? ctx.b.source : null,
          model: model
        }
      });
    }
    if (!r.ok) {
      const desc = opencodeErrorDescriptor(
        safeJson(r.text) || { message: "opencode backend error: HTTP " + r.status + " " + (r.text || "") },
        "BackendHTTPError"
      );
      log("opencode backend error:", r.status, desc.code, "|", desc.message);
      return sendJson(res, 502, {
        error: {
          message: desc.message,
          type: "server_error",
          param: null,
          code: desc.code,
          upstream: desc.name,
          status: r.status,
          opencode: desc.detail,
          sessionId: sid,
          backend: ctx.b ? ctx.b.base : null,
          backendSource: ctx.b ? ctx.b.source : null,
          model: model
        }
      });
    }
    const info = (r.json && r.json.info) || {};
    if (info.error) {
      const desc = opencodeErrorDescriptor(info.error);
      log("opencode model error:", desc.code, "|", desc.message);
      return sendJson(res, 502, {
        error: {
          message: "opencode model error: " + desc.message,
          type: "server_error",
          param: null,
          code: desc.code,
          upstream: desc.name,
          status: desc.statusCode,
          opencode: info.error,
          sessionId: sid,
          backend: ctx.b ? ctx.b.base : null,
          backendSource: ctx.b ? ctx.b.source : null,
          model: model
        }
      });
    }
    const rawText = extractResponseText(r.json && r.json.parts);
    const parsed = extractToolCalls(rawText);
    if (!rawText && !parsed.toolCalls.length) {
      log("opencode returned an empty reply (no content, no tool calls, no error)");
      return sendJson(res, 502, {
        error: {
          message: "opencode 返回了空回复（无内容、无工具调用、无错误信息）",
          type: "server_error",
          param: null,
          code: "OPENCODE_EMPTY_REPLY",
          upstream: "EmptyReply",
          opencode: null,
          sessionId: sid,
          backend: ctx.b ? ctx.b.base : null,
          backendSource: ctx.b ? ctx.b.source : null,
          model: model
        }
      });
    }
    if (toolsPrompt && !parsed.toolCalls.length) {
      log("tools requested but no tool_calls parsed, raw:", JSON.stringify(rawText).slice(0, 400));
    }
    const assistantMsg = parsed.toolCalls.length
      ? { role: "assistant", content: parsed.content, tool_calls: parsed.toolCalls }
      : { role: "assistant", content: rawText };
    cacheNextTurnKey(systemText, rest, assistantMsg, sid, model, variant, ctx);
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
    sse = await backendFetchWith(ctx.b, "GET", "/event?" + dirQ, undefined, 0);
  } catch (e) {
    return sendJson(res, 502, {
      error: {
        message: e.message,
        type: "server_error",
        param: null,
        code: null,
        opencode: e.opencode ?? null,
        sessionId: sid,
        backend: ctx.b ? ctx.b.base : null,
        backendSource: ctx.b ? ctx.b.source : null,
        model: model
      }
    });
  }
  if (!sse.ok || !sse.body) {
    return sendJson(res, 502, {
      error: {
        message: "failed to subscribe opencode event stream",
        type: "server_error",
        param: null,
        code: null,
        opencode: null,
        sessionId: sid,
        backend: ctx.b ? ctx.b.base : null,
        backendSource: ctx.b ? ctx.b.source : null,
        model: model
      }
    });
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
  const userMessageIds = new Set();
  let lastTokens = null;
  let finished = false;
  let idleTimer = null;
  let reader = null;
  let normalEnd = false;
  let streamContent = "";
  // True once the final text was taken from the prompt response / a completed
  // part. Later event deltas are then redundant and must not be appended a
  // second time (the prompt response can win the race against /event).
  let streamContentFromFallback = false;
  const bufferMode = !!toolsPrompt; // 带 tools 时缓冲 content，结束统一输出，避免调用标记泄漏
  let finalToolCalls = [];
  let finalContent = "";
  let lastStatusMessage = "";
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finishStream("stream idle timeout"), SSE_IDLE_TIMEOUT_MS);
  };

  function finishStream(errorInput) {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    const desc = errorInput ? errorFromEvent(errorInput) : null;
    try {
      if (desc) {
        normalEnd = false;
        // bufferMode 下已缓冲的部分文本先以去标记形式输出，再报错（adapter 会先 flush 增量再抛）
        if (bufferMode && streamContent) {
          const partial = extractToolCalls(streamContent);
          if (partial.content) writeChunk(chunk({ role: "assistant", content: partial.content }, null));
        }
        log("stream error:", desc.code, "|", desc.message);
        writeChunk({ error: {
          message: desc.message,
          type: "server_error",
          code: desc.code,
          upstream: desc.name,
          status: desc.statusCode ?? null,
          opencode: desc.detail ?? null,
          sessionId: sid,
          backend: ctx.b ? ctx.b.base : null,
          backendSource: ctx.b ? ctx.b.source : null,
          model: model
        } });
      } else {
        normalEnd = true;
        let normal = true;
        if (bufferMode) {
          const parsed = extractToolCalls(streamContent);
          finalToolCalls = parsed.toolCalls;
          finalContent = parsed.content;
          if (!finalToolCalls.length && streamContent.includes(TOOL_CALL_BEGIN)) {
            log(
              "stream: block marker present but no tool_calls parsed, raw:",
              JSON.stringify(streamContent).slice(0, 400),
              "| len:", streamContent.length,
              "head:", Array.from(streamContent.slice(0, 16)).map((c) => c.charCodeAt(0)).join(","),
              "hasEnd:", streamContent.includes(TOOL_CALL_END)
            );
          }
          if (!finalContent && !finalToolCalls.length) {
            normal = false;
          } else {
            if (finalContent) writeChunk(chunk({ role: "assistant", content: finalContent }, null));
            if (finalToolCalls.length) {
              writeChunk(
                chunk(
                  { tool_calls: finalToolCalls.map((tc, index) => ({ index, ...tc })) },
                  null
                )
              );
              res.write("data: " + JSON.stringify(chunk({}, "tool_calls")) + "\n\n");
            } else {
              res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
            }
          }
        } else if (!streamContent) {
          normal = false;
        } else {
          res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
        }
        if (!normal) {
          // 后端既没有内容也没有错误：绝不能静默结束，否则 dsh 只能看到「无信息回复」
          normalEnd = false;
          const msg = lastStatusMessage
            ? "opencode 返回空回复：" + lastStatusMessage
            : "opencode 返回了空回复（无内容、无工具调用、无错误信息）";
          log("stream error: OPENCODE_EMPTY_REPLY", "|", msg);
          writeChunk({ error: {
            message: msg,
            type: "server_error",
            code: "OPENCODE_EMPTY_REPLY",
            upstream: "EmptyReply",
            status: null,
            opencode: null,
            sessionId: sid,
            backend: backend ? backend.base : null,
            backendSource: backend ? backend.source : null,
            model: model
          } });
        } else if (includeUsage && lastTokens) {
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
      backendFetchWith(ctx.b, "POST", `/session/${sid}/abort?${dirQ}`, {}).catch(() => {});
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
  // 同步 message 端点本身返回本轮最终 assistant message（含 info.error）。
  // 以前的实现只在非流式分支解析它，流式分支完全丢弃响应体：一旦后端把
  // 「免费额度用尽」写进 info.error 而不是发 session.error 事件，代理就会
  // 一直挂着直到 dsh 侧取消 —— 表现就是「大模型无信息回复」。这里把它当作
  // 权威的收尾信号。
  const promptPromise = backendFetchWith(ctx.b, "POST", `/session/${sid}/message?${dirQ}`, promptBody, BACKEND_TIMEOUT_MS)
    .then(async (r) => {
      promptStatus = r.status;
      const text = await r.text().catch(() => "");
      if (finished) return undefined;
      if (!r.ok) {
        const parsed = safeJson(text);
        const upstream = parsed && parsed.error ? parsed.error : null;
        const desc = opencodeErrorDescriptor(
          upstream || { message: "opencode backend error: HTTP " + r.status + " " + text.slice(0, 400) },
          "BackendHTTPError"
        );
        log("prompt failed:", r.status, desc.code, "|", desc.message);
        finishStream({ ...desc, __xlError: true });
        return undefined;
      }
      const json = safeJson(text);
      const info = (json && json.info) || null;
      const parts = (json && json.parts) || null;
      if (info && info.error) {
        const desc = opencodeErrorDescriptor(info.error);
        log("message error:", desc.code, "|", desc.message);
        finishStream({ ...desc, __xlError: true });
        return undefined;
      }
      // 事件流可能因为版本/过滤原因没有任何增量：用响应体兜底，避免空回复
      if (!streamContent) {
        const fallbackText = extractResponseText(parts);
        if (fallbackText) {
          streamContent = fallbackText;
          streamContentFromFallback = true;
          if (!bufferMode) writeChunk(chunk({ role: "assistant", content: fallbackText }, null));
        }
      }
      return undefined;
    })
    .catch((e) => {
      if (!finished) {
        finishStream({
          ...opencodeErrorDescriptor({ name: "BackendFetchError", message: "无法连接 opencode 后端: " + e.message }, "BackendFetchError"),
          __xlError: true,
        });
      }
    });

  // 注意：这里使用同步 message 端点即可拿到流式事件（server 端一边生成一边发 /event），
  // 同时避免 prompt_async 与 /event 订阅之间的时序竞争。
  const consumeFrames = () => {
    let idx;
    while (!finished && (idx = buf.indexOf("\n\n")) >= 0) {
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
        const evSid = eventSessionId(props);
        if (evSid && evSid !== sid) continue;
        handleEvent(ev, props);
        if (finished) return;
      }
    }
  };

  // 事件流可能一个增量都不推（版本差异/过滤），必须同时等待 prompt 完成，
  // 否则 reader.read() 会一直挂着，dsh 侧只能看到空回复。
  // 关键：仍只保留一个进行中的 read，prompt 先完成时把该 read 留给宽限循环消费，
  // 避免 Promise.race 丢掉已经到达的分片（丢分片会丢掉 delta / idle）。
  let pendingRead = null;
  const startRead = () => {
    if (!pendingRead) {
      pendingRead = reader.read().then(
        (v) => ({ kind: "read", v }),
        (e) => ({ kind: "error", e })
      );
    }
    return pendingRead;
  };
  try {
    const promptSignal = promptPromise.then(() => "prompt", () => "prompt");
    while (!finished) {
      const raced = await Promise.race([startRead(), promptSignal]);
      if (raced === "prompt") break;
      pendingRead = null;
      if (raced.kind === "error") throw raced.e;
      if (raced.v.done) break;
      buf += decoder.decode(raced.v.value, { stream: true });
      consumeFrames();
    }
  } catch (e) {
    if (!finished) {
      finishStream({
        ...opencodeErrorDescriptor({ name: "EventStreamError", message: "opencode event stream error: " + e.message }, "EventStreamError"),
        __xlError: true,
      });
    }
  }
  await promptPromise;
  // prompt 返回即代表本轮结束；再给 /event 尾部增量一点时间落地，然后收尾。
  if (!finished) {
    const deadline = Date.now() + EVENTS_GRACE_MS;
    while (!finished) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remain);
      });
      let raced;
      try {
        raced = await Promise.race([startRead(), timeout]);
      } catch {
        break;
      }
      if (timer) clearTimeout(timer);
      if (!raced || raced.kind === "timeout") break;
      pendingRead = null;
      if (raced.kind === "error") break;
      if (raced.v.done) break;
      buf += decoder.decode(raced.v.value, { stream: true });
      consumeFrames();
    }
  }
  if (!finished) finishStream(null);
  if (normalEnd && streamContent) {
    if (!bufferMode) {
      cacheNextTurnKey(
        systemText,
        rest,
        { role: "assistant", content: streamContent },
        sid,
        model,
        variant
      );
    } else if (finalToolCalls.length) {
      cacheNextTurnKey(
        systemText,
        rest,
        { role: "assistant", content: finalContent, tool_calls: finalToolCalls },
        sid,
        model,
        variant
      );
    } else {
      cacheNextTurnKey(
        systemText,
        rest,
        { role: "assistant", content: finalContent || streamContent },
        sid,
        model,
        variant
      );
    }
  }

  function handleEvent(ev, props) {
    resetIdle();
    switch (ev.type) {
      case "message.part.updated": {
        const p = props.part;
        if (!p) break;
        const mid = p.messageID || p.messageId || props.messageID || null;
        if (mid && userMessageIds.has(mid)) break;
        if (p.type === "reasoning") reasoningParts.add(p.id);
        // 兼容只推 part.updated（不推 delta）的后端版本：没有增量时用整段文本兜底
        if (
          p.type === "text" &&
          !streamContent &&
          typeof p.text === "string" &&
          p.text &&
          p.time &&
          p.time.end
        ) {
          streamContent = p.text;
          streamContentFromFallback = true;
          if (!bufferMode) writeChunk(chunk({ role: "assistant", content: p.text }, null));
        }
        break;
      }
      case "message.part.delta": {
        const mid = props.messageID || props.messageId || (props.part && (props.part.messageID || props.part.messageId)) || null;
        if (mid && userMessageIds.has(mid)) break;
        if (props.field !== "text" && props.field !== undefined && props.field !== null) break;
        const delta = props.delta;
        if (typeof delta !== "string" || !delta) break;
        if (props.partID && reasoningParts.has(props.partID)) {
          writeChunk(chunk({ role: "assistant", reasoning_content: delta }, null));
        } else {
          // The prompt response fallback already carries the final text.
          if (streamContentFromFallback) break;
          streamContent += delta;
          if (!bufferMode) writeChunk(chunk({ role: "assistant", content: delta }, null));
        }
        break;
      }
      case "message.updated": {
        const msg = props.info || props.message;
        if (!msg) break;
        // User-message updates (and their parts) must never be mistaken for a
        // completed assistant turn. They arrive first in every request, so
        // finishing here used to produce an immediate OPENCODE_EMPTY_REPLY.
        if (msg.role === "user") {
          if (msg.id) userMessageIds.add(msg.id);
          break;
        }
        if (msg.role && msg.role !== "assistant") break;
        if (msg.tokens) lastTokens = msg.tokens;
        // 新版后端会把模型失败写进 assistant message 的 error 字段
        if (msg.error) {
          const desc = errorFromEvent({ properties: { error: msg.error } });
          finishStream(
            desc
              ? { ...desc, __xlError: true }
              : { ...opencodeErrorDescriptor(msg.error, "MessageError"), __xlError: true }
          );
        }
        break;
      }
      case "session.status": {
        const status = props.status || {};
        // busy / other transient statuses are informational: the turn is still
        // running. Only idle is a completion signal.
        if (status.type === "idle") {
          lastStatusMessage = "";
          finishStream(null);
          break;
        }
        if (status.type === "retry") {
          lastStatusMessage =
            typeof status.message === "string" && status.message
              ? status.message
              : "opencode 正在重试上游请求";
          const msg = "opencode 返回错误：" + lastStatusMessage;
          log("stream error: OPENCODE_QUOTA", "|", msg);
          // Route this through finishStream so the SSE response always gets a
          // [DONE] terminator and res.end(); the old branch forgot both and
          // left the adapter waiting until its read timeout.
          finishStream({
            __xlError: true,
            code: "OPENCODE_QUOTA",
            name: "FreeTierLimit",
            message: msg,
            statusCode: 429,
            detail: status,
          });
        }
        break;
      }
      case "session.error": {
        // A session error without a parseable detail is still an error — never
        // fall through to a normal finish.
        const desc = errorFromEvent(ev);
        finishStream(
          desc
            ? { ...desc, __xlError: true }
            : {
                ...opencodeErrorDescriptor(
                  props.error || { name: "SessionError", message: "opencode 会话错误（后端未提供错误详情）" },
                  "SessionError"
                ),
                __xlError: true,
              }
        );
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
    const health = {
      name: "opencode-free-proxy",
      proxy: { baseUrl: `http://${PROXY_HOST}:${PROXY_PORT}`, host: PROXY_HOST, port: PROXY_PORT },
      hasApiKey: !!API_KEY,
      backend: backend ? backend.base : null,
      backendSource: backend ? backend.source || "desktop" : null,
      backendApi: backend ? backend.api || "v1" : null,
      backendVersion: backend ? backend.version || null : null,
      backendReady: !!backend,
      cli: CLI_ENABLED
        ? {
            path: CLI_PATH,
            port: CLI_PORT,
            defaultDirectory: DIRECTORY,
            workspaces: [...cliPool.values()].map((entry) => entry.dir),
          }
        : null,
      healthy: true,
    };
    // The settings page runs in the same machine's browser and needs the key
    // to call /v1/models. Never expose it to non-loopback clients.
    if (API_KEY && isLoopbackRequest(req)) health.apiKey = API_KEY;
    return sendJson(res, 200, health);
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
      sendJson(res, 500, {
        error: {
          message: e.message || "internal error",
          type: "server_error",
          param: null,
          code: null,
          opencode: e.opencode ?? null,
          sessionId: e.sessionId ?? null,
          backend: e.backend ?? null,
          backendSource: e.backendSource ?? null,
          model: e.model ?? null
        }
      });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
});

// Listen first: /health and the settings page must answer immediately even
// while backend discovery (process scan / headless CLI spawn) is still running.
server.listen(PROXY_PORT, PROXY_HOST, () => {
  log(`opencode-free-proxy listening on http://${PROXY_HOST}:${PROXY_PORT}`);
  log(`api key: ${API_KEY ? "(configured)" : "(disabled)"}`);
  ensureBackend()
    .then(() => {
      log(
        `backend: ${backend.base} api=${backend.api || "v1"} version=${backend.version || "?"}`
      );
      // Warm the model cache in the background: the first 2.x /api/model call
      // against a freshly spawned CLI can take several seconds, and the
      // settings page only waits a few seconds.
      prefetchModels();
    })
    .catch((e) => {
      log("startup: backend discovery failed:", e.message);
      log("proxy keeps listening; discovery retries on the first request");
    });
});

process.on("SIGINT", () => {
  log("shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
