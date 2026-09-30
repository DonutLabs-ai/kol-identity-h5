#!/usr/bin/env node
/* Fast one-shot card: a single Gemini call, minimal inputs (Cory 2026-09-30: trade quality for time; target ≤30 s).
   node fast.mjs --avatar avatars/cz_binance.jpg --type risk_monk [--refs figma/loose--591-331] [--model google/gemini-3-pro-image] [--name x]
   Output: out/fast/<name>/card.png (+ .fin.png with the print finish). Prints seconds and cost. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { apiKey, loadPrompts, dataUrl, Budget, STYLE_DIR, CARDGEN, HERE } from "./lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const MODEL = args.model || "google/gemini-3-pro-image", key = await apiKey(), p = await loadPrompts(), budget = new Budget(2);
const rel = (f) => (existsSync(resolve(String(f))) ? resolve(String(f)) : resolve(CARDGEN, String(f)));
const avatar = rel(args.avatar), type = String(args.type);
const refs = String(args.refs || "").split(",").filter(Boolean).map((n) => ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync)).filter(Boolean);
const name = args.name || `${basename(avatar, extname(avatar))}--${type}--${refs.length}ref`;
const out = join(CARDGEN, "out/fast", name); await mkdir(out, { recursive: true });

/* the type's gear + action, one sentence, taken from prompts.md's section (first sentence after the dash) */
const sec = p.types[type] || "", action = sec.replace(/\s+/g, " ").trim();
const text = `Turn this profile picture into a collectible trading-card portrait, square. Keep the subject exactly recognisable (same face, hair, glasses, expression; if it is not a person, keep the same creature or object). ${action}
Style: 1980s retro-futurist album-cover art shot on film — the figure rim-lit with liquid chrome and glitter on the clothing edges and props (face stays clean), a few big four-point star flares, prismatic light streaks, deep violet background (#3c0996 → near-black) with flowing amber-orange, cream and periwinkle light ribbons, film grain and halation. Not a clean modern illustration. No text, no logo, no border.`;

const content = [{ type: "text", text: "The profile picture:" }, { type: "image_url", image_url: { url: await dataUrl(avatar) } }];
for (const r of refs) content.push({ type: "text", text: "Match this look (medium, light, chrome, glare, colour) exactly:" }, { type: "image_url", image_url: { url: await dataUrl(r) } });
content.push({ type: "text", text });
const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, modalities: ["image", "text"], messages: [{ role: "user", content }] }) });
const json = await res.json(); if (!res.ok) throw new Error("OpenRouter " + res.status + ": " + JSON.stringify(json.error || json).slice(0, 300));
budget.add(json.usage);
const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url; if (!url) throw new Error("no image: " + JSON.stringify(json.choices?.[0]?.message).slice(0, 300));
const m = /^data:image\/\w+;base64,(.+)$/.exec(url); const png = m ? Buffer.from(m[1], "base64") : Buffer.from(await (await fetch(url)).arrayBuffer());
await writeFile(join(out, "card.png"), png);
try { execFileSync("python3", [join(HERE, "finish.py"), join(out, "card.png"), join(out, "card.fin.png")], { stdio: "ignore" }); } catch {}
console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s  $${budget.spent.toFixed(3)}  → ${out}`);
