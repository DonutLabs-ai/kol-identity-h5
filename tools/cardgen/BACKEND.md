# Card art from a KOL's X avatar — backend request (for Sean)

**Goal (Ruqi):** a KOL connects X → finishes the quiz → their result card shows **themselves** drawn as their
trading type, in the Donut card style, instead of the shared default portrait.

The H5 is static, so it cannot hold an API key. It needs one small backend endpoint. `generate.mjs` next to this file
is a working reference for the model call; `prompts.md` is the prompt source of truth.

## Endpoint

```
POST /api/identity/card-art
{ "x_user_id": "123", "x_handle": "seanmoore", "type": "scalper" }        // type = one of the 12 ids in prompts.md

202 { "job_id": "…", "status": "queued" }                                   // generation takes ~20–60 s
GET /api/identity/card-art/{job_id}
200 { "status": "done", "image_url": "https://cdn…/card-art/….png", "prompt_version": "2026-09-29.1" }
200 { "status": "failed", "fallback_url": "…/img/archetypes/04-day-trader.jpg" }
```

## Server steps
1. Get the avatar from the X API (`profile_image_url`; swap `_normal` → `_400x400`). Don't trust a client-sent URL.
2. Cache key = `sha256(avatar bytes) + type + prompt_version`. On a hit, return the stored image right away.
3. Call OpenRouter `POST /api/v1/chat/completions` with `model: "openai/gpt-5.4-image-2"` (the newest ChatGPT image
   model listed on OpenRouter as of 2026-09-29), `modalities: ["image","text"]`, and one user message: the Base prompt +
   the type's section as text, then IMAGE 1 = avatar and IMAGE 2 = `identity/img/archetypes/NN-*.jpg` (both as data
   URLs). The image comes back in `choices[0].message.images[0].image_url.url` (base64 data URL).
4. Store the PNG on the CDN (3:4, pure-black background — the card frame composites it the same way as today's art).
5. On any failure or a moderation block, return the default archetype art. The reveal must never wait on this.

## Constraints
- **Region:** OpenRouter rejects OpenAI *and* Google image models from our office network ("not available in your
  region"). Run this on a server in a supported region.
- **Key:** `OPENROUTER_API_KEY` goes in the server's secret store only. Rotate the key that was pasted in chat on 2026-09-29.
- **Cost/abuse:** one generation per (user, type, avatar), rate-limit per X account, and a daily spend cap.
- **Timing:** start the job when the quiz is submitted (step 2 → analysis), so the ~8 s analysis hides part of the
  wait. The result page shows the default art and swaps it in when the job finishes.
- **Consent/safety:** only generate for the signed-in X account's own avatar; always depict an adult; no logos or text.

## Front-end hook (ours, once the endpoint exists)
The flashcard iframe takes the portrait from the page; `theme.js` already rewrites the card face after Sean's app
renders (`dressBack`). Add the job start to step-2 submit and an image swap when the poll returns `done`.
