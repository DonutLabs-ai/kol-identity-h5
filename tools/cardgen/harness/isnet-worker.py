#!/usr/bin/env python3
"""Resident IS-Net CPU session. Local paths over bounded JSON-lines IPC; no network."""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from PIL import Image, ImageStat
from rembg import new_session, remove

MODEL_SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--threads", required=True, type=int)
    args = parser.parse_args()
    if args.threads < 1 or args.model.name != "isnet-general-use.onnx":
        raise ValueError("IS-Net model path and positive thread count required")
    with args.model.open("rb") as model:
        if hashlib.file_digest(model, "sha256").hexdigest() != MODEL_SHA256:
            raise ValueError("IS-Net model checksum mismatch")
    os.environ["U2NET_HOME"] = str(args.model.parent)
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    session = new_session("isnet-general-use", providers=["CPUExecutionProvider"])
    if session.inner_session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError("Unexpected IS-Net execution provider")
    print(json.dumps({"event": "ready", "model": "isnet-general-use"}), flush=True)
    for line in sys.stdin:
        if len(line) > 4096:
            raise ValueError("IS-Net request exceeds IPC limit")
        request = json.loads(line)
        started = time.perf_counter()
        try:
            with Image.open(request["source"]) as image:
                image.load()
                source = image.convert("RGB")
            cut = remove(source, session=session)
            if cut.mode != "RGBA" or cut.size != source.size:
                raise ValueError("IS-Net foreground dimensions or channels invalid")
            alpha = cut.getchannel("A")
            coverage = ImageStat.Stat(alpha).mean[0] / 255
            if alpha.getextrema()[0] != 0 or not 0.03 <= coverage <= 0.9:
                raise ValueError("IS-Net has no usable foreground separation")
            target = Path(request["target"])
            temporary = target.with_name(target.name + ".isnet.tmp")
            cut.save(temporary, format="PNG")
            temporary.replace(target)
        except (OSError, ValueError) as error:
            print(f"isnet.invalid_output:{type(error).__name__}", file=sys.stderr, flush=True)
            print(json.dumps({"id": request["id"], "ok": False, "error": "invalid_output"}), flush=True)
            continue
        print(json.dumps({"id": request["id"], "ok": True, "seconds": time.perf_counter() - started}), flush=True)


if __name__ == "__main__":
    main()
