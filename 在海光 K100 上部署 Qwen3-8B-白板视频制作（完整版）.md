# 在海光 K100 上部署 Qwen3-8B（二）：白板视频制作实战

> **系列说明**：本文是《在海光 K100 上部署 Qwen3-8B：从超算互联网到 vLLM 服务的全流程实践》的续篇。
>
> - 上一篇解决的是"**让模型跑起来**"——在一张国产 DCU 上，把 Qwen3-8B 拉成标准的 OpenAI 兼容推理服务，并固化成镜像。
> - 这一篇解决的是"**让模型干活**"——用开源项目 whiteboard-studio，把一段文案自动变成带配音、字幕、封面的手绘白板讲解视频。
>
> **实践环境**：超算互联网 Notebook ｜ 海光 K100（DCU，单卡 64GB）｜ DTK 26.04 ｜ Qwen3-8B ｜ vLLM 0.11.0 ｜ whiteboard-studio

---

## 一、两篇文章是怎么接上的

whiteboard-studio 本身不含模型，它的"文案扩写""旁白润色"这些能力，全部通过 **OpenAI 兼容接口**调用外部大模型。

也就是说，只要在设置里把模型地址指向上一篇部署好的本地 vLLM 服务，整个链路就闭环了：

```
whiteboard-studio（浏览器） → http://127.0.0.1:8000/v1 → vLLM → Qwen3-8B → 海光 K100
```

这条链路的三个好处很实在：

| 好处 | 说明 |
|---|---|
| 不花钱 | 全程本地推理，不消耗任何第三方 API 额度 |
| 不出网 | 文案、素材都在 Notebook 内部流转，无数据外泄风险 |
| 可控 | 模型版本、上下文长度、温度参数全部自己说了算 |

代价是：**上一篇那套环境必须先跑通**。所以下面先给出一份"最小可复现版"的部署摘要，完整过程、踩坑细节和选型分析请回看上一篇。

---

## 二、前置条件：先把模型服务准备好

### 2.1 环境基线：版本四元组必须严格对齐

这是上一篇最重要的一条经验，这里再强调一次：

> **在海光 DCU 上，版本不是"建议对齐"，而是"必须对齐"。**

```
dtk2604  +  cp310  +  manylinux_2_28_x86_64  +  torch2.5.1
```

任何一个不匹配，都不是性能下降的问题，而是直接无法启动。

| 项目 | 本次取值 |
|---|---|
| 平台 | 超算互联网 Notebook（scnet.cn） |
| 加速卡 | 海光 K100（DCU），单卡 64GB，设备名上报为 `K500SM_AI` |
| 操作系统 | Ubuntu 22.04 |
| 软件栈 | DTK 26.04 + Python 3.10 |
| PyTorch | 2.5.1+das.opt1.dtk2604（HIP 6.3.26045） |
| 推理引擎 | vLLM 0.11.0+das.opt1.dtk2604.torch251 |
| 模型 | Qwen3-8B（魔乐社区 modelers.cn/Qwen-AI/Qwen3-8B） |

### 2.2 依赖清单

注意：PyPI 上的 torch 和 vllm 都是 CUDA 版，在 DCU 上装完 `torch.cuda.is_available()` 会一直返回 `False` 且不报错。必须使用海光定制编译的 wheel，从 `download.sourcefind.cn` 按版本获取。

| 序号 | 组件 | 版本 | 作用 |
|---|---|---|---|
| 1 | PyTorch | 2.5.1+das.opt1.dtk2604 | 加载 DTK 运行时 |
| 2 | NumPy | 1.25.0 | vLLM wheel 元数据硬性要求 |
| 3 | Triton | 3.1.0+das | 算子编译 |
| 4 | lmslim | 0.4.0+das | 线性层优化 |
| 5 | lightop | 0.7.0+das | 算子库 |
| 6 | FlashAttention | 2.8.3+das | 注意力加速 |
| 7 | FlashMLA | 1.2.0+das | MLA 加速 |
| 8 | vLLM | 0.11.0+das | 推理引擎 |
| 9 | amdsmi | 7.6.0 | 设备管理，需自行编译 |
| 10 | numa | 1.4.6 | NUMA 支持，需自行编译 |

