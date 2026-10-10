# Donut Trader 卡片 · 生图后端对接 PRD（人话版）

写给后端的同学。目标：把现在跑在 Cory 账号上的 mock 生图后端，换成我们自己的正式服务，前端一行配置切过去，其它都不用动。
更新：2026-10-09 · 维护：Cory（设计）。接口字段的权威定义在 `tools/cardgen/BACKEND.md`，本文只讲"是什么、怎么跑、你要做什么、怎么测"。

---

## 1. 项目在哪

| 东西 | 位置 |
|---|---|
| 代码仓库 | `DonutLabs-ai/kol-identity-h5`（私有） |
| 分支 | `dev` = 日常开发（Vercel 预览）· `prod` = 线上（Vercel 生产）· `main` = 旧版 GitHub Pages 流程，不用管 |
| 前端线上 | https://kol-identity-h5.vercel.app （`/` 自动跳到 `/v2/`）。静态站，没有构建步骤，Vercel 直接托管仓库文件 |
| 前端页面 | `v2/index.html`（落地页）→ `v2/claim.html`（资料 + 六道题）→ `v2/analysis.html`（D0 读取动画 + 结果卡） |
| 前端指向后端的地方 | `v2/config.js` 里一行：`window.DONUT_CARD_API = "https://donut-card-art.fly.dev"`。换成你的服务地址即可（页面在 localhost 打开时固定用本机 mock，URL 加 `?api=…` 可临时覆盖） |
| 后端（现在的 mock） | `tools/cardgen/server.mjs`（Node 20，无依赖，单文件），抠图脚本 `tools/cardgen/harness/cutout.py`（Linux）/ `cutout.swift`（macOS） |
| 后端线上 | Fly.io，app `donut-card-art`，https://donut-card-art.fly.dev ，San Jose，shared-cpu-2x / 2 GB，3 GB 持久卷放缓存。部署文件 `tools/cardgen/Dockerfile`、`fly.toml`，步骤 `tools/cardgen/DEPLOY.md` |
| 提示词 | `tools/cardgen/prompts.md`（源）· `tools/cardgen/PROMPT-EXPORT.md`（逐字导出，给人看） |
| 接口定义 | `tools/cardgen/BACKEND.md` §3（接口）§4（流程）§11–12（两种 pipeline 对比） |

---

## 2. 图是怎么生成的，现在跑得怎么样

**一句话**：拿用户的 X 头像 + 他测出来的交易人格，调一次 Gemini 出一张 1024×1024 的卡面；再把人物从画面里抠出来，前端用它做卡内的 2.5D 视差。

**流程（server.mjs 里就这几步）**

1. 收到 `POST /v1/identity/card-art`，body 里是头像（base64 `avatar_data` 或 `avatar_url`）、handle、人格 id（12 个之一，见 BACKEND.md §5）。
2. 算缓存 key = `sha256(头像字节) : 人格 : prompt_version`。命中就直接返回 `done`，不花钱。
3. 没命中：通过 OpenRouter 调 `google/gemini-3-pro-image`（chat completions 接口，`modalities: ["image","text"]`），输入 = 头像图 + 一段文本（`prompts.md` 里该人格的装备/动作 + 风格描述，逐字见 PROMPT-EXPORT.md §3）。返回 base64 PNG，存成 `<key>.png`。到这里就对外报 `done`。
4. 后台跑抠图：`rembg`（isnet-general-use 模型）把人物抠成带 alpha 的 `<key>.cut.png`，再生成一张"干净底图" `<key>.plate.jpg`（人物区域用模糊填掉）。前端把底图放在窗口层、人物放在前一层，鼠标/手机一动就有立体感。
5. 轮询接口在抠图没好之前最多等 15 秒；超过就先把 `done` + 卡面给出去，`cutout: "pending"`，前端自己再追 2.5 分钟把图层补上。

**实测数字（2026-10-09，Fly 线上）**

