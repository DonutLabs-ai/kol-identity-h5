#!/usr/bin/env node
/* Judge-only re-score of existing images (no generation). Useful to measure a post-process or compare prompt versions
   on the same output.   node rescore.mjs --image path.png --avatar path.jpg --type risk_monk [--refs figma/a,figma/b] [--judge model] */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { apiKey, loadPrompts, judgeImage, judgeRefs, Budget, STYLE_DIR, DEFAULT_REFS, CARDGEN } from "./lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const key = await apiKey(), prompts = await loadPrompts(), budget = new Budget(Number(args.cap || 2));
const refNames = args.refs ? String(args.refs).split(",") : DEFAULT_REFS;
const refs = refNames.map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean);
const mood = await judgeRefs(refs);
let dna = ""; { const f = join(STYLE_DIR, "figma/moodboard-dna.md"); if (existsSync(f)) { const md = await readFile(f, "utf8"); dna = ["## Shared DNA", "## Never", "## Judge checklist"].map((h) => { const i = md.indexOf(h); if (i < 0) return ""; const j = md.indexOf("\n## ", i + 3); return md.slice(i, j < 0 ? undefined : j).trim(); }).filter(Boolean).join("\n\n"); } }
const j = await judgeImage({ key, model: args.judge || "anthropic/claude-sonnet-5.5", imagePng: await readFile(resolve(args.image)), avatarPath: resolve(args.avatar), moodRefs: mood, styleBlock: prompts.style, typeSection: prompts.types[args.type], budget, dna });
console.log(JSON.stringify({ image: args.image, overall: j.overall, scores: j.scores, critique: j.critique, cost: +j.cost.toFixed(3) }, null, 1));
