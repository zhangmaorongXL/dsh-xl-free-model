/**
 * dsh-xl-free-model — Host half.
 *
 * Mounts the local OpenAI-compatible proxy that forwards free-model traffic
 * through the OpenCode backend (desktop or headless CLI). On mount it:
 *
 *   1. reads apiKey from the bundled proxy.config.json;
 *   2. publishes it as process.env.OPENCODE_PROXY_FREE_API_KEY (unless the
 *      deployment already set it);
 *   3. adopts an already-running proxy on the configured port, or spawns
 *      `node proxy.cjs` as a child process and supervises it;
 *   4. registers a structural LlmAdapter so the free models appear directly
 *      in the session model picker (no profile cordis.patch.yml needed);
 *   5. kills the child and unregisters the adapter on dispose.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XlFreeModelAdapter, PROVIDER } from "./adapter.js";

export const name = "dsh-xl-free-model";
export const version = "1.9.0";
export const inject = ["llm"];

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_VERSION = "1.19.0";
// Every download/install artefact stays inside the plugin folder and is keyed
// by version, so upgrades never share a half-written tree and the plugin owns
// no state outside its own directory.
const CLI_ROOT = path.join(here, "CLI");
const CLI_DIR = path.join(CLI_ROOT, CLI_PKG_VERSION);
const CLI_BINARY = path.join(
  CLI_DIR,
  "node_modules",
  "opencode-windows-x64",
  "bin",
  "opencode.exe"
);
const CLI_TARBALL_URL =
  `https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-${CLI_PKG_VERSION}.tgz`;
// The bundled 1.19 CLI is only a last-resort fallback. The long-term path is
// to reuse the OpenCode desktop CLI that is already installed on the machine,
// so never block proxy startup on this download.
const DOWNLOAD_DIR = path.join(CLI_DIR, ".download");
const DOWNLOAD_PART = path.join(DOWNLOAD_DIR, `opencode-windows-x64-${CLI_PKG_VERSION}.tgz.part`);
const DOWNLOAD_TARBALL = path.join(DOWNLOAD_DIR, `opencode-windows-x64-${CLI_PKG_VERSION}.tgz`);
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, "proxy.config.json"), "utf8"));
  } catch {
    return {};
  }
}

async function probeHealth(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function log(ctx, level, message) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === "function") logger[level](message);
  else console[level === "error" ? "error" : "log"](`[dsh-xl-free-model] ${message}`);
}

let cliInstallPromise = null;

function ensureCliPackageJson() {
  const pkgPath = path.join(CLI_DIR, "package.json");
  try {
    if (fs.existsSync(pkgPath)) return;
    fs.mkdirSync(CLI_DIR, { recursive: true });
    fs.writeFileSync(
      pkgPath,
      JSON.stringify(
        { name: "opencode-cli-host", private: true, dependencies: { "opencode-ai": `^${CLI_PKG_VERSION}` } },
        null,
        2
      ) + "\n"
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Locate an already-installed OpenCode CLI (desktop 2.x preferred).
 *
 * The desktop app bundles its CLI under
 *   %APPDATA%\ai.opencode.desktop\cli\<version>-x64\opencode-cli.exe
 * and keeps updating it. Reusing that binary is the long-term path: no
 * download, no stale pinned 1.19 runtime.
 */
