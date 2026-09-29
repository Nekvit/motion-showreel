#!/usr/bin/env python3
"""Contact sheet: python3 tools/sheet.py OUT.png COLS FILE... (labels each tile with its frame number)."""
import sys, re, os
from PIL import Image, ImageDraw, ImageFont
out, cols, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
tw = 480
tiles = []
for f in files:
    im = Image.open(f).convert('RGB')
    im = im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS)
    tiles.append((im, re.sub(r'\D', '', os.path.basename(f)).lstrip('0') or '0'))
th = tiles[0][0].height
rows = (len(tiles) + cols - 1) // cols
pad = 4
sheet = Image.new('RGB', (cols * (tw + pad) + pad, rows * (th + pad) + pad), (32, 32, 32))
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 16)
except OSError:
    font = ImageFont.load_default()
d = ImageDraw.Draw(sheet)
for i, (im, label) in enumerate(tiles):
    x, y = pad + (i % cols) * (tw + pad), pad + (i // cols) * (th + pad)
    sheet.paste(im, (x, y))
    d.rectangle([x, y, x + 12 + 10 * len(label), y + 22], fill=(0, 0, 0))
    d.text((x + 6, y + 3), label, fill=(255, 255, 255), font=font)
sheet.save(out)