装完必须验证：

```python
import torch
print("torch:", torch.__version__)
print("HIP:", torch.version.hip)
print("DCU available:", torch.cuda.is_available())
print("device 0:", torch.cuda.get_device_name(0))
```

正常输出：

```
torch: 2.5.1
HIP: 6.3.26045
DCU available: True
device 0: K500SM_AI
```

设备名是 `K500SM_AI`，但代码里照写 `cuda`——整个软件栈通过 HIP 层对 CUDA 接口做了完整映射，上层无需感知硬件差异。

### 2.3 三个必须避开的坑

| 坑 | 现象 | 正确做法 |
|---|---|---|
| vLLM wheel 携带 CUDA 版 CuPy | pip 尝试源码编译 CuPy，报缺 `cublas_v2.h` / `nvcc` | 先用 `--no-deps` 只装本体，再按 `pip check` 逐个补通用依赖 |
| `pip check` 永远不干净 | flash-attn / flash-mla / lightop / lmslim 报版本冲突 | 这是海光 wheel 元数据本身不一致，**切忌用 PyPI 同名包覆盖**，覆盖即崩 |
| amdsmi / numa 需自行编译 | 直接 pip 装不上 | 从 `/opt/hyhal/share/amd_smi` 拷贝源码，加 `--no-build-isolation --no-deps` 编译安装 |

### 2.4 启动 vLLM 服务

固化成一键脚本 `start-qwen3-vllm.sh`：

```bash
#!/usr/bin/env bash
set -e

source /root/miniconda3/etc/profile.d/conda.sh
conda activate haguang_vllm
source /opt/dtk/env.sh
export HIP_VISIBLE_DEVICES=0

exec /root/miniconda3/envs/haguang_vllm/bin/vllm serve /root/private_data/models \
  --host 0.0.0.0 \
  --port 8000 \
  --enforce-eager \
  --dtype bfloat16 \
  --trust-remote-code \
  --tensor-parallel-size 1 \
  --gpu-memory-utilization 0.90 \
  "$@"
```

```bash
bash /root/start-qwen3-vllm.sh
```

![启动 vLLM 服务](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261022175725667.png)

几个参数对本文尤其重要：

| 参数 | 说明 |
|---|---|
| `--host 0.0.0.0` | 必须监听全部网卡，否则 whiteboard-studio 通过自定义服务域名访问时连不上 |
| `--port 8000` | 后续模型地址就是 `http://127.0.0.1:8000/v1` |
| `--enforce-eager` | **DCU 上必须加**，关闭 CUDA Graph，否则服务偶发崩溃、P99 延迟翻倍 |
| `--dtype bfloat16` | K100 原生支持 BF16 |
| `--gpu-memory-utilization 0.90` | 留 10% 余量给系统和临时张量 |

> 环境名 `haguang_vllm` 是沿用参考文档的命名，拼写有误（应为 `haiguang`），仅为标识符，不影响功能。

### 2.5 验证服务可用

```bash
curl http://127.0.0.1:8000/v1/models
```

能看到 `Qwen3-8B` 及对应模型路径，就说明后端就绪，可以进入白板视频环节了。

> **省事提示**：上一篇最后把环境打包成了镜像。下次直接用该镜像开 Notebook，环境零搭建，开机即可 `bash start-qwen3-vllm.sh`——这是整条链路里性价比最高的一步。

---

## 三、拿到 whiteboard-studio

项目开源在 GitHub：

```
https://github.com/wwwzhouhui/whiteboard-studio
```

![项目主页](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030160605313.png)

Notebook 里通常没有配置 GitHub 的直连代理，最稳的方式是**本地下载 zip 再上传**：

![下载源码压缩包](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030160748349.png)

上传后在 Notebook 的终端里解压：

```bash
unzip whiteboard-studio.zip
```

![解压源码](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030160916245.png)

---

## 四、安装依赖并启动

进入目录，用 pnpm 安装：

```bash
cd whiteboard-studio
pnpm install
```