function findInstalledCli() {
  const candidates = [CLI_BINARY];
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
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const name of entries) {
      candidates.push(path.join(root, name, "opencode-cli.exe"));
      candidates.push(path.join(root, name, "opencode.exe"));
    }
  }

  for (const name of ["opencode-cli.exe", "opencode.exe"]) {
    try {
      const r = spawnSync("where", [name], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (r.status === 0 && r.stdout) {
        for (const line of r.stdout.split(/\r?\n/)) {
          const p = line.trim();
          if (p) candidates.push(p);
        }
      }
    } catch {
      /* ignore */
    }
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function resolveNpmCmd() {
  if (process.platform !== "win32") return "npm";
  // dsh runs the host inside Electron, so PATH may not include Node/npm.
  // Check the common install locations before giving up.
  const candidates = [
    path.join(path.dirname(process.execPath), "npm.cmd"),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs", "npm.cmd") : null,
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "nodejs", "npm.cmd")
      : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "npm.cmd") : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  try {
    const r = spawnSync("where", ["npm.cmd"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function tryNpmInstall(ctx) {
  return new Promise((resolve) => {
    const npmCmd = resolveNpmCmd();
    if (!npmCmd) {
      log(ctx, "warn", "npm not found on PATH; skipping npm fallback");
      resolve(false);
      return;
    }
    log(ctx, "debug", `spawning: ${npmCmd} install (cwd=${CLI_DIR})`);
    const npm = spawn(npmCmd, ["install"], {
      cwd: CLI_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: true,
    });
    let stderr = "";
    npm.stdout?.on("data", (d) => log(ctx, "debug", `npm: ${String(d).trim()}`));
    npm.stderr?.on("data", (d) => { stderr += d; });
    npm.on("error", (err) => {
      log(ctx, "warn", `npm spawn failed: ${err.message}`);
      resolve(false);
    });
    npm.on("exit", (code) => {
      if (code === 0 && fs.existsSync(CLI_BINARY)) {
        log(ctx, "info", "CLI binary installed via npm");
        resolve(true);
      } else {
        log(ctx, "warn", `npm install failed (code=${code}): ${stderr.trim().slice(0, 300)}`);
        resolve(false);
      }
    });
  });
}

async function tryDirectDownload(ctx) {
  const extractDir = path.join(DOWNLOAD_DIR, "extract");
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      let resumeAt = 0;
      try {
        resumeAt = fs.statSync(DOWNLOAD_PART).size;
      } catch {
        resumeAt = 0;
      }
      const headers = resumeAt > 0 ? { range: `bytes=${resumeAt}-` } : {};
      log(
        ctx,
        "info",
        `Downloading opencode-windows-x64@${CLI_PKG_VERSION} (attempt ${attempt}, resume=${resumeAt})...`
      );
      const res = await fetch(CLI_TARBALL_URL, {
        headers,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`registry responded ${res.status}`);

      const append = resumeAt > 0 && res.status === 206;
      if (!append) {
        try {
          fs.rmSync(DOWNLOAD_PART, { force: true });
        } catch {
          /* ignore */
        }
        resumeAt = 0;
      }
      const total = Number(res.headers.get("content-length") || 0) + resumeAt;
      const fd = fs.openSync(DOWNLOAD_PART, append ? "a" : "w");
      let received = resumeAt;
      let lastLog = Date.now();
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          fs.writeSync(fd, Buffer.from(value));
          received += value.length;
          if (Date.now() - lastLog > 5000) {
            const pct = total > 0 ? ` ${((received / total) * 100).toFixed(1)}%` : "";
            log(ctx, "info", `CLI download: ${(received / 1048576).toFixed(1)} MB${pct}`);
            lastLog = Date.now();
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      if (total > 0 && received < total) {
        throw new Error(`incomplete download ${received}/${total}`);
      }
      fs.renameSync(DOWNLOAD_PART, DOWNLOAD_TARBALL);
      log(ctx, "info", `Downloaded ${(received / 1048576).toFixed(1)} MB; extracting...`);

      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      await new Promise((resolve, reject) => {
        const tar = spawn("tar", ["-xzf", DOWNLOAD_TARBALL, "-C", extractDir], {
          windowsHide: true,
          shell: false,
        });
        tar.on("error", reject);
        tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit code ${code}`))));
      });

      // npm tarballs nest files under "package/"
      const src = path.join(extractDir, "package", "bin", "opencode.exe");
      if (!fs.existsSync(src)) throw new Error("opencode.exe not found inside tarball");
      fs.mkdirSync(path.dirname(CLI_BINARY), { recursive: true });
      fs.copyFileSync(src, CLI_BINARY);
      fs.rmSync(extractDir, { recursive: true, force: true });
      try {
        fs.rmSync(DOWNLOAD_TARBALL, { force: true });
      } catch {
        /* ignore */
      }
      log(ctx, "info", "CLI binary installed via direct download");
      return true;
    } catch (err) {
      lastError = err;
      log(ctx, "warn", `Direct download attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  log(ctx, "warn", `Direct download failed: ${lastError ? lastError.message : "unknown error"}`);
  return false;
}

async function ensureCliBinary(ctx) {
  // Prefer any CLI already installed on the machine (desktop 2.x included);
  // the bundled 1.19 binary is only needed when nothing else exists.
  if (findInstalledCli()) return true;
  if (cliInstallPromise) return cliInstallPromise;
  log(ctx, "info", "OpenCode CLI binary not found; installing...");

  cliInstallPromise = (async () => {
    // Primary: direct tarball download — works even when dsh's PATH has no npm.
    if (await tryDirectDownload(ctx)) return true;
    // Fallback: npm install (resolves npm.cmd next to the running node.exe).
    log(ctx, "info", "Falling back to npm install...");
    ensureCliPackageJson();
    return await tryNpmInstall(ctx);
  })().finally(() => {
    cliInstallPromise = null;
  });

  return cliInstallPromise;
}

export function apply(ctx, options) {
  const config = readConfig();
  const configuredPort = Number((options && options.port) || config.proxyPort || 8787);
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      ? configuredPort
      : 8787;
  // An environment value supplied by the deployment wins over plugin options
  // and proxy.config.json so a preconfigured proxy and this adapter agree.
  const apiKey =
    process.env.OPENCODE_PROXY_FREE_API_KEY || (options && options.apiKey) || config.apiKey || "";

  // Capture the dsh process's cwd (the user's selected workspace) before we
  // spawn the proxy with cwd=here; without this the proxy would treat the
  // plugin folder as the backend workspace.
  const dshWorkdir = process.cwd();

  if (apiKey && !process.env.OPENCODE_PROXY_FREE_API_KEY) {
    process.env.OPENCODE_PROXY_FREE_API_KEY = apiKey;
  }

  let child = null;
  let disposed = false;
  let registration = null;

  const killChild = () => {
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      child = null;
    }
  };

  const ensure = async () => {
    if (disposed) return;
    if (await probeHealth(port)) {
      log(ctx, "info", `adopted existing proxy on 127.0.0.1:${port}`);
      return;
    }
    if (child) return;
    // Never block proxy startup on CLI installation. proxy.cjs listens first
    // and discovers a usable backend (installed OpenCode 2.x CLI, running
    // desktop backend, or the bundled 1.19 CLI) in the background.
    const proxyMain = path.join(here, "proxy.cjs");
    if (!fs.existsSync(proxyMain)) {
      log(ctx, "error", `proxy.cjs missing at ${proxyMain}`);
      return;
    }
    log(ctx, "info", `starting proxy on 127.0.0.1:${port} (workspace: ${dshWorkdir})`);
    // 代理日志落到文件：以前 stdio:"ignore" 让代理侧完全黑盒，opencode 上游报错
    // 只能靠后端日志间接排查。超过 4MB 自动截断，避免长期运行无限增长。
    const proxyLog = path.join(here, "proxy.log");
    let out = "ignore";
    let err = "ignore";
    let fd = null;
    try {
      if (fs.existsSync(proxyLog) && fs.statSync(proxyLog).size > 4 * 1024 * 1024) {
        fs.writeFileSync(proxyLog, "");
      }
      fd = fs.openSync(proxyLog, "a");
      out = fd;
      err = fd;
      log(ctx, "info", `proxy log -> ${proxyLog}`);
    } catch {
      fd = null;
      out = "ignore";
      err = "ignore";
    }
    child = spawn(process.execPath, [proxyMain], {
      cwd: here,
      env: {
        ...process.env,
        OPENCODE_PROXY_DIRECTORY: dshWorkdir,
        OPENCODE_PROXY_FREE_PORT: String(port),
        ...(apiKey ? { OPENCODE_PROXY_FREE_API_KEY: apiKey } : {}),
      },
      stdio: ["ignore", out, err],
      windowsHide: true,
    });
    if (fd !== null) {
      // 子进程已继承句柄，父进程不再需要它
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    child.on("exit", (code) => {
      child = null;
      if (!disposed) log(ctx, "warn", `proxy exited unexpectedly (code=${code}); will retry on next tick`);
    });
    child.on("error", (err) => {
      child = null;
      log(ctx, "error", `failed to start proxy: ${err.message}`);
    });
  };

  // Long-term path: reuse the OpenCode desktop CLI that is already installed
  // (2.x). Only fall back to the pinned 1.19 download when the machine has no
  // usable CLI at all, and always do it in the background.
  const installedCli = findInstalledCli();
  if (installedCli) {
    log(ctx, "info", `using installed OpenCode CLI: ${installedCli}`);
  } else {
    ensureCliBinary(ctx).catch((err) =>
      log(ctx, "error", `ensureCliBinary failed: ${err.message}`)
    );
  }

  // Register the adapter immediately so the picker shows the provider even
  // while the proxy is still booting; listModels falls back until it answers.
  if (ctx && ctx.llm && typeof ctx.llm.registerAdapter === "function") {
    const adapter = new XlFreeModelAdapter({
      port,
      apiKey,
      logger: ctx.logger,
    });
    try {
      registration = ctx.llm.registerAdapter([PROVIDER], adapter);
      log(ctx, "info", `registered llm adapter route "${PROVIDER}"`);
    } catch (err) {
      log(ctx, "error", `registerAdapter failed: ${err && err.message}`);
    }
    // Declare the route as a configurable provider so the settings surface
    // can activate/edit it without a restart (optional, non-fatal).
    try {
      if (typeof ctx.llm.registerConfigurableProviders === "function") {
        ctx.llm.registerConfigurableProviders([
          {
            provider: PROVIDER,
            displayName: "XL Free Model",
            settingsNs: name,
            settingsPath: [],
          },
        ]);
        log(ctx, "info", `declared configurable provider "${PROVIDER}"`);
      }
    } catch (err) {
      log(ctx, "debug", `registerConfigurableProviders skipped: ${err && err.message}`);
    }
  } else {
    log(ctx, "warn", "ctx.llm unavailable; models will not appear in the picker");
  }

  ensure().catch((err) => {
    log(ctx, "error", `ensure failed: ${err.message}`);
    // Log a helpful message about the free tier restriction
    if (err.message && err.message.includes("free tier")) {
      log(ctx, "warn", "Free tier models require OpenCode desktop. See https://opencode.ai");
    }
  });

  const timer = setInterval(() => {
    ensure().catch(() => {});
  }, 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();

  if (ctx && typeof ctx.on === "function") {
    ctx.on("dispose", () => {
      disposed = true;
      clearInterval(timer);
      killChild();
      if (registration && typeof registration.dispose === "function") {
        try {
          registration.dispose();
        } catch {
          /* ignore */
        }
      }
      registration = null;
    });
  }
}
