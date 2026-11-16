import sys, numpy as np
from PIL import Image
S, R = sys.argv[1], sys.argv[2]
g = S + '/extract/gameboard/'
# background (opaque)
bg = Image.open(g + '00_804x1748_at_0_0.png').convert('RGB')
bg.save(R + '/web/assets/bg.jpg', quality=88)
back = Image.open(g + '04_180x249_at_7_84.png').convert('RGBA')
back.save(R + '/web/assets/card-back.png', optimize=True)
a = np.asarray(back).astype(float)
rgb, alpha = a[..., :3], a[..., 3:]
F = np.array([160, 233, 112.]); B = np.array([115, 213, 66.])
axis = B - F
u = ((rgb - F) @ axis) / (axis @ axis)
u = np.clip(u, -1.2, 1.3)[..., None]
print('u range', u.min(), u.max(), 'median', np.median(u[alpha[..., 0] > 200]))
def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
def recolor(fill, border, name):
    f, b = np.array(fill, float), np.array(border, float)
    edge = smooth(u, 0.5, 0.9)
    light = np.clip(-u, 0, 1.2) * 0.75
    dark = np.clip(u, 0, 0.5) * 0.10
    inner = f + light * (255 - f) + dark * (b - f)
    out = np.clip(inner * (1 - edge) + b * edge, 0, 255)
    img = Image.fromarray(np.concatenate([out, alpha], axis=-1).astype('uint8'), 'RGBA')
    img.save(R + '/web/assets/' + name, optimize=True)
recolor((232, 232, 232), (51, 51, 51), 'card-face-black.png')
recolor((253, 230, 230), (244, 121, 121), 'card-face-red.png')