![安装依赖](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161037487.png)

> 如果提示 `pnpm: command not found`，先执行 `npm i -g pnpm`；若连 npm 都没有，用 `corepack enable` 激活 Node 自带的包管理器。Node 版本建议 18 以上。

安装完成后启动开发服务：

```bash
pnpm run dev
```

![启动开发服务](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161145043.png)

终端出现 `http://localhost:8080/` 即表示启动成功。

**注意**：这个 `localhost:8080` 是 Notebook 容器内部的地址，浏览器直接访问不到。必须走下面的"自定义服务"通道。

---

## 五、通过自定义服务访问

回到 Notebook 控制台，点击"访问自定义服务"：

![访问自定义服务](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161307324.png)

浏览器会打开形如下面的外网地址（端口与实例绑定，每台机器不同）：

```
https://c-2112431672773898241.ksai.scnet.cn:58043
```

首次进入是登录页，**第一次使用需要创建新用户**，填写账号密码后点击"创建用户"：

![创建用户](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161514670.png)

登录后进入后台管理界面：

![后台管理页面](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161602826.png)

---

## 六、把本地模型接进来

这是全文最关键的一步——把第二节跑起来的 vLLM 服务，配置成 whiteboard-studio 的模型提供商。

点击左下角 **设置 → 模型**：

![设置-模型](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161717362.png)

点击"添加提供商"，选择"自定义模型"（OpenAI 兼容协议），按下表填写：

| 字段 | 填什么 | 说明 |
|---|---|---|
| 模型地址 / Base URL | `http://127.0.0.1:8000/v1` | 与 whiteboard-studio 在同一 Notebook 内，用回环地址即可 |
| 模型名称 | `Qwen3-8B` 或 `/root/private_data/models` | vLLM 的 `served-model-name` 未指定时，默认就是模型目录路径 |
| API Key | `EMPTY` | 本地服务未配鉴权，但 SDK 要求非空值 |
| 显示名称 | `本地Qwen3-8B` | 仅用于界面展示，随意 |

![配置自定义模型](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030161920779.png)

填完保存，界面上出现该提供商即配置成功。

> **两个容易踩的点**
>
> 1. 地址结尾一定要带 `/v1`，少写会返回 404。
> 2. 如果 whiteboard-studio 部署在**另一台机器**（不是 Notebook 本机），`127.0.0.1` 就指向那台机器自己，必须改成 Notebook 的内网 IP 或自定义服务域名，同时确认 vLLM 启动时带了 `--host 0.0.0.0`。

配置完成后可以先在对话区随便问一句，能正常返回就说明打通了。

---

## 七、生成第一条白板视频

### 7.1 新建视频

点击"新建视频"，输入视频主题。这里以"给初中生做一个能量守恒定律的科普视频"为例：

![新建视频](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030201647400.png)

确认后进入创作界面：

![创作界面](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030201737655.png)

### 7.2 写旁白（可让本地模型润色）

在右侧"旁白"面板里填写每个分镜要说的话。写不顺手就点 AI 润色——**这一步走的就是刚才配置的本地 Qwen3-8B**，不联网、不计费：

![旁白与AI润色](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030202021082.png)

> 如果润色等得久，多半是模型开了思考模式。上一篇的客户端里用 `chat_template_kwargs.enable_thinking=false` 关掉它，速度会快一倍。

### 7.3 选配音

点击"配音"，下拉可选三个平台的 TTS：

| 平台 | 特点 |
|---|---|
| edge-tts | 免费、音色多、开箱即用，走微软在线接口 |
| 小米 TTS | 需配置密钥 |
| 火山引擎 TTS | 音质最好，需配置密钥与音色 ID |

![选择配音](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030202303768.png)

### 7.4 文案扩写

"文案"面板可以贴一段原始素材，让模型按分镜扩写成适合口播的旁白：

![文案扩写](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030202520593.png)

### 7.5 一键成片

右上角"一键成片"把整条流水线串起来：

```
文案 → 文案转语音（TTS） → 文案生成画面 → 生成视频 → 合成视频
```

![一键成片](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030203010021.png)

