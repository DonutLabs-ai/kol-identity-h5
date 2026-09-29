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
