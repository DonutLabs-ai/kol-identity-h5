# KOL 卡面生图 Prompt 导出 — 2026-10-08

来源：`tools/cardgen/prompts.md`（prompt_version **2026-09-30.10**）+ `harness/lib.mjs`。本文件由 `harness/export-prompt.mjs` 生成，改 prompt 请改源文件再重新导出，不要手改这里。

## 0. 现在线上（mock 后端 `server.mjs`）怎么调

两步 pipeline（BACKEND.md §11）：

| 步 | 模型 | 输入（按发送顺序） | 文本 |
|---|---|---|---|
| 1 | `openai/gpt-5.4-image-2`（~150 s，$0.25） | 头像 → 风格参考 ×3（每张前面一句 STYLE REFERENCE 说明）→ Donut 品牌色带图 | §1 的 Base + 该人格小节 |
| 2 | `google/gemini-3-pro-image`（~60 s，$0.14） | 风格参考 ×3 → 第 1 步出的卡面（SOURCE）→ 头像（IDENTITY）→ 品牌色带图（COLOUR） | §2 |

备选快速路径（BACKEND.md §12，≈24 s，一次 Gemini，只给头像）：§3。

头像是唯一身份输入；风格参考是 Figma moodboard「glare 十字流光」组里按人格挑的 3 张（`style-refs/figma/refs-<type>.txt`，第三方图，不入库）；品牌色带图 `refs/donut-ribbons.webp`。

## 1. 第 1 步（GPT）——发送的消息

消息 content 顺序：

1. 文本：`The profile picture to edit:` + 头像图
2. 对每张风格参考（k = 1…3）：文本 + 图
   > STYLE REFERENCE 1 — render the final image EXACTLY in this visual style: the same medium and rendering technique, the same light, surface texture, grain, colour treatment and finish, as if the same artist made both. Take the STYLE from this image and only the person's identity from the avatar:
3. 文本 + 品牌色带图
   > DONUT BRAND BACKGROUND REFERENCE — use exactly this palette and these soft flowing light ribbons for the background and the colour of the light. Its colours win over every other reference:
4. 正文 = **Base**（KEEP / ACT / ART DIRECTION / NEVER / Clean edges）+ 空行 + **该人格小节**，原文如下。

### 1.1 Base（所有人格共用）

```text
EDIT the attached profile picture into a collectible trading-card image, vertical 3:4.

KEEP (most important): the same subject, recognisable at first glance to anyone who knows this avatar — the same
person with the same face, features, skin tone, hairstyle, glasses, headwear and facial hair; or, if it is not a person,
the same creature, character or object with its silhouette, colours and signature details. Do not replace the subject
with someone or something else and do not change their age or gender. Remove any text, logos, magazine mastheads or
watermarks from the avatar. If the avatar is a drawing, anime or pixel art, keep the character drawn-looking with
its own design — do not turn it into a realistic human.

ACT (equally important): the subject performs the TRADING TYPE's signature action with its signature gear, exactly as
described below — this is what makes the card theirs. Re-pose the body and hands as needed; keep the face and head
recognisable. A creature holds or uses the gear with its own limbs; an object (a rocket, a logo-like shape) carries the
gear and action as part of the scene in a playful, natural way. Frame from the knees or waist up — full body only when
the action needs it — with the face large enough to recognise and the gear fully visible.

ART DIRECTION (Cory's vocabulary, 2026-09-30 — the images attached as STYLE REFERENCES define the look; this text only
names it): a vintage film still, 1950s–60s Hollywood glamour meets vintage luxury, surreal and dreamlike. The figure is
rendered as a SILHOUETTE OUTLINED IN LIGHT — a figure made of stars and sparkles, shimmering glitter texture over the
body and clothing, features drawn by rim light so the person stays recognisable. Light and material: sparkling,
glimmering, shimmering, prismatic, radiant, crystalline; intense lens flare; star-filter cross flares on every bright
point; long-exposure light trails. Colour: highly saturated, psychedelic, day-glo, electric blues and purples, neon,
high-contrast, vaporwave palette — on Donut's deep violet field with flowing amber, cream and periwinkle light.
Optional digital accents: floating code, ASCII overlays, a touch of pixelated glitch — small, never over the face.

NEVER: a clean modern digital illustration or 3D render, flat cel shading, an evenly-lit passport-style face, a pale
field, large text.

Clean edges, no border, no frame, no text, letters, numbers or logos anywhere. No cigarettes, cigars, alcohol or drugs.
```

