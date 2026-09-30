# KOL card art — backend integration spec

**Owner:** Sean (product) → backend · **Prototype and prompts:** `tools/cardgen/` · **Updated:** 2026-09-29
**Prompt version at time of writing:** `2026-09-29.8`

## 1. What we're building

A KOL signs in with X, answers six questions and gets a Donut Trader type (one of 12). Today every result card shows
the same default portrait. With this feature, the card art becomes **the KOL's own X profile picture, edited** into the
Donut card style and performing their type's signature action. Whatever the avatar shows (a face, an anime drawing, pixel
art, an animal, a rocket) stays recognisable.

```
Connect X ──► quiz (6 answers) ──► submit ─┬─► type decided (client, today)
                                           └─► POST /card-art {type}        ◄── start here, in parallel
                    analysis animation (~8 s) … result page shows default art
                    poll GET /card-art/{job} ── done ──► swap generated art into the card
```

The reveal must never wait for generation. If the job fails or is slow, the default art stays.

## 2. What exists today (front end)

| Piece | State |
|---|---|
| H5 (`identity/`) | Static site, no backend. It can't hold secrets. |
| Connect X | **Mock.** The demo signs everyone in as `@seanmoore`. Real X OAuth 2.0 is a backend dependency. |
| Type | Computed on the client after the quiz. Ids are listed in §5. |
| Card art | The flashcard iframe (`flashcard/kol.html`) shows `.kol-photo img`; the H5 currently sets it to a fixed image. |

## 3. API

All endpoints need the signed-in user's session (from X OAuth). The server derives the X account from the session and
never takes an avatar URL or handle from the client.

### `POST /v1/identity/card-art`
```json
{ "type": "scalper", "lang": "en" }
```
| Response | When |
|---|---|
| `200 { "status": "done", "job_id": "…", "image_url": "https://cdn…/card-art/<hash>.webp", "prompt_version": "2026-09-29.7" }` | cache hit |
| `202 { "status": "queued", "job_id": "…" }` | new job |
| `400 { "error": "unknown_type" }` | type isn't one of §5 |
| `429 { "error": "rate_limited", "retry_after": 3600 }` | per-account limit |

### `GET /v1/identity/card-art/{job_id}`
```json
{ "status": "queued" | "running" | "done" | "failed",
  "image_url": "…",                 // when done
  "fallback_url": "…/img/archetypes/04-day-trader.jpg",   // when failed
  "error": "moderation_blocked" | "provider_error" | "timeout" | "no_avatar" }
```
The front end polls every 3 s for up to 4 min, then keeps the fallback.

## 4. Generation pipeline (server)

1. **Avatar.** Read `profile_image_url` for the signed-in user from the X API and swap `_normal` for `_400x400` to get
   the large size. If it's X's default egg or silhouette, return `failed / no_avatar`.
2. **Cache.** Key = `sha256(avatar bytes) : type : prompt_version : model`. On a hit, return `done` right away. A new
   avatar or a new prompt version produces a new image.
3. **Prompt.** Parse `tools/cardgen/prompts.md`: split on `## ` headings and take the `Base` section plus the section
   whose heading is the type id, each verbatim. Also read the `prompt_version:` line. Ship the file with the service,
   or copy it into config on deploy.
