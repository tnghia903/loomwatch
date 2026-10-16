"""Turn the rendered layers in ./wear into what the app serves (ui/public/agent/wear): each layer as
WebP, and per accessory an icon (a close-up of a figure wearing it) and a shape (the accessory
alone, for its silhouette while locked)."""
import glob, os
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'ui', 'public', 'agent', 'wear')
STILL = os.path.join(os.path.dirname(__file__), '..', '..', 'ui', 'public', 'agent', 'figures', 'yarn-sky.webp')
os.makedirs(OUT, exist_ok=True)
for path in sorted(glob.glob('wear/*-*.png')):
    name = os.path.basename(path)
    if name.startswith(('icon-', 'shape-')):
        continue
    Image.open(path).convert('RGBA').save(os.path.join(OUT, name.replace('.png', '.webp')), 'WEBP', quality=90, method=6)
base = Image.open(STILL).convert('RGBA')
for item in ['band', 'chalk', 'patch', 'pin', 'monocle', 'cushion', 'shuttle']:
    layer = Image.open(f'wear/yarn-{item}.png').convert('RGBA')
    pixels = np.asarray(layer).copy()
    # The accessory's own pixels: opaque enough, and not the black of its shadow.
    own = (pixels[:, :, 3] > 110) & (pixels[:, :, :3].max(axis=2) > 40)
    if item == 'chalk':
        own[200:, :] = False  # the piece behind the ear, not the line on the tummy
    ys, xs = np.nonzero(own)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    side = max(64, max(xs.max() - xs.min(), ys.max() - ys.min()) * 1.4)
    box = (int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2))
    Image.alpha_composite(base, layer).crop(box).resize((96, 96), Image.LANCZOS).save(os.path.join(OUT, f'icon-{item}.webp'), 'WEBP', quality=90, method=6)
    alone = pixels.copy()
    alone[~own] = 0
    Image.fromarray(alone).crop(box).resize((96, 96), Image.LANCZOS).save(os.path.join(OUT, f'shape-{item}.webp'), 'WEBP', quality=90, method=6)
print('done')
