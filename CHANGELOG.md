# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.8.0] - 2026-11-10

### Added

- 完整支持 OpenCode 2.x API：
  - 通过 `/api/info` 自动识别 2.x 后端，并优先使用 2.x；未检测到时回退 1.x。
  - 适配 `/api/model`、`/api/session`、`/api/session/{id}/prompt`、`/api/event`、`/api/session/{id}/message`、`/api/session/{id}/interrupt`。
  - 支持 2.x 的流式/非流式响应、reasoning 内容、token 统计和模型 variant（reasoning effort）。
  - 模型不支持指定 variant 时自动降级为默认 variant 重试。
  - 以持久化的最终 assistant 消息作为权威结果，避免事件流缺少结束帧导致内容不完整。
  - 客户端断开时主动中断 2.x 会话执行。
- 按工作区隔离的 CLI 进程池：
  - 每个 dsh 工作区使用独立的 OpenCode CLI 进程，cwd 固定为该工作区。
  - 最多保留 8 个进程，空闲最久的自动回收，退出时统一清理。
  - 端口从 4097 起顺延，每个进程使用随机生成的服务器密码。
- 优先复用已安装的 OpenCode 桌面版 CLI：
  - 扫描 `%APPDATA%\ai.opencode.desktop\cli`、`%LOCALAPPDATA%\ai.opencode.desktop\cli` 和 PATH。
  - 版本号从新到旧排序；自带 1.19 CLI 仅作为最后兜底。
- CLI 下载安装增强：
  - 安装目录改为版本化的 `CLI/<version>`。
  - 支持 HTTP Range 断点续传、最多 3 次重试、30 分钟超时、进度日志和临时文件清理。
  - npm 安装作为兜底，并扩展 npm 可执行文件查找范围。
- Function Calling 桥接增强：
  - 支持并行工具调用，按 delta `index`/`id` 合并分片。
  - 缺失工具调用 ID 时自动生成，参数缺失时补 `"{}"`。
  - 支持零宽字符清理、截断结束标记 salvage、平衡 JSON 扫描和整段 JSON 解析。
  - 自动修复“有调用无结果/有结果无调用”的工具配对，避免后续请求持续 400。
- 新增工作区路由：
  - dsh 适配器从运行时上下文提取当前工作区，通过 `x-dsh-working-directory` 请求头传给代理。
  - 代理校验路径后按工作区选择后端。
- 新增环境变量覆盖：
  - `OPENCODE_PROXY_FREE_HOST`
  - `OPENCODE_PROXY_FREE_PORT`
  - `OPENCODE_PROXY_FREE_API_KEY`
  - `OPENCODE_PROXY_DIRECTORY`
  - `OPENCODE_PROXY_CLI_PORT`
  - `OPENCODE_PROXY_BACKEND_PORT`
  - `OPENCODE_PROXY_BACKEND_PASSWORD`
- 代理标准输出/错误写入 `proxy.log`，超过 4 MB 自动截断。
- `/health` 增加代理地址、后端版本/API 类型、CLI 工作区列表等状态信息。
- PEB 密码发现同时扫描 `OpenCode.exe`、`opencode-cli.exe`、`opencode.exe`，并去重 PID。

### Changed

- 模型上下文窗口从 131072 提升到 262144，默认最大输出 token 从 8192 提升到 32768。
- 原生工具策略由 `read + glob + grep` 收紧为仅 `read`；其余工具统一走 Function Calling 桥接。
- CLI 目录名从 `cli` 改为 `CLI`，并按版本号分目录安装。
- `proxy.config.json` 中 `backend.host` 明确为 `127.0.0.1`，CLI 路径更新为 `CLI\1.19.0\...`。
- 代理先监听端口，再在后台发现后端并预取模型，启动不再阻塞等待 CLI 安装或后端探测。
- 后端身份变化时自动清空 session 缓存和模型缓存；后端异常支持重新发现和重试。
- 2.x 会话使用显式权限规则：放行当前工作区和 `read`，拒绝 `edit`、`bash`、`task`、`webfetch`、`websearch` 等副作用工具。
- 适配器支持透传 `stop` 停止序列、`reasoning_effort` 和 `stream_options.include_usage`。
- 设置页代理地址支持通过 `globalThis.__XL_FREE_MODEL_PROXY__` 覆盖。
- 设置页移除硬编码 API Key，改为从 `/health` 动态获取；请求超时从 5 秒放宽到 30 秒。
- 设置页支持 dsh 的 `t` 翻译函数，并补充中英文回退逻辑。
- `cordis.patch.yml` 移除 `config: {}`，明确热挂载只支持纯 insert，完整 bundle 需重启 dsh 生效。
- `package.json` 版本更新为 `1.8.0`。

### Fixed

- 修复后端无内容、无工具调用、无错误时静默结束的问题，统一返回 `OPENCODE_EMPTY_REPLY`。
- 修复免费额度耗尽或上游重试时流式请求一直挂起的问题，改为返回明确错误（含 429 状态）。
- 修复流式请求丢弃 prompt 响应体、无法感知 `info.error` 的问题。
- 修复事件流无增量时可能空回复的问题，使用 prompt 响应文本兜底并避免重复追加。
- 修复用户消息更新被误判为 assistant 完成、从而提前返回空回复的问题。
- 修复工具调用标记泄漏到用户可见内容的问题；带 tools 时先缓冲再输出结构化 `tool_calls`。
- 修复并行工具调用参数分片错位、调用 ID 缺失和工具配对不完整导致的 400。
- 修复不同工作区、模型或 variant 之间错误复用 session 的问题。
- 修复 session 缓存淘汰后未删除后端会话的问题。
- 修复代理日志因 `stdio: "ignore"` 完全不可见的问题。
- 修复 npm 不在 PATH 时无法执行兜底安装的问题。
- 修复设置页模型数量文案模板插值、错误详情展示和 API Key 未设置状态的问题。

### Security

- API Key 仅对回环地址客户端返回，避免暴露给非本机请求。
- 工作区路径在作为子进程 cwd 使用前进行合法性校验。
- 无头 CLI 使用随机服务器密码。
- 通过会话权限和工具白名单阻止模型直接执行副作用原生工具。

### Upgrade Notes

- 外部 OpenAI 接口保持不变：`/v1/models`、`/v1/chat/completions` 的调用方式不变。
- OpenCode 1.x 仍可用；检测到 2.x 时优先使用 2.x。
- 旧版 `cli/` 目录不再使用。如配置过自定义 `backend.cli.path`，请改为实际路径或留空交给自动发现。
- 原生工具仅保留 `read`，`glob`、`grep`、`write`、`bash` 等通过 Function Calling 桥接执行。
- 升级后建议重启 dsh，使插件和 `cordis.patch.yml` 完整生效。

[Unreleased]: https://github.com/zhangmaorongXL/dsh-xl-free-model/compare/v1.8.0...HEAD
[1.8.0]: https://github.com/zhangmaorongXL/dsh-xl-free-model/compare/1.5.0...v1.8.0
