/* Shared pieces for the card-art harness: OpenRouter calls (image + vision judge), prompt parsing, cost tracking. */
import { readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CARDGEN = resolve(HERE, "..");
export const ROOT = resolve(CARDGEN, "../..");
export const TYPES = ["diamond_hands", "hodler", "degen", "scalper", "sniper", "grid_farmer", "swing_hunter", "momentum_chaser", "arbitrageur", "narrative_trader", "risk_monk", "bottom_fisher", "unresolved"];

export async function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = join(ROOT, ".env");
  if (existsSync(env)) { const m = /^OPENROUTER_API_KEY=(.+)$/m.exec(await readFile(env, "utf8")); if (m) return m[1].trim(); }
  throw new Error("OPENROUTER_API_KEY missing (env or .env)");
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
export async function dataUrl(src) {
  return "data:" + (MIME[extname(src).toLowerCase()] || "image/jpeg") + ";base64," + (await readFile(src)).toString("base64");
}

/* prompts.md → { version, keep, style, tail, types }.
   keep  = KEEP + ACT paragraphs (identity + type action — never rewritten by the judge)
   style = ART DIRECTION + PALETTE block (the judge's knob)
   tail  = the closing hygiene line ("Clean edges, no border…") */
export async function loadPrompts() {
  const md = await readFile(join(CARDGEN, "prompts.md"), "utf8"), sections = {};
  md.split(/^## /m).slice(1).forEach((s) => { const nl = s.indexOf("\n"); sections[s.slice(0, nl).trim()] = s.slice(nl + 1).trim(); });
  const version = (/prompt_version:\s*(\S+)/.exec(md) || [])[1] || "unversioned";
  const base = sections.Base;
  const iStyle = base.indexOf("ART DIRECTION"), iTail = base.indexOf("Clean edges");
  if (iStyle < 0 || iTail < 0) throw new Error("prompts.md Base must contain 'ART DIRECTION' and 'Clean edges' markers");
  return { version, keep: base.slice(0, iStyle).trim(), style: base.slice(iStyle, iTail).trim(), tail: base.slice(iTail).trim(), types: sections };
}
export function buildPrompt(p, styleBlock, type) { return [p.keep, styleBlock, p.tail].join("\n\n") + "\n\n" + p.types[type]; }

/* Moodboard tiles: full size for the generator, 512px copies for the judge (made once with sips — macOS). */
export const STYLE_DIR = join(CARDGEN, "style-refs");
export const DEFAULT_REFS = ["silhouette", "chrome-knight", "chrome-hands", "light-streams", "glitter-driver", "gold-record"];
export async function judgeRefs(paths) {
  const out = [];
  for (const full of paths) {
    const dir = join(dirname(full), "_judge"); await mkdir(dir, { recursive: true });
    const small = join(dir, basename(full, extname(full)) + ".jpg");
    if (!existsSync(small)) execFileSync("sips", ["-Z", "512", "-s", "format", "jpeg", full, "--out", small], { stdio: "ignore" });
    out.push(small);
  }
  return out;
}

export class Budget {
  constructor(cap) { this.cap = cap; this.spent = 0; this.calls = 0; }
  add(usage) { const c = Number(usage?.cost || 0); this.spent += c; this.calls++; return c; }
  get left() { return this.cap - this.spent; }
  check(estimate) { if (this.spent + estimate > this.cap) throw new Error(`budget cap $${this.cap} reached (spent $${this.spent.toFixed(2)})`); }
}

async function openrouter(key, body, timeoutMs) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "X-Title": "Donut card-art harness" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("OpenRouter " + res.status + ": " + JSON.stringify(json.error || json).slice(0, 300));
    return json;
  } finally { clearTimeout(t); }
}

