#!/usr/bin/env node
/* Card-art prototype: KOL avatar + trading type → Donut Trader card illustration (3:4). Only the avatar is attached;
   the style is all in prompts.md (v3: 1960s spy-poster retro-futurism, Donut purple + ivory/gold).
   Reference implementation for the backend endpoint (see BACKEND.md). Node 18+, no dependencies.

   node tools/cardgen/generate.mjs --avatar ./me.jpg --type scalper
   node tools/cardgen/generate.mjs --x seanmoore --type all          # avatar via unavatar.io (dev only)
   options: --model openai/gpt-5.4-image-2  --out tools/cardgen/out  --n 1

   Reads OPENROUTER_API_KEY from the environment or the repo's .env (gitignored). Never ship the key to the browser. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../..");
const TYPES = ["diamond_hands", "hodler", "degen", "scalper", "sniper", "grid_farmer", "swing_hunter", "momentum_chaser", "arbitrageur", "narrative_trader", "risk_monk", "bottom_fisher"];
const ART = ["01-diamond-hands", "02-dca-believer", "03-risk-explorer", "04-day-trader", "05-sniper", "06-grid-executor", "07-swing-hunter", "08-momentum-rider", "09-arb-researcher", "10-narrative-trader", "11-risk-first", "12-contrarian"];

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const model = args.model || "openai/gpt-5.4-image-2", outDir = resolve(args.out || join(HERE, "out")), n = Number(args.n || 1);

async function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = join(ROOT, ".env");
  if (existsSync(env)) { const m = /^OPENROUTER_API_KEY=(.+)$/m.exec(await readFile(env, "utf8")); if (m) return m[1].trim(); }
  throw new Error("OPENROUTER_API_KEY missing (env or .env)");
}
async function prompts() {
  const md = await readFile(join(HERE, "prompts.md"), "utf8"), sections = {};
  md.split(/^## /m).slice(1).forEach((s) => { const nl = s.indexOf("\n"); sections[s.slice(0, nl).trim()] = s.slice(nl + 1).trim(); });
  const version = (/prompt_version:\s*(\S+)/.exec(md) || [])[1] || "unversioned";
  return { base: sections.Base, types: sections, version };
}
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
async function dataUrl(src) {
  if (/^https?:/.test(src)) {
    const r = await fetch(src); if (!r.ok) throw new Error("avatar fetch " + r.status + " " + src);
    return "data:" + (r.headers.get("content-type") || "image/jpeg").split(";")[0] + ";base64," + Buffer.from(await r.arrayBuffer()).toString("base64");
  }
  return "data:" + (MIME[extname(src).toLowerCase()] || "image/jpeg") + ";base64," + (await readFile(src)).toString("base64");
}

async function generate(type, avatar, p, apiKey) {
  const i = TYPES.indexOf(type); if (i < 0) throw new Error("unknown type " + type + " — one of " + TYPES.join(", "));
  const text = p.base + "\n\n" + p.types[type];
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", "X-Title": "Donut KOL Identity card-art prototype" },
    body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content: [
      { type: "text", text: "The profile picture to edit:" }, { type: "image_url", image_url: { url: avatar } },
      ...styleRefs.flatMap((u, k) => [{ type: "text", text: `LOOK REFERENCE ${k + 1} — copy only its film grain, light, chrome and glint treatment (not its colours). Do NOT copy its subject, objects, composition, pose or any text:` }, { type: "image_url", image_url: { url: u } }]),
      ...(brandRef ? [{ type: "text", text: "DONUT BRAND BACKGROUND REFERENCE — use exactly this palette and these soft flowing light ribbons for the background and the colour of the light. Its colours win over every other reference:" }, { type: "image_url", image_url: { url: brandRef } }] : []),
      { type: "text", text }
    ] }] })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("OpenRouter " + res.status + ": " + JSON.stringify(body.error || body).slice(0, 400));
  const msg = body.choices?.[0]?.message || {}, img = msg.images?.[0]?.image_url?.url;
  if (!img) throw new Error("no image returned: " + JSON.stringify(msg).slice(0, 400));
  return { img, secs: ((Date.now() - t0) / 1000).toFixed(1), usage: body.usage, note: msg.content, text };
}

const p = await prompts(), apiKey = args.pack ? null : await key();
const src = args.avatar || (args.x ? "https://unavatar.io/x/" + String(args.x).replace(/^@/, "") : null);
if (!src) { console.error("need --avatar <path|url> or --x <handle>"); process.exit(1); }
/* --style a.webp,b.webp — optional look-only references (moodboard tiles), attached after the avatar */
/* the Donut brand backdrop (our own asset, tracked in refs/) is attached by default; --no-brand turns it off */
const brandRef = args["no-brand"] ? null : await dataUrl(join(HERE, "refs/donut-ribbons.webp"));
const styleRefs = await Promise.all(String(args.style || "").split(",").filter(Boolean).map((f) => dataUrl(f)));
const avatar = await dataUrl(src), who = args.x ? String(args.x).replace(/^@/, "") : basename(src).replace(/\.[^.]+$/, "");
const list = args.type === "all" ? TYPES : [args.type || "diamond_hands"];
await mkdir(outDir, { recursive: true });
/* --pack: no API call — write prompt.txt + the two reference images per type, for pasting into ChatGPT's image tool
   (the route the original 12 were made with) when the API is unavailable, e.g. region-blocked */
if (args.pack) {
  const { copyFile } = await import("node:fs/promises");
  for (const type of list) {
    const dir = join(outDir, "pack", `${who}--${type}`); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.txt"), `Attach 1-identity. prompt_version ${p.version}\n\n` + p.base + "\n\n" + p.types[type] + "\n");
    if (/^https?:/.test(src)) await writeFile(join(dir, "1-identity.jpg"), Buffer.from(avatar.split(",")[1], "base64")); else await copyFile(src, join(dir, "1-identity" + extname(src)));
    console.log("▸ pack " + dir);
  }
  process.exit(0);
}
for (const type of list) for (let k = 0; k < n; k++) {
  try {
    const r = await generate(type, avatar, p, apiKey), m = /^data:image\/(\w+);base64,(.+)$/.exec(r.img);
    const file = join(outDir, `${who}--${type}--${p.version}${n > 1 ? "-" + (k + 1) : ""}.${m ? m[1].replace("jpeg", "jpg") : "png"}`);
    await writeFile(file, m ? Buffer.from(m[2], "base64") : Buffer.from(await (await fetch(r.img)).arrayBuffer()));
    console.log(`✓ ${type} → ${file}  (${r.secs}s, ${model}${r.usage?.cost != null ? ", $" + r.usage.cost : ""})`);
  } catch (e) { console.error(`✗ ${type}: ${e.message}`); }
}
