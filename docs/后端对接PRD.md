# Donut Trader 卡片 · 生图后端对接 PRD（人话版）

写给后端的同学。目标：把现在跑在 Cory 账号上的 mock 生图后端，换成我们自己的正式服务，前端一行配置切过去，其它都不用动。
更新：2026-10-14（按产品 S13 口径：60 s 统一上限、只有两种 Retry、静默兜底、断网不重试、回访直达结果页；前端和 mock 已实现）· 维护：Cory（设计）。接口字段的权威定义在 `tools/cardgen/BACKEND.md`，本文只讲"是什么、怎么跑、你要做什么、怎么测"。

---

## 1. 项目在哪

| 东西 | 位置 |
|---|---|
| 代码仓库 | `DonutLabs-ai/kol-identity-h5`（私有） |
| 分支 | `dev` = 日常开发（Vercel 预览）· `prod` = 线上（Vercel 生产）· `main` = 旧版 GitHub Pages 流程，不用管 |
| 前端线上 | https://kol-identity-h5.vercel.app （`/` 自动跳到 `/v2/`）。静态站，没有构建步骤，Vercel 直接托管仓库文件 |
| 前端页面 | `v2/index.html`（落地页）→ `v2/claim.html`（资料 + 六道题）→ `v2/analysis.html`（D0 读取动画 + 结果卡） |
| 前端指向后端的地方 | `v2/config.js` 里一行：`window.DONUT_CARD_API = "https://donut-card-art.fly.dev"`。换成你的服务地址即可（页面在 localhost 打开时固定用本机 mock，URL 加 `?api=…` 可临时覆盖） |
| 后端（现在的 mock） | `tools/cardgen/mock-server.mjs`（Node 20，无依赖，单文件；同目录的 `worker.mjs` / `card-art-service.mjs` / `server.mjs` 是后端团队自己的正式服务代码，部署见 `tools/cardgen/DONUT-CLUSTER.md`，和本文的 mock 不是一回事），抠图脚本 `tools/cardgen/harness/cutout.py`（Linux）/ `cutout.swift`（macOS） |
| 后端线上 | Fly.io，app `donut-card-art`，https://donut-card-art.fly.dev ，San Jose，shared-cpu-2x / 2 GB，3 GB 持久卷放缓存。部署文件 `tools/cardgen/Dockerfile.mock`、`fly.toml`（`Dockerfile` 是正式服务的镜像），步骤 `tools/cardgen/DEPLOY.md` |
| 提示词 | `tools/cardgen/prompts.md`（源）· `tools/cardgen/PROMPT-EXPORT.md`（逐字导出，给人看） |
| 接口定义 | `tools/cardgen/BACKEND.md` §3（接口）§4（流程）§11–12（两种 pipeline 对比） |

---

## 2. 图是怎么生成的，现在跑得怎么样

**一句话**：拿用户的 X 头像 + 他测出来的交易人格，让 Gemini 3 Pro 和 3.1 Flash 同时画一张 1024×1024 的卡面，28 s 内 Pro 回来用 Pro、否则用 Flash；再把人物从画面里抠出来，前端用它做卡内的 2.5D 视差。

**流程（mock-server.mjs 里就这几步）**

1. 收到 `POST /v1/identity/card-art`，body 里是头像（base64 `avatar_data` 或 `avatar_url`）、handle、人格 id（12 个之一，见 BACKEND.md §5）。
2. 算缓存 key = `sha256(头像字节) : 人格 : prompt_version`。命中就直接返回 `done`，不花钱。
3. 没命中：通过 OpenRouter 同时调 `google/gemini-3-pro-image` 和 `google/gemini-3.1-flash-image`；Pro 在 28 s 内回来就用 Pro，否则用 Flash（见 BACKEND.md §13）（chat completions 接口，`modalities: ["image","text"]`），输入 = 头像图 + 一段文本（`prompts.md` 里该人格的装备/动作 + 风格描述，逐字见 PROMPT-EXPORT.md §3）。返回 base64 PNG，存成 `<key>.png`。到这里就对外报 `done`。
4. 后台跑抠图：`rembg`（isnet-general-use 模型）把人物抠成带 alpha 的 `<key>.cut.png`，再生成一张"干净底图" `<key>.plate.jpg`（人物区域用模糊填掉）。前端把底图放在窗口层、人物放在前一层，鼠标/手机一动就有立体感。
5. 卡面一到就对外报 `done`，不等抠图；图层单独走 `layers.status`：`pending → ready | failed`。整个任务（生图 + 图层）由服务端在 **60 s** 内判定：到点没有主图 → `failed: timeout`；有主图没图层 → `layers.status: failed, error: timeout`。单独重试图层另给 60 s。前端拿到 `done` 后继续轮询，三层齐了才揭晓；图层失败就先出平面卡 + "Retry 3D effect"（只重做图层，不调 LLM）。

