/* Deployment config for the v2 pages. Card-art backend base URL, no trailing slash. Empty = none on this host (pages
   opened from localhost still find the mock on 127.0.0.1:3022; `?api=…` on the URL overrides everything).
   After the backend is deployed (tools/cardgen/DEPLOY.md) put its URL here and redeploy the site. */
window.DONUT_CARD_API = "https://donut-card-art.fly.dev";
