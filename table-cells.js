/* ===================================================================
   Table-cell detection with onnxruntime-web  (client-side, file://-safe)

   JS port of the Label Studio ML backend pipeline:
     [optional] PP-DocLayout_plus-L  -> table / image regions
                 -> IOS-NMS -> GraphBasedOrdering (reading order)
     RT-DETR-L wired / wireless table-cell detector
                 -> SAHI-style sliced inference + NMM merge, per region

   Public API (window.TableCells):
     DEFAULT_MODELS
     listModels()                       -> {wired, wireless, layout} each {name,size,savedAt}|null
     storeModelFile(kind, file)         -> Promise
     downloadModel(kind, url, onProg, isCancelled) -> Promise
     removeModel(kind)                  -> Promise
     imageSourceFromUrl(url)            -> Promise<ImageSource>
     detectTableCells(src, opts)        -> Promise<[{score, bbox:[x1,y1,x2,y2]}]>
     GraphBasedOrdering, _internals     (for tests)
   =================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.TableCells = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function (root) {
"use strict";

/* ----------------------------------------------------------------- *
 *  Defaults
 *  NOTE: the file name inside the HF repos is assumed to be
 *  "inference.onnx"; the URL fields in the UI are editable.
 * ----------------------------------------------------------------- */
var HF = "https://huggingface.co/PaddlePaddle/";
var DEFAULT_MODELS = {
  wired: {
    label: "Wired cells (RT-DETR-L)",
    url: HF + "RT-DETR-L_wired_table_cell_det_onnx/resolve/main/inference.onnx",
    inputSize: 640
  },
  wireless: {
    label: "Wireless cells (RT-DETR-L)",
    url: HF + "RT-DETR-L_wireless_table_cell_det_onnx/resolve/main/inference.onnx",
    inputSize: 640
  },
  layout: {
    label: "Layout (PP-DocLayout_plus-L, optional)",
    url: HF + "PP-DocLayout_plus-L_onnx/resolve/main/inference.onnx",
    inputSize: 800
  }
};

// PP-DocLayout_plus-L class list (index = class id emitted by the model)
var LAYOUT_LABELS = [
  "paragraph_title", "image", "text", "number", "abstract", "content",
  "figure_title", "formula", "table", "reference", "doc_title", "footnote",
  "header", "algorithm", "footer", "seal", "chart", "formula_number",
  "aside_text", "reference_content"
];
var LAYOUT_KEEP = { table: 1, image: 1, figure: 1 };

/* ----------------------------------------------------------------- *
 *  Reading order (port of GraphBasedOrdering)
 *  boxes: [[x_min, y_min, x_max, y_max], ...]  ->  indices in reading order
 * ----------------------------------------------------------------- */
function GraphBasedOrdering(textDirection) {
  this.textDirection = textDirection || "lr";
}
GraphBasedOrdering.prototype._features = function (b) {
  return { ax: b[0], ay: b[1], ymin: b[1], ymax: b[3], h: b[3] - b[1] };
};
GraphBasedOrdering.prototype._shouldPrecede = function (u, v) {
  var overlap = Math.min(u.ymax, v.ymax) - Math.max(u.ymin, v.ymin);
  var refH = Math.min(u.h, v.h); // minimum (not average) height as the reference for "same row"
  if (overlap > 0.5 * refH) {
    return this.textDirection === "lr" ? u.ax < v.ax : u.ax > v.ax;
  }
  return u.ay < v.ay;
};
GraphBasedOrdering.prototype.order = function (boxes) {
  var n = boxes.length;
  if (!n) return [];
  var self = this, f = boxes.map(function (b) { return self._features(b); });
  var graph = new Array(n), inDeg = new Int32Array(n), i, j;
  for (i = 0; i < n; i++) graph[i] = [];
  for (i = 0; i < n; i++) {
    for (j = i + 1; j < n; j++) {
      if (this._shouldPrecede(f[i], f[j])) { graph[i].push(j); inDeg[j]++; }
      else { graph[j].push(i); inDeg[i]++; }
    }
  }
  var queue = [], head = 0, done = new Uint8Array(n), result = [];
  for (i = 0; i < n; i++) if (inDeg[i] === 0) queue.push(i);
  var lr = this.textDirection === "lr";
  while (head < queue.length || result.length < n) {
    var node;
    if (head < queue.length) {
      node = queue[head++];
      if (done[node]) continue;
    } else {
      // cycle break: pick the remaining node with the fewest unemitted predecessors
      // (violates the fewest constraints), ties broken by (y, x)
      node = -1;
      var bestD = Infinity, bestY = Infinity, bestX = Infinity;
      for (i = 0; i < n; i++) {
        if (done[i]) continue;
        var d = inDeg[i], y = f[i].ay, x = lr ? f[i].ax : -f[i].ax;
        if (d < bestD || (d === bestD && (y < bestY || (y === bestY && x < bestX)))) {
          bestD = d; bestY = y; bestX = x; node = i;
        }
      }
    }
    done[node] = 1;
    result.push(node);
    var nb = graph[node];
    for (var k = 0; k < nb.length; k++) {
      var m = nb[k];
      if (--inDeg[m] === 0) queue.push(m);
    }
  }
  return result;
};