**接口实测（Fly 线上，2026-10-12 更新）**

| 项目 | 数字 |
|---|---|
| 新卡从 POST 到 `done`（含抠图） | 2026-10-12 起「赛跑」：`gemini-3-pro-image`（画质最好，通常 22 s，实测会到 48 s）和 `gemini-3.1-flash-image`（≈ 12 s）同时发；28 s 内 Pro 回来就用 Pro，否则用已经等着的 Flash。抠图 ≈ 7–15 s。整体通常 30–37 s，坏情况 ≈ 35–43 s |
| 单张成本 | ≈ $0.21（两路都计费；`CARD_RACE_MODE=hedge` 只在超时才发 Flash，≈ $0.14） |
| 缓存命中 | < 1 s |
| 卡面文件 | PNG 1.8 MB；抠图 PNG ≈ 1 MB；底图 JPG ≈ 0.2 MB（正式服务请转 WebP 并走 CDN） |
| 进程花费上限 | 环境变量 `CARD_BUDGET`（线上 50 美元），到了只返回缓存 |

**产品端实测（2026-10-12 晚，线上 Vercel 页面 + Fly 后端，两张全新未缓存的卡）**

| 用例 | 生图模型 | 生图（LLM）耗时 | 抠图 + 底图就绪 | 页面翻出卡片 |
|---|---|---|---|---|
| @elonmusk · Sniper | `gemini-3-pro-image`（28 s 内 Pro 自己回来，Flash 没接力） | 25.9 s | ≈ 29 s | **37.6 s** |
| @cz_binance · Swing Hunter | 同上 | 20.0 s | ≈ 22 s | **30.6 s** |

- 计时口径：浏览器打开 `analysis.html` 起算，到卡片揭晓为止；后端两列取自 `GET /v1/identity/card-art/{job}` 返回的 `llm_ms`，以及 `layers.status` 变成 `ready` 的时刻。两张卡的 2.5D 图层都正常，没有触发任何降级提示。
- 翻牌比后端就绪晚 6–8 s：浏览器要下载三张图（卡面 PNG 1.8 MB、抠图 PNG ≈ 1 MB、底图 JPG 0.2 MB）再播揭晓动画。正式服务把图转 WebP 走 CDN（§3 第 3 条）后这段会明显缩短。
- 结论：现网 30–40 s 出卡，达到"40 s 左右"的要求。Pro 超过 28 s 的慢请求会改用已经等着的 Flash 结果，最坏情况也在 40 s 附近，只是那一张是 Flash 画质。
- 复现：按 §4 B 走一遍并把任意一题改掉（避开缓存）；结果页控制台 `DonutArt.job` 是任务 id，拿它去打 GET 接口就能看到 `llm_ms` / `model` / `raced`（`raced: true` = Flash 接力）。

**现状**：线上可用，前端已接通；六个 demo 账号（chriszhu / cz_binance / elonmusk / justinsuntron / VitalikButerin / ansem）的卡已预先放进缓存，秒出；其它组合现生成。
非人物头像（logo、物体、动物）的规则（2026-10-14 定稿，prompt v12）：主体原样不动、不加道具和动作，logo 不加圆框，人格只以 2–4 个该类型道具漂在背景里，道具都比主体小；卡片文字说明类型。
备选方案"两步 pipeline"（GPT 画卡 → Gemini 重绘，≈ 3.5 min / $0.39，更好看）只在本机能跑（需要不入库的 moodboard 参考图），线上默认快速路径。

**已知的坑（都已处理，写出来省你踩一遍）**
- 头像文件名曾和成品同名，导致轮询秒回 `done` 却拿到头像本身 —— 现在头像存为 `<key>.avatar.<ext>`。
- 任务线程和轮询各起一个抠图进程，2 GB 机器直接 OOM —— 现在每个 key 只跑一次（single-flight）。
- 抠图失败会写 `<key>.cut.none` 标记，之后不再重试；要重跑删掉它。

---

## 3. 需要你做什么

现在的后端是 Cory 的 Fly 账号 + Cory 的 OpenRouter key，没有鉴权、CORS 全开，谁拿到 URL 都能花额度。正式上线要换成我们自己的服务。最省事的路线是**直接把 `mock-server.mjs` 搬过去**（它就是参考实现），在它外面补这几件事：