### 1.2 人格小节（接在 Base 后面，一次只发一个）

**diamond_hands** — 风格参考：`loose--591-331` · `loose--591-380` · `loose--591-312`

```text
Diamond Hands — calm, unwavering conviction. Gear: one large faceted AMETHYST diamond. Action: facing the viewer,
shoulders square, holding the diamond securely at centre chest with both hands, direct steady gaze, serene resolute
expression.
```

**hodler** — 风格参考：**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**

```text
DCA Believer — disciplined, steady accumulation. Gear: a compact handheld rail of identical, evenly spaced small
AMETHYST crystals, a plain dark stool. Action: seated sideways, leaning in, one hand placing one more crystal into the
next empty slot, eyes on it, patient focus.
```

**degen** — 风格参考：`loose--591-331` · `loose--591-312` · `loose--591-318`

```text
Risk Explorer — bold, deliberate exploration. Gear: a small dark floating stepping stone and one ROSE-PINK faceted
waypoint orb. Action: stepping onto the stone and reaching for the orb, glancing back over the shoulder at the viewer
with a confident grin.
```

**scalper** — 风格参考：**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**

```text
Day Trader — alert, immediate, precise. Gear: three small ROSE-PINK translucent candlestick-shaped blocks floating
close by. Action: leaning forward, knees bent, one hand snapping across the body to tap one block, the other ready,
sharp eyes on the fingertip.
```

**sniper** — 风格参考：`loose--591-331` · `loose--591-312` · `loose--591-380`

```text
Sniper — patience and precision, never firing. Gear: a sleek ONYX-and-silver sci-fi precision rifle. Action: low
one-knee kneel, rifle shouldered and aimed horizontally into empty space, eye at the sight, completely composed; no
target, no muzzle flash.
```

**grid_farmer** — 风格参考：**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**

```text
Grid Executor — methodical execution. Gear: a compact rigid ONYX-and-silver lattice with glinting nodes, a minimal dark
stool. Action: seated upright and symmetrical, both hands precisely adjusting two nodes, chin tucked, eyes on the
lattice.
```

**swing_hunter** — 风格参考：**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**

```text
Swing Hunter — timing the next wave. Gear: a short sculptural EMERALD ribbon wave with one clear crest and one trough.
Action: low sideways half-crouch, one hand tracing the wave, eyes on the next trough, poised.
```

**momentum_chaser** — 风格参考：`loose--591-312` · `loose--591-331` · `loose--591-318`

```text
Momentum Rider — riding a strong established direction. Gear: a sleek dark floating board with one EMERALD directional
accent. Action: standing sideways on the board tilted up toward the upper right, leaning into the motion, arms spread
for balance, hair swept back, determined gaze ahead.
```

**arbitrageur** — 风格参考：`loose--591-331` · `loose--591-380` · `loose--591-312`

```text
Arb Researcher — analytical comparison. Gear: a small optical lens and two near-identical AMBER-GOLD faceted prisms
floating at slightly different heights. Action: bent slightly forward, lens raised between the prisms, other hand
adjusting one, head tilted, examining the difference — the lens never hides the face.
```

**narrative_trader** — 风格参考：`loose--591-312` · `loose--591-331` · `loose--591-379`

```text
Narrative Trader — reading the story ahead. Gear: a compact translucent AMBER book of abstract pictures (no writing)
with three short golden threads rising from its pages. Action: seated sideways, book open in one hand, the other
selecting one thread, eyes lifted to it, a knowing look.
```

**risk_monk** — 风格参考：`loose--591-331` · `loose--591-312` · `loose--591-380`

```text
Risk-First — assured, clear boundaries. Gear: a crisp translucent curved shield with AURORA (teal-lilac-pink)
reflections and a small luminous core. Action: side-on stance, feet planted, one palm supporting the shield close to
the body, the other hand holding the core, head turned to the viewer with a direct resolute gaze.
```

**bottom_fisher** — 风格参考：**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**

