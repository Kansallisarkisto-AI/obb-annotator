# obb-annotator

**Completely vibe coded** editor to produce YOLO-OBB style annotations for SfRD


A 100% client-side web app for loading, editing, and saving YOLO-OBB
annotation exports (Label Studio "YOLO OBB" zip format).

## Running it

Unzip the delivered folder anywhere and double-click **`index.html`**
(or drag it into a browser window). Everything — including the ZIP
library — is bundled locally in `vendor/`, so it works fully offline
and directly from `file://`.

Works best in a recent Chrome, Edge, or Firefox.

## Expected zip layout (in and out)

```
<project-name>/
  classes.txt        # one class name per line, line index = class id
  notes.json         # optional Label-Studio metadata (regenerated on save)
  images/
    1.jpg ...
  labels/
    1.txt ...         # "classId x1 y1 x2 y2 x3 y3 x4 y4" per line, normalized 0-1
```

**Multi-label boxes**: a box with more than one label is represented
in the file as multiple lines that share the same 8-number coordinate
list, one line per label — exactly as produced by the patched Label
Studio OBB export. The editor detects this on load by grouping lines
into the same box whenever their coordinates describe the same
quadrilateral, even if a duplicate line's vertex list starts at a
different corner, winds the opposite direction, or has trivial
floating-point noise — not just when the text is byte-identical. If
any boxes needed that more permissive matching, a toast tells you how
many; saving always writes duplicate labels back out with identical,
clean coordinates.

Class ids in the file are just the 0-based line position in
`classes.txt`. Internally the editor tracks classes by a separate
stable id (so renaming, reordering, or deleting a class never
requires touching every box), translating file positions to that
internal id exactly once on load and back again on save.

## Features

- **Open / New / Save** — open an existing zip, or click **New Project** to
  start from a blank project (one default class, no images) and build up
  from scratch. **Save Zip** re-packages everything (images copied
  byte-for-byte, uncompressed for speed; labels and classes regenerated)
  into a new downloadable zip.
- **Add / remove images** — use **+ Add** above the image list (or drag &
  drop image files anywhere on the page) to add images to the current
  project at any time, whether it came from a zip or was started fresh. Each
  image row has a small remove (&times;) button; removing an image with
  existing boxes asks for confirmation first. Both are undoable.
- **Multiple images** — every image in the project is listed in the left
  sidebar with its box count; click to switch. All annotation data is kept
  in memory so edits, class renames/reordering, and undo history work
  uniformly across the whole project.
- **Class list panel** — add, rename (inline), recolor, reorder
  (drag or ▲▼), toggle visibility, or delete classes. Each row shows
  how many boxes currently use that class. Deleting an in-use class
  asks for confirmation and removes just that label from affected
  boxes (a box left with zero labels is removed).
- **Selection** — click a box to select it; drag on empty canvas for a
  rubber-band multi-select; `Ctrl+A` selects all visible boxes on the
  current image. Holding `Shift`/`Ctrl`/`Cmd` switches to selection-only
  mode: a click toggles the box under the cursor, and a drag
  rubber-band-**adds** to the current selection — even when the drag
  starts in the middle of a box. Nothing is moved or resized while a
  modifier is held.
- **Overlap highlighting** — boxes that overlap another box are filled
  translucently, so the intersection renders darker (a triple overlap
  darker still); non-overlapping boxes stay outline-only. The status
  bar reports how many visible boxes overlap. Toggle with the
  **◐ Overlaps** toolbar button or `O`. Works for rotated boxes too
  (exact convex-quad test).
- **Label colors** — the **▨ Label colors** toolbar button (or `L`)
  tints every box with its label color(s): single-label boxes get a
  translucent fill, and multi-label boxes get diagonal stripes cycling
  through each of their (visible) labels' colors, with a striped
  outline too. Off by default; combines with overlap shading.