1. **身份与头像**：前端目前把头像 base64 传上来（mock 没有登录）。正式版应该是：X OAuth 登录 → 服务端从会话里拿 `profile_image_url`（把 `_normal` 换成 `_400x400`）自己下载 → 不信任客户端传的任何头像/handle。接口里 `avatar_data` 这个字段可以砍掉。详见 `docs/X接入说明.md`。
2. **鉴权与限流**：两个接口都要求登录态；每账号每天限次（建议 3 次），防刷额度。
3. **存储**：成品、抠图、底图上 CDN（WebP），接口返回绝对 URL；任务记录入库（user、type、prompt_version、cost、耗时），便于查账。另外按 X 账号存"最近一张卡"并提供 `GET /v1/identity/card-art/mine`（S13 第 5 条：回访直达结果页，不重新生成；demo 版暂存在浏览器 localStorage，见 `v2/demo-kols.js` 的 `DonutCardStore`）。
4. **抠图依赖**：Linux 上 `pip install rembg onnxruntime pillow numpy`，模型 179 MB 建议打进镜像（`Dockerfile.mock` 有现成写法），内存给 2 GB。
5. **Key 与模型**：用公司自己的 OpenRouter 账号；Cory 在聊天里贴过的 key 上线前必须换。模型固定 `google/gemini-3-pro-image`；`prompt_version` 变了缓存自动失效，这个机制要保留。
6. **CORS**：只放行 `https://kol-identity-h5.vercel.app`（以及之后的正式域名）。
7. **前端切换**：把你的地址写进 `v2/config.js`，push `dev` 再 `git push origin dev:prod`，Vercel 自动上线。其它前端代码不用改。
8. **不用做**：胶片颗粒、卡片 UI、分享图 —— 都在前端。

接口契约（照 `BACKEND.md` §3 实现，前端已按这个写死；2026-10-10 按产品口径定稿）：
- `POST /v1/identity/card-art` → `200 {status:"done", image_url, layers:{status, cutout_url?, plate_url?}}` 或 `202 {status:"running", stage, job_id}`；失败任务之后再 POST 算一次新任务（计额度）
- `GET /v1/identity/card-art/{job_id}` → `running`（带真实 `stage`）/ `done`（`layers.status` = `pending` | `ready` | `failed`，三层是独立状态）/ `failed`（`error` = `timeout` | `provider_error` | `moderation_blocked` | `budget` | `no_avatar`）
- `POST /v1/identity/card-art/{job_id}/layers` → 只重做抠图和底图（"重试立体效果"），不调 LLM、不计额度
- 规则（S13，2026-10-14）：**一个任务 = 生图 + 图层，服务端 60 s 内判定**（mock 环境变量 `CARD_JOB_DEADLINE_MS`；正式服务已按 `tools/cardgen/S13-DEADLINE.md` 实现：`processingDeadlineAt`，前端不传时默认收到请求 + 60 s），单独重试图层另给 60 s（`CARD_LAYERS_RETRY_MS` / `acceptedRetryProcessingDeadlineAt`）；额度不足正式服务回 `budget_not_dispatched`，前端按静默兜底处理；`failed`/`timeout` 必须是服务端判定，前端不会因为等久了就宣告失败；LLM 和图层的成功/失败/超时/耗时分开记（mock 写 `jobs.jsonl`，`/healthz.metrics` 分 `ok`/`failed`/`timeout`）
- 前端只在两种情况给 Retry：主图失败/超时 → 用头像（无头像用类型默认图）做卡 + **Regenerate card**（新任务、计额度、新 `requestKey`）；主图成功但图层失败/超时 → 平面卡 + **Retry 3D effect**（只重做图层）。提示和按钮都在过场结束、卡片出现后才显示，重试期间保留当前卡
- `budget`（额度不足）和 `no_avatar` → 静默兜底：有头像用头像、没有用类型默认图，正常展示、可分享保存，不说原因、不给 Retry
- 断网 → 页面只显示一句"Connection lost. Reopen this page to continue."，不给 Retry / 查看进度，也不会自己重发任务；用户重新进入会重走流程，所以**服务端要按缓存 key（头像 + 类型 + prompt_version）去重**，同一个人同一类型不能跑两次
- 回访（已抽卡用户）→ 直接进结果页展示已有卡并引导分享，不重新生成；只有上一次结果属于上面两种失败/超时时才保留对应 Retry（见 BACKEND.md §3 "Revisit"，正式版需要 `GET /v1/identity/card-art/mine`）
- `GET /healthz` → `{ok:true, pipeline, spent_usd, prompt_version}`（mock 现在还带 `model` / `race_model` / `race_mode` / `primary_deadline_ms` 和各阶段成功、失败计数）
- 前端行为：每 3 s 轮询，没有浏览器侧超时（60 s 上限是服务端的；慢任务一直停在等待页并显示真实阶段），8 s 后显示百分比（按 30 s 预期），拿到 `done` 且 `layers.status` 落定（`ready` 或 `failed`）才进结果页。

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

