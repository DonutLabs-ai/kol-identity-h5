# X（Twitter）接入说明 · KOL 身份卡

更新：2026-09-30 · 给后端。H5 里的 Connect X 目前是**假的**（固定 @seanmoore，或 `?kol=chriszhu` 演示账号）；真实接入是后端的事，前端只需要拿到三样东西：**名字、handle、头像 URL**。

## 1. 要什么

| 字段 | 用在哪 | 来源 |
|---|---|---|
| `name` | 弹窗资料行、第 1 步资料行、卡片标题（大写） | X `users/me` → `name` |
| `username`（handle） | 同上 + 卡片 notch（`@handle`） | `username` |
| `profile_image_url` | 弹窗/资料行头像；**生图的唯一身份输入** | `profile_image_url`，把 `_normal` 换成 `_400x400` 拿大图 |
| `id` | 缓存键、限流、日志 | `id` |

不需要发帖、私信、关注者列表等任何写权限或额外读权限。

## 2. OAuth 2.0（推荐 PKCE）

1. 在 X Developer Portal 建 App，类型 Web App，开启 OAuth 2.0，回调填后端地址（例：`https://api.donut.ai/auth/x/callback`）。
2. 前端点 Connect X → 跳转 `GET /auth/x/start`（后端生成 `state` + PKCE `code_verifier`，302 到 X 授权页）。
   - scopes：`users.read tweet.read`（`tweet.read` 是 X 拿 `users/me` 的硬性要求，即使不读推文）。`offline.access` 可不加——我们只需要一次读取。
3. X 回调 `/auth/x/callback?code&state` → 后端换 token → `GET https://api.x.com/2/users/me?user.fields=profile_image_url` → 建会话（HttpOnly cookie）→ 302 回 H5，带 `?connected=1`。
4. H5 加载时 `GET /v1/me` 拿到 `{name, username, avatar_url}` 渲染；未登录返回 401，H5 显示 Connect X。
5. **头像不要相信客户端传的地址**：生图接口只用会话里的 `profile_image_url`，服务端自己下载。

Token 可以用完即弃（拿到资料就够了）；要"重新同步头像"再走一遍授权即可。

## 3. 前端要改的三处（我们做）

- `identity/theme.js` 的 `DEMO_KOLS`/`applyDemoProfile` 改成读 `/v1/me`；三处渲染点已经集中在这个函数里。
- Connect X 按钮从"打开假弹窗"改成跳 `/auth/x/start`；回来后自动进第 1 步。
- 卡片 notch 与标题用真 handle/名字（现在已通过同一函数注入，接口通了即生效）。

## 4. 边界与走查

- 头像是默认蛋/剪影 → 生图返回 `failed / no_avatar`，卡面用默认图。
- 头像是 logo/NFT/动物/火箭 → 正常生图（提示词已处理：保留原样，做人格动作）。
- handle 太长（15 字符上限）→ 卡片 notch 已按 50.7% 宽度自适应，走查一下最长情况。
- 名字含 emoji/非拉丁字符 → 卡片标题是 Instrument Serif，只有拉丁字形；中文名会回退到宋体。走查一个中文名和一个 emoji 名。
- 用户拒绝授权 / 回调 state 不匹配 → 回 H5 显示"未连接"，不要卡在空白页。
- 隐私：邮箱、Discord、钱包不上卡、不进分享链接（H5 文案已承诺）。

## 5. 本地联调

H5：`?kol=chriszhu` 演示账号 · 生图 mock 后端：`NODE_USE_ENV_PROXY=1 node tools/cardgen/server.mjs`（端口 3022，接口和 `BACKEND.md` 一致）。
