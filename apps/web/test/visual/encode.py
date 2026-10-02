# SPDX-License-Identifier: AGPL-3.0-or-later
"""Encode the landing page's images: each rendered PNG and the hero photo as AVIF and WebP at the widths the
page asks for (srcset), plus the Open Graph card as a JPEG (the format every link preview reads).

    uvx --from "pillow>=11.3" python encode.py <raw-dir> <public/landing> <hero.jpg>
"""
import sys
from pathlib import Path

from PIL import Image

raw, out, hero = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)

# name -> widths in px (the source is cut down to each; never scaled up)
WIDTHS = {
    "map-band": [800, 1600],
    "phone": [390, 780],
    "desktop": [960, 1920],
}


def write(img: Image.Image, stem: str, width: int) -> None:
    w = min(width, img.width)
    h = round(img.height * w / img.width)
    small = img.resize((w, h), Image.LANCZOS) if w != img.width else img
    small.save(out / f"{stem}-{w}.avif", quality=58, speed=6)
    small.save(out / f"{stem}-{w}.webp", quality=78, method=6)
    print(f"  {stem}-{w} {w}x{h}")


for name, widths in WIDTHS.items():
    img = Image.open(raw / f"{name}.png").convert("RGB")
    for w in widths:
        write(img, name, w)

img = Image.open(hero).convert("RGB")
for w in [960, 1600, 2560]:
    write(img, "hero", w)

og = Image.open(raw / "og.png").convert("RGB")
og.save(out / "og.jpg", quality=84, optimize=True, progressive=True)
print("  og 1200x630")
