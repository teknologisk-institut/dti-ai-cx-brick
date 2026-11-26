"""
crop-image.py

Reproducible crop+upscale helper for reading dense BMS schematic screenshots.
These screens are 1920x1080 and most labels/values (plant buttons, sensor IDs,
setpoints) are below readable size at full frame — so extraction must always be
done from upscaled crops, never a full-frame glance (see the image-extraction
protocol in the equipment-inventory skill).

For each region it prints the ORIGINAL-pixel bounding box, so a label read in a
crop can be mapped back to a global x/y — needed for ductPath (which depends on
an element's position relative to the heat-recovery block), not just its label.

Usage:
    # named regions, normalized coords x0,y0,x1,y1 in [0,1]
    python tools/crop-image.py <image> --region L=0.03,0.12,0.40,0.60 \
                                        --region C=0.36,0.12,0.70,0.60 --scale 3

    # one full-width skeleton band (fix heat-recovery x + the two duct-line y's)
    python tools/crop-image.py <image> --skeleton

    # whole image at a scale (default region if none given)
    python tools/crop-image.py <image> --scale 2

Crops are written to the system temp dir by default (kept out of the repo) — pass
--out-dir to change. Read the printed paths with the Read tool.
"""

import argparse
import os
import tempfile
from pathlib import Path

from PIL import Image


def parse_region(spec: str):
    """'name=x0,y0,x1,y1' -> (name, (x0,y0,x1,y1)) with coords in [0,1]."""
    if "=" not in spec:
        raise argparse.ArgumentTypeError(f"region '{spec}' must be name=x0,y0,x1,y1")
    name, coords = spec.split("=", 1)
    parts = [float(c) for c in coords.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(f"region '{spec}' needs 4 coords x0,y0,x1,y1")
    x0, y0, x1, y1 = parts
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise argparse.ArgumentTypeError(f"region '{spec}' coords must be 0<=x0<x1<=1, 0<=y0<y1<=1")
    return name, (x0, y0, x1, y1)


def main():
    ap = argparse.ArgumentParser(description="Crop+upscale regions of a BMS screenshot for legible reading.")
    ap.add_argument("image", help="path to the source image")
    ap.add_argument("--region", action="append", default=[], type=parse_region,
                    help="name=x0,y0,x1,y1 (normalized). Repeatable.")
    ap.add_argument("--skeleton", action="store_true",
                    help="emit one full-width band (y 0.15..0.62) to fix HR x + duct-line y's")
    ap.add_argument("--scale", type=float, default=3.0, help="upscale factor (default 3)")
    ap.add_argument("--out-dir", default=tempfile.gettempdir(), help="output dir (default system temp)")
    args = ap.parse_args()

    if not Path(args.image).exists():
        ap.error(f"image not found: {args.image}")

    im = Image.open(args.image)
    w, h = im.size
    stem = Path(args.image).stem
    Path(args.out_dir).mkdir(parents=True, exist_ok=True)

    regions = dict(args.region)
    if args.skeleton:
        regions["skeleton"] = (0.0, 0.15, 1.0, 0.62)
    if not regions:
        regions["full"] = (0.0, 0.0, 1.0, 1.0)

    print(f"source {args.image}  ({w}x{h})  scale={args.scale}")
    for name, (x0, y0, x1, y1) in regions.items():
        px = (int(w * x0), int(h * y0), int(w * x1), int(h * y1))
        crop = im.crop(px)
        scaled = crop.resize((max(1, int(crop.width * args.scale)),
                              max(1, int(crop.height * args.scale))), Image.LANCZOS)
        out = os.path.join(args.out_dir, f"{stem}_{name}.png")
        scaled.save(out)
        # Print original-pixel bbox so a crop coordinate maps back: global_x = px[0] + local_x/scale
        print(f"  {name}: orig-px {px}  saved {scaled.width}x{scaled.height}  ->  {out}")


if __name__ == "__main__":
    main()
