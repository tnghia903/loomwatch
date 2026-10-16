# Figure art: earned heads, accessory layers and icons

The two figures quests earn (Scissors and Bobbin) and the pictures of the wardrobe's accessories
(docs/QUESTS.md) are made here with three.js, in the conventions of `ui/public/agent/workbench.glb`.
The six starter figures and their stills come from a Blender script kept outside this repository;
these files only add to them.

| File | What it does |
|---|---|
| `heads.js` | Builds `head_scissors` and `head_bobbin`: under `figure/body/neck/head`, face toward +z, materials named by role, eyes named `<kind>_eye_[lr]`. |
| `export.html`, `export.mjs` | Export the heads as a GLB of their own. |
| `merge.py BASE HEADS OUT` | Adds the heads under `head` without re-encoding anything already in the model; refuses one that has them. |
| `calib.html`, `calib.mjs` | Fit the camera and the arms' pose to the Blender stills' silhouettes (IoU 0.98). The result is `cam.json`. |
| `render.html`, `still.mjs` | Render a still with `cam.json`: how the earned figures' stills are made. |
| `layers.html`, `layers.mjs` | Render each accessory on each figure as a layer the size of a still: the figure hides what is behind it and catches its shadow. The accessories come from the app's own `accessoryMeshes.ts`, so the pictures match the 3D bench. Accessories on the face are moved by each still's measured face shift (in `layers.mjs`): the Blender stills' faces sit a few pixels from this model's. |
| `finish.py` | Turns the layers into WebP in `ui/public/agent/wear`, with an icon and a locked silhouette per accessory. |

Serve this folder with `three` (ui/node_modules/three) and `agent` (ui/public/agent) linked into
it, and the app's accessories compiled into `lib/`:

```sh
cd scripts/figures
ln -s ../../ui/node_modules/three three && ln -s ../../ui/public/agent agent
npx --prefix ../../ui tsc ../../ui/src/components/agents/accessoryMeshes.ts --ignoreConfig --outDir lib \
  --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --lib es2022,dom
python3 -m http.server 8765 &

# The earned heads (only when changing them):
node export.mjs heads.glb
git show HEAD:ui/public/agent/workbench.glb > base.glb   # a model without the earned heads
python3 merge.py base.glb heads.glb ../../ui/public/agent/workbench.glb

# A still: kind, colour and the calibrated camera.
node still.mjs bobbin-sky.png "kind=bobbin&color=%239EC3E6&cam=$(python3 -c 'import urllib.parse;print(urllib.parse.quote(open("cam.json").read().strip()))')"

# The accessory layers, icons and silhouettes:
node layers.mjs && python3 finish.py
```

Convert stills to WebP (quality 88) into `ui/public/agent/figures/<kind>-<color>.webp`. The renders
need Playwright's Chromium with software WebGL (SwiftShader).
