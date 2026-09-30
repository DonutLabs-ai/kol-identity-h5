#!/usr/bin/env node
/* Card-art iteration harness: generate → vision judge → rewrite style block → generate again, per subject, under a
   spending cap. Results land in out/harness/<run>/ and show up in dashboard.html.

   NODE_USE_ENV_PROXY=1 node tools/cardgen/harness/run.mjs [--rounds 3] [--cap 20] [--subjects cz_binance:risk_monk,chriszhu:diamond_hands]
       [--model openai/gpt-5.4-image-2] [--judge anthropic/claude-sonnet-5.5] [--refs default|all|a,b,c] [--no-brand]
       [--notes "human art-director notes for the judge"] [--name my-run] [--parallel 3] [--no-finish] [--ref-mode look|style]

   Subjects default to the 7 test avatars. Each round for a subject costs ~$0.25 (image) + ~$0.03 (judge). */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, extname } from "node:path";
import { apiKey, loadPrompts, buildPrompt, generateImage, judgeImage, judgeRefs, Budget, STYLE_DIR, DEFAULT_REFS, CARDGEN, TYPES, HERE } from "./lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? a.concat([[v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]]) : a), []));
const ROUNDS = Number(args.rounds || 3), CAP = Number(args.cap || 20);
const MODEL = args.model || "openai/gpt-5.4-image-2", JUDGE = args.judge || "anthropic/claude-sonnet-5.5";
const DEFAULT_SUBJECTS = "cz_binance:risk_monk,chriszhu:diamond_hands,elonmusk:momentum_chaser,justinsuntron:narrative_trader,VitalikButerin:arbitrageur,ansem:degen,chris-flashcard:sniper";
const subjects = String(args.subjects || DEFAULT_SUBJECTS).split(",").map((s) => { const [who, type] = s.split(":"); if (!TYPES.includes(type)) throw new Error("unknown type " + type); return { who, type }; });
const avatarDir = join(CARDGEN, "avatars");
const avatarOf = async (who) => { const f = (await readdir(avatarDir)).find((f) => basename(f, extname(f)) === who); if (!f) throw new Error("no avatar for " + who); return join(avatarDir, f); };
const refNames = args.refs === "all" ? (await readdir(STYLE_DIR)).filter((f) => /\.(webp|jpg|png)$/i.test(f)).map((f) => basename(f, extname(f))) : args.refs && args.refs !== "default" ? String(args.refs).split(",") : DEFAULT_REFS;
const refs = refNames.map((n) => { const f = ["webp", "jpg", "png"].map((e) => join(STYLE_DIR, n + "." + e)).find(existsSync); if (!f) throw new Error("style ref not found: " + n); return f; });
const brand = args["no-brand"] ? null : join(CARDGEN, "refs/donut-ribbons.webp");

const key = await apiKey(), prompts = await loadPrompts(), mood = await judgeRefs(refs), budget = new Budget(CAP);
/* the judge's criteria: Shared DNA + Never + Judge checklist from the reverse-prompted moodboard, when present */
let dna = ""; { const f = join(STYLE_DIR, "figma/moodboard-dna.md"); if (existsSync(f)) { const md = await readFile(f, "utf8"); dna = ["## Shared DNA", "## Never", "## Judge checklist"].map((h) => { const i = md.indexOf(h); if (i < 0) return ""; const j = md.indexOf("\n## ", i + 3); return md.slice(i, j < 0 ? undefined : j).trim(); }).filter(Boolean).join("\n\n"); } }
const runId = (args.name ? String(args.name) + "-" : "") + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const outDir = join(CARDGEN, "out/harness", runId); await mkdir(outDir, { recursive: true });
const run = { id: runId, started: new Date().toISOString(), model: MODEL, judge: JUDGE, prompt_version: prompts.version, refs: refNames, brand: !!brand, ref_mode: String(args["ref-mode"] || "look"), dna_criteria: !!dna, rounds: ROUNDS, cap: CAP, notes: args.notes || "", initial_style: prompts.style, subjects: {} };
const save = async () => { run.spent = +budget.spent.toFixed(3); run.updated = new Date().toISOString(); await writeFile(join(outDir, "run.json"), JSON.stringify(run, null, 1)); await index(); };
async function index() {
  const base = join(CARDGEN, "out/harness"), ids = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  const list = [];
  for (const id of ids) { try { const r = JSON.parse(await readFile(join(base, id, "run.json"), "utf8")); list.push({ id, started: r.started, model: r.model, spent: r.spent, subjects: Object.keys(r.subjects).length, rounds: r.rounds, notes: r.notes }); } catch {} }
  await writeFile(join(base, "runs.json"), JSON.stringify(list, null, 1));
}
console.log(`run ${runId}: ${subjects.length} subjects × ${ROUNDS} rounds, cap $${CAP}, refs [${refNames.join(", ")}]${brand ? " + brand" : ""}`);

