# Card-art prompts — KOL avatar → Donut Trader card

An **image EDIT of the KOL's own X profile picture**: whatever the avatar shows (a person, an anime drawing, pixel art,
an owl, a rocket) stays recognisable, while the subject performs their trading type's signature action with its gear,
restyled to Cory's moodboard — coloured liquid chrome, a few big star flares, slow-shutter prismatic light trails,
cobalt-violet against molten gold, a minimal iconic poster composition, film grain.

Only the avatar is attached. The backend (and `generate.mjs`) sends the **Base** section followed by the type's
section, verbatim. Bump `prompt_version` whenever either changes — the backend's cache key includes it.
History: v3 spy poster → v4 airbrush → v5 avatar edit (types lost) → v6 gear + actions back → v7 moodboard art direction.

prompt_version: 2026-09-29.7

## Base

EDIT the attached profile picture into a collectible trading-card image, vertical 3:4.

KEEP (most important): the same subject, recognisable at first glance to anyone who knows this avatar — the same
person with the same face, features, skin tone, hairstyle, glasses, headwear and facial hair; or, if it is not a person,
the same creature, character or object with its silhouette, colours and signature details. Do not replace the subject
with someone or something else and do not change their age or gender. Remove any text, logos, magazine mastheads or
watermarks from the avatar. If the avatar is a drawing, anime or pixel art, keep the character drawn-looking with
its own design — do not turn it into a realistic human.

ACT (equally important): the subject performs the TRADING TYPE's signature action with its signature gear, exactly as
described below — this is what makes the card theirs. Re-pose the body and hands as needed; keep the face and head
recognisable. A creature holds or uses the gear with its own limbs; an object (a rocket, a logo-like shape) carries the
gear and action as part of the scene in a playful, natural way. Frame from the knees or waist up — full body only when
the action needs it — with the face large enough to recognise and the gear fully visible.

ART DIRECTION — 1970s–80s album-cover art made with practical in-camera effects and shot on slide film:
- LIQUID CHROME that reflects colour, never grey steel: mirror-smooth, slightly molten surfaces on the gear, the
  clothing and hair highlights, cool electric-violet and cobalt on the shadow side and hot molten gold-orange on the
  lit side, like chrome reflecting a sunset. A person's face stays human and recognisable, lit with a warm key and a
  cool rim.
- A FEW BIG STAR FLARES: two or three large four/six-point cross flares on the very brightest points (the gear, an
  eye glint, a chrome edge) — not glitter sprinkled everywhere. Disco-mirror glitter only as an accent on one surface.
- SLOW-SHUTTER LIGHT PAINTING: long, smooth, fluid light trails sweeping through the frame with prismatic rainbow
  fringes at their edges; the moving gear leaves a motion smear.
- PRISM CAUSTICS: iridescent spectral refraction where light passes through glass, gems or chrome edges.
- COMPOSITION: an iconic poster — one heroic subject, bold graphic silhouette, low-angle hero light with a strong rim,
  generous negative space, on a flat saturated backdrop (deep cobalt-to-violet gradient, or near-black with a single
  soft glow).
- FILM: heavy fine grain, halation glow around every light, deep rich blacks, gentle soft-focus fall-off at the edges,
  slight vignette.
It must read as a photograph of a real chrome-and-light effects shoot — NOT a digital painting, NOT anime shading on
a person, NOT a clean 3D render. Less is more: fewer, bigger, more deliberate effects.

PALETTE (saturated, complementary): deep cobalt-ultramarine and Donut violet (#12104a, #1a1466, #3b1f73, #7a3dff) for
the backdrop and cool reflections; molten gold, amber and warm ivory (#ffb347, #e9c77b, #fff3d6) for hot reflections,
flares and trails; spectral rainbow only in trail fringes and prism caustics. High contrast. The gear may carry the
type's accent colour named below.

Clean edges, no border, no frame, no text, letters, numbers or logos anywhere. No cigarettes, cigars, alcohol or drugs.

## diamond_hands

Diamond Hands — calm, unwavering conviction. Gear: one large faceted AMETHYST diamond. Action: facing the viewer,
shoulders square, holding the diamond securely at centre chest with both hands, direct steady gaze, serene resolute
expression.

## hodler

DCA Believer — disciplined, steady accumulation. Gear: a compact handheld rail of identical, evenly spaced small
AMETHYST crystals, a plain dark stool. Action: seated sideways, leaning in, one hand placing one more crystal into the
next empty slot, eyes on it, patient focus.

## degen

Risk Explorer — bold, deliberate exploration. Gear: a small dark floating stepping stone and one ROSE-PINK faceted
waypoint orb. Action: stepping onto the stone and reaching for the orb, glancing back over the shoulder at the viewer
with a confident grin.

## scalper

Day Trader — alert, immediate, precise. Gear: three small ROSE-PINK translucent candlestick-shaped blocks floating
close by. Action: leaning forward, knees bent, one hand snapping across the body to tap one block, the other ready,
sharp eyes on the fingertip.

## sniper

Sniper — patience and precision, never firing. Gear: a sleek ONYX-and-silver sci-fi precision rifle. Action: low
one-knee kneel, rifle shouldered and aimed horizontally into empty space, eye at the sight, completely composed; no
target, no muzzle flash.

## grid_farmer

Grid Executor — methodical execution. Gear: a compact rigid ONYX-and-silver lattice with glinting nodes, a minimal dark
stool. Action: seated upright and symmetrical, both hands precisely adjusting two nodes, chin tucked, eyes on the
lattice.

## swing_hunter

Swing Hunter — timing the next wave. Gear: a short sculptural EMERALD ribbon wave with one clear crest and one trough.
Action: low sideways half-crouch, one hand tracing the wave, eyes on the next trough, poised.

## momentum_chaser

Momentum Rider — riding a strong established direction. Gear: a sleek dark floating board with one EMERALD directional
accent. Action: standing sideways on the board tilted up toward the upper right, leaning into the motion, arms spread
for balance, hair swept back, determined gaze ahead.

## arbitrageur

Arb Researcher — analytical comparison. Gear: a small optical lens and two near-identical AMBER-GOLD faceted prisms
floating at slightly different heights. Action: bent slightly forward, lens raised between the prisms, other hand
adjusting one, head tilted, examining the difference — the lens never hides the face.

## narrative_trader

Narrative Trader — reading the story ahead. Gear: a compact translucent AMBER book of abstract pictures (no writing)
with three short golden threads rising from its pages. Action: seated sideways, book open in one hand, the other
selecting one thread, eyes lifted to it, a knowing look.

## risk_monk

Risk-First — assured, clear boundaries. Gear: a crisp translucent curved shield with AURORA (teal-lilac-pink)
reflections and a small luminous core. Action: side-on stance, feet planted, one palm supporting the shield close to
the body, the other hand holding the core, head turned to the viewer with a direct resolute gaze.

## bottom_fisher

Contrarian — patient, independent observation. Gear: a small unmarked optical observation device and one small AURORA
prism. Action: back three-quarter view as if they just stopped walking, device held behind them, looking back over the
shoulder at the prism low at one side, calm and contemplative.

## unresolved

Style Explorer — still writing their story. Gear: a small multi-faceted token that shows a different colour on each
face. Action: relaxed three-quarter pose, turning the token between two fingers as if deciding which face to show,
curious open expression.
