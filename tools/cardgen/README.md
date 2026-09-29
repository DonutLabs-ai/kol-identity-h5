# cardgen — KOL avatar → Donut Trader card art (prototype)

- `prompts.md`: refined prompt set (Base + one section per type). Bump `prompt_version` when you edit it.
- `generate.mjs`: calls OpenRouter with IMAGE 1 = avatar (identity) and IMAGE 2 = our art for that type (style, costume, pose).
- `BACKEND.md`: the endpoint Sean needs to request.

```
node tools/cardgen/generate.mjs --avatar path/to/avatar.jpg --type all
```

Put `OPENROUTER_API_KEY=…` in the repo-root `.env` (gitignored). Output goes to `tools/cardgen/out/` (gitignored).
Must run from a region where OpenRouter serves the image models (the office network gets a 403).