/* ----------------------------------------------------------------- *
 *  Geometry helpers: IOS-NMS (layout) and SAHI-style slicing + NMM
 * ----------------------------------------------------------------- */
function ios(a, b) { // intersection over smaller area
  var iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  var ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (iw <= 0 || ih <= 0) return 0;
  var aa = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  var ab = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  var small = Math.min(aa, ab);
  return small > 0 ? (iw * ih) / small : 0;
}

// items: [{score, box:[x1,y1,x2,y2], ...}] ; keeps highest score, drops overlaps with IOS > thr
function iosNms(items, thr) {
  var order = items.map(function (_, i) { return i; })
    .sort(function (a, b) { return items[b].score - items[a].score; });
  var keep = [];
  while (order.length) {
    var cur = order.shift();
    keep.push(cur);
    order = order.filter(function (o) { return ios(items[cur].box, items[o].box) <= thr; });
  }
  keep.sort(function (a, b) { return a - b; });
  return keep.map(function (i) { return items[i]; });
}

// SAHI greedy NMM with IOS metric: boxes overlapping the best one are merged (union) into it.
function nmm(preds, thr) {
  var order = preds.map(function (_, i) { return i; })
    .sort(function (a, b) { return preds[b].score - preds[a].score; });
  var out = [];
  while (order.length) {
    var cur = order.shift();
    var merged = { score: preds[cur].score, box: preds[cur].box.slice() };
    var rest = [], matches = [];
    for (var k = 0; k < order.length; k++) {
      if (ios(preds[cur].box, preds[order[k]].box) >= thr) matches.push(order[k]);
      else rest.push(order[k]);
    }
    order = rest;
    for (var m = 0; m < matches.length; m++) {
      var p = preds[matches[m]];
      if (ios(p.box, merged.box) >= thr) {
        merged.box = [
          Math.min(p.box[0], merged.box[0]), Math.min(p.box[1], merged.box[1]),
          Math.max(p.box[2], merged.box[2]), Math.max(p.box[3], merged.box[3])
        ];
        merged.score = Math.max(p.score, merged.score);
      }
    }
    out.push(merged);
  }
  return out;
}

// port of sahi.slicing.get_slice_bboxes (auto_slice_resolution off)
function sliceBoxes(imgH, imgW, sliceH, sliceW, ovH, ovW) {
  var boxes = [];
  var yOv = Math.floor(ovH * sliceH), xOv = Math.floor(ovW * sliceW);
  var yMin = 0, yMax = 0;
  while (yMax < imgH) {
    var xMin = 0, xMax = 0;
    yMax = yMin + sliceH;
    while (xMax < imgW) {
      xMax = xMin + sliceW;
      if (yMax > imgH || xMax > imgW) {
        var xm = Math.min(imgW, xMax), ym = Math.min(imgH, yMax);
        boxes.push([Math.max(0, xm - sliceW), Math.max(0, ym - sliceH), xm, ym]);
      } else {
        boxes.push([xMin, yMin, xMax, yMax]);
      }
      xMin = xMax - xOv;
    }
    yMin = yMax - yOv;
  }
  return boxes;
}

