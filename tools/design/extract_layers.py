import re, sys, base64, io, os
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
s = open(src).read()
masks = {}
for m in re.finditer(r'<mask id="(mask_\d+)">\s*<g transform="matrix\(([^)]*)\)">\s*<image id="[^"]*" width="(\d+)" height="(\d+)" xlink:href="data:image/(\w+);base64,([^"]+)"', s):
    masks[m.group(1)] = (m.group(2), base64.b64decode(m.group(6)))
items = []
for m in re.finditer(r'<g mask="url\(#(mask_\d+)\)">\s*<g transform="matrix\(([^)]*)\)">\s*<image id="[^"]*" width="(\d+)" height="(\d+)" xlink:href="data:image/(\w+);base64,([^"]+)"', s):
    mid, tr, w, h, kind, data = m.groups()
    if mid not in masks: continue
    color = Image.open(io.BytesIO(base64.b64decode(data))).convert('RGB')
    alpha = Image.open(io.BytesIO(masks[mid][1])).convert('L')
    if alpha.size != color.size: alpha = alpha.resize(color.size)
    img = color.copy(); img.putalpha(alpha)
    t = [float(x) for x in tr.split(',')]
    name = f"{len(items):02d}_{w}x{h}_at_{t[4]:.0f}_{t[5]:.0f}.png"
    img.save(os.path.join(out, name)); items.append((name, img))
print(len(items), 'layers')
# contact sheet
cols = 8; cell = 150
rows = (len(items) + cols - 1) // cols
sheet = Image.new('RGB', (cols * cell, rows * (cell + 14)), (60, 60, 70))
d = ImageDraw.Draw(sheet)
for i, (name, img) in enumerate(items):
    th = img.copy(); th.thumbnail((cell - 8, cell - 8))
    x, y = (i % cols) * cell + 4, (i // cols) * (cell + 14) + 4
    sheet.paste(th, (x, y), th)
    d.text((x, y + cell - 6), name[:22], fill=(255, 255, 255))
sheet.save(os.path.join(out, '_sheet.png'))
