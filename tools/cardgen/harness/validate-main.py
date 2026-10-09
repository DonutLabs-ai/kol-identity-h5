#!/usr/bin/env python3
"""Fully decode the bounded main PNG before using another paid image service."""
import json
import sys
from PIL import Image


def main():
    if len(sys.argv) != 2:
        raise ValueError("usage: validate-main.py main.png")
    with Image.open(sys.argv[1]) as image:
        if image.format != "PNG":
            raise ValueError("main image must be PNG")
        width, height = image.size
        if width < 64 or height < 64 or width * height > 9437184:
            raise ValueError("unsupported main dimensions")
        if not 0.4 <= width / height <= 2.5:
            raise ValueError("unsupported main aspect ratio")
        image.verify()
    with Image.open(sys.argv[1]) as image:
        image.load()
    print(json.dumps({"width": width, "height": height}))


if __name__ == "__main__":
    main()