| 项目 | 数字 |
|---|---|
| 新卡从 POST 到 `done`（含抠图） | 39 s（Gemini ≈ 25 s，抠图 ≈ 10 s） |
| 单张成本 | ≈ $0.14（OpenRouter 计费） |
| 缓存命中 | < 1 s |
| 卡面文件 | PNG 1.8 MB；抠图 PNG ≈ 1 MB；底图 JPG ≈ 0.2 MB（正式服务请转 WebP 并走 CDN） |
| 进程花费上限 | 环境变量 `CARD_BUDGET`（线上 50 美元），到了只返回缓存 |

**现状**：线上可用，前端已接通；六个 demo 账号（chriszhu / cz_binance / elonmusk / justinsuntron / VitalikButerin / ansem）的卡已预先放进缓存，秒出；其它组合现生成。
备选方案"两步 pipeline"（GPT 画卡 → Gemini 重绘，≈ 3.5 min / $0.39，更好看）只在本机能跑（需要不入库的 moodboard 参考图），线上默认快速路径。

**已知的坑（都已处理，写出来省你踩一遍）**
- 头像文件名曾和成品同名，导致轮询秒回 `done` 却拿到头像本身 —— 现在头像存为 `<key>.avatar.<ext>`。
- 任务线程和轮询各起一个抠图进程，2 GB 机器直接 OOM —— 现在每个 key 只跑一次（single-flight）。
- 抠图失败会写 `<key>.cut.none` 标记，之后不再重试；要重跑删掉它。

---

## 3. 需要你做什么

现在的后端是 Cory 的 Fly 账号 + Cory 的 OpenRouter key，没有鉴权、CORS 全开，谁拿到 URL 都能花额度。正式上线要换成我们自己的服务。最省事的路线是**直接把 `server.mjs` 搬过去**（它就是参考实现），在它外面补这几件事：

1. **身份与头像**：前端目前把头像 base64 传上来（mock 没有登录）。正式版应该是：X OAuth 登录 → 服务端从会话里拿 `profile_image_url`（把 `_normal` 换成 `_400x400`）自己下载 → 不信任客户端传的任何头像/handle。接口里 `avatar_data` 这个字段可以砍掉。详见 `docs/X接入说明.md`。
2. **鉴权与限流**：两个接口都要求登录态；每账号每天限次（建议 3 次），防刷额度。
3. **存储**：成品、抠图、底图上 CDN（WebP），接口返回绝对 URL；任务记录入库（user、type、prompt_version、cost、耗时），便于查账。
4. **抠图依赖**：Linux 上 `pip install rembg onnxruntime pillow numpy`，模型 179 MB 建议打进镜像（`Dockerfile` 有现成写法），内存给 2 GB。
5. **Key 与模型**：用公司自己的 OpenRouter 账号；Cory 在聊天里贴过的 key 上线前必须换。模型固定 `google/gemini-3-pro-image`；`prompt_version` 变了缓存自动失效，这个机制要保留。
6. **CORS**：只放行 `https://kol-identity-h5.vercel.app`（以及之后的正式域名）。
7. **前端切换**：把你的地址写进 `v2/config.js`，push `dev` 再 `git push origin dev:prod`，Vercel 自动上线。其它前端代码不用改。
8. **不用做**：胶片颗粒、卡片 UI、分享图 —— 都在前端。

接口契约（照 `BACKEND.md` §3 实现，前端已按这个写死；2026-10-10 按产品口径定稿）：
- `POST /v1/identity/card-art` → `200 {status:"done", image_url, layers:{status, cutout_url?, plate_url?}}` 或 `202 {status:"running", stage, job_id}`；失败任务之后再 POST 算一次新任务（计额度）
- `GET /v1/identity/card-art/{job_id}` → `running`（带真实 `stage`）/ `done`（`layers.status` = `pending` | `ready` | `failed`，三层是独立状态）/ `failed`（`error` = `timeout` | `provider_error` | `moderation_blocked` | `budget` | `no_avatar`）
- `POST /v1/identity/card-art/{job_id}/layers` → 只重做抠图和底图（"重试立体效果"），不调 LLM、不计额度
- 规则：`failed`/`timeout` 必须是服务端判定（LLM 540 s、抠图 180 s 各自有上限），前端不会因为等久了就宣告失败；LLM 和图层的成功/失败/超时/耗时分开记（mock 写 `jobs.jsonl`，`/healthz` 有计数）
- `GET /healthz` → `{ok:true, pipeline, spent_usd, prompt_version}`
- 前端行为：每 3 s 轮询，最长等 6 分钟，8 s 后显示百分比（按 30 s 预期），拿到 `done` 才进结果页。

