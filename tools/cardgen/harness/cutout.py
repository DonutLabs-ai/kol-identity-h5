#!/usr/bin/env python3
"""Subject cut-out + clean plate for the 2.5D card portrait — the Linux twin of cutout.swift (rembg, isnet-general-use).
   python3 cutout.py in.png out.cut.png [out.plate.jpg]      exit 0 ok · 2 no foreground · 1 error
   Prints "coverage 0.xxx" (share of the frame the subject covers); the server rejects <3 % and >90 %.
   out.cut.png   RGBA, the input's size, subject only
   out.plate.jpg the art with the subject region (mask grown ~10 px) replaced by a 28 px blur of itself
"""
import sys
from PIL import Image, ImageFilter
import numpy as np
from rembg import remove, new_session

if len(sys.argv) not in (3, 4):
    print("usage: cutout.py in.png out.cut.png [out.plate.jpg]", file=sys.stderr); sys.exit(1)
src = Image.open(sys.argv[1]).convert("RGB")
cut = remove(src, session=new_session("isnet-general-use"))          # RGBA
alpha = np.asarray(cut.getchannel("A"), dtype=np.float32) / 255.0
coverage = float(alpha.mean())
if coverage < 0.005:
    print("no foreground", file=sys.stderr); sys.exit(2)
cut.save(sys.argv[2])
if len(sys.argv) == 4:
    region = Image.fromarray((alpha * 255).astype("uint8")).filter(ImageFilter.MaxFilter(21))   # dilate ~10 px
    blurred = src.filter(ImageFilter.GaussianBlur(28))
    Image.composite(blurred, src, region).save(sys.argv[3], quality=90)
print(f"coverage {coverage:.3f}")
