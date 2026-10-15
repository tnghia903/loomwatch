# Earned figures: heads and stills

The two figures quests earn (docs/QUESTS.md), Scissors and Bobbin, are built here with three.js,
in the conventions of `ui/public/agent/workbench.glb`: under `figure/body/neck/head`, face toward
+z, materials named by role, eyes named `<kind>_eye_[lr]`. The six starter figures come from a
Blender script kept outside this repository; these files only add to its model.

- `heads.js` builds `head_scissors` and `head_bobbin`.
- `export.html` + `export.mjs` export them as a GLB of their own.
- `merge.py BASE.glb HEADS.glb OUT.glb` adds them under `head` in the model, without re-encoding
  anything already in it. It refuses a model that already has them.
- `render.html` + `still.mjs` render a 320 × 320 still with the camera matched to the Blender
  stills, and print where the eyes and hands land, for `ui/src/lib/library/accessorySpots.ts`.

Serve this folder with `three` (ui/node_modules/three) and `agent` (ui/public/agent) linked into it:

```sh
cd scripts/figures
ln -s ../../ui/node_modules/three three && ln -s ../../ui/public/agent agent
python3 -m http.server 8765 &
node export.mjs heads.glb
git show HEAD:ui/public/agent/workbench.glb > base.glb   # a model without the earned heads
python3 merge.py base.glb heads.glb ../../ui/public/agent/workbench.glb
CAM='{"y":0.55,"z":3.0,"fov":20.5,"ty":0.47,"exp":0.7,"rot":-0.25,"env":0.6,"key":1.8,"tm":"neutral"}'
node still.mjs bobbin-sky.png "build=1&kind=bobbin&color=%239EC3E6&cam=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$CAM")"
```

Then convert each still to WebP (quality 88) into `ui/public/agent/figures/<kind>-<color>.webp`.
`still.mjs` needs Playwright's Chromium with software WebGL (SwiftShader).