![生成中](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030203025181.png)

几分钟后出片：

![成片结果](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030203140734.png)

---

## 八、产物清单

一次成片会输出一整套可直接发布的素材：

![产物文件](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/image-20261030203401846.png)

| 文件 | 用途 |
|---|---|
| `final.mp4` | 成片，可直接上传 |
| `字幕.srt` | 逐句时间轴字幕 |
| `封面3*4.png` | 竖版封面（小红书 / 抖音） |
| `封面4*3.png` | 横版封面（B 站 / 视频号） |
| `封面9*16.png` | 全屏竖版封面 |

字幕示例（能量守恒定律那条）：

```
1
00:00:00,312 --> 00:00:03,152
把能量想象成一个可以变换形状的总量

2
00:00:03,293 --> 00:00:04,634
它不会凭空产生

3
00:00:04,634 --> 00:00:05,873
也不会凭空消失

4
00:00:06,022 --> 00:00:07,384
只会从一种形式

5
00:00:07,384 --> 00:00:08,717
转移到另一种形式

6
00:00:08,866 --> 00:00:10,185
变化的是形式

7
00:00:10,185 --> 00:00:11,248
不变的是总量

8
00:00:11,397 --> 00:00:13,165
这就是能量守恒定律
```

时间轴与画面是对齐的，直接拿去剪映或播放器都能用。

---

## 九、踩坑记录

| 现象 | 原因 | 解决 |
|---|---|---|
| 浏览器打不开 `localhost:8080` | 容器内地址，外网不可达 | 走"访问自定义服务"的外网域名 |
| `pnpm: command not found` | 未安装 pnpm | `npm i -g pnpm` 或 `corepack enable` |
| 模型测试报 404 | Base URL 少了 `/v1` | 补全为 `http://127.0.0.1:8000/v1` |
| 模型测试超时 / 连接被拒 | vLLM 未加 `--host 0.0.0.0`，或跨机仍用 `127.0.0.1` | 改启动参数、改地址 |
| AI 润色很慢 | Qwen3 思考模式开着 | 传 `enable_thinking=false` |
| 一键成片中途失败 | TTS 走在线接口，网络抖动 | 换 edge-tts，或分步执行（先配音再合成） |
| 生成耗时长 | 分镜多、视频长 | 控制文案在 8~12 句，单条 1~2 分钟为宜 |

---

## 十、小结

把两篇文章连起来看，其实是同一件事的两个阶段：

| 阶段 | 目标 | 主要成本 | 产出 |
|---|---|---|---|
| 上一篇 | 让卡变成服务 | **环境工程**：版本对齐、依赖补齐、CUDA Graph 关闭 | 一个 OpenAI 兼容的 Qwen3-8B 服务 + 可复用镜像 |
| 这一篇 | 让服务变成生产力 | **内容工程**：文案、分镜、配音 | 一条带字幕和封面的成片视频 |

上一篇的结论是"业务代码零改动"，这一篇正好做了一个印证：**whiteboard-studio 一行代码没改，只是把模型地址指向了本地服务**。上层应用的生态兼容性，恰恰是国产卡最容易被低估的优势。

至于这条链路值不值得跑，答案还是那句——**国产卡的可用性，最终不是靠参数表证明的，而是靠"能跑出东西"证明的**。一条白板视频，就是一个挺直观的证据。

---

**附：本文环境速查**

```
平台      : 超算互联网 Notebook
加速卡    : 海光 K100 (DCU)，单卡 64GB，设备名 K500SM_AI
操作系统  : Ubuntu 22.04
DTK       : 26.04
Python    : 3.10
PyTorch   : 2.5.1+das.opt1.dtk2604
vLLM      : 0.11.0+das.opt1.dtk2604.torch251
模型      : Qwen3-8B (modelers.cn/Qwen-AI/Qwen3-8B)
模型服务  : http://127.0.0.1:8000/v1  (--enforce-eager, BF16)
前端项目  : whiteboard-studio (github.com/wwwzhouhui/whiteboard-studio)
前端端口  : 8080（经自定义服务映射至外网）
```
