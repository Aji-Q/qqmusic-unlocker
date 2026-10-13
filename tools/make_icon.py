#!/usr/bin/env python3
"""生成应用图标：音符 + 解锁语义的圆角方形图标。"""
import os
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "AppIcon.iconset")
MASTER = os.path.join(HERE, "icon_1024.png")


def rounded_mask(size, radius, scale=4):
    m = Image.new("L", (size * scale, size * scale), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size * scale - 1, size * scale - 1],
                        radius=radius * scale, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def gradient(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size), Image.BILINEAR)


def draw_note(canvas, color, box):
    """双音符：两个符头 + 两条符杆 + 顶部横梁。box = (x0, y0, x1, y1)"""
    d = ImageDraw.Draw(canvas)
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    head_rx, head_ry = w * 0.20, w * 0.145
    stem_w = w * 0.075
    beam_h = h * 0.11
    # 符头（左低右高）
    ly = y0 + h * 0.82
    ry = y0 + h * 0.66
    lx = x0 + head_rx
    rx = x1 - head_rx
    d.ellipse([lx - head_rx, ly - head_ry, lx + head_rx, ly + head_ry], fill=color)
    d.ellipse([rx - head_rx, ry - head_ry, rx + head_rx, ry + head_ry], fill=color)
    # 符杆
    d.rectangle([lx + head_rx - stem_w, y0 + h * 0.06, lx + head_rx, ly], fill=color)
    d.rectangle([rx + head_rx - stem_w, y0, rx + head_rx, ry], fill=color)
    # 横梁
    d.polygon([(lx + head_rx - stem_w, y0 + h * 0.06),
               (rx + head_rx, y0),
               (rx + head_rx, y0 + beam_h),
               (lx + head_rx - stem_w, y0 + h * 0.06 + beam_h)],
              fill=color)


def main():
    bg = gradient(SIZE, (34, 46, 42), (16, 20, 24))
    canvas = Image.new("RGB", (SIZE, SIZE), (0, 0, 0))
    canvas.paste(bg, (0, 0))

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-SIZE * 0.2, -SIZE * 0.45, SIZE * 1.2, SIZE * 0.75],
                                 fill=(49, 196, 141, 70))
    canvas.paste(Image.alpha_composite(
        canvas.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(SIZE * 0.12))).convert("RGB"), (0, 0))

    draw_note(canvas, (232, 250, 240), (SIZE * 0.29, SIZE * 0.22, SIZE * 0.72, SIZE * 0.70))

    # 右下角解锁标记
    lock = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lock)
    cx, cy, r = SIZE * 0.735, SIZE * 0.775, SIZE * 0.125
    ld.rounded_rectangle([cx - r * 1.3, cy - r * 0.9, cx + r * 1.3, cy + r * 1.05],
                         radius=r * 0.42, fill=(49, 196, 141, 255))
    ld.arc([cx - r * 0.78, cy - r * 1.95, cx + r * 0.9, cy - r * 0.05],
           start=175, end=335, fill=(49, 196, 141, 255), width=int(r * 0.32))
    ld.line([cx + r * 0.84, cy - r * 1.02, cx + r * 0.30, cy - r * 1.02],
            fill=(231, 246, 239, 255), width=int(r * 0.32))
    ld.ellipse([cx - r * 0.24, cy - r * 0.38, cx + r * 0.24, cy + r * 0.10],
               fill=(10, 26, 20, 255))
    ld.rectangle([cx - r * 0.085, cy - r * 0.14, cx + r * 0.085, cy + r * 0.68],
                 fill=(10, 26, 20, 255))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), lock)

    canvas.putalpha(rounded_mask(SIZE, int(SIZE * 0.225)))
    canvas.save(MASTER)

    # iconset + icns
    subprocess.run(["rm", "-rf", OUT], check=True)
    os.makedirs(OUT, exist_ok=True)
    specs = [(16, ""), (16, "@2x"), (32, ""), (32, "@2x"), (128, ""), (128, "@2x"),
             (256, ""), (256, "@2x"), (512, ""), (512, "@2x")]
    for size, suffix in specs:
        px = size * (2 if suffix else 1)
        canvas.resize((px, px), Image.LANCZOS).save(
            os.path.join(OUT, f"icon_{size}x{size}{suffix}.png"))
    out_icns = os.path.join(HERE, "AppIcon.icns")
    subprocess.run(["iconutil", "-c", "icns", OUT, "-o", out_icns], check=True)
    print("生成:", out_icns, os.path.getsize(out_icns), "字节")


if __name__ == "__main__":
    sys.exit(main())
