#!/usr/bin/env python3
"""Validate the AWS foreground and derive Cory's existing blur plate from its alpha."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat


def main():
    if len(sys.argv) != 4:
        raise ValueError("usage: plate.py original.png foreground.png plate.jpg")
    with Image.open(sys.argv[1]) as original:
        original.load()
        source = original.convert("RGB")
    with Image.open(sys.argv[2]) as foreground:
        foreground.load()
        if foreground.mode != "RGBA" or foreground.size != source.size:
            raise ValueError("cutout must be RGBA with the original image dimensions")
        alpha = foreground.getchannel("A")
        coverage = ImageStat.Stat(alpha).mean[0] / 255
        if alpha.getextrema()[0] != 0 or not 0.03 <= coverage <= 0.9:
            raise ValueError("cutout has no usable foreground separation")
        region = alpha.filter(ImageFilter.MaxFilter(21))
    plate = Image.composite(source.filter(ImageFilter.GaussianBlur(28)), source, region)
    target = Path(sys.argv[3])
    temporary = target.with_name(target.name + ".tmp")
    plate.save(temporary, format="JPEG", quality=90)
    temporary.replace(target)
    print(json.dumps({"coverage": coverage, "width": source.width, "height": source.height}))


if __name__ == "__main__":
    main()
