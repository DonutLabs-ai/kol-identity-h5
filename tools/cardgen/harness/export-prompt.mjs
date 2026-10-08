#!/usr/bin/env node
/* Export the prompts exactly as the pipeline sends them — for review by people who don't read the code.
   node tools/cardgen/harness/export-prompt.mjs  →  tools/cardgen/PROMPT-EXPORT.md
   Stage 1 (GPT) is composed by lib.mjs buildPrompt() from prompts.md; stage 2 (Gemini restyle) and the fast path are the
   strings in lib.mjs (restylePrompt / fastPrompt). Attachment captions are the same constants the calls use. */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadPrompts, buildPrompt, REF_WORDING, BRAND_CAPTION, restylePrompt, RESTYLE_CAPTIONS, fastPrompt, TYPES, STYLE_DIR, CARDGEN } from "./lib.mjs";

const p = await loadPrompts();
const refsFor = async (t) => { const f = join(STYLE_DIR, `figma/refs-${t}.txt`); return existsSync(f) ? (await readFile(f, "utf8")).split("\n").filter(Boolean) : []; };
const fence = (s) => "```text\n" + s.trim() + "\n```";
const L = [];
L.push(`# KOL 卡面生图 Prompt 导出 — ${new Date().toISOString().slice(0, 10)}`);
L.push(`\n来源：\`tools/cardgen/prompts.md\`（prompt_version **${p.version}**）+ \`harness/lib.mjs\`。本文件由 \`harness/export-prompt.mjs\` 生成，改 prompt 请改源文件再重新导出，不要手改这里。`);
L.push(`\n## 0. 现在线上（mock 后端 \`server.mjs\`）怎么调\n`);
L.push(`两步 pipeline（BACKEND.md §11）：\n\n| 步 | 模型 | 输入（按发送顺序） | 文本 |\n|---|---|---|---|\n| 1 | \`openai/gpt-5.4-image-2\`（~150 s，$0.25） | 头像 → 风格参考 ×3（每张前面一句 STYLE REFERENCE 说明）→ Donut 品牌色带图 | §1 的 Base + 该人格小节 |\n| 2 | \`google/gemini-3-pro-image\`（~60 s，$0.14） | 风格参考 ×3 → 第 1 步出的卡面（SOURCE）→ 头像（IDENTITY）→ 品牌色带图（COLOUR） | §2 |\n\n备选快速路径（BACKEND.md §12，≈24 s，一次 Gemini，只给头像）：§3。\n\n头像是唯一身份输入；风格参考是 Figma moodboard「glare 十字流光」组里按人格挑的 3 张（\`style-refs/figma/refs-<type>.txt\`，第三方图，不入库）；品牌色带图 \`refs/donut-ribbons.webp\`。`);

L.push(`\n## 1. 第 1 步（GPT）——发送的消息\n`);
L.push(`消息 content 顺序：\n\n1. 文本：\`The profile picture to edit:\` + 头像图\n2. 对每张风格参考（k = 1…3）：文本 + 图\n   > ${REF_WORDING.style(0)}\n3. 文本 + 品牌色带图\n   > ${BRAND_CAPTION}\n4. 正文 = **Base**（KEEP / ACT / ART DIRECTION / NEVER / Clean edges）+ 空行 + **该人格小节**，原文如下。\n`);
L.push(`### 1.1 Base（所有人格共用）\n`);
L.push(fence([p.keep, p.style, p.tail].join("\n\n")));
L.push(`\n### 1.2 人格小节（接在 Base 后面，一次只发一个）\n`);
for (const t of TYPES) {
  const refs = await refsFor(t);
  L.push(`**${t}** — 风格参考：${refs.length ? refs.map((r) => "`" + r.replace(/^figma\//, "") + "`").join(" · ") : "**（没有 refs 文件 → 第 1 步不带风格参考，只有品牌色带图）**"}\n`);
  L.push(fence(p.types[t]));
  L.push("");
}
L.push(`### 1.3 完整示例：diamond_hands 第 1 步正文（Base + 小节，逐字）\n`);
L.push(fence(buildPrompt(p, p.style, "diamond_hands")));

L.push(`\n## 2. 第 2 步（Gemini restyle）——发送的消息\n`);
L.push(`content 顺序：\n\n1. 每张风格参考前：\`${RESTYLE_CAPTIONS.ref(0)}\`（k = 1…3）+ 图\n2. \`${RESTYLE_CAPTIONS.source}\` + 第 1 步的卡面\n3. \`${RESTYLE_CAPTIONS.identity}\` + 头像\n4. \`${RESTYLE_CAPTIONS.brand}\` + 品牌色带图\n5. 正文（mock 后端参数：strict、edge-sparkle；头像是照片（jpg）时再加 face-clean）：\n`);
L.push(`**照片头像（--face-clean）：**\n`);
L.push(fence(restylePrompt({ strict: true, edgeSparkle: true, faceClean: true })));
L.push(`\n**画的头像（动漫 / 像素 / 动物，不加 face-clean）：**\n`);
L.push(fence(restylePrompt({ strict: true, edgeSparkle: true, faceClean: false })));

L.push(`\n## 3. 快速路径（一次 Gemini，只给头像，≈24 s）\n`);
L.push(`content：\`The profile picture:\` + 头像图 → 正文。正文 = 下面模板，\`${"${action}"}\` 处填该人格小节（§1.2 原文）。\n`);
L.push(fence(fastPrompt("${action}")));
L.push(`\n示例（diamond_hands）：\n`);
L.push(fence(fastPrompt(p.types.diamond_hands.replace(/\s+/g, " ").trim())));

L.push(`\n## 4. 版本与修改\n\n- 改 Base / 人格小节：\`prompts.md\`，并把 \`prompt_version\` 升一号（后端缓存 key 含版本号，老图不会复用）。\n- 改第 2 步 / 快速路径文本：\`harness/lib.mjs\` 的 \`restylePrompt\` / \`fastPrompt\`。\n- 改风格参考：\`style-refs/figma/refs-<type>.txt\`（\`harness/pick_refs.py --for-type <type>\` 可按人格重选）。\n- 重新导出：\`node tools/cardgen/harness/export-prompt.mjs\`。\n`);
const out = join(CARDGEN, "PROMPT-EXPORT.md");
await writeFile(out, L.join("\n") + "\n");
console.log("wrote", out);
