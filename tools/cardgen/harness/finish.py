#!/usr/bin/env python3
"""Print finish for card art: halation bloom around highlights, lifted violet blacks, slight scan softness, fine grain,
soft vignette. Deterministic, so every card gets the same "80s offset print" feel regardless of what the model did.
The CSS in identity/theme.js should mirror this recipe (grain is already there).

    python3 finish.py in.png out.png [--strength 1.0]
"""
import sys
from PIL import Image, ImageFilter, ImageChops, ImageEnhance, ImageOps

def finish(src, dst, strength=1.0):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    s = strength

    # 1. halation: bright regions bleed a warm glow into their surroundings
    lum = ImageOps.grayscale(im)
    mask = lum.point(lambda v: 0 if v < 150 else int((v - 150) / 105 * 255))
    glow = Image.composite(im, Image.new("RGB", im.size, (0, 0, 0)), mask)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=w * 0.025))
    warm = Image.new("RGB", im.size, (255, 196, 120))
    glow = Image.blend(glow, ImageChops.multiply(glow, warm), 0.5)
    out = ImageChops.screen(im, ImageEnhance.Brightness(glow).enhance(0.55 * s))

    # 2. lifted blacks: the print never hits true black — shadows sit on a faint violet
    lift = Image.new("RGB", im.size, (26, 15, 51))
    out = ImageChops.lighter(out, Image.blend(Image.new("RGB", im.size, (0, 0, 0)), lift, 0.9 * s))
    out = Image.blend(out, ImageChops.add(out, lift, scale=1.0, offset=0), 0.12 * s)

    # 3. scan softness: a whisper of blur, kept mostly in the shadows
    soft = out.filter(ImageFilter.GaussianBlur(radius=max(0.6, w * 0.0009)))
    out = Image.blend(out, soft, 0.45 * s)

    # 4. fine grain
    import random
    rnd = random.Random(7)
    noise = Image.effect_noise(im.size, 18).convert("L")
    noise = ImageEnhance.Contrast(noise).enhance(1.4)
    grain = Image.merge("RGB", (noise, noise, noise))
    out = Image.blend(out, ImageChops.overlay(out, grain), 0.28 * s)

    # 5. vignette
    vig = Image.new("L", im.size, 0)
    from PIL import ImageDraw
    d = ImageDraw.Draw(vig)
    d.ellipse((-w * 0.25, -h * 0.25, w * 1.25, h * 1.25), fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(radius=w * 0.22))
    dark = ImageEnhance.Brightness(out).enhance(0.72)
    out = Image.composite(out, dark, vig)

    out.save(dst, quality=94)

if __name__ == "__main__":
    a = sys.argv[1:]
    strength = float(a[a.index("--strength") + 1]) if "--strength" in a else 1.0
    finish(a[0], a[1], strength)