/* ----------------------------------------------------------------- *
 *  Model storage (IndexedDB, separate DB from the project autosave)
 *  Models are ~100+ MB, so they are stored once and re-used.
 * ----------------------------------------------------------------- */
var MODEL_DB = "yolo_obb_editor_models", dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    if (!root.indexedDB) { reject(new Error("IndexedDB is not available")); return; }
    var req = root.indexedDB.open(MODEL_DB, 1);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains("info")) db.createObjectStore("info", { keyPath: "key" });
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data", { keyPath: "key" });
    };
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror = function (e) { dbPromise = null; reject(e.target.error || new Error("IndexedDB open failed")); };
  });
  return dbPromise;
}
function txDone(tx) {
  return new Promise(function (res, rej) { tx.oncomplete = res; tx.onerror = tx.onabort = function () { rej(tx.error); }; });
}
function reqP(req) {
  return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; });
}

var sessions = {}; // kind -> {session, savedAt}

function listModels() {
  return openDb().then(function (db) {
    var tx = db.transaction("info", "readonly");
    var st = tx.objectStore("info");
    return Promise.all(["wired", "wireless", "layout"].map(function (k) { return reqP(st.get(k)); }));
  }).then(function (r) {
    return { wired: r[0] || null, wireless: r[1] || null, layout: r[2] || null };
  }).catch(function () { return { wired: null, wireless: null, layout: null }; });
}

async function putModel(kind, name, buffer) {
  var db = await openDb();
  var tx = db.transaction(["info", "data"], "readwrite");
  var savedAt = Date.now();
  tx.objectStore("data").put({ key: kind, buffer: buffer });
  tx.objectStore("info").put({ key: kind, name: name, size: buffer.byteLength, savedAt: savedAt });
  await txDone(tx);
  delete sessions[kind];
}

async function storeModelFile(kind, file) {
  var buf = await file.arrayBuffer();
  await putModel(kind, file.name, buf);
}

async function removeModel(kind) {
  var db = await openDb();
  var tx = db.transaction(["info", "data"], "readwrite");
  tx.objectStore("data").delete(kind);
  tx.objectStore("info").delete(kind);
  await txDone(tx);
  delete sessions[kind];
}

async function downloadModel(kind, url, onProgress, isCancelled) {
  var resp;
  try { resp = await fetch(url, { mode: "cors" }); }
  catch (e) { throw new Error("Could not download the model (" + e.message + "). Check the URL / network, or load the .onnx file manually."); }
  if (!resp.ok) throw new Error("Model download failed: HTTP " + resp.status + " for " + url);
  var total = parseInt(resp.headers.get("content-length") || "0", 10);
  var chunks = [], got = 0;
  if (resp.body && resp.body.getReader) {
    var reader = resp.body.getReader();
    for (;;) {
      if (isCancelled && isCancelled()) { try { reader.cancel(); } catch (e) {} throw new Error("Cancelled"); }
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value); got += r.value.length;
      if (onProgress) onProgress(got, total);
    }
  } else {
    var ab = await resp.arrayBuffer(); chunks.push(new Uint8Array(ab)); got = ab.byteLength;
  }
  var buf = new Uint8Array(got), off = 0;
  chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
  var name = decodeURIComponent((url.split("?")[0].split("/").slice(-4).join("/")) || "model.onnx");
  await putModel(kind, name, buf.buffer);
}

/* ----------------------------------------------------------------- *
 *  onnxruntime-web loading
 *  Classic <script> tags only (works from file://). The wasm glue is an
 *  ES module, so it is passed to ORT as a blob: URL, and the wasm bytes
 *  are passed directly (env.wasm.wasmBinary) instead of being fetch()ed.
 * ----------------------------------------------------------------- */
