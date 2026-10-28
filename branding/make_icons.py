#!/usr/bin/env python3
"""Builds the Super-Power Doctor AI icon set (blue rounded square, white medical cross).

Outputs to branding/out/: logo.svg, favicon-16x16.png, favicon-32x32.png,
apple-touch-icon-180x180.png, icon-192x192.png, maskable-icon.png (512).
Install into the running client with branding/apply_branding.sh.
"""
import os
from PIL import Image, ImageDraw

BLUE = (21, 101, 192)      # #1565C0
BLUE_DARK = (13, 71, 161)  # #0D47A1
WHITE = (255, 255, 255)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUT, exist_ok=True)


def icon(size, maskable=False):
    s = size * 4  # draw large, downsample for smooth edges
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, s, s], fill=BLUE)
        inner = 0.52
    else:
        r = int(s * 0.22)
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=BLUE)
        d.rounded_rectangle([int(s * 0.04), int(s * 0.04), s - 1 - int(s * 0.04), s - 1 - int(s * 0.04)],
                            radius=int(r * 0.85), outline=BLUE_DARK, width=max(1, int(s * 0.012)))
        inner = 0.62
    c = s / 2
    arm = s * inner / 2
    w = s * inner * 0.34 / 2
    rr = int(w * 0.35)
    d.rounded_rectangle([c - w, c - arm, c + w, c + arm], radius=rr, fill=WHITE)
    d.rounded_rectangle([c - arm, c - w, c + arm, c + w], radius=rr, fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


for name, size, mask in [('favicon-16x16.png', 16, False), ('favicon-32x32.png', 32, False),
                         ('apple-touch-icon-180x180.png', 180, True), ('icon-192x192.png', 192, False),
                         ('maskable-icon.png', 512, True)]:
    icon(size, mask).save(os.path.join(OUT, name))

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Super-Power Doctor AI">
  <rect x="0" y="0" width="100" height="100" rx="22" fill="#1565C0"/>
  <rect x="4" y="4" width="92" height="92" rx="19" fill="none" stroke="#0D47A1" stroke-width="1.2"/>
  <rect x="39.5" y="19" width="21" height="62" rx="3.7" fill="#fff"/>
  <rect x="19" y="39.5" width="62" height="21" rx="3.7" fill="#fff"/>
</svg>
'''
with open(os.path.join(OUT, 'logo.svg'), 'w') as f:
    f.write(SVG)
print('icons written to', OUT)
