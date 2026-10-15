# dsh-xl-free-model

在 [dsh](https://github.com/deepseek-ai/dsh) 中自动运行本地 OpenAI 兼容代理的插件，经 OpenCode 免费通道使用 `mimo-v2.6-flash-free` 等 free 模型。支持流式、多轮会话复用、function calling 桥接与无头 CLI 后备（桌面版未打开时自动拉起）。

模型通过 Host 半身注册的 LlmAdapter **直接出现在会话的模型选择列表中**（provider: `xl-free-model`），无需在 profile 的 `cordis.patch.yml` 手工配置 provider。设置页含 **XL Free Model** 插页，展示代理状态与模型卡片列表。

## 功能特性

- **零配置模型接入**：安装插件后，免费模型自动出现在会话的模型选择列表
- **本地代理**：OpenAI 兼容 API（`http://127.0.0.1:8787/v1`），可被任意 OpenAI SDK 调用
- **自动管理**：dsh 启动时自动拉起代理，退出时自动清理
- **桌面/无头双后端**：优先复用已打开的 OpenCode 桌面版；未打开时自动启动无头 CLI 后备
- **CLI 二进制自动安装**：缺失时直接从 npm registry 下载 tarball 解压（无需 npm 在 PATH），npm install 兜底
- **流式支持**：完整支持 SSE 流式响应
- **Function Calling**：通过提示词桥接模拟工具调用
- **会话复用**：后端连接池自动复用，提升响应速度
- **PEB 密码发现**：无需手动配置密码，自动从 OpenCode 进程环境读取

## 安装

### 前置条件

- Windows 10/11 x64
- Node.js ≥ 22
- dsh 桌面版或 CLI

### 步骤

1. **克隆仓库**

   ```bash
   git clone https://github.com/zhangmaorongXL/dsh-xl-free-model.git
   cd dsh-xl-free-model
   ```

2. **安装到 dsh**

   将本目录复制到 dsh 插件目录，或在 dsh 设置中指定插件路径。

5. **重启 dsh**

   重启后，会话模型选择列表中将出现 `XL Free Model` 分组，包含可用的免费模型。

## 使用

### 在 dsh 中使用

1. 新建会话
2. 在模型选择器中选择 `XL Free Model` 分组下的模型（如 `mimo-v2.6-flash-free`）
3. 正常对话即可

### 独立使用代理

代理兼容 OpenAI API，可被任意支持自定义 base URL 的工具调用：

```bash
# 启动代理（dsh 运行时会自动管理，通常无需手动）
node proxy.cjs
```

```python
# Python 示例
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="changeme-dsh-key"  # proxy.config.json 中的 apiKey
)

response = client.chat.completions.create(
    model="mimo-v2.6-flash-free",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
```

```javascript
// Node.js 示例
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "changeme-dsh-key",
});

const stream = await client.chat.completions.create({
  model: "mimo-v2.6-flash-free",
  messages: [{ role: "user", content: "你好" }],
  stream: true,
});
```

## 配置

`proxy.config.json` 完整配置项：

```json
{
  "proxyHost": "127.0.0.1",        // 代理监听地址
  "proxyPort": 8787,               // 代理监听端口
  "apiKey": "changeme-dsh-key",    // API Key（必改）
  "backend": {
    "host": "",                    // OpenCode 后端地址（留空自动发现）
    "port": 0,                     // OpenCode 后端端口（留空自动发现）
    "username": "opencode",        // 后端用户名
    "password": "",                // 后端密码（留空自动 PEB 发现）
    "cli": {
      "enabled": true,             // 是否启用无头 CLI 后备
      "path": "cli\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
      "port": 4097                 // CLI 后备端口
    }
  }
}
```

## 架构

```
dsh-xl-free-model/
├── index.js              # Host 半身：挂载代理 + 注册 LlmAdapter + CLI 二进制自动安装
├── adapter.js            # LlmAdapter 实现（dsh 结构化契约）
├── client.js             # Browser 半身：设置页插页 UI
├── proxy.cjs             # 本地 OpenAI 兼容代理服务器
├── peb_env.ps1           # PEB 密码发现脚本（PowerShell）
├── proxy.config.json     # 代理配置
├── cordis.patch.yml      # dsh bundle patch（仅挂载 Host）
├── package.json          # 插件清单
├── cli/                  # OpenCode 无头 CLI 后备
│   ├── package.json      # npm 依赖清单（opencode-ai）
│   └── node_modules/     # 自动下载/npm install 后生成（.gitignore 排除）
├── .gitignore            # 排除大文件与运行时产物
├── LICENSE               # MIT
└── README.md
```

### 工作流程

1. dsh 加载插件 → `index.js` 的 `apply()` 执行
2. 读取 `proxy.config.json`，注入 API Key 环境变量
3. 检测代理是否已在运行；未运行则 spawn `proxy.cjs`
4. 通过 `ctx.llm.registerAdapter()` 注册 `xl-free-model` provider
5. `adapter.js` 的 `listModels()` 从代理拉取模型列表
6. 会话选择模型时，`adapter.js` 的 `stream()` 转发请求到代理
7. 代理转发到 OpenCode 后端（桌面版或无头 CLI），返回流式响应

## 故障排查

### 模型未出现在选择列表

- 检查 dsh 日志（`~/.dsh/logs/`）中 `registerAdapter failed` 错误
- 确认代理已启动：`curl http://127.0.0.1:8787/health`
- 重启 dsh

### 代理启动失败

- 检查端口占用：`netstat -ano | findstr 8787`
- 查看 `cli-serve.log`（CLI 后备日志）
- 确认 `cli/node_modules/opencode-windows-x64/bin/opencode.exe` 存在

### 密码获取失败

- 确认 OpenCode 桌面版已打开
- 手动测试：`powershell -NoProfile -ExecutionPolicy Bypass -File peb_env.ps1 OPENCODE_SERVER_PASSWORD`
- 或在 `proxy.config.json` 的 `backend.password` 中手动填写

## 开发

### 本地测试

```bash
# 语法检查
node --check index.js
node --check adapter.js
node --check client.js
node --check proxy.cjs

# 启动代理（前台运行）
node proxy.cjs
```

### 修改适配器

`adapter.js` 实现了 dsh 的结构化 LlmAdapter 契约：

- `providerInfo(provider)` → `{ id, name }`
- `listModels(provider)` → `LlmModelInfo[]`
- `resolveModel(provider, model)` → `ResolvedModelInfo`
- `prepareCall(provider, model)` → `{ model, stream }`
- `stream(options)` → `AsyncIterable<StreamChunk>`

参考 dsh 源码中的 `LlmAdapter` 类型定义。

## 许可证

MIT