var ortLib = null, ortPromise = null, ortOverride = null;

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("Failed to load " + src)); };
    document.head.appendChild(s);
  });
}
function b64ToBytes(b64) {
  var bin = atob(b64), n = bin.length, out = new Uint8Array(n), CH = 1 << 20;
  for (var i = 0; i < n; i += CH) {
    var end = Math.min(n, i + CH);
    for (var j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}
function ensureOrt(onStatus) {
  if (ortOverride) return Promise.resolve(ortOverride);
  if (ortLib) return Promise.resolve(ortLib);
  if (ortPromise) return ortPromise;
  ortPromise = (async function () {
    var base = "vendor/ort/";
    if (onStatus) onStatus("Loading onnxruntime-web\u2026");
    if (!root.ort) await loadScript(base + "ort.wasm.min.js");
    if (!root.__ORT_EMBED) await loadScript(base + "ort-wasm-embedded.js");
    var E = root.__ORT_EMBED, ort = root.ort;
    if (!ort || !E) throw new Error("onnxruntime-web files are missing from vendor/ort/");
    ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([E.mjs], { type: "text/javascript" })) };
    ort.env.wasm.wasmBinary = b64ToBytes(E.wasmB64);
    E.wasmB64 = null; // free the base64 copy
    // single-threaded: multi-threading needs cross-origin isolation, which file:// pages don't have
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ortLib = ort;
    return ort;
  })().catch(function (e) { ortPromise = null; throw e; });
  return ortPromise;
}

async function getSession(kind, onStatus) {
  var ort = await ensureOrt(onStatus);
  if (sessions[kind] && sessions[kind].savedAt === 0) return sessions[kind].session; // injected (tests)
  var db = await openDb();
  var info = await reqP(db.transaction("info", "readonly").objectStore("info").get(kind));
  if (!info) throw new Error("No ONNX model loaded for \u201c" + kind + "\u201d.");
  var cached = sessions[kind];
  if (cached && cached.savedAt === info.savedAt) return cached.session;
  if (onStatus) onStatus("Initializing " + kind + " model\u2026");
  var rec = await reqP(db.transaction("data", "readonly").objectStore("data").get(kind));
  var session = await ort.InferenceSession.create(new Uint8Array(rec.buffer), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  });
  sessions[kind] = { session: session, savedAt: info.savedAt };
  return session;
}

/* ----------------------------------------------------------------- *
 *  Image sources
 *  ImageSource = { width, height, getTile(sx,sy,sw,sh,outW,outH) -> RGBA Uint8ClampedArray }
 * ----------------------------------------------------------------- */
