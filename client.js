/**
 * XL Free Model — browser half.
 *
 * Contributes one settings section (`settings.section` id `xl-free-model`,
 * label "XL Free Model") that shows the local proxy status and the live
 * free-model roster fetched from the proxy's OpenAI-compatible API.
 *
 * Hand-written ModuleLoader bundle: no build step, only the `react` the
 * shell already provides. All colour comes from theme variables with
 * literal fallbacks so the page survives scheme switches.
 */
window.__ModuleLoader__.load({
  id: "dsh-xl-free-model",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const { createElement: h, useState, useEffect, useCallback, useMemo } = React;

    const NS = "settings.xlFreeModel";
    const inject = ["slots", "locale"];

    const PROXY =
      (typeof globalThis !== "undefined" &&
        typeof globalThis.__XL_FREE_MODEL_PROXY__ === "string" &&
        globalThis.__XL_FREE_MODEL_PROXY__) ||
      "http://127.0.0.1:8787";

    const DICT = {
      zh: {
        nav: "XL Free Model",
        title: "XL 免费模型",
        subtitle: "本地 OpenAI 兼容代理 · 经 OpenCode 免费通道",
        statusOn: "代理运行中",
        statusOff: "代理未运行",
        statusUnknown: "检测中…",
        backend: "后端",
        baseUrl: "Base URL",
        apiKey: "API Key",
        modelsTitle: "可用模型",
        modelsHint: "在会话模型选择列表中使用下列模型（provider: xl-free-model），点击 ID 可复制。",
        refresh: "刷新",
        retry: "重试",
        loading: "加载中…",
        loadFail: "无法获取模型列表：请确认代理已启动。",
        count: "共 {n} 个模型",
        copied: "已复制",
        copy: "复制 ID",
        levels: "推理等级",
        pickerNote: "模型已自动注册到会话的模型选择列表；支持推理等级的模型可在选择器中切换档位。",
        notSet: "未设置",
      },
      en: {
        nav: "XL Free Model",
        title: "XL Free Model",
        subtitle: "Local OpenAI-compatible proxy · routed via the OpenCode free tier",
        statusOn: "Proxy running",
        statusOff: "Proxy not running",
        statusUnknown: "Checking…",
        backend: "Backend",
        baseUrl: "Base URL",
        apiKey: "API Key",
        modelsTitle: "Available models",
        modelsHint: "Use the model IDs below in the session model picker (provider: xl-free-model). Click an ID to copy.",
        refresh: "Refresh",
        retry: "Retry",
        loading: "Loading…",
        loadFail: "Cannot fetch models: make sure the proxy is running.",
        count: "{n} models",
        copied: "Copied",
        copy: "Copy ID",
        levels: "Reasoning levels",
        pickerNote: "Models are auto-registered in the session model picker; models with reasoning support expose a level selector there.",
        notSet: "not set",
      },
    };

    function buildDict(t) {
      const translate = typeof t === "function" ? t : (key) => key;
      const tr = (key, params) => {
        const translated = translate(key, params);
        // Locale dictionaries only cover zh/en; fall back to zh instead of
        // showing raw keys when the active locale has no entry.
        if (typeof translated === "string" && translated !== key) return translated;
        const template = DICT.zh[key] ?? key;
        return typeof params === "object" && params !== null
          ? template.replace(/\{(\w+)\}/g, (match, name) =>
              name in params ? String(params[name]) : match
            )
          : template;
      };
      return {
        nav: tr("nav"),
        title: tr("title"),
        subtitle: tr("subtitle"),
        statusOn: tr("statusOn"),
        statusOff: tr("statusOff"),
        statusUnknown: tr("statusUnknown"),
        backend: tr("backend"),
        baseUrl: tr("baseUrl"),
        apiKey: tr("apiKey"),
        modelsTitle: tr("modelsTitle"),
        modelsHint: tr("modelsHint"),
        refresh: tr("refresh"),
        retry: tr("retry"),
        loading: tr("loading"),
        loadFail: tr("loadFail"),
        count: (n) => tr("count", { n }),
        copied: tr("copied"),
        copy: tr("copy"),
        levels: tr("levels"),
        pickerNote: tr("pickerNote"),
        notSet: tr("notSet"),
      };
    }

    const CSS = `
.xlfm-page { display: flex; flex-direction: column; gap: 20px; padding: 4px 0; color: var(--dsw-alias-text-primary, inherit); }
.xlfm-status { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-radius: 12px; background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.08)); }
.xlfm-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.xlfm-dot.on { background: var(--dsw-static-green-500, #22c55e); box-shadow: 0 0 8px var(--dsw-static-green-500, #22c55e); }
.xlfm-dot.off { background: var(--dsw-static-red-500, #ef4444); }
.xlfm-dot.unknown { background: var(--dsw-static-neutral-bluish-400, #9ca3af); }
.xlfm-status-text { font-size: 14px; font-weight: 500; }
.xlfm-backend { margin-left: auto; font-size: 12px; color: var(--dsw-alias-text-secondary, #888); font-family: ui-monospace, monospace; }
.xlfm-meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; padding: 0 4px; margin: 0; }
.xlfm-meta dt { color: var(--dsw-alias-text-secondary, #888); }
.xlfm-meta dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
.xlfm-section { display: flex; flex-direction: column; gap: 10px; }
.xlfm-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.xlfm-section-title { margin: 0; font-size: 14px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.xlfm-count { color: var(--dsw-alias-text-secondary, #888); font-size: 12px; font-weight: 400; }
.xlfm-hint { font-size: 12px; color: var(--dsw-alias-text-secondary, #888); margin: 0; line-height: 1.5; }
.xlfm-btn { border: 1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3)); background: transparent; color: inherit; border-radius: 8px; padding: 5px 16px; font-size: 13px; cursor: pointer; transition: background .12s; }
.xlfm-btn:hover { background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.08)); }
.xlfm-btn:disabled { opacity: .5; cursor: default; }
.xlfm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.xlfm-card { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.06)); border: 1px solid transparent; transition: border-color .12s, background .12s; position: relative; }
.xlfm-card:hover { border-color: var(--dsw-alias-border-secondary, rgba(127,127,127,.25)); background: var(--dsw-alias-bg-tertiary, rgba(127,127,127,.1)); }
.xlfm-card-top { display: flex; align-items: center; gap: 8px; }
.xlfm-badge { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-static-green-500, #22c55e); opacity: .7; }
.xlfm-card-id { font-family: ui-monospace, monospace; font-size: 12.5px; font-weight: 500; word-break: break-all; line-height: 1.4; flex: 1; min-width: 0; }
.xlfm-copy { flex: none; border: none; background: transparent; color: var(--dsw-alias-text-secondary, #888); cursor: pointer; padding: 2px 6px; border-radius: 6px; font-size: 11px; opacity: 0; transition: opacity .12s, background .12s, color .12s; }
.xlfm-card:hover .xlfm-copy { opacity: 1; }
.xlfm-copy:hover { background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.12)); color: var(--dsw-alias-text-primary, inherit); }
.xlfm-copy.done { opacity: 1; color: var(--dsw-static-green-500, #22c55e); }
.xlfm-card-tag { font-size: 11px; color: var(--dsw-alias-text-secondary, #888); }
.xlfm-levels { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.xlfm-levels-label { font-size: 11px; color: var(--dsw-alias-text-secondary, #888); }
.xlfm-level { font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1.5; padding: 0 6px; border-radius: 999px; color: var(--dsw-alias-text-secondary, #888); background: var(--dsw-alias-bg-tertiary, rgba(127,127,127,.12)); }
.xlfm-msg { font-size: 13px; color: var(--dsw-alias-text-secondary, #888); padding: 12px 0; }
.xlfm-footer { display: flex; align-items: center; gap: 12px; }
`;

    async function fetchJson(url, init) {
      // A cold proxy may need to discover/start the OpenCode backend and warm
      // its model list; 5s was too tight and surfaced "Failed to fetch"-style
      // errors in the settings page.
      const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, init || {}));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }

    function ModelCard({ id, variants, levelsLabel, copyLabel, copiedLabel }) {
      const [copied, setCopied] = useState(false);
      const onCopy = useCallback(() => {
        const text = id;
        const done = () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => {});
        } else {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (_) {}
          ta.remove();
        }
      }, [id]);
      return h(
        "div",
        { className: "xlfm-card" },
        h(
          "div",
          { className: "xlfm-card-top" },
          h("span", { className: "xlfm-badge" }),
          h("span", { className: "xlfm-card-id", title: id }, id),
          h(
            "button",
            {
              className: "xlfm-copy" + (copied ? " done" : ""),
              onClick: onCopy,
              title: copied ? copiedLabel : copyLabel,
            },
            copied ? "✓" : copyLabel
          )
        ),
        h(
          "div",
          { className: "xlfm-levels" },
          h("span", { className: "xlfm-card-tag" }, "opencode · free"),
          variants && variants.length
            ? h("span", { className: "xlfm-levels-label" }, "· " + levelsLabel)
            : null,
          (variants || []).map((level) =>
            h("span", { className: "xlfm-level", key: level }, level)
          )
        )
      );
    }

    function SettingsPage(props) {
      const [health, setHealth] = useState(null);
      const [models, setModels] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const t = props && typeof props.t === "function" ? props.t : null;
      const dict = useMemo(() => buildDict(t), [t]);

      const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        let key = "";
        try {
          const hres = await fetchJson(PROXY + "/health").catch(() => null);
          setHealth(hres);
          if (hres && typeof hres.apiKey === "string") key = hres.apiKey;
        } catch {
          setHealth(null);
        }
        try {
          const list = await fetchJson(
            PROXY + "/v1/models",
            key ? { headers: { authorization: "Bearer " + key } } : undefined
          );
          setModels(Array.isArray(list.data) ? list.data : []);
        } catch (e) {
          setModels(null);
          setError(e && e.message ? e.message : String(e));
        }
        setLoading(false);
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const online = !!(health && health.healthy);
      const statusLabel = health == null ? dict.statusUnknown : online ? dict.statusOn : dict.statusOff;
      const dotClass = health == null ? "unknown" : online ? "on" : "off";
      const modelList = useMemo(
        () =>
          models
            ? models
                .map((m) => ({
                  id: m && m.id,
                  variants:
                    m && Array.isArray(m.variants)
                      ? m.variants.filter((level) => typeof level === "string" && level !== "")
                      : [],
                }))
                .filter((m) => m.id)
            : [],
        [models]
      );
      const proxyBase =
        (health && health.proxy && typeof health.proxy.baseUrl === "string" && health.proxy.baseUrl) ||
        PROXY;
      const apiKeyLabel =
        health && typeof health.apiKey === "string" && health.apiKey
          ? health.apiKey
          : health && health.hasApiKey
            ? "••••••••"
            : dict.notSet;

      return h(
        "div",
        { className: "xlfm-page" },
        h(
          "div",
          { className: "xlfm-status" },
          h("span", { className: "xlfm-dot " + dotClass }),
          h("span", { className: "xlfm-status-text" }, statusLabel),
          health && health.backendSource
            ? h("span", { className: "xlfm-backend" }, dict.backend + ": " + health.backendSource)
            : null
        ),
        h(
          "dl",
          { className: "xlfm-meta" },
          h("dt", null, dict.baseUrl),
          h("dd", null, proxyBase + "/v1"),
          h("dt", null, dict.apiKey),
          h("dd", null, apiKeyLabel)
        ),
        h(
          "div",
          { className: "xlfm-section" },
          h(
            "div",
            { className: "xlfm-section-head" },
            h(
              "h3",
              { className: "xlfm-section-title" },
              dict.modelsTitle,
              modelList.length
                ? h("span", { className: "xlfm-count" }, dict.count(modelList.length))
                : null
            ),
            h(
              "button",
              { className: "xlfm-btn", onClick: load, disabled: loading },
              loading ? dict.loading : dict.refresh
            )
          ),
          h("p", { className: "xlfm-hint" }, dict.modelsHint),
          loading && models == null
            ? h("p", { className: "xlfm-msg" }, dict.loading)
            : modelList.length
              ? h(
                  "div",
                  { className: "xlfm-grid" },
                  modelList.map((model) =>
                    h(ModelCard, {
                      key: model.id,
                      id: model.id,
                      variants: model.variants,
                      levelsLabel: dict.levels,
                      copyLabel: dict.copy,
                      copiedLabel: dict.copied,
                    })
                  )
                )
              : h("p", { className: "xlfm-msg" }, error ? dict.loadFail + " (" + error + ")" : dict.loadFail)
        ),
        h("p", { className: "xlfm-hint" }, dict.pickerNote)
      );
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }),
        "dsh-xl-free-model: dictionaries"
      );
      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin", "dsh-xl-free-model");
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "dsh-xl-free-model: styles");

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "xl-free-model",
            order: 36,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ t }),
          },
          (props) => h(SettingsPage, Object.assign({}, props))
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "xl-free-model";
    return module.exports;
  },
});