/* One card image. refs = look-only tiles (full-size paths), brand = the Donut ribbon image. Returns { png (Buffer), cost, secs }. */
export async function generateImage({ key, model, prompt, avatarPath, refs = [], brandPath, budget }) {
  budget.check(0.30);
  const content = [{ type: "text", text: "The profile picture to edit:" }, { type: "image_url", image_url: { url: await dataUrl(avatarPath) } }];
  for (let k = 0; k < refs.length; k++) content.push({ type: "text", text: `LOOK REFERENCE ${k + 1} — copy only its film grain, light, chrome and glint treatment (not its colours). Do NOT copy its subject, objects, composition, pose or any text:` }, { type: "image_url", image_url: { url: await dataUrl(refs[k]) } });
  if (brandPath) content.push({ type: "text", text: "DONUT BRAND BACKGROUND REFERENCE — use exactly this palette and these soft flowing light ribbons for the background and the colour of the light. Its colours win over every other reference:" }, { type: "image_url", image_url: { url: await dataUrl(brandPath) } });
  content.push({ type: "text", text: prompt });
  const t0 = Date.now();
  const json = await openrouter(key, { model, modalities: ["image", "text"], messages: [{ role: "user", content }] }, 540000);   /* ~200 s solo; parallel runs can double that */
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error("no image: " + JSON.stringify(json.choices?.[0]?.message).slice(0, 300));
  const m = /^data:image\/\w+;base64,(.+)$/.exec(url);
  return { png: m ? Buffer.from(m[1], "base64") : Buffer.from(await (await fetch(url)).arrayBuffer()), cost: budget.add(json.usage), secs: (Date.now() - t0) / 1000 };
}

/* The vision judge: scores a card against the avatar + moodboard and rewrites the style block. Strict JSON out. */
export const JUDGE_SCHEMA = `{"scores":{"likeness":0-10,"type_readable":0-10,"film_feel":0-10,"chrome_light":0-10,"palette":0-10,"composition":0-10},"overall":0-10,"critique":"2-4 sentences: what is right, what is off vs the moodboard","fixes":["3-6 concrete prompt-level changes"],"revised_style_block":"the full replacement for the ART DIRECTION + PALETTE block"}`;
export async function judgeImage({ key, model, imagePng, avatarPath, moodRefs, styleBlock, typeSection, budget, humanNotes = "", dna = "" }) {
  budget.check(0.10);
  const content = [
    { type: "text", text: `You are the art director for Donut's KOL trading cards. Judge the GENERATED card image against (1) the KOL's avatar it must stay recognisable as, and (2) the MOODBOARD tiles that define the target look: 1970s–80s album-cover retro-futurism shot on film — liquid chrome that reflects colour, a few big star flares, slow-shutter light trails with prismatic fringes, heavy film grain and halation, lifted blacks, iconic minimal poster composition. Target background: Donut deep violet with flowing amber/cream/periwinkle light ribbons.\n\nNOTE: the product adds film GRAIN in CSS on top of this image later, so do not penalise missing grain — judge film_feel on halation, lifted blacks, softness, fringing and print-like tonality instead.\n\nScore 0–10 on each axis, be harsh and specific (a 10 is indistinguishable from the moodboard in feel). Then rewrite ONLY the style block so the next generation moves closer: keep it under 260 words, prescriptive, in the same format (ART DIRECTION bullets + PALETTE paragraph). Never touch identity or type-action rules — they live elsewhere.${dna ? "\n\nMOODBOARD DNA — the authoritative criteria, distilled from the full 98-tile board (use its checklist to score film_feel, chrome_light and composition):\n" + dna : ""}${humanNotes ? "\n\nHUMAN ART DIRECTOR NOTES (highest priority): " + humanNotes : ""}\n\nReply with ONLY minified JSON matching: ${JUDGE_SCHEMA}` },
    { type: "text", text: "GENERATED CARD:" }, { type: "image_url", image_url: { url: "data:image/png;base64," + imagePng.toString("base64") } },
    { type: "text", text: "AVATAR (identity):" }, { type: "image_url", image_url: { url: await dataUrl(avatarPath) } },
  ];
  for (const r of moodRefs) content.push({ type: "text", text: "MOODBOARD:" }, { type: "image_url", image_url: { url: await dataUrl(r) } });
  content.push({ type: "text", text: "CURRENT STYLE BLOCK:\n" + styleBlock + "\n\nTYPE SECTION (fixed, for context):\n" + typeSection });
  let cost = 0, last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = [{ role: "user", content }];
    if (attempt) msgs.push({ role: "assistant", content: last || "(empty)" }, { role: "user", content: "That was not valid JSON. Reply again with ONLY the minified JSON object, no prose, no code fences." });
    const json = await openrouter(key, { model, messages: msgs, temperature: 0.3, max_tokens: 1800 }, 180000);
    cost += budget.add(json.usage);
    last = json.choices?.[0]?.message?.content || "";
    const m = /\{[\s\S]*\}/.exec(last.replace(/```json|```/g, ""));
    if (m) { try { return { ...JSON.parse(m[0]), cost }; } catch (e) { if (attempt) throw new Error("judge JSON unparsable: " + e.message); } }
  }
  throw new Error("judge returned no JSON: " + last.slice(0, 200));
}