预期：`running / stage=gemini` → 20–26 秒 → `done` + `image_url`（这时 `layers.status` 多半还是 `pending`，再过几秒变 `ready` 并带 `cutout_url` / `plate_url`）。`done` 的回答里还有 `llm_ms`、`model`、`raced`（`true` = Flash 接力），`elapsed_s`。图片直接 `GET https://donut-card-art.fly.dev/art/<key>.png`。人格 id 共 12 个 + `unresolved`，传错返回 `400 unknown_type`。

**B. 走一遍产品（线上）**

1. 打开 https://kol-identity-h5.vercel.app/v2/ ，点 Claim now，登录弹窗里点 "Demo as" 的任意头像（或直接 `…/v2/claim.html?kol=elonmusk`）。
2. 资料页直接 Next（demo 不校验），六道题已按人设预填，Next、Next、Reveal my card。
3. "D0 is reading" 动画约 4 秒后出卡（demo 账号命中缓存）；把任意一题改掉再提交，就会现生成，看到百分比，30–40 秒出卡（实测见 §2），卡内人物随鼠标/手机动有视差。
4. 结果页 Share on X 是 intent 链接，Save card 目前是 demo（只变文案）。

**C. 本机跑（改代码时）**

```bash
cd kol-identity-h5 && python3 -m http.server 3025 --bind 127.0.0.1
```

```bash
cd kol-identity-h5 && OPENROUTER_API_KEY=你的key node tools/cardgen/mock-server.mjs --port 3022
```

打开 http://127.0.0.1:3025/v2/ ，页面在 localhost 会自动用 3022。macOS 上抠图走系统 Vision，不用装 rembg；Linux 装了 rembg 才有抠图，没有也能出卡。

**D. 各种状态怎么看（产品 S13 口径，2026-10-14，前端已实现）**

Demo 用浏览器模拟任务：结果页 URL 加 `?demo=<情况>` 即可演示，对任何后端都有效；默认走真实 60 s，加 `&fast=1` 把上限缩成 6 s 快速过一遍：
- `?demo=timeout&fast=1`：到点没有主图 → 用头像做卡 + "Your card is ready using your original profile picture." + **Regenerate card**（点了就真的重新生成，当前卡保留到新卡到位）
- `?demo=layers-timeout&fast=1`：主图到了、图层到点没好 → 平面卡 + "Your card is ready. The 3D effect isn't available yet." + **Retry 3D effect**（只重做图层）
- `?demo=layers` / `?demo=llm`：同上两种，但第一次回答就判失败（不用等）
- `?demo=budget` / `?demo=noavatar`：静默兜底，没有提示也没有按钮，卡正常显示、可分享保存（budget 用头像，noavatar 用类型默认图）
- `?demo=net`：前两次轮询连不上 → 等待页只显示 "Connection lost. Reopen this page to continue."，没有按钮，连上后自动出卡
- `?demo=net-post`：提交任务那一下就断网 → 同上一句，页面不会自己重发；用户重新进入重走流程
- 回访：任何一个 demo 账号出过卡以后，落地页 "Demo as" 里它的头像带绿圈，点它直接进结果页（没有资料页、问卷和过场），显示 "Welcome back. Your card is ready to share."；上一次是失败/超时的，对应 Retry 还在。想重来：`claim.html?kol=elonmusk&reset=1`
- 正常：三层齐了才揭晓；等待页显示真实阶段（Painting your card → Rendering the 3D layers）。
例：https://kol-identity-h5.vercel.app/v2/analysis.html?kol=cz_binance&demo=layers-timeout&fast=1

服务端也能演示超时（只有 mock 有，正式服务不要做）：`POST …/card-art?fault=slow&deadline_ms=5000` → 5 s 后 `failed: timeout`，不调模型不花钱；`?fault=layers-slow` → 主图正常、图层跑到预算用完 → `layers.status: failed, error: timeout`，再 `POST …/layers` 就正常了。

**E. 失败怎么看**
- 轮询返回 `failed`：看服务日志（Fly：`fly logs -a donut-card-art`），常见是 OpenRouter 拒绝（真人名人头像偶尔会）、超时、额度上限。
- `layers.status:"failed"`（`error` = `no_subject` 画面覆盖 < 3 % 或 > 90 %、`timeout` 超过 180 s、`no_segmenter` 机器上没装 rembg）：卡照常显示，只是没有立体层，页面给 "Retry 3D effect"。
- 想重跑某张：删缓存目录里对应的 `<key>.*` 文件。
