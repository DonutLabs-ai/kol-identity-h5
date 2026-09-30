# cardgen — KOL avatar → Donut Trader card art (prototype)

- `BACKEND.md`: **integration spec for the backend** (API, pipeline, costs, ops, front-end hooks).
- `prompts.md`: the prompt set (Base + one section per type). Bump `prompt_version` when you edit it.
- `generate.mjs`: reference implementation of the OpenRouter call (edits the avatar; no other image attached).
- `codex-batch.sh`: fallback that generates through the local Codex CLI's image tool.

```
NODE_USE_ENV_PROXY=1 node tools/cardgen/generate.mjs --avatar path/to/avatar.jpg --type all
```

Put `OPENROUTER_API_KEY=…` in the repo-root `.env` (gitignored). Output goes to `tools/cardgen/out/` (gitignored);
test avatars live in `tools/cardgen/avatars/` (gitignored — real people's pictures stay local).

## Iteration harness (`harness/`)

Generate → vision judge scores it against the avatar + moodboard → judge rewrites the style block → generate again,
per subject, under a spending cap. Results in `out/harness/<run>/`; compare them in the dashboard.

```
NODE_USE_ENV_PROXY=1 node tools/cardgen/harness/run.mjs --rounds 3 --cap 20
NODE_USE_ENV_PROXY=1 node tools/cardgen/harness/run.mjs --subjects cz_binance:risk_monk --rounds 2 --refs all --notes "more grain, less glitter"
open http://127.0.0.1:3021/tools/cardgen/harness/dashboard.html      # served by the kol-identity-h5 preview server
```

- `--refs default|all|a,b,c` picks moodboard tiles from `style-refs/` (local, gitignored) as look references.
- `--notes` feeds human art-director notes to the judge (highest priority). In the dashboard, mark ✓/✗ and add notes per
  round, then **Export picks** → paste the useful notes into the next run's `--notes`.
- Each run ends with `recommended-style.md`: the judge's merge of the best-scoring style blocks — paste it over the
  ART DIRECTION + PALETTE block in `prompts.md` and bump `prompt_version`.
- The judge only ever rewrites the style block; identity (KEEP) and type action (ACT) stay fixed.
- Judge: `anthropic/claude-sonnet-5.5` via OpenRouter (~$0.03/round). Image: ~$0.25/round, 2.5–3.5 min.