async function subjectLoop({ who, type }) {
  const avatar = await avatarOf(who), dir = join(outDir, who); await mkdir(dir, { recursive: true });
  const rec = run.subjects[who] = { type, avatar: basename(avatar), rounds: [] };
  let style = prompts.style;
  for (let r = 0; r < ROUNDS; r++) {
    const prompt = buildPrompt(prompts, style, type), round = { n: r, style };
    rec.rounds.push(round);
    try {
      const g = await generateImage({ key, model: MODEL, prompt, avatarPath: avatar, refs, brandPath: brand, budget, refMode: String(args["ref-mode"] || "look") });
      await writeFile(join(dir, `r${r}.png`), g.png); Object.assign(round, { raw: `${who}/r${r}.png`, image: `${who}/r${r}.png`, gen_cost: +g.cost.toFixed(3), gen_secs: +g.secs.toFixed(1) });
      /* the print finish (finish.py) is applied before judging, so the judge scores what the product will show */
      let judged = g.png;
      if (!args["no-finish"]) { try { execFileSync("python3", [join(HERE, "finish.py"), join(dir, `r${r}.png`), join(dir, `r${r}.fin.png`)], { stdio: "ignore" }); judged = await readFile(join(dir, `r${r}.fin.png`)); round.image = `${who}/r${r}.fin.png`; round.finished = true; } catch (e) { round.finish_error = e.message; } }
      await save();
      const j = await judgeImage({ key, model: JUDGE, imagePng: judged, avatarPath: avatar, moodRefs: mood, styleBlock: style, typeSection: prompts.types[type], budget, humanNotes: run.notes, dna });
      Object.assign(round, { scores: j.scores, overall: j.overall, critique: j.critique, fixes: j.fixes, judge_cost: +j.cost.toFixed(3) });
      console.log(`  ${who} r${r}: overall ${j.overall}  ${Object.entries(j.scores || {}).map(([k, v]) => k.split("_")[0] + " " + v).join(" · ")}  ($${budget.spent.toFixed(2)} total)`);
      style = j.revised_style_block || style;
    } catch (e) { round.error = e.message; console.error(`  ${who} r${r}: ✗ ${e.message}`); await save(); if (/budget cap/.test(e.message)) return; }
    await save();
  }
}
const POOL = Number(args.parallel || 3);   /* the image model slows down sharply past ~3 concurrent jobs */
{ const queue = subjects.slice(); await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, async () => { while (queue.length) await subjectLoop(queue.shift()); })); }

/* consensus: merge the best-scoring style blocks into one recommendation for prompts.md */
try {
  const best = Object.entries(run.subjects).map(([who, s]) => s.rounds.filter((r) => r.overall != null).sort((a, b) => b.overall - a.overall)[0]).filter(Boolean);
  if (best.length >= 2 && budget.left > 0.2) {
    const { default: lib } = await import("./lib.mjs").then((m) => ({ default: m }));
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JUDGE, temperature: 0.2, messages: [{ role: "user", content: `These style blocks each produced the best-scoring card for one subject (score in brackets). Merge them into ONE style block (same format: ART DIRECTION bullets + PALETTE paragraph, under 260 words) that keeps what they agree on and the strongest specific instructions. Reply with the block only, no preamble.\n\n` + best.map((r) => `[${r.overall}]\n${r.style}`).join("\n\n---\n\n") }] }) });
    const json = await res.json(); budget.add(json.usage);
    run.recommended_style = json.choices?.[0]?.message?.content?.trim();
    if (run.recommended_style) await writeFile(join(outDir, "recommended-style.md"), run.recommended_style + "\n");
  }
} catch (e) { console.error("consensus: " + e.message); }
run.finished = new Date().toISOString(); await save();
console.log(`done — spent $${budget.spent.toFixed(2)} over ${budget.calls} calls → out/harness/${runId}/  (open http://127.0.0.1:3021/tools/cardgen/harness/dashboard.html)`);
