# kol-identity-h5

**Donut Identity** — the KOL trading-personality campaign H5.
Landing → Connect X → details + wallet → six questions → D0 analysis → your Donut Trader card.

Pure static site, no build step. Open `identity/index.html` from any static server.

## Layout

```
identity/     the campaign flow (entry: identity/index.html)
  app.js      Sean's flow bundle (artifact repo, build kol-d0-cinematic-*) — do not hand-edit except the flashcard path
  app.css     Sean's styles — untouched
  base.css    Sean's style.css — untouched
  theme.css   Donut website skin over Sean's class names (light + dark on data-theme)
  theme.js    theme toggle, planet-video stage, card tuning panel (⚙ / ?tune=1)
  glass.js    card glare / pseudo-3D treatment
  fonts/ img/ media/ logos/
flashcard/    the card renderer, embedded by identity as an iframe (Yi's Astro build)
  kol.html    ../identity/app.js loads ../flashcard/kol.html?embed=1&skin=…
  thanks.html
  _astro/     CSS + fonts (font URLs rewritten to ./ so the site works under any sub-path)
index.html    redirects to identity/
```

The two folders reference each other with `../` paths — keep them siblings.

## Run locally

```bash
python3 -m http.server 3021 --bind 127.0.0.1
```

Then open <http://127.0.0.1:3021/identity/>.

URL flags: `?intro=1` replays the opening, `?intro=0` skips it, `?tune=1` shows the card tuning panel.
The EN / 中文 toggle is top-right.

## Sync from upstream

- **Flow (identity/app.js, app.css, base.css)** — from Sean's artifact repo
  `seanmoorecrypto/product/kol-identity-card`: sparse-clone that folder, copy `build/App.js → app.js`,
  `build/App.css → app.css`, `style.css → base.css`. Re-apply the one edit in `app.js`: the iframe `src`
  must point at `../flashcard/kol.html`.
- **Card renderer (flashcard/)** — from Yi's build. After copying, rewrite root-absolute font URLs:

  ```bash
  sed -i '' 's#url(/_astro/#url(./#g' flashcard/_astro/*.css
  ```

## History

Split out of `DonutLabs-ai/kol-card` (`public/identity` and `public/flashcard`, branch `feat/identity-site`)
on 2026-09-28 with `git subtree split`, so every commit that touched either folder is preserved here.