async function imageSourceFromUrl(url) {
  var img = await new Promise(function (res, rej) {
    var im = new Image();
    im.onload = function () { res(im); };
    im.onerror = function () { rej(new Error("Could not decode image")); };
    im.src = url;
  });
  var W = img.naturalWidth, H = img.naturalHeight;
  var cv = document.createElement("canvas"), ctx = null, cw = 0, ch = 0;
  return {
    width: W, height: H,
    getTile: function (sx, sy, sw, sh, outW, outH) {
      if (cw !== outW || ch !== outH || !ctx) {
        cv.width = cw = outW; cv.height = ch = outH;
        ctx = cv.getContext("2d", { willReadFrequently: true });
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#fff"; // flatten transparency onto white
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      return ctx.getImageData(0, 0, outW, outH).data;
    }
  };
}

/* ----------------------------------------------------------------- *
 *  Single-tile inference
 *  Paddle RT-DETR-style ONNX: inputs im_shape[1,2], image[1,3,S,S], scale_factor[1,2];
 *  output [N,6] = class, score, x1, y1, x2, y2 in ORIGINAL tile pixel coordinates.
 *  Input roles are matched by name so input order doesn't matter.
 * ----------------------------------------------------------------- */
function pickInputRole(name) {
  var n = name.toLowerCase();
  if (n.indexOf("scale") >= 0) return "scale";
  if (n.indexOf("shape") >= 0) return "shape";
  if (n.indexOf("image") >= 0 || n === "x" || n.indexOf("input") >= 0) return "image";
  return null;
}

async function runTile(session, ort, src, tile, size, scoreThr, debug) {
  var sx = tile[0], sy = tile[1], sw = tile[2] - tile[0], sh = tile[3] - tile[1];
  var rgba = src.getTile(sx, sy, sw, sh, size, size);
  var plane = size * size, data = new Float32Array(3 * plane);
  // RGB, scale 1/255, mean 0 / std 1 (as in the PaddleX RT-DETR configs)
  for (var p = 0, q = 0; p < plane; p++, q += 4) {
    data[p] = rgba[q] / 255;
    data[plane + p] = rgba[q + 1] / 255;
    data[2 * plane + p] = rgba[q + 2] / 255;
  }
  var feeds = {};
  session.inputNames.forEach(function (name) {
    var role = pickInputRole(name);
    if (role === "image") feeds[name] = new ort.Tensor("float32", data, [1, 3, size, size]);
    else if (role === "shape") feeds[name] = new ort.Tensor("float32", Float32Array.from([size, size]), [1, 2]);
    else if (role === "scale") feeds[name] = new ort.Tensor("float32", Float32Array.from([size / sh, size / sw]), [1, 2]);
    else throw new Error("Unrecognised model input \u201c" + name + "\u201d (expected image / im_shape / scale_factor).");
  });
  var outs = await session.run(feeds);

  var t = null;
  for (var i = 0; i < session.outputNames.length; i++) {
    var cand = outs[session.outputNames[i]];
    if (cand && cand.dims.length >= 2 && cand.dims[cand.dims.length - 1] === 6) { t = cand; break; }
  }
  if (!t) throw new Error("Unexpected model output (no [N,6] detection tensor found).");
  var d = t.data, n = Math.floor(d.length / 6), res = [], maxC = 0;
  if (debug) console.log("[table-cells] raw output dims", t.dims, "first row", Array.prototype.slice.call(d, 0, 6));
  for (var r = 0; r < n; r++) {
    var o = r * 6, cls = d[o], score = d[o + 1];
    if (cls < 0 || !(score >= scoreThr)) continue;
    var b = [d[o + 2], d[o + 3], d[o + 4], d[o + 5]];
    maxC = Math.max(maxC, b[0], b[1], b[2], b[3]);
    res.push({ cls: Math.round(cls), score: score, box: b });
  }
  // defensive: some exports emit normalized (0..1) boxes
  if (res.length && maxC <= 2 && (sw > 4 || sh > 4)) {
    res.forEach(function (e) { e.box = [e.box[0] * sw, e.box[1] * sh, e.box[2] * sw, e.box[3] * sh]; });
  }
  return res;
}

function yieldUi() { return new Promise(function (r) { setTimeout(r, 0); }); }

/* ----------------------------------------------------------------- *
 *  Full pipeline
 *  opts: { wired:true, cellThreshold:.3, layoutThreshold:.3, useLayout:false,
 *          onProgress(text), isCancelled(), debug }
 * ----------------------------------------------------------------- */
async function detectTableCells(src, opts) {
  opts = opts || {};
  var wired = opts.wired !== false;
  var cellThr = opts.cellThreshold != null ? opts.cellThreshold : 0.3;
  var layoutThr = opts.layoutThreshold != null ? opts.layoutThreshold : 0.3;
  var progress = opts.onProgress || function () {};
  var cancelled = opts.isCancelled || function () { return false; };
  function checkCancel() { if (cancelled()) throw new Error("Cancelled"); }

  var ort = await ensureOrt(progress);
  var W = src.width, H = src.height;
  var orderer = new GraphBasedOrdering("lr");

  // ---- 1. regions -------------------------------------------------
  var regions = [[0, 0, W, H]];
  if (opts.useLayout) {
    var lsess = await getSession("layout", progress);
    progress("Detecting layout\u2026");
    await yieldUi();
    var rows = await runTile(lsess, ort, src, [0, 0, W, H], DEFAULT_MODELS.layout.inputSize, layoutThr, opts.debug);
    var cand = rows.filter(function (r) { return LAYOUT_KEEP[LAYOUT_LABELS[r.cls]]; });
    cand = iosNms(cand, 0.5);
    var ord = orderer.order(cand.map(function (c) { return c.box; }));
    regions = ord.map(function (i) { return cand[i].box; });
    if (!regions.length) return [];
  }

  // ---- 2. cell detection per region (sliced) ---------------------
  var csess = await getSession(wired ? "wired" : "wireless", progress);
  var size = DEFAULT_MODELS.wired.inputSize;
  var maxSliceH = Math.max(1920, Math.floor(H / 6));
  var maxSliceW = Math.max(1920, Math.floor(W / 6));
  var all = [];

  for (var ri = 0; ri < regions.length; ri++) {
    var rg = regions[ri];
    var cx1 = Math.max(0, Math.floor(rg[0])), cy1 = Math.max(0, Math.floor(rg[1]));
    var cx2 = Math.min(W, Math.ceil(rg[2])), cy2 = Math.min(H, Math.ceil(rg[3]));
    if (cx2 <= cx1 || cy2 <= cy1) continue;
    var cw = cx2 - cx1, chh = cy2 - cy1;

    var tiles = sliceBoxes(chh, cw, Math.min(maxSliceH, chh), Math.min(maxSliceW, cw), 0.2, 0.2);
    if (tiles.length > 1) tiles.push([0, 0, cw, chh]); // SAHI also predicts on the full crop
    var preds = [];
    for (var ti = 0; ti < tiles.length; ti++) {
      checkCancel();
      progress("Detecting cells\u2026 region " + (ri + 1) + "/" + regions.length + ", tile " + (ti + 1) + "/" + tiles.length);
      await yieldUi();
      var t = tiles[ti];
      var rows2 = await runTile(csess, ort, src, [t[0] + cx1, t[1] + cy1, t[2] + cx1, t[3] + cy1], size, cellThr, opts.debug);
      for (var k = 0; k < rows2.length; k++) {
        var b = rows2[k].box;
        preds.push({ score: rows2[k].score, box: [b[0] + t[0], b[1] + t[1], b[2] + t[0], b[3] + t[1]] });
      }
    }
    var merged = tiles.length > 1 ? nmm(preds, 0.5) : preds;

    var cells = [];
    merged.forEach(function (m) {
      var x1 = Math.max(0, Math.min(W, m.box[0] + cx1)), y1 = Math.max(0, Math.min(H, m.box[1] + cy1));
      var x2 = Math.max(0, Math.min(W, m.box[2] + cx1)), y2 = Math.max(0, Math.min(H, m.box[3] + cy1));
      if (x2 > x1 && y2 > y1) cells.push({ score: m.score, bbox: [x1, y1, x2, y2] });
    });
    var co = orderer.order(cells.map(function (c) { return c.bbox; }));
    co.forEach(function (i) { all.push(cells[i]); });
  }
  return all;
}

return {
  DEFAULT_MODELS: DEFAULT_MODELS,
  listModels: listModels,
  storeModelFile: storeModelFile,
  downloadModel: downloadModel,
  removeModel: removeModel,
  imageSourceFromUrl: imageSourceFromUrl,
  detectTableCells: detectTableCells,
  GraphBasedOrdering: GraphBasedOrdering,
  _internals: {
    ios: ios, iosNms: iosNms, nmm: nmm, sliceBoxes: sliceBoxes, runTile: runTile,
    setOrt: function (o) { ortOverride = o; },
    setSession: function (kind, s) { sessions[kind] = { session: s, savedAt: 0 }; },
    LAYOUT_LABELS: LAYOUT_LABELS
  }
};
});