```text
Contrarian — patient, independent observation. Gear: a small unmarked optical observation device and one small AURORA
prism. Action: back three-quarter view as if they just stopped walking, device held behind them, looking back over the
shoulder at the prism low at one side, calm and contemplative.
```

**unresolved** — 风格参考：**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**

```text
Style Explorer — still writing their story. Gear: a small multi-faceted token that shows a different colour on each
face. Action: relaxed three-quarter pose, turning the token between two fingers as if deciding which face to show,
curious open expression.
```

### 1.3 完整示例：diamond_hands 第 1 步正文（Base + 小节，逐字）

```text
EDIT the attached profile picture into a collectible trading-card image, vertical 3:4.

KEEP (most important): the same subject, recognisable at first glance to anyone who knows this avatar — the same
person with the same face, features, skin tone, hairstyle, glasses, headwear and facial hair; or, if it is not a person,
the same creature, character or object with its silhouette, colours and signature details. Do not replace the subject
with someone or something else and do not change their age or gender. Remove any text, logos, magazine mastheads or
watermarks from the avatar. If the avatar is a drawing, anime or pixel art, keep the character drawn-looking with
its own design — do not turn it into a realistic human.

ACT (equally important): the subject performs the TRADING TYPE's signature action with its signature gear, exactly as
described below — this is what makes the card theirs. Re-pose the body and hands as needed; keep the face and head
recognisable. A creature holds or uses the gear with its own limbs; an object (a rocket, a logo-like shape) carries the
gear and action as part of the scene in a playful, natural way. Frame from the knees or waist up — full body only when
the action needs it — with the face large enough to recognise and the gear fully visible.

ART DIRECTION (Cory's vocabulary, 2026-09-30 — the images attached as STYLE REFERENCES define the look; this text only
names it): a vintage film still, 1950s–60s Hollywood glamour meets vintage luxury, surreal and dreamlike. The figure is
rendered as a SILHOUETTE OUTLINED IN LIGHT — a figure made of stars and sparkles, shimmering glitter texture over the
body and clothing, features drawn by rim light so the person stays recognisable. Light and material: sparkling,
glimmering, shimmering, prismatic, radiant, crystalline; intense lens flare; star-filter cross flares on every bright
point; long-exposure light trails. Colour: highly saturated, psychedelic, day-glo, electric blues and purples, neon,
high-contrast, vaporwave palette — on Donut's deep violet field with flowing amber, cream and periwinkle light.
Optional digital accents: floating code, ASCII overlays, a touch of pixelated glitch — small, never over the face.

NEVER: a clean modern digital illustration or 3D render, flat cel shading, an evenly-lit passport-style face, a pale
field, large text.

Clean edges, no border, no frame, no text, letters, numbers or logos anywhere. No cigarettes, cigars, alcohol or drugs.

Diamond Hands — calm, unwavering conviction. Gear: one large faceted AMETHYST diamond. Action: facing the viewer,
shoulders square, holding the diamond securely at centre chest with both hands, direct steady gaze, serene resolute
expression.
```

## 2. 第 2 步（Gemini restyle）——发送的消息

content 顺序：

1. 每张风格参考前：`STYLE REFERENCE 1:`（k = 1…3）+ 图
2. `SOURCE IMAGE — the card to restyle:` + 第 1 步的卡面
3. `IDENTITY — the person in the source; their face must stay recognisable as this:` + 头像
4. `COLOUR REFERENCE — use this palette for the background and the light: deep violet field with amber, cream and periwinkle ribbons. Not cobalt, not sky blue.` + 品牌色带图
5. 正文（mock 后端参数：strict、edge-sparkle；头像是照片（jpg）时再加 face-clean）：

**照片头像（--face-clean）：**