---

## 4. 怎么测

**A. 直接打接口（任何机器，不用登录）**

```bash
curl https://donut-card-art.fly.dev/healthz
```

```bash
cd /path/to/kol-identity-h5 && B64=$(base64 -i flashcard/kol-pfp.jpg | tr -d '\n') && curl -s -X POST https://donut-card-art.fly.dev/v1/identity/card-art -H 'Content-Type: application/json' -d "{\"avatar_data\":\"data:image/jpeg;base64,$B64\",\"handle\":\"@test\",\"type\":\"scalper\"}"
```

返回 `{"status":"running","job_id":"…"}`（或命中缓存直接 `done`）。然后每 3 秒：

```bash
curl -s https://donut-card-art.fly.dev/v1/identity/card-art/<job_id>
```

预期：`running / stage=gemini` → 25 秒左右 → `done` + `image_url`（抠图通常也在里面；没有就是 `cutout:"pending"`，再问一次会有）。图片直接 `GET https://donut-card-art.fly.dev/art/<key>.png`。人格 id 共 12 个 + `unresolved`，传错返回 `400 unknown_type`。

**B. 走一遍产品（线上）**

1. 打开 https://kol-identity-h5.vercel.app/v2/ ，点 Claim now，登录弹窗里点 "Demo as" 的任意头像（或直接 `…/v2/claim.html?kol=elonmusk`）。
2. 资料页直接 Next（demo 不校验），六道题已按人设预填，Next、Next、Reveal my card。
3. "D0 is reading" 动画约 4 秒后出卡（demo 账号命中缓存）；把任意一题改掉再提交，就会现生成，看到百分比，约 40 秒出卡，卡内人物随鼠标/手机动有视差。
4. 结果页 Share on X 是 intent 链接，Save card 目前是 demo（只变文案）。

**C. 本机跑（改代码时）**

```bash
cd kol-identity-h5 && python3 -m http.server 3025 --bind 127.0.0.1
```

```bash
cd kol-identity-h5 && OPENROUTER_API_KEY=你的key node tools/cardgen/server.mjs --port 3022
```

打开 http://127.0.0.1:3025/v2/ ，页面在 localhost 会自动用 3022。macOS 上抠图走系统 Vision，不用装 rembg；Linux 装了 rembg 才有抠图，没有也能出卡。

**D. 各种状态怎么看（产品 2026-10-10 口径，前端已实现）**

在结果页 URL 加一个参数就能演示（只对 mock 有效，正式服务没有）：
- `?fault=layers`：主图成功、立体图层失败 → 平面卡 + "Your card is ready. The 3D effect isn't available yet." + **Retry 3D effect**（只重做图层）
- `?fault=llm`：LLM 失败 → 用 X 头像原图做卡 + "Your card is ready using your original profile picture." + **Regenerate card**（新任务，保留当前卡）
- `?fault=net`：前两次请求连不上 → "Can't confirm generation progress right now. Reconnecting…" + **Check progress**（只查原任务）
- 正常：三层齐了才揭晓；等待页显示真实阶段（Painting your card → Rendering the 3D layers）。
例：https://kol-identity-h5.vercel.app/v2/analysis.html?kol=cz_binance&fault=layers

**E. 失败怎么看**
- 轮询返回 `failed`：看服务日志（Fly：`fly logs -a donut-card-art`），常见是 OpenRouter 拒绝（真人名人头像偶尔会）、超时、额度上限。
- `cutout:"none"`：抠图没抠出主体（画面覆盖 < 3 % 或 > 90 %），卡照常显示，只是没有立体层。
- 想重跑某张：删缓存目录里对应的 `<key>.*` 文件。
