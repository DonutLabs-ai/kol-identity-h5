#!/usr/bin/env python3
"""Rank moodboard tiles by how well their VL annotation matches the card target and write a --refs list.
Target: airbrushed medium, human/hands as hero, amber+violet palette, rim light, film artifacts, chrome, light trails;
penalise typography tiles and clean 3D renders.

    python3 pick_refs.py [--n 8] [--dir style-refs/figma] [--out refs-auto.txt]
Prints the ranking; writes one `figma/<tile>` per line for `run.mjs --refs $(paste -sd, refs-auto.txt)`.
"""
import json, glob, os, sys

args = sys.argv[1:]
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
N = int(opt("--n", 8))
HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "..", opt("--dir", "style-refs/figma"))
OUT = os.path.join(DIR, opt("--out", "refs-auto.txt"))

tiles = []
for f in glob.glob(os.path.join(DIR, "reverse", "*.json")):
    if os.path.basename(f).startswith("_"): continue
    t = json.load(open(f))
    if t.get("tile", "").startswith("_"): continue          # contact sheets etc.
    tiles.append(t)

def has(v, *ws):
    s = json.dumps(v, ensure_ascii=False).lower()
    return any(w in s for w in ws)

def score(t):
    sc, why = 0, []
    if has(t.get("medium"), "airbrush", "gouache"): sc += 3; why.append("airbrush")
    if has(t.get("subject"), "person", "figure", "man", "woman", "hand", "silhouette", "portrait", "character", "robot"): sc += 2; why.append("human/hands")
    col = json.dumps(t.get("colour", {}), ensure_ascii=False).lower()
    if any(w in col for w in ("orange", "amber", "gold")) and any(w in col for w in ("violet", "purple", "indigo", "magenta")): sc += 2; why.append("amber+violet")
    if has(t.get("lighting"), "rim", "glow", "halation", "bloom"): sc += 1; why.append("rim/glow")
    if t.get("film_artifacts"): sc += 1; why.append("film")
    if has(t.get("materials"), "chrome", "mirror"): sc += 1; why.append("chrome")
    if has(t.get("motion"), "streak", "trail", "ribbon", "long-exposure"): sc += 1; why.append("trails")
    if has(t.get("subject"), "logo", "lettering", "typograph", "text", "wordmark", "letter"): sc -= 3; why.append("TEXT")
    if has(t.get("medium"), "3d render", "cgi", "digital render"): sc -= 1; why.append("3d")
    return sc, why

# Cory's category per tile (manifest.json, from the Figma label cards) → role-based plan
MANIFEST = os.path.join(DIR, "manifest.json")
cat_of = {}
if os.path.exists(MANIFEST):
    for im in json.load(open(MANIFEST))["images"]:
        cat_of[os.path.splitext(im["file"])[0]] = im.get("category", "uncategorised")
for t in tiles: t["category"] = cat_of.get(t["tile"], "uncategorised")

ranked = sorted(((score(t), t) for t in tiles), key=lambda x: -x[0][0])

if "--plan" in args:
    # roles: what each of Cory's categories is FOR in a card generation
    PLAN = [("glare-streak", 3, "texture: glare, cross-flares, psychedelic trails, film"),
            ("gradient-speed", 1, "motion: streaks and speed lines"),
            ("hands-gesture", 1, "gesture: how the KOL handles the type's gear"),
            ("elements", 1, "prop rendering: chrome / glass objects")]
    chosen = []
    for cat, n, role in PLAN:
        pool = [(sc, t) for (sc, _), t in ranked if t["category"] == cat]
        for sc, t in pool[:n]:
            chosen.append(t["tile"]); print(f"{cat:<16} {t['tile']:<34} {sc:>2}  ← {role}")
    prefix = os.path.basename(os.path.normpath(DIR))
    out = os.path.join(DIR, opt("--out", "refs-role.txt"))
    with open(out, "w") as fh: fh.write("\n".join(f"{prefix}/{x}" for x in chosen) + "\n")
    print(f"\nwrote {out} ({len(chosen)} refs)")
    sys.exit(0)
for (sc, why), t in ranked[:max(N, 12)]:
    print(f"{sc:>2}  {t['tile']:<34} {','.join(why):<44} {t.get('figma_caption', '')[:36]}")
top = [t["tile"] for (sc, _), t in ranked[:N]]
prefix = os.path.basename(os.path.normpath(DIR))
with open(OUT, "w") as fh: fh.write("\n".join(f"{prefix}/{x}" for x in top) + "\n")
print(f"\nwrote {OUT} ({N} refs)")
