#!/usr/bin/env node
/* Restyle an existing card image with the moodboard references, keeping its composition, pose, face and props.
   Pipeline H: GPT makes the card (action, likeness, prop are reliable) → Gemini re-renders it in the glare style
   (Gemini learns style from images far more literally, but can't be trusted with pose/props on its own).

   NODE_USE_ENV_PROXY=1 node restyle.mjs --image out/harness/<run>/cz_binance/r0.png --avatar avatars/cz_binance.jpg --type risk_monk
       [--refs figma/a,figma/b,figma/c] [--model google/gemini-3-pro-image] [--name x] [--judge] [--strength strict|loose] */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { apiKey, loadPrompts, dataUrl, Budget, STYLE_DIR, CARDGEN, HERE, judgeImage, judgeRefs, restylePrompt } from "./lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const MODEL = args.model || "google/gemini-3-pro-image", key = await apiKey(), p = await loadPrompts(), budget = new Budget(Number(args.cap || 2));
const rel = (f) => (existsSync(resolve(String(f))) ? resolve(String(f)) : resolve(CARDGEN, String(f)));   /* cwd-relative or cardgen-relative */
const src = rel(args.image), avatar = args.avatar ? rel(args.avatar) : null, type = String(args.type || "");
const refs = String(args.refs || "").split(",").filter(Boolean).map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean);
const name = args.name || `${basename(src, ".png")}--restyle--${MODEL.split("/")[1]}`;
const out = join(CARDGEN, "out/restyle", name); await mkdir(out, { recursive: true });

const content = [];
refs.forEach(() => {}); for (let k = 0; k < refs.length; k++) content.push({ type: "text", text: `STYLE REFERENCE ${k + 1}:` }, { type: "image_url", image_url: { url: await dataUrl(refs[k]) } });
content.push({ type: "text", text: "SOURCE IMAGE — the card to restyle:" }, { type: "image_url", image_url: { url: await dataUrl(src) } });
if (avatar) content.push({ type: "text", text: "IDENTITY — the person in the source; their face must stay recognisable as this:" }, { type: "image_url", image_url: { url: await dataUrl(avatar) } });
/* --brand: pin the palette with the Donut ribbon image (Gemini otherwise drifts to the references' cobalt) */
if (args.brand) content.push({ type: "text", text: "COLOUR REFERENCE — use this palette for the background and the light: deep violet field with amber, cream and periwinkle ribbons. Not cobalt, not sky blue." }, { type: "image_url", image_url: { url: await dataUrl(join(CARDGEN, "refs/donut-ribbons.webp")) } });
const strict = String(args.strength || "strict") === "strict";
content.push({ type: "text", text: restylePrompt({ strict, edgeSparkle: !!args["edge-sparkle"], faceClean: !!args["face-clean"] }) });
const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, modalities: ["image", "text"], messages: [{ role: "user", content }] }) });
const json = await res.json(); if (!res.ok) throw new Error("OpenRouter " + res.status + ": " + JSON.stringify(json.error || json).slice(0, 300));
budget.add(json.usage);
const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url; if (!url) throw new Error("no image: " + JSON.stringify(json.choices?.[0]?.message).slice(0, 300));
const m = /^data:image\/\w+;base64,(.+)$/.exec(url); const png = m ? Buffer.from(m[1], "base64") : Buffer.from(await (await fetch(url)).arrayBuffer());
await writeFile(join(out, "restyled.png"), png); await writeFile(join(out, "source.png"), await readFile(src));
console.log(`restyled in ${((Date.now() - t0) / 1000).toFixed(0)}s  $${budget.spent.toFixed(2)}  → ${out}`);
try { execFileSync("python3", [join(HERE, "finish.py"), join(out, "restyled.png"), join(out, "restyled.fin.png")], { stdio: "ignore" }); } catch {}

if (args.judge && avatar && type) {
  const mood = await judgeRefs(refs);
  let dna = ""; { const f = join(STYLE_DIR, (args.dna ? String(args.dna) : "figma") + "/moodboard-dna.md");   /* --dna glare → judge against the glare-set DNA */ if (existsSync(f)) { const md = await readFile(f, "utf8"); dna = ["## Shared DNA", "## Never", "## Judge checklist"].map((h) => { const i = md.indexOf(h); if (i < 0) return ""; const j = md.indexOf("\n## ", i + 3); return md.slice(i, j < 0 ? undefined : j).trim(); }).filter(Boolean).join("\n\n"); } }
  const img = existsSync(join(out, "restyled.fin.png")) ? await readFile(join(out, "restyled.fin.png")) : png;
  const j = await judgeImage({ key, model: "anthropic/claude-sonnet-5.5", imagePng: img, avatarPath: avatar, moodRefs: mood, styleBlock: p.style, typeSection: p.types[type] || "", budget, dna });
  await writeFile(join(out, "judge.json"), JSON.stringify(j, null, 1));
  console.log(`judge: overall ${j.overall}  ${Object.entries(j.scores || {}).map(([k, v]) => k.split("_")[0] + " " + v).join(" · ")}\n  ${j.critique}`);
}