- **Help dialog** — the **? Help** toolbar button (or `?` / `F1`) opens a
  scrollable, grouped shortcut reference in a modal, so it never gets
  cut off or competes with the side panels for space. `Esc` or a click
  outside closes it.
- **Click-cycling through stacked boxes** — click the same spot again
  (within a few pixels) to step through every box under it, topmost
  first, wrapping around; the status bar shows the position ("overlap
  2/3"). Clicking elsewhere resets the cycle, and pressing and dragging
  still moves the currently selected box. Tiny hand jitter (&lt;3px)
  during a click no longer counts as a drag.
- **Editing** — drag a box body to move it (works for multi-selection
  too — all selected boxes move together); drag a bar on the middle of an edge
  to move just that edge (along its own normal, so rotated boxes stay
  rectangular; edges shorter than 28px on screen get no bar); drag a corner handle to
  resize (keeps the box rectangular — the opposite corner stays fixed
  and the two adjacent corners are re-projected, so it behaves like a
  real oriented bounding box, not a free quad); hold **Alt** while
  dragging a corner to move that single vertex freely instead; drag
  the green handle to rotate around the box's centroid. Arrow keys
  nudge the selection by 1px (10px with Shift). `B` draws a brand new
  axis-aligned box (assigned to the first class by default — then use
  the label checklist to correct it).
- **Multi-labeling** — the right-hand "Labels for selection" panel is
  a tri-state checklist of every class: unchecked = no selected box
  has it, filled = all of them have it, half-filled = some do.
  Clicking a class toggles it on/off for the *entire* current
  selection in one action — this is how you multi-label a box (or a
  batch of boxes) or strip a label from many boxes at once.
- **Undo / redo** — `Ctrl+Z` / `Ctrl+Shift+Z` (or the toolbar
  buttons) cover moves, resizes, rotations, add/delete/duplicate,
  label toggles, and class list edits.
- **Duplicate** (`Ctrl+D`), **Delete** (`Del`), **Fit to window**
  (`F`), **zoom** (scroll wheel, or `+`/`-`), **pan** (space+drag,
  middle-mouse drag, or right-mouse drag &mdash; the browser's right-click
  menu is suppressed on the canvas so this doesn't fight with it).
- **Autosave to this browser** &mdash; the project (including image bytes)
  is automatically and continuously backed up to this browser's local
  storage (IndexedDB under the hood; plain `localStorage` is far too
  small to hold images) a couple of seconds after any change, with a
  small status indicator in the toolbar. If you reopen the page later
  and a backup is found, a banner offers to **Restore** it or
  **Discard** it. **Clear Backup** wipes it on demand. This is a local
  safety net only &mdash; **zip import/export remains the actual,
  portable way to save and share a project**, unchanged from before.
  Note: browser storage under `file://` can behave a little
  differently from a normal `https://` site depending on the browser,
  so treat it as a convenience, not a substitute for saving a zip.
- **Table cell detection (ONNX, in-browser)** — the right-hand
  *Table cell detection* panel runs the PaddlePaddle RT-DETR-L wired /
  wireless table-cell detectors locally with onnxruntime-web (WASM) and
  adds each detected cell as an ordinary box. Pick *wired* or *wireless*,
  set the cell threshold and the class to assign (or let it create a
  `table_cell` class), then **Detect (this image)** or **All images**.
  Optionally tick *Find tables first* to run the PP-DocLayout_plus-L
  layout model and detect cells only inside table / image regions.
  Large images are processed in overlapping 1920px tiles and merged
  (SAHI-style), cells are emitted in reading order, and a whole run is a
  single **undo** step. *Replace this class's boxes* makes re-running
  with a different threshold idempotent. See "Table cell detection
  models" below for how models are obtained.
- **Performance at scale** — designed for images with thousands of
  boxes: the base image is a plain `<img>` panned/zoomed via a GPU
  CSS transform (so pan/zoom cost is independent of box count), while
  annotation boxes are drawn on a single overlay `<canvas>`, batched
  into one `stroke()` call per class color and culled to the visible
  viewport, so redraws stay sub-millisecond even at 10,000+ boxes.

## Table cell detection models

The `.onnx` files are large (~100+ MB each) and are **not** bundled. The
first time you run detection, the app downloads the model for the selected
mode in your browser (Hugging Face serves CORS headers, so this works from
`file://`) and stores it in browser storage (IndexedDB, separate from the
project autosave) so it is only fetched once. Alternatively, download the
`.onnx` yourself and use **Model files → Load file…** for fully offline use.

Default sources (editable in the *Model files* section):

| Model | URL |
|---|---|
| Wired cells | `huggingface.co/PaddlePaddle/RT-DETR-L_wired_table_cell_det_onnx` (`inference.onnx`) |
| Wireless cells | `huggingface.co/PaddlePaddle/RT-DETR-L_wireless_table_cell_det_onnx` (`inference.onnx`) |
| Layout (optional) | `huggingface.co/PaddlePaddle/PP-DocLayout_plus-L_onnx` (`inference.onnx`) |

If a repo uses a different file name, paste the correct `resolve/main/...`
URL into the field. Models are expected to follow the Paddle detection
export convention: inputs `im_shape`, `image`, `scale_factor` (matched by
name, any order) and an `[N, 6]` output of `class, score, x1, y1, x2, y2`.

Notes:

- Inference runs entirely on-device (WASM, single-threaded, since
  multi-threading needs cross-origin isolation which `file://` pages
  don't have). Expect seconds per 1920px tile on a laptop CPU; the
  *Cancel* button on the progress dialog stops between tiles and keeps
  what was already detected.
- The ONNX Runtime WASM binary (~11 MB) is embedded in
  `vendor/ort/ort-wasm-embedded.js` (14 MB, base64) and only loaded the
  first time detection is used — it has no effect on startup time. This
  is what makes it work from `file://`, where ES modules and `fetch()` of
  local files are blocked. Regenerate it with `tools/build-ort-embed.js`
  (instructions in the file header).
- Preprocessing resizes tiles to the model input size with the browser's
  canvas scaler (the Python pipeline uses OpenCV bicubic), so scores can
  differ marginally from the Label Studio backend.

## Keyboard reference

| Key | Action |
|---|---|
| `V` / `B` | Select tool / New-box tool |
| Click | Select |
| Shift/Ctrl+Click | Toggle box in selection |
| Drag empty space | Rubber-band select |
| Shift/Ctrl+Drag (anywhere) | Rubber-band add to selection, never moves boxes |
| `Ctrl+A` | Select all (visible) on current image |
| `Del` | Delete selection |
| `Ctrl+D` | Duplicate selection |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| Arrow keys / `Shift`+arrow | Nudge 1px / 10px |
| Scroll | Zoom (around cursor) |
| Space+drag, middle/right-drag | Pan |
| `F` | Fit image to window |
| `O` | Toggle overlap shading |
| `L` | Toggle label-color tint / stripes |
| `?` / `F1` | Open / close the help dialog |
| Click same spot repeatedly | Cycle through stacked boxes |
| `Ctrl+S` | Save zip |

## Troubleshooting

If loading ever seems to hang, open DevTools (F12) → Console before
retrying — every stage of loading (zip opened, labels parsed, each
image decoded) is logged there, and any error is now surfaced as a
visible toast (plus the loading spinner is force-dismissed) instead
of failing silently.

## Files

```
index.html            page shell
style.css             styling
app.js                application logic
table-cells.js        table-cell detection (onnxruntime-web pipeline, reading order, tiling/merge)
vendor/jszip.min.js   bundled ZIP library (MIT licensed, JSZip project)
vendor/ort/           onnxruntime-web (MIT): ort.wasm.min.js + embedded WASM runtime
tools/build-ort-embed.js   regenerates vendor/ort/ort-wasm-embedded.js
```