4. **Call OpenRouter.** This goes through the chat completions endpoint, not OpenAI's native `images.generate`:
   ```http
   POST https://openrouter.ai/api/v1/chat/completions
   Authorization: Bearer $OPENROUTER_API_KEY
   Content-Type: application/json

   { "model": "openai/gpt-5.4-image-2",
     "modalities": ["image", "text"],
     "messages": [{ "role": "user", "content": [
       { "type": "text", "text": "The profile picture to edit:" },
       { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<avatar>" } },
       { "type": "text", "text": "<Base>\n\n<type section>" } ] }] }
   ```
   **Look references (chosen 2026-09-29, "B"):** after the avatar, attach two style images, each preceded by the text
   `LOOK REFERENCE n — copy only its film grain, colour grade, light, chrome and glint treatment. Do NOT copy its
   subject, objects, composition, pose or any text:`. In the prototype these are two moodboard tiles
   (`generate.mjs --style …`, kept local because they're third-party art). **Before production, replace them with
   Donut-owned reference images** (e.g. approved generated cards), for licensing and consistency.
   The image comes back as a data URL in `choices[0].message.images[0].image_url.url`. `usage.cost` holds the charge.
   Set a timeout of 240 s. Retry once on 5xx or timeout. Never retry a moderation or refusal response.
5. **Store.** Decode the PNG (1024×1024, about 1.7 MB), convert it to WebP at q≈85 (roughly 200 KB), and upload it to
   the CDN under the cache-key hash. Save the job record: user, type, prompt_version, model, cost, latency.
6. **Don't bake in film grain.** The H5 adds the grain in CSS over the card art (`identity/theme.js`, `grainCards`),
   so the stored image stays clean and the grain looks the same on every card.
7. **Fail safe.** On any error, set `failed` with `fallback_url` pointing to the type's default art (§5).

## 5. Type ids

| id | Name (EN / 中文) | Default art (fallback) |
|---|---|---|
| `diamond_hands` | Diamond Hands / 钻石手 | `identity/img/archetypes/01-diamond-hands.jpg` |
| `hodler` | DCA Believer / 定投信徒 | `02-dca-believer.jpg` |
| `degen` | Risk Explorer / 高风险探索者 | `03-risk-explorer.jpg` |
| `scalper` | Day Trader / 日内交易者 | `04-day-trader.jpg` |
| `sniper` | Sniper / 狙击手 | `05-sniper.jpg` |
| `grid_farmer` | Grid Executor / 网格执行者 | `06-grid-executor.jpg` |
| `swing_hunter` | Swing Hunter / 波段猎手 | `07-swing-hunter.jpg` |
| `momentum_chaser` | Momentum Rider / 动量跟随者 | `08-momentum-rider.jpg` |
| `arbitrageur` | Arb Researcher / 套利研究者 | `09-arb-researcher.jpg` |
| `narrative_trader` | Narrative Trader / 叙事交易者 | `10-narrative-trader.jpg` |
| `risk_monk` | Risk-First / 风控优先者 | `11-risk-first.jpg` |
| `bottom_fisher` | Contrarian / 逆向布局者 | `12-contrarian.jpg` |
| `unresolved` | Style Explorer / 风格探索者 | `01-diamond-hands.jpg` (no dedicated art yet) |

## 6. Measured numbers (14 runs, `openai/gpt-5.4-image-2`, 2026-09-29)

| | |
|---|---|
| Latency | text-only prompt: 124–157 s (median about 137 s). With the three reference images (v8, current): 156–217 s (median about 198 s) |
| Cost | $0.238–0.246 per image |
| Output | PNG 1024×1024 (the prompt asks for 3:4; the model returns a square, which matches the square art window) |
| Cheaper model for testing | `openai/gpt-5-image-mini`. Also available: `openai/gpt-5-image`, `google/gemini-3-pro-image`, `google/gemini-2.5-flash-image` |

Because it takes about 2–2.5 minutes, the art usually arrives **after** the result page opens. Plan the swap-in (§8),
and consider a "Your art is being made…" state on the share button.

## 7. Operations and safety

- **Key:** `OPENROUTER_API_KEY` goes in the secret store only, never in the client, a repo or logs. The key that was
  pasted in chat on 2026-09-29 must be rotated before production.
- **Region:** OpenRouter blocks its image models for some regions ("This model is not available in your region"). Run
  the worker in a supported region.
- **Limits:** one successful generation per (account, type, avatar hash). At most 5 attempts per account per day, and
  a global daily spend cap with an alert. Use a queue with bounded concurrency (start at 8).
- **Consent:** generate only from the signed-in account's own avatar. The prompt always depicts an adult, strips
  logos and text, and bans smoking, alcohol and drugs. Treat a provider refusal as `moderation_blocked` and use the fallback.
- **Retention:** keep the images and job records, and delete the original avatar bytes after the job finishes.

## 8. Front-end hooks (we build these once the API exists)

1. On quiz submit (step 2 → analysis), call `POST /card-art` with the computed type.
2. On the result page, show the default art, poll the job, and when it's `done` set the iframe's `.kol-photo img` `src`
   to `image_url`. `theme.js` already reaches into the iframe after Sean's app renders (`dressBack`), so the swap goes there.
3. "Save card" and "Share" should use the generated art once it's ready.

## 9. Run the prototype

```
# repo root .env (gitignored):  OPENROUTER_API_KEY=…
NODE_USE_ENV_PROXY=1 node tools/cardgen/generate.mjs --avatar path/to/avatar.jpg --type scalper
node tools/cardgen/generate.mjs --x <handle> --type all        # avatar via unavatar.io, dev only
```
`NODE_USE_ENV_PROXY=1` makes Node's `fetch` use the machine's `HTTPS_PROXY` (needed on the office network). Output
goes to `tools/cardgen/out/` (gitignored). `--pack` writes the prompt and avatar for a manual ChatGPT run instead of
calling the API.

## 10. Open questions

1. Who owns X OAuth and the session: this service, or an existing Donut auth?
2. Should the generated art replace the default on the **shared** card image, and does the share page need an OG image?
3. Do we pre-generate for a VIP KOL list (known avatars) so their reveal is instant?
4. Budget: expected KOL count × about $0.24, plus retries. Is a cheaper model acceptable for regular users?
5. Should `unresolved` (Style Explorer) get its own default art?

## 11. Proposed pipeline v2 — GPT card → Gemini restyle (2026-09-30 harness findings)

Single-pass GPT edits keep the avatar's likeness, the type action and the prop reliably but ignore the style of attached
reference images. `google/gemini-3-pro-image` does the opposite: it takes style from images literally but breaks pose,
props and likeness on its own. The combination is the first result that matches Cory's chosen "glare十字流光" moodboard set:

1. **Stage 1 (GPT, as in §4):** avatar + 3 best-matching glare tiles (`pick_refs.py --for-type <type>`) + brand ribbon +
   the KEEP/ACT prompt. Output: the card with the right action, prop and face.
2. **Stage 2 (Gemini, `harness/restyle.mjs`):** stage-1 image + the same 3 tiles + avatar + brand ribbon, instruction
   "re-render entirely in the reference style; keep composition, pose, props, face; props in the same material language;
   sparkle only on edges" (`--brand --edge-sparkle`, plus `--face-clean` for photo avatars). ~$0.14, ~60 s.
3. Store both; the CSS grain/finish is still applied client-side.

Cost/latency per card: ≈ $0.40 and ≈ 4 min end to end. Cache key must include both prompt versions and both models.
Open point: Gemini drifts to cobalt without the brand ribbon; with it, backgrounds converge — background variety should
come from a stage-1 reference chosen from the "漸變流線感，速度" set, kept subordinate.