```text
Re-render the SOURCE IMAGE entirely in the visual style of the STYLE REFERENCES: the same medium and rendering technique, film-still texture and grain, halation, big star-filter cross flares on the brightest points, prismatic light trails, high-contrast saturated electric violet / amber / cream colour, and the same way of drawing a figure (a silhouette outlined in light, body shimmering with stars and sparkles).
KEEP from the SOURCE, exactly: the composition and framing, the pose and gesture, the props and what the hands are doing, the clothing shapes, and the person's face and identity (features, glasses, hairline, expression) — recognisable at first glance.
CRITICAL: re-render the PROPS in the same material language as the rest of the image (light, sparkle, chrome reflections, glare) — never a glossy modern 3D object dropped onto a film-still figure. Everything in the frame must look like it was made by one artist in one medium.
Do not add, remove or move anything. Do not change the background layout, only its rendering.
SPARKLE RULE: star glints and sparkles live ONLY along the outer edges / rim outlines of the figure and the props, and on a few brightest specular points — the interiors of the body, clothing and face stay clean and readable (no glitter fill). Restyle the background TOGETHER with the figure in the same film-still language, but keep it quieter than the figure. FACE: keep the face, glasses and hair clean, legible and softly lit — NO glitter, stars or sparkles on the face; sparkles live on the clothing, hair edges, hands, props and background only.
No text, letters or logos. Output one square image.
```

**画的头像（动漫 / 像素 / 动物，不加 face-clean）：**

```text
Re-render the SOURCE IMAGE entirely in the visual style of the STYLE REFERENCES: the same medium and rendering technique, film-still texture and grain, halation, big star-filter cross flares on the brightest points, prismatic light trails, high-contrast saturated electric violet / amber / cream colour, and the same way of drawing a figure (a silhouette outlined in light, body shimmering with stars and sparkles).
KEEP from the SOURCE, exactly: the composition and framing, the pose and gesture, the props and what the hands are doing, the clothing shapes, and the person's face and identity (features, glasses, hairline, expression) — recognisable at first glance.
CRITICAL: re-render the PROPS in the same material language as the rest of the image (light, sparkle, chrome reflections, glare) — never a glossy modern 3D object dropped onto a film-still figure. Everything in the frame must look like it was made by one artist in one medium.
Do not add, remove or move anything. Do not change the background layout, only its rendering.
SPARKLE RULE: star glints and sparkles live ONLY along the outer edges / rim outlines of the figure and the props, and on a few brightest specular points — the interiors of the body, clothing and face stay clean and readable (no glitter fill). Restyle the background TOGETHER with the figure in the same film-still language, but keep it quieter than the figure. 
No text, letters or logos. Output one square image.
```

## 3. 快速路径（一次 Gemini，只给头像，≈24 s）

content：`The profile picture:` + 头像图 → 正文。正文 = 下面模板，`${action}` 处填该人格小节（§1.2 原文）。

```text
Turn this profile picture into a collectible trading-card portrait, square. Keep the subject exactly recognisable (same face, hair, glasses, expression; if it is not a person, keep the same creature or object). ${action}
Style: 1980s retro-futurist album-cover art shot on film — the figure rim-lit with liquid chrome and glitter on the clothing edges and props (face stays clean), a few big four-point star flares, prismatic light streaks, deep violet background (#3c0996 → near-black) with flowing amber-orange, cream and periwinkle light ribbons, film grain and halation. Not a clean modern illustration. No text, no logo, no border.
```

示例（diamond_hands）：

```text
Turn this profile picture into a collectible trading-card portrait, square. Keep the subject exactly recognisable (same face, hair, glasses, expression; if it is not a person, keep the same creature or object). Diamond Hands — calm, unwavering conviction. Gear: one large faceted AMETHYST diamond. Action: facing the viewer, shoulders square, holding the diamond securely at centre chest with both hands, direct steady gaze, serene resolute expression.
Style: 1980s retro-futurist album-cover art shot on film — the figure rim-lit with liquid chrome and glitter on the clothing edges and props (face stays clean), a few big four-point star flares, prismatic light streaks, deep violet background (#3c0996 → near-black) with flowing amber-orange, cream and periwinkle light ribbons, film grain and halation. Not a clean modern illustration. No text, no logo, no border.
```

## 4. 版本与修改

- 改 Base / 人格小节：`prompts.md`，并把 `prompt_version` 升一号（后端缓存 key 含版本号，老图不会复用）。
- 改第 2 步 / 快速路径文本：`harness/lib.mjs` 的 `restylePrompt` / `fastPrompt`。
- 改风格参考：`style-refs/figma/refs-<type>.txt`（`harness/pick_refs.py --for-type <type>` 可按人格重选）。
- 重新导出：`node tools/cardgen/harness/export-prompt.mjs`。

