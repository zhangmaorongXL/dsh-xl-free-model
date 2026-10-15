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

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XlFreeModelAdapter, PROVIDER } from "./adapter.js";

export const name = "dsh-xl-free-model";
export const version = "1.4.2";
export const inject = ["llm"];

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_BINARY = path.join(here, "cli", "node_modules", "opencode-windows-x64", "bin", "opencode.exe");
const CLI_DIR = path.join(here, "cli");
const CLI_PKG_VERSION = "1.19.0";
const CLI_TARBALL_URL =
  `https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-${CLI_PKG_VERSION}.tgz`;

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

function resolveNpmCmd() {
  if (process.platform !== "win32") return "npm";
  // dsh's PATH may not include the Node.js install dir; resolve npm.cmd next
  // to the running node.exe first, then fall back to PATH lookup.
  const beside = path.join(path.dirname(process.execPath), "npm.cmd");
  if (fs.existsSync(beside)) return beside;
  return "npm.cmd";
}

async function tryNpmInstall(ctx) {
  return new Promise((resolve) => {
    const npmCmd = resolveNpmCmd();
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xl-free-cli-"));
  const tarball = path.join(tmpDir, "pkg.tgz");
  const extractDir = path.join(tmpDir, "extract");
  try {
    log(ctx, "info", `Downloading opencode-windows-x64@${CLI_PKG_VERSION} (${CLI_TARBALL_URL})...`);
    const res = await fetch(CLI_TARBALL_URL, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tarball, buf);
    log(ctx, "info", `Downloaded ${(buf.length / 1048576).toFixed(1)} MB; extracting...`);

    fs.mkdirSync(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-xzf", tarball, "-C", extractDir], {
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
    log(ctx, "info", "CLI binary installed via direct download");
    return true;
  } catch (err) {
    log(ctx, "warn", `Direct download failed: ${err.message}`);
    return false;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function ensureCliBinary(ctx) {
  if (fs.existsSync(CLI_BINARY)) return true;
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
  const port = Number((options && options.port) || config.proxyPort || 8787);
  const apiKey = (options && options.apiKey) || config.apiKey || "";

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
    // Binary should already be ensured at load time; re-check as a safety net
    // before spawning so the proxy's CLI fallback has something to launch.
    if (!fs.existsSync(CLI_BINARY)) {
      log(ctx, "warn", "CLI binary missing right before proxy spawn; attempting install...");
      await ensureCliBinary(ctx);
    }
    const proxyMain = path.join(here, "proxy.cjs");
    if (!fs.existsSync(proxyMain)) {
      log(ctx, "error", `proxy.cjs missing at ${proxyMain}`);
      return;
    }
    log(ctx, "info", `starting proxy on 127.0.0.1:${port} (workspace: ${dshWorkdir})`);
    child = spawn(process.execPath, [proxyMain], {
      cwd: here,
      env: { ...process.env, OPENCODE_PROXY_DIRECTORY: dshWorkdir },
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", (code) => {
      child = null;
      if (!disposed) log(ctx, "warn", `proxy exited unexpectedly (code=${code}); will retry on next tick`);
    });
    child.on("error", (err) => {
      child = null;
      log(ctx, "error", `failed to start proxy: ${err.message}`);
    });
  };

  // Kick off CLI binary installation immediately at load time, independent
  // of proxy health. If missing, npm install runs in the background so the
  // headless fallback is ready by the time it's actually needed.
  ensureCliBinary(ctx).catch((err) =>
    log(ctx, "error", `ensureCliBinary failed: ${err.message}`)
  );

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

  ensure().catch((err) => log(ctx, "error", `ensure failed: ${err.message}`));

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
