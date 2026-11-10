# 语音调校迁移手册（换电脑 / 重装系统后还原）

> **最快路径**：大部分文件已经打包好了，直接下这个 zip——
> [`elysia-voice-assets.zip`](https://github.com/1148462398-hub/dsh-elysia-memory/releases/download/voice-assets-v2.7.2/elysia-voice-assets.zip)（203 MB）
>
> 里面有：GPT 权重、SoVITS 权重、参考音频、6 个后处理脚本、一份说明 README。
> **不含引擎本体**（GPT-SoVITS 27 GB，要自己装）。
> 下面这份文档是「为什么要拷这些、哪些机器相关要重配」的完整解释。

> 这份文档说清楚一件事：**爱莉希雅语音的后处理链调校都在哪些文件里、换电脑后要拷什么、什么要重配。**
>
> 语音的后处理链（吸气压缩、EQ、去噪、去哨音、说话时机）是反复调出来的，散落在 workspace
> 根目录的一堆 Python 脚本里。它们**不是插件内置的**——插件是纯 JS、零依赖，只负责
> 「预处理文本 → 起子进程调 `elysia_say.py` → 交回音频路径」。
> 所以这份清单存在的意义，就是让你换电脑后能**一键核对**，而不是靠记忆瞎猜。

---

## 一、整体结构（谁调用谁）

```
插件 lib/voice.js (cleanForSpeech → 英文音译 → 起子进程)
        │  spawn <python> elysia_say.py "文本" --save-only --model v5turbo --ref R06
        ▼
elysia_say.py  （合成入口：打 GPT-SoVITS HTTP API + 后处理链调度）
        │  import（同目录模块）
        ├── elysia_quality.py    上行压缩 + 升余弦 EQ + 迭代陷波去哨音 + 峰值归一 + silence_lock
        ├── elysia_denoise.py    fix_chain()：音质主链
        ├── elysia_breath_fix3.py 吸气压缩（clean_v3）
        ├── elysia_timing.py     说话时机（plan_from_text / retime_pauses / ensure_edges）
        └── _timing_lib.py       静音检测底层库（load/detect/save）
        │  HTTP
        ▼
GPT-SoVITS 引擎（127.0.0.1:9880）
        ├── 权重（v5turbo SoVITS + GPT）
        └── 参考音频（R06 / R04 / R07 / gameA）
```

---

## 二、换电脑后要拷的文件（跨机器稳定，是调校资产本身）

这些文件**内容不依赖机器**，换个电脑路径对上就能用。建议整个 workspace 目录一起拷，至少别漏下面这批：

| 文件（相对 workspace 根目录） | 作用 | 说明 |
|---|---|---|
| `elysia_say.py` | 合成入口 + 后处理链调度 | 核心，必须拷 |
| `elysia_quality.py` | 上行压缩 + EQ + 去哨音 + 峰值归一 | 后处理主链 |
| `elysia_denoise.py` | `fix_chain()` 音质主链 | 后处理主链 |
| `elysia_breath_fix3.py` | 吸气压缩 | 后处理链 |
| `elysia_timing.py` | 说话时机（停顿重排） | 后处理链 |
| `_timing_lib.py` | 静音检测底层库 | 被 elysia_timing 依赖 |
| `elysia_work/ref_manifest_new.json` | 参考音频清单（含每条原文 text_off） | 调参依据，建议拷 |
| `_game_audio/refs_new/elysia_R04_p950.90_d4.6s.wav` | 参考音频 R04 | ref=R04 用 |
| `_game_audio/refs_new/elysia_R06_p950.90_d4.9s.wav` | 参考音频 R06（默认） | ref=R06 用 |
| `_game_audio/refs_new/elysia_R07_p951.00_d5.3s.wav` | 参考音频 R07 | ref=R07 用 |
| `_game_audio/refs_game/elysia_A_cos0951_9.3s.wav` | 参考音频 gameA | ref=gameA 用 |
| `_elysia_audio/`（可选） | 历史合成产物 | 只有对照用，不拷也能跑 |

> ⚠️ 参考音频的路径是 `elysia_say.py` 里 `REF_R04/REF_R06/REF_R07/GAME_REF_A` 硬编码的
> （基于 `os.path.dirname(__file__)` 拼接）。所以**只要参考音频和 `elysia_say.py` 保持同目录结构**，
> 换电脑后不用改脚本里的路径；如果目录结构变了，就得改 `elysia_say.py` 里那几个 `REF_*` 常量。

---

## 三、机器相关、要重配的项（不要照搬旧机器的值）

| 配置项 | 在哪个文件/配置里 | 为什么机器相关 | 怎么重配 |
|---|---|---|---|
| `voice.engineDir` | 插件配置（`voice.engineDir`） | GPT-SoVITS 引擎根目录，含 api_v2.py、runtime、权重 | 指向新机器上的引擎根目录 |
| `voice.pythonPath` | 插件配置 | 跑引擎的 Python（含 torch/CUDA） | 指向引擎自带 `runtime\python.exe` 或系统 Python |
| `voice.sayPythonPath` | 插件配置 | 跑 `elysia_say.py` 的 Python（只需 numpy/scipy，不要 torch） | 指向新机器上装了 numpy/scipy 的 Python |
| `voice.scriptPath` | 插件配置 | `elysia_say.py` 的绝对路径 | 指向新 workspace 里的 `elysia_say.py` |
| `voice.engineUrl` | 插件配置 | 引擎 HTTP 端口（一般不变 `127.0.0.1:9880`） | 一般不用改 |
| `ELYsia_ENGINE_DIR`（可选环境变量） | 环境变量 | 覆盖 `elysia_say.py` 里的 `ENGINE_DIR` 默认值 `D:\tts\...` | 新盘符不同时用它覆盖 |

> ⚠️ `elysia_say.py` 顶部有 `DIR = r"D:\tts\GPT-SoVITS-v5-20261006nvidia50x0"` 和
> `ENGINE_DIR = os.environ.get("ELYSIA_ENGINE_DIR") or r"D:\tts\..."`。
> 这是**本机硬编码的默认路径**，换电脑后要么设 `ELYSIA_ENGINE_DIR` 环境变量，要么改脚本。
> 引擎根目录（api_v2.py 那一层）必须真实存在，权重路径是相对它拼的。

---

## 四、跨机器稳定 vs 机器相关（一句话总结）

- **跨机器稳定（要拷）**：权重文件本身、参考音频、后处理参数（都在脚本里）、`elysia_*.py` 脚本链。
- **机器相关（要重配）**：`engineDir`、`pythonPath`、`sayPythonPath`、`scriptPath`、
  引擎安装（27GB 整合包 + NVIDIA 显卡 + CUDA）、以及 `elysia_say.py` 里硬编码的 `D:\tts\...` 默认路径。

> 注意区分「权重文件」和「权重文件的位置」：
> 权重文件内容稳定，但它的**绝对路径**在引擎根目录下，换盘符就要跟着改 `voice.engineDir`。

---

## 五、还原后怎么验证

1. 先把插件配置里 `voice.engineDir / pythonPath / sayPythonPath / scriptPath` 填对新路径。
2. 跑一遍调校完整性自检：`GET /dsh-shared-memory/api/voice/tuning`（或面板语音页新增的「调校自检」），
   它会列出后处理链 / 权重 / 参考音频逐项是否存在，并指出缺失项。
3. 再跑环境检测：`GET /dsh-shared-memory/api/voice/doctor`（显卡 / Python / 磁盘 / 引擎）。
4. 最后合成一句试听：面板「试听」按钮，或 `memory_file_voice({action:"say", text:"…"})`。

---

## 六、为什么不把引擎/权重塞进插件

- GPT-SoVITS 完整安装 27GB（精简 10-12GB），权重约 1.6GB，塞进插件会把插件撑爆，而且
  torch/CUDA 依赖是机器相关的（NVIDIA 显卡、驱动、CUDA 版本），跨机器根本不通用。
- 插件只做「参数/脚本的清单 + 说明 + 校验」这层，把「该拷什么、该重配什么」固化下来，
  而不是把二进制资产打包进去。这是有意的边界。

---

## 没有 N 卡也能跑（CPU / A 卡）

GPT-SoVITS 官方安装器在 **Windows 上只给 CUDA 和 CPU**（ROCm 只在 Linux 的 `install.sh` 里有）。
所以「A 卡」在 Windows 上的现实答案就是 **CPU 模式**。

### 一行切换

设备只从 `GPT_SoVITS/configs/tts_infer.yaml` 读（`api_v2.py` 里的 `--device` 是注释掉的），
改 `custom:` 段这两行即可：

```yaml
custom:
  device: cpu      # 原来是 cuda
  is_half: false   # 原来是 true
```

或者交给插件：`voice.device: 'auto'`（默认）会在第一次启动时探测 `torch.cuda.is_available()`，
探测不到就自动用 CPU，并生成 `tts_infer.cpu.yaml` 用 `-c` 启动——**原配置不动**。
也可以显式写 `cuda` / `cpu`，或在面板上点「切换设备」（写进 state.json，重启引擎后生效）。

### 实测速度（Ryzen 7 9800X3D / 16 线程，v5turbo）

| 设备 | 7.3 秒音频的合成耗时 | 实时率 |
|---|---|---|
| RTX 5070 Ti（CUDA） | 0.9 秒 | 0.14× |
| 同 CPU | 8.4 秒 | **1.15×** |

也就是说：**你说一句 7 秒的话，它 8 秒后能念出来**。对话可用，只是别指望实时。
引擎首次加载权重在 CPU 上约 25 秒（GPU 约 20 秒），插件已把 CPU 模式的启动超时放宽到 240 秒。

### 为什么不走 DirectML / ZLUDA

GPT-SoVITS 的算子没有按 DirectML 或 ZLUDA 写过，装上去大概率报各种算子缺失。
RVC 反而是官方支持 DirectML 的（`A卡/I卡使用 CPU 依赖方案；Windows 可使用 DirectML`），
但 RVC 是「变声」不是「合成」，需要另外训练模型——两条路别混。