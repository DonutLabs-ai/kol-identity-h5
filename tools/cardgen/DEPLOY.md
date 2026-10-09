# 部署生图 mock 后端（快速路径）

`server.mjs` 就是后端：两个接口（`BACKEND.md` §3）+ 缓存 + 主体抠图。默认 **快速路径**（一次 Gemini，≈24 s，≈$0.14/张）。
容器里用 Python `rembg` 做抠图（本机 Mac 用 Vision），所以线上也有卡内 2.5D 视差。

## Fly.io（推荐，一台常驻小机器 ≈ $10/月 + 3 GB 卷）

```bash
brew install flyctl && fly auth login            # 一次性
cd tools/cardgen
fly launch --copy-config --name donut-card-art --region sjc --no-deploy   # 读 fly.toml；名字被占就换一个
fly volumes create cache --region sjc --size 3 --yes                     # 缓存卷（挂到 /app/out）
fly secrets set OPENROUTER_API_KEY="$(sed -n 's/^OPENROUTER_API_KEY=//p' ../../.env)"   # 不会打印 key
fly deploy                                                               # 首次构建 ≈ 5–8 分钟（装 rembg + 模型）
curl https://donut-card-art.fly.dev/healthz                              # {"ok":true,"pipeline":"fast",...}
```

然后把前端指过去：`v2/config.js` 里 `window.DONUT_CARD_API = "https://donut-card-art.fly.dev"`，commit，重新部署站点。
临时试一下不用改代码：页面 URL 加 `?api=https://donut-card-art.fly.dev`。

## 其它平台

任何能跑 Docker 的地方都行（Render / Railway / 一台 VPS）：构建上下文是 `tools/cardgen`，环境变量
`OPENROUTER_API_KEY`（必填）、`PORT`、`HOST=0.0.0.0`、`CARD_PIPELINE=fast`、`CARD_BUDGET`（每个进程的美元上限，默认 20）。
健康检查 `GET /healthz`。持久化（可选）挂 `/app/out`。本地跑 Docker：

```bash
docker build -t donut-card-art tools/cardgen
docker run -p 3022:3022 -e OPENROUTER_API_KEY=... donut-card-art
```

## 注意

- 接口没有鉴权、CORS 全开：拿到 URL 的人都能花你的额度。`CARD_BUDGET` 到了就只返回缓存；上线前接 Sean 的会话校验（`BACKEND.md` §3）。
- 聊天里贴过的 OpenRouter key 上线前要换（`fly secrets set` 再设一次即可）。
- 两步 pipeline（GPT→Gemini，更好看，≈3.5 min/$0.39）需要 `style-refs/`（第三方 moodboard 图，不入库，镜像里没有），所以线上只能快速路径；本机 `--pipeline two`。
- 卡面生成 24 s 左右，前端 `ART_EXPECT` 已按 30 s 显示百分比，最长等 6 分钟。
