# 白板工作室 · Whiteboard Studio

把一段文案变成**手绘白板讲解视频**：分镜、旁白、配音、字幕、封面、成片，全流程本地跑通。

大模型走标准 OpenAI 兼容接口——既可以接本机 vLLM 上的 **Qwen3-8B**（海光 K100 / 任意 GPU，零 API 费用），也可以在设置里换成任意自定义云端 API。渲染引擎、任务数据和产物都留在本机。

- 官方脚手架：Agent-Native Chat（React Router 8 + Nitro）

- 渲染引擎：`whiteboard-video-factory`（Playwright + ffmpeg + TTS）

- 部署实录：[在海光 K100 上部署 Qwen3-8B · 白板视频制作（完整版）](<在海光 K100 上部署 Qwen3-8B-白板视频制作（完整版）.md>)

- 视频效果 

  	<p align="center">
    <video src="https://github.com/user-attachments/assets/c9348c99-a08e-4628-891f-6e4826f0b734" controls muted playsinline width="100%"></video>

  </p>

---

## 目录

- [功能特性](#功能特性)
- [架构概览](#架构概览)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [接入本地 Qwen3-8B（vLLM）](#接入本地-qwen3-8bvllm)
- [使用自定义云端 API](#使用自定义云端-api)
- [配置项说明](#配置项说明)
- [使用流程](#使用流程)
- [产物清单](#产物清单)
- [目录结构](#目录结构)
- [可用命令](#可用命令)
- [常见问题](#常见问题)
- [海光 K100 部署摘要](#海光-k100-部署摘要)
- [开发与验证](#开发与验证)
- [技术交流群](#技术交流群)
- [作者联系](#作者联系)
- [打赏](#打赏)
- [Star History](#star-history)
- [License](#license)
- [更新日志](#更新日志)
- [致谢](#致谢)
- [贡献指南](#贡献指南)

---

## 功能特性

- **项目与分镜编辑**：标题、旁白、画面要点、语气与配色，支持多集管理。
- **对话式编辑**：聊天里说"把第二幕旁白改短"，Agent 通过 action 直接改结构化数据。
- **一键成片**：文案 → 文案转语音（TTS） → 生成画面 → 合成视频，全程可见工序日志。
- **三种封面 + 字幕**：横版 4:3、竖版 3:4、全屏 9:16，附逐句 SRT 字幕。
- **模型来源可切换**：设置页一键在「本地 vLLM」与「自定义云 API」之间切换，凭据自动归档还原。
- **本地优先**：数据库、项目文件、渲染任务与产物都在 `data/`，不上传外部服务。
- **多种配音**：edge-tts（免费）、小米 TTS、火山引擎 TTS。

## 架构概览

```
浏览器（React Router 8 + Agent-Native UI）
  ├─ /studio    白板编辑器（分镜、旁白、配音、一键成片）
  ├─ /chat      对话式编辑（Agent + actions）
  └─ /settings  模型来源、TTS、组织设置
        │
        ├─ actions/           UI 与 Agent 共用的动作契约（HTTP / MCP / CLI 同一套）
        ├─ server/            Nitro 路由：模型端点、同源校验、渲染任务
        ├─ engine/            渲染引擎：Chromium 截图 → 逐帧 → ffmpeg 合成 → TTS 对齐
        └─ OpenAI 兼容模型     本地 vLLM（Qwen3-8B）或任意云端 API
```

`actions` 是这个项目的核心约定：聊天、界面按钮、HTTP 接口、MCP 工具都调用同一份实现，所以"人点的"和"模型点的"行为完全一致。

## 环境要求

| 依赖 | 版本 / 说明 |
|---|---|
| Node.js | ≥ 22.22（`package.json` 的 `engines`） |
| pnpm | 10.x（`packageManager: pnpm@10.29.1`） |
| Python | 3.10+，用于 `edge-tts` |
| ffmpeg / ffprobe | 渲染与时长探测必需，需在 `PATH` 中 |
| Chromium | 由 Playwright 安装，用于逐帧渲染 |
| 大模型 | 任选：本地 vLLM（推荐）或云端 OpenAI 兼容 API |

> Windows 建议用 Docker 版（`docker-start.cmd`，见 `docs/docker-deployment.md`），容器内已含 Node、Python、ffmpeg、Chromium 与字体。

## 快速开始

```bash
# 1. 安装依赖
pnpm install
npm --prefix engine ci --ignore-scripts
(cd engine && npx playwright install chromium)
python3 -m pip install edge-tts

# 2. 准备配置（可选，首次可跳过；模型在界面里配也可以）
cp .env.example .env

# 3. 启动开发服务
pnpm dev            # http://localhost:8080
```

也可以直接用启动器（会检查依赖、装浏览器和 edge-tts，并打开浏览器）：

```bash
sh start.sh         # macOS / Linux，端口 4317
start.cmd           # Windows
```

生产模式：

```bash
pnpm build
pnpm start
```

> 不要同时运行两个实例：同一个 `data/` 目录只允许一个进程持有数据库。

## 接入本地 Qwen3-8B（vLLM）

### 1. 启动模型服务

```bash
bash /root/start-qwen3-vllm.sh --served-model-name Qwen3-8B \
  --enable-auto-tool-choice --tool-call-parser hermes
```

`start-qwen3-vllm.sh` 的核心参数：

| 参数 | 作用 |
|---|---|
| `--host 0.0.0.0` | 允许跨机访问；同机用 `127.0.0.1` 即可 |
| `--port 8000` | 对应模型地址 `http://127.0.0.1:8000/v1` |
| `--enforce-eager` | 海光 DCU 上必须加，关闭 CUDA Graph 避免偶发崩溃 |
| `--dtype bfloat16` | K100 原生支持 BF16 |
| `--served-model-name Qwen3-8B` | 不指定时模型名会变成模型目录路径 |
| `--enable-auto-tool-choice --tool-call-parser hermes` | 让 Qwen3 能正确输出工具调用 |

验证：

```bash
curl -s http://127.0.0.1:8000/v1/models
# {"object":"list","data":[{"id":"Qwen3-8B",...,"max_model_len":40960}]}
```

### 2. 配置 `.env`

```ini
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=EMPTY

LOCAL_MODEL_BASE_URL=http://127.0.0.1:8000/v1
LOCAL_MODEL_ID=Qwen3-8B
LOCAL_MODEL_LABEL=Qwen3-8B（本地 vLLM）
LOCAL_MODEL_API_KEY=EMPTY

# Qwen3 默认开思考，会拖慢首字并干扰工具调用
LOCAL_MODEL_CHAT_TEMPLATE_KWARGS={"enable_thinking":false}

# 40960 上下文下必须收紧默认 64000 的输出上限
AGENT_MAIN_CHAT_MAX_OUTPUT_TOKENS=4096
AGENT_EMPTY_RESPONSE_RETRY_MAX_OUTPUT_TOKENS=4096
AGENT_SOURCE_SWEEP_TOOL_CALL_THRESHOLD=6
```

> 本地服务不校验 Key，但 OpenAI SDK 要求非空，所以写 `EMPTY`。
> `enable_thinking` 只对回环/内网地址生效，云端 API 不会收到这个字段。

### 3. 在界面里启用

设置 → 模型 → **模型来源** → 「启用本地 Qwen3-8B」。

如果之前配置过云端自定义模型，切换时会自动把云端地址与密钥归档为 `CLOUD_OPENAI_*`，点「切回自定义 API」即可原样恢复。

### 4. 两个容易踩的点

- 地址必须以 `/v1` 结尾，否则 404。
- 应用不在 Notebook 本机时，`127.0.0.1` 指向的是应用所在机器，需要换成 vLLM 的内网 IP，并确认 vLLM 带 `--host 0.0.0.0`。

## 使用自定义云端 API

设置 → 模型 → 「添加提供商」→ 自定义模型（OpenAI 兼容协议）：

| 字段 | 示例 |
|---|---|
| 模型地址 | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| 模型名称 | `deepseek-v4.1-flash`（以服务商文档为准） |
| API Key | 服务商密钥 |
| 显示名称 | 任意 |

保存后即可在对话和润色里使用；再点「启用本地 Qwen3-8B」可随时切回本地，云端配置不会丢失。

## 配置项说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_BASE_URL` | 本地模型时必填 | OpenAI 兼容地址（部署级端点） |
| `OPENAI_API_KEY` | 同上 | 本地写 `EMPTY`，云端填真实密钥 |
| `LOCAL_MODEL_BASE_URL` / `_ID` / `_LABEL` / `_API_KEY` | 否 | 设置页展示与切换用的本地模型描述 |
| `LOCAL_MODEL_CHAT_TEMPLATE_KWARGS` | 否 | 仅对回环/内网端点注入的额外请求字段 |
| `AGENT_MAIN_CHAT_MAX_OUTPUT_TOKENS` | 否 | 单轮首次生成上限，默认 64000，本地模型建议 ≤4096 |
| `AGENT_EMPTY_RESPONSE_RETRY_MAX_OUTPUT_TOKENS` | 否 | 空回复重试上限，需 ≥ 上一个值 |
| `AGENT_SOURCE_SWEEP_TOOL_CALL_THRESHOLD` | 否 | 只读检索多少次后强制收敛，默认 24 |
| `APP_URL` | 经网关访问时 | 对外访问地址，用于同源校验 |
| `MI_TTS_API_KEY` / `MI_TTS_BASE_URL` | 小米配音时 | 小米 TTS 凭证 |
| `VOLC_TTS_API_KEY` | 火山配音时 | 火山引擎 TTS 凭证 |
| `WB_CHROMIUM` | 否 | 自定义 Chromium 可执行文件路径 |
| `AUTH_DISABLED=1` | 仅调试 | 跳过登录，所有请求按本地开发账号执行 |

## 使用流程

1. **新建视频**：输入主题（例：给初中生做一个能量守恒定律的科普视频）。
2. **写旁白**：逐幕填写口播文案，可用 AI 润色（走当前配置的模型）。
3. **选配音**：edge-tts 免费开箱即用；小米/火山需要密钥。
4. **文案扩写**：贴原始素材，让模型按分镜扩写成口播稿。
5. **一键成片**：右上角触发整条流水线，面板里能看到每道工序和日志，可随时取消。
6. **预览与导出**：预览只出静帧与封面，构建才生成带旁白的成片。

## 产物清单

一次成片会输出一整套可直接发布的素材（位于 `data/jobs/<任务ID>/.../engine/build/<项目>/`）：

| 文件 | 用途 |
|---|---|
| `final.mp4` | 成片，H.264 / AAC |
| `字幕.srt` | 逐句时间轴字幕 |
| `封面-4x3.png` | 横版封面（B 站 / 视频号） |
| `封面-3x4.png` | 竖版封面（小红书 / 抖音） |
| `封面-9x16.png` | 全屏竖版封面 |
| `发布.md` | 标题、简介、话题标签建议 |

## 目录结构

```
app/          前端页面与组件（/studio、/chat、/settings）
actions/      Agent 与 UI 共用的 action 契约
server/       Nitro 路由、插件、模型端点与同源校验
shared/       前后端共享类型与常量
engine/       白板渲染引擎（Playwright + ffmpeg + TTS）
scripts/      启动器、部署与验证脚本
docs/         操作手册、验证记录、部署说明
public/       静态资源与图标
data/         数据库、项目、任务产物（不进版本库）
patches/      对 @agent-native/core 的补丁（cookie、本地模型请求体）
```

## 可用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发服务器，默认 http://localhost:8080 |
| `pnpm build` / `pnpm start` | 生产构建 / 启动 |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 单元测试（vitest） |
| `pnpm action <name> '<json>'` | 直接调用某个 action |
| `pnpm agent-native:doctor` | 环境自检 |
| `pnpm migrate:production` | 生产库迁移 |

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 浏览器提示 `Blocked request. This host is not allowed` | Vite 的 Host 校验 | 在 `vite.config.ts` 的 `server.allowedHosts` 加上访问域名 |
| 登录报 `We couldn't sign you in right now` | Cookie 含中文，`Headers.set()` 拒绝非 Latin1 | 已通过 `patches/` 里的 cookie 编码补丁修复，执行 `pnpm install` 重放 |
| 保存模型报 `Cross-origin credential save refused` | 网关剥掉 `Origin` 且 TLS 终止 | 服务端已兼容 Fetch Metadata/Referer；换域名时同步 `APP_URL` |
| 一键成片报 `FileNotFoundError: ffprobe` | 缺 ffmpeg/ffprobe | `apt install -y ffmpeg`（或 Docker 版） |
| 模型报 `max_tokens ... 64000 ... maximum context length is 40960` | 默认输出上限大于模型上下文 | 调低 `AGENT_MAIN_CHAT_MAX_OUTPUT_TOKENS`（本仓库默认 4096） |
| 回复很慢、首字很久 | Qwen3 思考模式开启 | 配置 `LOCAL_MODEL_CHAT_TEMPLATE_KWARGS={"enable_thinking":false}` |
| 模型 404 `The model xxx does not exist` | 模型名不匹配或 Base URL 少 `/v1` | 对齐 `--served-model-name`，地址补 `/v1` |
| vLLM 启动报显存不足，但已没有模型进程 | 上次中断留下的孤儿 `VLLM::EngineCore` 仍占显存 | `bash /root/stop-qwen3-vllm.sh` 后再启动 |
| 对话被自己打断后报 `write_tool_outcome_unknown` | 写操作（save-episode）结果未确认，系统不自动重放 | 按提示先核对已保存内容，再回复 `continue` |
| `pnpm dev` 退出码 132 | rolldown 原生二进制与 CPU 不兼容 | 已在 `pnpm.overrides` 固定 `rolldown@1.2.16` |

## 海光 K100 部署摘要

完整过程（环境版本、依赖清单、踩坑、截图）见 [部署实录](<在海光 K100 上部署 Qwen3-8B-白板视频制作（完整版）.md>)。速查：

```
平台      : 超算互联网 Notebook
加速卡    : 海光 K100（DCU），单卡 64GB，设备名 K500SM_AI
操作系统  : Ubuntu 22.04
软件栈    : DTK 26.04 + Python 3.10
PyTorch   : 2.5.1+das.opt1.dtk2604（HIP 6.3.26045）
vLLM      : 0.11.0+das.opt1.dtk2604.torch251
模型      : Qwen3-8B（modelers.cn/Qwen-AI/Qwen3-8B，40960 上下文）
模型服务  : http://127.0.0.1:8000/v1（--enforce-eager + bfloat16）
应用端口  : 8080（经 Notebook 自定义服务映射到外网）
```

版本必须严格对齐 `dtk2604 + cp310 + manylinux_2_28_x86_64 + torch2.5.1`；PyPI 上的 torch/vllm 是 CUDA 版，在 DCU 上 `torch.cuda.is_available()` 会静默返回 `False`，务必使用海光定制 wheel。

## 开发与验证

- 交互与操作手册：`docs/verification.md`、`docs/whiteboard-studio-handbook.pdf`
- 部署：`START-HERE.md`（本机）、`START-DEPLOY.md`（VPS / Vercel + VPS）、`docs/docker-deployment.md`
- 本机改造与排障记录：`CHANGES-2026-10-30.md`
- 实测产物与截图：`docs/test-output/`

提交前建议执行：

```bash
pnpm typecheck
pnpm test
```

---

## English overview

Whiteboard Studio turns a script into a hand-drawn whiteboard explainer video:
scenes, narration, TTS, subtitles, covers and a final MP4 — all locally.

The app is an Agent-Native chat app (React Router 8 + Nitro). The rendering
engine lives in `engine/` (Playwright + ffmpeg + TTS). Model calls use any
OpenAI-compatible endpoint, so it runs fully offline against a local vLLM
Qwen3-8B server, or against a cloud provider you configure in Settings →
Model. Actions are the single contract shared by the chat agent, the UI, HTTP
and MCP.

---

## 技术交流群

欢迎加入技术交流群，分享你的使用心得和反馈建议：

![技术交流群](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/Screenshot_20261029_102501_com.tencent.mm.jpg)

---

## 作者联系

- **微信**: laohaibao2025
- **邮箱**: 75271002@qq.com

![微信二维码](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Screenshot_20260123_095617_com.tencent.mm.jpg)

---

## 打赏

如果这个项目对你有帮助，欢迎请我喝杯咖啡 ☕

**微信支付**

![微信支付](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20250914152855543.png)

---

## Star History

如果觉得项目不错，欢迎点个 Star ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=wwwzhouhui/whiteboard-studio&type=Date)](https://star-history.com/#wwwzhouhui/whiteboard-studio&Date)

---

## License

MIT License

---

## 更新日志

### v1.1.0 (2026-10-30)

**新功能**：
- ✨ 支持本地 Qwen3-8B（vLLM），零 API 费用本地离线运行
- ✨ 设置页新增「模型来源」面板，本地模型与云端 API 一键切换
- ✨ 云端凭据按用户 / 组织维度自动归档与还原

**改进**：
- ⚡ 本地端点自动注入 `enable_thinking: false`，关闭 Qwen3 思考模式，加快首字响应
- ⚡ 收紧聊天输出上限，适配 40960 token 上下文
- 🎯 精简系统提示词、语料工具懒加载，加快本地推理速度

### v1.0.0 (2026-10-29)

- 🎬 首次发布：文案 → 分镜 → TTS → 逐帧渲染 → 成片，全流程本地跑通
- 🤖 对话式编辑：Agent 通过 action 直接修改结构化分镜数据
- 🎨 三种比例封面（4:3 / 3:4 / 9:16）+ 逐句 SRT 字幕
- 🔊 支持 edge-tts、小米 TTS、火山引擎 TTS 多种配音

---

## 致谢

- [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) — 本地大模型
- [vLLM](https://github.com/vllm-project/vllm) — 高吞吐模型推理服务
- [Playwright](https://playwright.dev/) — 浏览器逐帧渲染
- [FFmpeg](https://ffmpeg.org/) — 视频合成与转码
- [edge-tts](https://github.com/rany2/edge-tts) — 免费开箱即用的配音

---

## 贡献指南

欢迎贡献！请：

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'Add amazing feature'`
4. 推送到分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request
