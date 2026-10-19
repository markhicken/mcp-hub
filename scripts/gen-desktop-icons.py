"""Generates the placeholder MCP Hub app icon and macOS tray template icon (needs Pillow).

    python3 scripts/gen-desktop-icons.py && npm run tauri -w @mcp-hub/desktop -- icon src-tauri/icons/source.png

Writes apps/desktop/src-tauri/icons/source.png (1024x1024) and tray-template.png (44x44, i.e. 22pt @2x).
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "apps/desktop/src-tauri/icons"


def hub_points(cx, cy, radius, n=5, start=-90):
    return [
        (cx + radius * math.cos(math.radians(start + i * 360 / n)), cy + radius * math.sin(math.radians(start + i * 360 / n)))
        for i in range(n)
    ]


def draw_glyph(draw, size, fill, scale_nodes=1.0):
    c = size / 2
    ring = size * 0.30
    pts = hub_points(c, c, ring)
    line = max(2, int(size * 0.028))
    for p in pts:
        draw.line([(c, c), p], fill=fill, width=line)
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        draw.line([p, q], fill=fill, width=max(1, line // 2))
    r_out = size * 0.062 * scale_nodes
    for x, y in pts:
        draw.ellipse([x - r_out, y - r_out, x + r_out, y + r_out], fill=fill)
    r_c = size * 0.105 * scale_nodes
    draw.ellipse([c - r_c, c - r_c, c + r_c, c + r_c], fill=fill)


def app_icon(size=1024, ss=2):
    big = size * ss
    margin = int(big * 0.098)  # matches the macOS icon grid
    box = (margin, margin, big - margin, big - margin)

    # diagonal gradient #5b5bf0 -> #06b6d4
    grad = Image.new("RGB", (big, big))
    px = grad.load()
    a, b = (91, 91, 240), (6, 182, 212)
    for y in range(big):
        for x in range(big):
            t = (x + y) / (2 * (big - 1))
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=int(big * 0.225), fill=255)

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    glyph = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_glyph(ImageDraw.Draw(glyph), big, (255, 255, 255, 255))
    img = Image.alpha_composite(img, glyph)
    return img.resize((size, size), Image.LANCZOS)


def tray_icon(size=44, ss=8):
    big = size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_glyph(ImageDraw.Draw(img), big, (0, 0, 0, 255), scale_nodes=1.15)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    app_icon().save(OUT / "source.png")
    tray_icon().save(OUT / "tray-template.png")
    print("wrote", OUT / "source.png", "and", OUT / "tray-template.png")
