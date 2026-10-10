#!/usr/bin/env python3
"""Decode a bounded derivative before publishing its durable ready receipt."""
import json
import sys

from PIL import Image, ImageStat


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("cutout", "plate"):
        raise ValueError("usage: validate-layer.py cutout|plate main.png layer")
    kind, source_path, layer_path = sys.argv[1:]
    with Image.open(source_path) as source:
        source.load()
        dimensions = source.size
    with Image.open(layer_path) as layer:
        if layer.format != ("PNG" if kind == "cutout" else "JPEG"):
            raise ValueError("unexpected derivative format")
        layer.verify()
    with Image.open(layer_path) as layer:
        layer.load()
        if layer.size != dimensions:
            raise ValueError("derivative dimensions differ from main")
        if kind == "cutout":
            if layer.mode != "RGBA":
                raise ValueError("cutout must have alpha")
            alpha = layer.getchannel("A")
            coverage = ImageStat.Stat(alpha).mean[0] / 255
            if alpha.getextrema()[0] != 0 or not 0.03 <= coverage <= 0.9:
                raise ValueError("cutout has no usable foreground separation")
    print(json.dumps({"width": dimensions[0], "height": dimensions[1]}))


if __name__ == "__main__":
    main()
