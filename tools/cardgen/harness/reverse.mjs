#!/usr/bin/env node
/* Reverse-prompt the moodboard: a vision model describes every tile in style-refs/ in generation-prompt language, then
   distils the shared "style DNA" (what every tile has), the range (what varies) and a ready ART DIRECTION block.
   Output: style-refs/reverse/<tile>.json and style-refs/moodboard-dna.md (both local — the tiles are third-party art).

   NODE_USE_ENV_PROXY=1 node tools/cardgen/harness/reverse.mjs [--model anthropic/claude-sonnet-5.5] [--dir style-refs] */
import { readdir, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { apiKey, dataUrl, Budget, STYLE_DIR, CARDGEN } from "./lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const MODEL = args.model || "anthropic/claude-sonnet-5.5", DIR = args.dir ? join(CARDGEN, String(args.dir)) : STYLE_DIR;
const key = await apiKey(), budget = new Budget(Number(args.cap || 6)), outDir = join(DIR, "reverse"); await mkdir(outDir, { recursive: true });

async function chat(content, maxTokens = 1200) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "X-Title": "Donut moodboard reverse-prompt" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: "user", content }] }) });
  const json = await res.json(); if (!res.ok) throw new Error("OpenRouter " + res.status + ": " + JSON.stringify(json.error || json).slice(0, 200));
  budget.add(json.usage); return json.choices?.[0]?.message?.content || "";
}
const parseJson = (t) => { const m = /\{[\s\S]*\}/.exec(t.replace(/```json|```/g, "")); if (!m) throw new Error("no JSON: " + t.slice(0, 120)); return JSON.parse(m[0]); };

const TILE_SCHEMA = `{"subject":"what is depicted, 1 line","medium":"how it was made: film photo / practical effects / airbrush / 3D / collage — be specific","era_cues":["what makes it read as 70s-80s"],"lighting":"key/rim/backlight, colour of light, flares, halation","materials":"chrome/glitter/glass/liquid — how they reflect","colour":{"background":"...","dominant":["hex-ish"],"accents":["hex-ish"],"contrast":"low/high"},"film_artifacts":["grain, halation, softness, fringing, print texture…"],"composition":"framing, negative space, focal point","motion":"blur/streaks/long-exposure if any","prompt_line":"ONE dense sentence that would regenerate this look (not this subject) in an image model"}`;

const tiles = (await readdir(DIR)).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort();
console.log(`reverse-prompting ${tiles.length} tiles with ${MODEL}`);
const results = [];
for (const f of tiles) {
  const name = basename(f, extname(f)), out = join(outDir, name + ".json");
  if (existsSync(out) && !args.force) { results.push(JSON.parse(await readFile(out, "utf8"))); console.log(`  ${name}: cached`); continue; }
  try {
    const t = parseJson(await chat([
      { type: "text", text: "You are a photo/illustration forensics expert and prompt engineer. Describe this moodboard tile so an image model could reproduce its LOOK (not its subject). Be concrete and technical; name the medium honestly (e.g. '35mm slide film photo of a real chrome prop with a star filter' vs 'digital 3D render'). Reply with ONLY minified JSON: " + TILE_SCHEMA },
      { type: "image_url", image_url: { url: await dataUrl(join(DIR, f)) } }]));
    t.tile = name; results.push(t); await writeFile(out, JSON.stringify(t, null, 1));
    console.log(`  ${name}: ${t.medium?.slice(0, 70)}`);
  } catch (e) { console.error(`  ${name}: ✗ ${e.message}`); }
}

/* distil */
const dna = await chat([{ type: "text", text: `Below are technical descriptions of ${results.length} moodboard tiles for Donut's KOL trading cards. Write a Markdown document with exactly these sections:

## Shared DNA
Bullet list of what EVERY tile has in common (medium, light, materials, colour logic, film artifacts, composition). Only include traits present in most tiles.

## Range
What varies across tiles (so the generator knows the allowed latitude).

## Never
What is never present (so we can forbid it).

## ART DIRECTION block
A ready-to-paste prompt block, under 260 words, in this exact format: 6–8 bullets starting with "- " each naming ONE technique concretely (medium, light, chrome, flares, trails, grain/halation, composition), then a paragraph starting "PALETTE" that uses Donut's brand: deep violet background (#3c0996 → #20033c → near-black) with flowing amber-orange (#c86b38→#f08a2c), cream (#f2e4d6) and periwinkle (#6760cd) light ribbons; forbid green and cobalt sky.

## Judge checklist
10 yes/no questions a judge can ask of a generated card to test whether it matches this look.

TILES:\n` + results.map((t) => JSON.stringify(t)).join("\n") }], 2200);
await writeFile(join(DIR, "moodboard-dna.md"), dna.trim() + "\n");
await writeFile(join(outDir, "_all.json"), JSON.stringify(results, null, 1));
console.log(`\nwrote ${join(DIR, "moodboard-dna.md")}  (spent $${budget.spent.toFixed(3)})`);
