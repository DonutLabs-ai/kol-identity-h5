#!/usr/bin/env node
/* Two-stage generation: style first, identity second.
   Stage 1 "plate": text + style references, NO avatar — the model is free to go fully moodboard (a figure made of light
   performing the type's action). Stage 2 "transplant": the plate + the avatar — replace the figure's face/head with the
   KOL, keep everything else. Inverts the avatar's dominance seen in single-pass edits.

   NODE_USE_ENV_PROXY=1 node twostage.mjs --avatar avatars/cz_binance.jpg --type risk_monk [--refs figma/a,figma/b]
       [--model openai/gpt-5.4-image-2] [--model2 <same>] [--name x] [--judge]           → out/twostage/<name>/ */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { apiKey, loadPrompts, dataUrl, Budget, STYLE_DIR, CARDGEN, HERE, REF_WORDING, judgeImage, judgeRefs } from "./lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const MODEL = args.model || "openai/gpt-5.4-image-2", MODEL2 = args.model2 || MODEL, key = await apiKey(), p = await loadPrompts(), budget = new Budget(Number(args.cap || 3));
const avatar = resolve(CARDGEN, String(args.avatar)), type = String(args.type);
const refs = String(args.refs || "").split(",").filter(Boolean).map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean);
const who = basename(avatar, extname(avatar)), name = args.name || `${who}--${type}--${MODEL.split("/")[1]}`;
const out = join(CARDGEN, "out/twostage", name); await mkdir(out, { recursive: true });

async function image(model, content, timeout = 540000) {
  budget.check(0.3);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: ctl.signal, headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content }] }) }).finally(() => clearTimeout(t));
  const json = await res.json(); if (!res.ok) throw new Error("OpenRouter " + res.status + ": " + JSON.stringify(json.error || json).slice(0, 300));
  budget.add(json.usage);
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url; if (!url) throw new Error("no image: " + JSON.stringify(json.choices?.[0]?.message).slice(0, 300));
  const m = /^data:image\/\w+;base64,(.+)$/.exec(url); return m ? Buffer.from(m[1], "base64") : Buffer.from(await (await fetch(url)).arrayBuffer());
}

/* ── stage 1: the plate. The type section is rewritten for "a figure" (no identity). ── */
const typeText = p.types[type].replace(/the subject|the KOL|the person/gi, "the figure");
const plateText = `Create ONE image, square. ${p.style}\n\nTHE FIGURE: an adult human figure rendered exactly in the style of the attached references — a silhouette outlined in light, made of stars and sparkles — with a generic, softly-lit, unremarkable face (no likeness to anyone). ${typeText}\n\nNo text, letters or logos.`;
const c1 = [];
refs.forEach((r, k) => c1.push({ type: "text", text: REF_WORDING.style(k) }, { type: "image_url", image_url: { url: "" } }));
for (let k = 0; k < refs.length; k++) c1[k * 2 + 1].image_url.url = await dataUrl(refs[k]);
c1.push({ type: "text", text: plateText });
let t0 = Date.now(); const plate = await image(MODEL, c1); await writeFile(join(out, "1-plate.png"), plate);
console.log(`stage 1 plate: ${((Date.now() - t0) / 1000).toFixed(0)}s  $${budget.spent.toFixed(2)}`);

/* ── stage 2: identity transplant into the plate. ── */
const c2 = [
  { type: "text", text: "IMAGE 1 — the finished card art. Keep it EXACTLY as it is: same pose, clothing, props, lighting, colours, sparkles, background and rendering style." },
  { type: "image_url", image_url: { url: "data:image/png;base64," + plate.toString("base64") } },
  { type: "text", text: "IMAGE 2 — the person whose card this is." },
  { type: "image_url", image_url: { url: await dataUrl(avatar) } },
  { type: "text", text: "Edit IMAGE 1 so that the figure IS the person in IMAGE 2: replace the face and head (face shape, features, skin tone, hairstyle, glasses, facial hair, expression) with theirs, recognisable at first glance, and render that face in the SAME sparkling, light-outlined, film-still style as the rest of IMAGE 1 — do not paste a photographic face onto it. Change nothing else. If IMAGE 2 is not a human (a drawing, animal, object), keep IMAGE 1's figure and give it IMAGE 2's key colours and one signature detail instead." },
];
t0 = Date.now(); const final = await image(MODEL2, c2); await writeFile(join(out, "2-final.png"), final);
console.log(`stage 2 transplant: ${((Date.now() - t0) / 1000).toFixed(0)}s  $${budget.spent.toFixed(2)}`);
try { execFileSync("python3", [join(HERE, "finish.py"), join(out, "2-final.png"), join(out, "2-final.fin.png")], { stdio: "ignore" }); } catch {}

if (args.judge) {
  const mood = await judgeRefs(refs);
  let dna = ""; { const f = join(STYLE_DIR, "figma/moodboard-dna.md"); if (existsSync(f)) { const md = await readFile(f, "utf8"); dna = ["## Shared DNA", "## Never", "## Judge checklist"].map((h) => { const i = md.indexOf(h); if (i < 0) return ""; const j = md.indexOf("\n## ", i + 3); return md.slice(i, j < 0 ? undefined : j).trim(); }).filter(Boolean).join("\n\n"); } }
  const img = existsSync(join(out, "2-final.fin.png")) ? await readFile(join(out, "2-final.fin.png")) : final;
  const j = await judgeImage({ key, model: "anthropic/claude-sonnet-5.5", imagePng: img, avatarPath: avatar, moodRefs: mood, styleBlock: p.style, typeSection: p.types[type], budget, dna });
  await writeFile(join(out, "judge.json"), JSON.stringify(j, null, 1));
  console.log(`judge: overall ${j.overall}  ${Object.entries(j.scores || {}).map(([k, v]) => k.split("_")[0] + " " + v).join(" · ")}\n  ${j.critique}`);
}
console.log(`done → ${out}  ($${budget.spent.toFixed(2)})`);
