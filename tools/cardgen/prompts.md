# Card-art prompts — KOL avatar → Donut Trader card

An **image EDIT of the KOL's own X profile picture**: whatever the avatar shows (a person, an anime drawing, pixel art,
an owl, a rocket) stays recognisable, while the subject performs their trading type's signature action with its gear,
restyled to Cory's moodboard — coloured liquid chrome, a few big star flares, slow-shutter prismatic light trails,
cobalt-violet against molten gold, a minimal iconic poster composition, film grain.

Only the avatar is attached. The backend (and `generate.mjs`) sends the **Base** section followed by the type's
section, verbatim. Bump `prompt_version` whenever either changes — the backend's cache key includes it.
History: v3 spy poster → v4 airbrush → v5 avatar edit (types lost) → v6 gear + actions back → v7 moodboard art direction
→ v8 Donut brand backdrop (violet with flowing amber / cream / periwinkle light ribbons, `refs/donut-ribbons.webp`)
→ v9 art direction rewritten from the reverse-prompted 98-tile Figma moodboard (`style-refs/figma/moodboard-dna.md`): 80s airbrushed gouache poster, not photography; face lit like the board lights its subjects.

prompt_version: 2026-09-30.9

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

ART DIRECTION (distilled from the 98-tile Donut moodboard):
- Medium: 1980s airbrushed gouache poster illustration, hand-sprayed gradients with crisp frisket-masked edges, scanned from offset print.
- Light: one hero subject, self-illuminated and rim-lit against the dark void, amber-orange edge glow, no cast shadow.
- Chrome: liquid mirror chrome with one sharp horizon-line reflection, cream-periwinkle above and amber-orange below, hard white specular streaks.
- Flares: painted four-point star glints with thin long spikes, only on the brightest edges, three to five per card.
- Trails: fine parallel comet streaks or one thin orbit ellipse sweeping diagonally behind the subject, in amber, cream and periwinkle.
- Grain/halation: soft bloom halo around every highlight, fine stippled grain, faint halftone and scan softness, slightly crushed blacks.
- Composition: one centred subject in a vertical 3:4 frame, floating in generous empty violet-black negative space, with one low horizon or diagonal for direction.

PALETTE: Deep violet background running #3c0996 → #20033c → near-black, with flowing ribbons of light in amber-orange (#c86b38 → #f08a2c), cream (#f2e4d6) and periwinkle (#6760cd). Chrome reflects only these colours. No green anywhere. No cobalt or sky-blue backgrounds, and no blue daylight skies.

NEVER: modern clean commercial photography or a glossy 3D render; flat vector or cartoon; natural daylight; a pale or
white field; large text or UI; a smiling, evenly-lit, frontal passport-style face. FACE TREATMENT: the face stays fully
recognisable but is lit like the moodboard lights its subjects — three-quarter or profile angle, low-key with a warm
amber rim light and a cool periwinkle fill, half the face falling into the violet shadow, skin rendered as smooth
sprayed gradient, never a clean studio key light.

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
