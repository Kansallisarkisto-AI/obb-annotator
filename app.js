/* ===================================================================
   YOLO-OBB Annotation Editor
   Pure client-side (file://-safe, no ES modules, no server).
   =================================================================== */
(function () {
"use strict";

/* ----------------------------------------------------------------- *
 *  Small utilities
 * ----------------------------------------------------------------- */
function $(sel) { return document.querySelector(sel); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function uid() { return (uid._n = (uid._n || 0) + 1); }

function classColor(index) {
  var hue = (index * 137.508) % 360; // golden-angle spacing
  return "hsl(" + hue.toFixed(1) + " 78% 58%)";
}

function fmt(n) { return (Math.round(n * 1e6) / 1e6).toString(); }

function toast(msg, kind) {
  var host = $("#toastHost");
  var t = el("div", "toast" + (kind ? " " + kind : ""), msg);
  host.appendChild(t);
  setTimeout(function () {
    t.style.opacity = "0";
    t.style.transition = "opacity .25s";
    setTimeout(function () { t.remove(); }, 260);
  }, 2600);
}

function showLoading(text, sub) {
  $("#loadingOverlay").hidden = false;
  $("#loadingText").textContent = text || "Loading\u2026";
  $("#loadingSub").textContent = sub || "";
}
function updateLoading(text, sub) {
  if (text !== undefined) $("#loadingText").textContent = text;
  if (sub !== undefined) $("#loadingSub").textContent = sub;
}
function hideLoading() { $("#loadingOverlay").hidden = true; }

window.addEventListener("error", function (e) {
  console.error("[yolo-obb-editor] uncaught error:", e.error || e.message);
  hideLoading();
  toast("Unexpected error: " + (e.message || (e.error && e.error.message) || "see console (F12) for details"), "err");
});
window.addEventListener("unhandledrejection", function (e) {
  console.error("[yolo-obb-editor] unhandled promise rejection:", e.reason);
  hideLoading();
  var msg = (e.reason && (e.reason.message || e.reason)) || "see console (F12) for details";
  toast("Unexpected error: " + msg, "err");
});

/* ----------------------------------------------------------------- *
 *  Global state
 * ----------------------------------------------------------------- */
var state = {
  projectName: "annotations",
  classes: [],          // [{cid, name}]  (cid = permanent id, position = export index)
  classVisible: {},     // cid -> bool
  images: [],           // [{name, path, width, height, blob, url, boxes:[Box], nextBoxId}]
  currentImageIndex: -1,

  selection: new Set(), // set of box.id for the CURRENT image only
  tool: "select",       // 'select' | 'draw'
  view: { panX: 0, panY: 0, zoom: 1 },

  history: [],
  future: [],

  loaded: false,
  dirty: false
};

// Box = { id, pts: Float64Array(8) normalized [x1,y1,x2,y2,x3,y3,x4,y4], labels: number[] (cids), bbox: [minX,minY,maxX,maxY] normalized }

function classPos(cid) {
  for (var i = 0; i < state.classes.length; i++) if (state.classes[i].cid === cid) return i;
  return -1;
}
function classByCid(cid) {
  for (var i = 0; i < state.classes.length; i++) if (state.classes[i].cid === cid) return state.classes[i];
  return null;
}
function currentImage() {
  return state.currentImageIndex >= 0 ? state.images[state.currentImageIndex] : null;
}

function recomputeBBox(box) {
  var p = box.pts, minX = p[0], maxX = p[0], minY = p[1], maxY = p[1];
  for (var i = 2; i < 8; i += 2) {
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
  }
  box.bbox = [minX, minY, maxX, maxY];
}

/* ----------------------------------------------------------------- *
 *  DOM refs (populated on DOMContentLoaded)
 * ----------------------------------------------------------------- */
var dom = {};

/* ----------------------------------------------------------------- *
 *  ZIP LOADING
 * ----------------------------------------------------------------- */
function pickBaseName(path) {
  var parts = path.split("/");
  return parts[parts.length - 1];
}

function guessMime(name) {
  var n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".bmp")) return "image/bmp";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function roundCoord(x) {
  // collapse floating-point serialization noise while staying far below any
  // meaningful precision loss (1e-7 normalized ~ 0.001px on a 10000px image)
  return Math.round(x * 1e7) / 1e7;
}

function canonicalPolyKey(coordsArr) {
  // Returns a key that is identical for the same quadrilateral regardless of
  // which vertex it starts at or which winding direction it was written in.
  // This matters because duplicate coordinate lines for a multi-labeled box
  // are only guaranteed to describe the same geometry -- some exporters
  // (including patched ones) may re-emit the vertex list starting at a
  // different corner or in the opposite winding order for each label copy,
  // which would otherwise make each copy look like a distinct box.
  var pts = [];
  for (var i = 0; i < 8; i += 2) pts.push(roundCoord(coordsArr[i]) + "," + roundCoord(coordsArr[i + 1]));
  var best = null;
  for (var reflect = 0; reflect < 2; reflect++) {
    var base = reflect ? pts.slice().reverse() : pts;
    for (var rot = 0; rot < 4; rot++) {
      var s = base.slice(rot).concat(base.slice(0, rot)).join("|");
      if (best === null || s < best) best = s;
    }
  }
  return best;
}

function parseLabelText(text) {
  // returns { boxes: [Box] (without id assigned yet), nonExactMerges: number }
  var lines = text.split(/\r\n|\n|\r/);
  var groups = new Map(); // canonicalKey -> {pts, labels:[], firstRaw}
  var nonExactMerges = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var toks = line.split(/\s+/);
    if (toks.length < 9) continue;
    var cls = parseInt(toks[0], 10);
    if (!isFinite(cls)) continue;
    var coordsArr = new Array(8);
    for (var k = 0; k < 8; k++) coordsArr[k] = parseFloat(toks[k + 1]);
    var rawKey = toks.slice(1, 9).join(",");
    var key = canonicalPolyKey(coordsArr);
    var g = groups.get(key);
    if (!g) {
      g = { pts: new Float64Array(coordsArr), labels: [], firstRaw: rawKey };
      groups.set(key, g);
    } else if (rawKey !== g.firstRaw) {
      nonExactMerges++;
    }
    g.labels.push(cls);
  }
  var boxes = [];
  groups.forEach(function (g) {
    boxes.push({ pts: g.pts, labels: g.labels });
  });
  return { boxes: boxes, nonExactMerges: nonExactMerges };
}

async function loadZipFile(file) {
  console.log("[yolo-obb-editor] loadZipFile start:", file.name, file.size, "bytes");
  showLoading("Reading zip\u2026", file.name);
  try {
    var zip = await JSZip.loadAsync(file);
    console.log("[yolo-obb-editor] zip opened, entry count:", Object.keys(zip.files).length);
    var files = zip.files;
    var classesEntry = null, notesEntry = null;
    var labelEntries = [];  // {path, name, entry}
    var imageEntries = [];  // {path, name, entry}

    Object.keys(files).forEach(function (path) {
      var f = files[path];
      if (f.dir) return;
      var base = pickBaseName(path);
      if (base === "classes.txt") classesEntry = f;
      else if (base === "notes.json") notesEntry = f;
      else if (/\/labels\//.test("/" + path) && base.toLowerCase().endsWith(".txt")) {
        labelEntries.push({ path: path, name: base.replace(/\.txt$/i, ""), entry: f });
      } else if (/\/images\//.test("/" + path) && /\.(jpe?g|png|bmp|webp|gif)$/i.test(base)) {
        imageEntries.push({ path: path, name: base, entry: f });
      }
    });

    if (!imageEntries.length) throw new Error("No files found under images/ in the zip.");
    console.log("[yolo-obb-editor] found", imageEntries.length, "image(s),", labelEntries.length, "label file(s), classes.txt:", !!classesEntry);

    // project name = top folder of classes.txt or first image
    var refPath = classesEntry ? classesEntry.name : imageEntries[0].path;
    var topFolder = refPath.split("/")[0];
    state.projectName = topFolder || "annotations";

    // classes.txt
    var classNames = [];
    if (classesEntry) {
      var txt = await classesEntry.async("string");
      classNames = txt.split(/\r\n|\n|\r/).filter(function (l, idx, arr) {
        return !(l === "" && idx === arr.length - 1);
      });
    }

    // labels map by base name (without extension)
    var labelByStem = {};
    labelEntries.forEach(function (le) { labelByStem[le.name] = le; });

    updateLoading("Parsing labels\u2026");
    var images = [];
    var maxClassSeen = classNames.length - 1;
    var totalNonExactMerges = 0;

    for (var i = 0; i < imageEntries.length; i++) {
      var ie = imageEntries[i];
      var stem = ie.name.replace(/\.[^.]+$/, "");
      var boxesRaw = [];
      var le = labelByStem[stem];
      if (le) {
        var ltxt = await le.entry.async("string");
        var parsed = parseLabelText(ltxt);
        boxesRaw = parsed.boxes;
        totalNonExactMerges += parsed.nonExactMerges;
      }
      images.push({
        name: ie.name,
        path: ie.path,
        width: 0, height: 0,
        blob: null, url: null,
        boxesRaw: boxesRaw,
        boxes: null,
        nextBoxId: 1,
        _entry: ie.entry
      });
      boxesRaw.forEach(function (b) {
        b.labels.forEach(function (c) { if (c > maxClassSeen) maxClassSeen = c; });
      });
    }
    if (totalNonExactMerges > 0) {
      console.warn("[yolo-obb-editor] " + totalNonExactMerges + " multi-label line(s) shared a box only after rounding/reordering, not as exact text -- saving will normalize these.");
    }

    // ensure classes array covers every seen id
    for (var c = classNames.length; c <= maxClassSeen; c++) classNames.push("class_" + c);
    if (classNames.length === 0) classNames.push("object");
    console.log("[yolo-obb-editor] labels parsed for all images, class count:", classNames.length);

    // load image blobs + dimensions (need dims to convert normalized coords)
    updateLoading("Decoding images\u2026", "0 / " + images.length);
    var CONC = 4;
    var idx = 0;
    var IMG_DECODE_TIMEOUT_MS = 20000;
    async function decodeOneImage(im) {
      var blob = await im._entry.async("blob");
      var typedBlob = blob.slice(0, blob.size, guessMime(im.name));
      im.blob = typedBlob;
      im.url = URL.createObjectURL(typedBlob);
      var dims = await new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          console.warn("[yolo-obb-editor] Timed out waiting for browser to decode image dimensions:", im.name, "- falling back to 1000x1000. The image will likely still display, but coordinate scaling may be off until this is investigated.");
          resolve({ w: 1000, h: 1000, failed: true });
        }, IMG_DECODE_TIMEOUT_MS);
        var img = new Image();
        img.onload = function () {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve({ w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 });
        };
        img.onerror = function (e) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          console.warn("[yolo-obb-editor] Browser could not decode image:", im.name, e);
          resolve({ w: 1000, h: 1000, failed: true });
        };
        img.src = im.url;
      });
      im.width = dims.w; im.height = dims.h;
      if (dims.failed) im._decodeFailed = true;
    }
    async function worker() {
      while (idx < images.length) {
        var myIdx = idx++;
        var im = images[myIdx];
        console.log("[yolo-obb-editor] decoding image " + (myIdx + 1) + "/" + images.length + ": " + im.name);
        await decodeOneImage(im);
        updateLoading("Decoding images\u2026", (myIdx + 1) + " / " + images.length + "  (" + im.name + ")");
      }
    }
    var workers = [];
    for (var w = 0; w < CONC; w++) workers.push(worker());
    await Promise.all(workers);
    console.log("[yolo-obb-editor] all images decoded");
    var failedImgs = images.filter(function (im) { return im._decodeFailed; }).map(function (im) { return im.name; });
    if (failedImgs.length) {
      toast("Could not read pixel dimensions for: " + failedImgs.join(", ") + ". Boxes may be misaligned on those images.", "err");
    }

    // Build the class list FIRST, so we have a raw-file-position -> internal cid
    // mapping ready before we touch any box. (Box labels parsed from the .txt files
    // are 0-based POSITIONS in classes.txt, e.g. "7 x1 y1 ..." means "class at
    // position 7" -- they are NOT the same id-space as our internal `cid`s, which
    // are an arbitrary incrementing counter used so class renames/reorders/deletes
    // never require rewriting every box. Every box label must be translated
    // through this table exactly once, right here.)
    state.classes = classNames.map(function (name, i) { return { cid: uid(), name: name, _origIndex: i }; });
    var posToCid = state.classes.map(function (c) { return c.cid; });

    // finalize boxes with ids, translating raw file positions -> internal cids
    images.forEach(function (im) {
      var boxes = [];
      im.boxesRaw.forEach(function (b) {
        var mappedLabels = [];
        b.labels.forEach(function (pos) {
          var cid = posToCid[pos];
          if (cid !== undefined) mappedLabels.push(cid);
          else console.warn("[yolo-obb-editor] label references unknown class position " + pos + " in " + im.name + " -- dropped");
        });
        mappedLabels.sort(function (a, z) { return a - z; }); // cid order == file position order (see posToCid)
        var box = { id: im.nextBoxId++, pts: b.pts, labels: mappedLabels };
        recomputeBBox(box);
        boxes.push(box);
      });
      im.boxes = boxes;
      delete im.boxesRaw;
      delete im._entry;
    });

    // commit to state
    state.classVisible = {};
    state.classes.forEach(function (c) { state.classVisible[c.cid] = true; });
    state.images = images;
    state.currentImageIndex = -1; // switchToImage(0) below (via onProjectLoaded) performs the real init
    state.selection = new Set();
    state.history = []; state.future = [];
    state.loaded = true;
    state.dirty = false;

    hideLoading();
    toast("Loaded " + images.length + " image(s), " + state.classes.length + " classes.", "ok");
    if (totalNonExactMerges > 0) {
      toast(totalNonExactMerges + " multi-label box(es) had reordered/rounded duplicate coordinates \u2014 merged and will be written back out consistently on save.", "ok");
    }
    onProjectLoaded();
  } catch (err) {
    hideLoading();
    console.error(err);
    toast("Failed to load zip: " + err.message, "err");
  }
}

/* ----------------------------------------------------------------- *
 *  ZIP EXPORT
 * ----------------------------------------------------------------- */
async function saveZip() {
  if (!state.loaded) return;
  showLoading("Building zip\u2026");
  try {
    var zip = new JSZip();
    var root = zip.folder(state.projectName || "annotations");
    var imgFolder = root.folder("images");
    var lblFolder = root.folder("labels");

    // classes.txt
    var classesTxt = state.classes.map(function (c) { return c.name; }).join("\n") + "\n";
    root.file("classes.txt", classesTxt);

    // notes.json
    var notes = {
      categories: state.classes.map(function (c, i) { return { id: String(i), name: c.name }; }),
      info: { year: new Date().getFullYear(), version: "1.0", contributor: "YOLO-OBB Editor" }
    };
    root.file("notes.json", JSON.stringify(notes, null, 2));

    for (var i = 0; i < state.images.length; i++) {
      var im = state.images[i];
      updateLoading("Building zip\u2026", "image " + (i + 1) + " / " + state.images.length);
      if (im.blob) imgFolder.file(im.name, im.blob, { compression: "STORE" });
      var lines = [];
      im.boxes.forEach(function (box) {
        if (!box.labels.length) return;
        var coordStr = "";
        for (var k = 0; k < 8; k++) coordStr += " " + fmt(box.pts[k]);
        box.labels.forEach(function (cid) {
          var pos = classPos(cid);
          if (pos < 0) return;
          lines.push(pos + coordStr);
        });
      });
      lblFolder.file(im.name.replace(/\.[^.]+$/, "") + ".txt", lines.join("\n") + (lines.length ? "\n" : ""));
    }

    var blob = await zip.generateAsync({ type: "blob" }, function (meta) {
      updateLoading("Compressing\u2026", meta.percent.toFixed(0) + "%");
    });
    var a = document.createElement("a");
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = (state.projectName || "annotations") + "_edited.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    state.dirty = false;
    hideLoading();
    toast("Saved " + a.download, "ok");
  } catch (err) {
    hideLoading();
    console.error(err);
    toast("Failed to save zip: " + err.message, "err");
  }
}

/* ----------------------------------------------------------------- *
 *  BROWSER LOCAL STORAGE (autosave via IndexedDB)
 *
 *  localStorage itself is capped at a few MB and can't hold binary
 *  image data, so the actual project (including image bytes) is kept
 *  in IndexedDB -- this is what browsers use under the hood for any
 *  "save to this browser" feature that involves files. Two object
 *  stores are used: "images" (rarely-changing blobs, keyed by image
 *  name) and "meta" (everything else -- classes, boxes, project name,
 *  current image -- written frequently but cheaply since it carries
 *  no binary data). Zip import/export remains the portable, primary
 *  save mechanism; this is purely a local crash/reload safety net.
 * ----------------------------------------------------------------- */
var IDB_NAME = "yolo_obb_editor_db";
var IDB_VERSION = 1;
var idbOpenPromise = null;
var AUTOSAVE_ENABLED = !!(typeof window !== "undefined" && window.indexedDB);

function openIDB() {
  if (idbOpenPromise) return idbOpenPromise;
  idbOpenPromise = new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error("IndexedDB is not available in this browser/context")); return; }
    var req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "name" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror = function (e) { reject((e.target && e.target.error) || new Error("IndexedDB open failed")); };
  });
  return idbOpenPromise;
}
function idbPut(storeName, value) {
  return openIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function idbGet(storeName, key) {
  return openIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, "readonly");
      var req = tx.objectStore(storeName).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function idbGetAllKeys(storeName) {
  return openIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, "readonly");
      var req = tx.objectStore(storeName).getAllKeys();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function idbDelete(storeName, key) {
  return openIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function idbClear(storeName) {
  return openIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function setAutosaveStatus(text) {
  if (dom.autosaveStatus) dom.autosaveStatus.textContent = text;
}

var autosaveTimer = null;
var autosavePendingFull = false;
function scheduleAutosave(full) {
  if (!AUTOSAVE_ENABLED || !state.loaded) return;
  autosavePendingFull = autosavePendingFull || !!full;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  setAutosaveStatus("Backup pending\u2026");
  autosaveTimer = setTimeout(function () {
    var doFull = autosavePendingFull;
    autosavePendingFull = false;
    runAutosave(doFull);
  }, 1500);
}

async function runAutosave(full) {
  if (!AUTOSAVE_ENABLED || !state.loaded) return;
  try {
    setAutosaveStatus("Saving to browser\u2026");
    if (full) {
      for (var i = 0; i < state.images.length; i++) {
        var im = state.images[i];
        if (im.blob) await idbPut("images", { name: im.name, blob: im.blob, width: im.width, height: im.height });
      }
      var currentNames = {};
      state.images.forEach(function (imm) { currentNames[imm.name] = true; });
      var storedKeys = await idbGetAllKeys("images");
      for (var s = 0; s < storedKeys.length; s++) {
        if (!currentNames[storedKeys[s]]) await idbDelete("images", storedKeys[s]);
      }
    }
    var perImageBoxes = {}, perImageNextBoxId = {}, imageOrder = [];
    state.images.forEach(function (imm) {
      imageOrder.push(imm.name);
      perImageNextBoxId[imm.name] = imm.nextBoxId;
      perImageBoxes[imm.name] = imm.boxes.map(function (b) {
        return { id: b.id, pts: Array.prototype.slice.call(b.pts), labels: b.labels.slice() };
      });
    });
    await idbPut("meta", {
      key: "current",
      projectName: state.projectName,
      classes: state.classes.map(function (c) { return { cid: c.cid, name: c.name }; }),
      classVisible: state.classVisible,
      uidCounter: uid._n || 0,
      currentImageIndex: state.currentImageIndex,
      imageOrder: imageOrder,
      perImageBoxes: perImageBoxes,
      perImageNextBoxId: perImageNextBoxId,
      savedAt: Date.now()
    });
    setAutosaveStatus("Backed up " + new Date().toLocaleTimeString());
  } catch (err) {
    console.warn("[yolo-obb-editor] autosave failed:", err);
    var quota = err && (err.name === "QuotaExceededError" || /quota/i.test(err.message || ""));
    setAutosaveStatus(quota ? "Browser storage full" : "Backup unavailable");
    if (!quota) AUTOSAVE_ENABLED = false; // don't keep retrying a broken environment forever
  }
}

async function clearAllPersistence() {
  try {
    await idbClear("images");
    await idbClear("meta");
    setAutosaveStatus("");
  } catch (err) {
    console.warn("[yolo-obb-editor] failed to clear browser storage:", err);
  }
}

var pendingRestoreMeta = null;
async function checkForAutosavedProject() {
  if (!AUTOSAVE_ENABLED) return;
  try {
    var meta = await idbGet("meta", "current");
    if (meta && meta.imageOrder) showRestoreBanner(meta);
  } catch (err) {
    console.warn("[yolo-obb-editor] could not check for an autosaved project:", err);
    AUTOSAVE_ENABLED = false;
  }
}

function showRestoreBanner(meta) {
  pendingRestoreMeta = meta;
  var when = meta.savedAt ? new Date(meta.savedAt).toLocaleString() : "an earlier session";
  dom.restoreBannerText.textContent =
    "Found a browser backup of \u201c" + (meta.projectName || "annotations") + "\u201d (" +
    (meta.imageOrder || []).length + " image(s)), saved " + when + ".";
  dom.restoreBanner.hidden = false;
}

async function restoreAutosavedProject() {
  var meta = pendingRestoreMeta;
  if (!meta) return;
  dom.restoreBanner.hidden = true;
  showLoading("Restoring browser backup\u2026");
  try {
    var images = [];
    for (var i = 0; i < meta.imageOrder.length; i++) {
      var name = meta.imageOrder[i];
      var rec = await idbGet("images", name);
      if (!rec) { console.warn("[yolo-obb-editor] missing stored image data for", name, "-- skipped"); continue; }
      var url = URL.createObjectURL(rec.blob);
      var boxesRaw = meta.perImageBoxes[name] || [];
      var boxes = boxesRaw.map(function (b) {
        return { id: b.id, pts: new Float64Array(b.pts), labels: b.labels.slice() };
      });
      boxes.forEach(recomputeBBox);
      images.push({
        name: name, path: name, width: rec.width, height: rec.height,
        blob: rec.blob, url: url, boxes: boxes,
        nextBoxId: (meta.perImageNextBoxId && meta.perImageNextBoxId[name]) || 1
      });
    }
    state.classes = (meta.classes || []).map(function (c) { return { cid: c.cid, name: c.name }; });
    if (!state.classes.length) state.classes = [{ cid: uid(), name: "object" }];
    state.classVisible = meta.classVisible || {};
    state.classes.forEach(function (c) { if (state.classVisible[c.cid] === undefined) state.classVisible[c.cid] = true; });
    uid._n = Math.max(uid._n || 0, meta.uidCounter || 0);
    state.images = images;
    state.projectName = meta.projectName || "annotations";
    state.currentImageIndex = -1;
    state.selection = new Set();
    state.history = []; state.future = [];
    state.loaded = true; state.dirty = false;
    invalidateColorCache();
    hideLoading();
    finishProjectInit();
    if (images.length) switchToImage(clamp(meta.currentImageIndex != null ? meta.currentImageIndex : 0, 0, images.length - 1));
    toast("Restored browser backup.", "ok");
  } catch (err) {
    hideLoading();
    console.error(err);
    toast("Failed to restore browser backup: " + err.message, "err");
  }
}

async function discardAutosavedProject() {
  dom.restoreBanner.hidden = true;
  pendingRestoreMeta = null;
  await clearAllPersistence();
  toast("Cleared browser backup.", "ok");
}


var HISTORY_LIMIT = 150;
function pushHistory(cmd) {
  state.history.push(cmd);
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.future.length = 0;
  syncHistoryButtons();
}
function undo() {
  var cmd = state.history.pop();
  if (!cmd) return;
  cmd.undo();
  state.future.push(cmd);
  syncHistoryButtons();
  afterDataChange();
}
function redo() {
  var cmd = state.future.pop();
  if (!cmd) return;
  cmd.redo();
  state.history.push(cmd);
  syncHistoryButtons();
  afterDataChange();
}
function syncHistoryButtons() {
  dom.btnUndo.disabled = state.history.length === 0;
  dom.btnRedo.disabled = state.future.length === 0;
}
function afterDataChange() {
  state.dirty = true;
  rebuildBoxIndexCache();
  requestRedraw();
  syncSelectionPanels();
  renderClassList();
  renderImageList();
  scheduleAutosave(false);
}

/* ----------------------------------------------------------------- *
 *  VIEWPORT / RENDERING
 * ----------------------------------------------------------------- */
var rafPending = false;
function requestRedraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(function () { rafPending = false; drawOverlay(); });
}

function sizeCanvasToViewport() {
  var canvas = dom.overlayCanvas;
  var rect = dom.viewport.getBoundingClientRect();
  var dpr = window.devicePixelRatio || 1;
  var w = Math.max(1, Math.round(rect.width * dpr));
  var h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  canvas._dpr = dpr;
  canvas._cssW = rect.width; canvas._cssH = rect.height;
}

function applyStageTransform() {
  var v = state.view;
  dom.stage.style.transform = "translate(" + v.panX + "px," + v.panY + "px) scale(" + v.zoom + ")";
  dom.zoomLabel.textContent = Math.round(v.zoom * 100) + "%";
}

function worldToScreen(nx, ny, im) {
  var v = state.view;
  return [v.panX + nx * im.width * v.zoom, v.panY + ny * im.height * v.zoom];
}
function screenToWorldNorm(sx, sy, im) {
  var v = state.view;
  return [(sx - v.panX) / v.zoom / im.width, (sy - v.panY) / v.zoom / im.height];
}

function fitToWindow() {
  var im = currentImage();
  if (!im || !im.width) return;
  var rect = dom.viewport.getBoundingClientRect();
  var margin = 40;
  var zx = (rect.width - margin) / im.width;
  var zy = (rect.height - margin) / im.height;
  var z = Math.min(zx, zy);
  if (!isFinite(z) || z <= 0) z = 1;
  state.view.zoom = z;
  state.view.panX = (rect.width - im.width * z) / 2;
  state.view.panY = (rect.height - im.height * z) / 2;
  applyStageTransform();
  requestRedraw();
}

// interactive state used while dragging (module scoped)
var drag = null; // set during pointer interactions
var rubberRect = null; // {x0,y0,x1,y1} screen coords, while rubber-band selecting
var newBoxPreview = null; // {x0,y0,x1,y1} world-norm, while drawing

function drawOverlay() {
  sizeCanvasToViewport();
  var canvas = dom.overlayCanvas;
  var ctx = canvas.getContext("2d");
  var dpr = canvas._dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas._cssW, canvas._cssH);

  var im = currentImage();
  if (!im) return;

  var v = state.view;
  // visible world-normalized rect (with small margin) for culling
  var vx0 = (-v.panX) / v.zoom / im.width;
  var vy0 = (-v.panY) / v.zoom / im.height;
  var vx1 = (canvas._cssW - v.panX) / v.zoom / im.width;
  var vy1 = (canvas._cssH - v.panY) / v.zoom / im.height;
  var m = 0.02;
  vx0 -= m; vy0 -= m; vx1 += m; vy1 += m;

  var boxes = im.boxes;
  var sel = state.selection;

  // group by color (first visible label's color, or grey if all-hidden-but-shown-anyway)
  var byColor = new Map(); // colorHex -> array of box
  var visibleCount = 0, culledCount = 0, hiddenCount = 0;

  for (var i = 0; i < boxes.length; i++) {
    var box = boxes[i];
    if (!box.labels.length) continue;
    var anyVisible = false;
    for (var li = 0; li < box.labels.length; li++) {
      if (state.classVisible[box.labels[li]] !== false) { anyVisible = true; break; }
    }
    if (!anyVisible) { hiddenCount++; continue; }
    var bb = box.bbox;
    if (bb[2] < vx0 || bb[0] > vx1 || bb[3] < vy0 || bb[1] > vy1) { culledCount++; continue; }
    visibleCount++;
    var primaryCid = box.labels[0];
    var cls = classByCid(primaryCid);
    var color = cls ? classColorCache(primaryCid) : "#888";
    var arr = byColor.get(color);
    if (!arr) { arr = []; byColor.set(color, arr); }
    arr.push(box);
  }

  // draw non-selected boxes, batched by color
  byColor.forEach(function (arr, color) {
    ctx.beginPath();
    for (var i2 = 0; i2 < arr.length; i2++) {
      var b = arr[i2];
      var isSel = sel.has(b.id);
      if (isSel) continue; // drawn in a separate pass on top
      addBoxPath(ctx, b, im, v);
    }
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = color;
    ctx.stroke();
    // subtle fill for multi-label boxes so they read differently at a glance
  });

  // multi-label hatch marker (small corner dot) -- only when reasonably zoomed in, and only for non-selected
  if (v.zoom > 0.35) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    byColor.forEach(function (arr) {
      for (var i3 = 0; i3 < arr.length; i3++) {
        var b = arr[i3];
        if (sel.has(b.id)) continue;
        if (b.labels.length < 2) continue;
        var p0 = worldToScreen(b.pts[0], b.pts[1], im);
        ctx.beginPath();
        ctx.arc(p0[0], p0[1], 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // selected boxes on top, highlighted
  if (sel.size) {
    ctx.beginPath();
    boxes.forEach(function (b) {
      if (!sel.has(b.id)) return;
      addBoxPath(ctx, b, im, v);
    });
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#ffd23f";
    ctx.stroke();
    ctx.fillStyle = "rgba(255,210,63,0.14)";
    ctx.fill();

    // handles only when exactly one selected (avoid clutter / cost for big multi-select)
    if (sel.size === 1) {
      var only = null;
      boxes.forEach(function (b) { if (sel.has(b.id)) only = b; });
      if (only) drawHandles(ctx, only, im, v);
    }
  }

  // rubber band
  if (rubberRect) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#7fd1ff";
    ctx.fillStyle = "rgba(127,209,255,0.10)";
    var rx = Math.min(rubberRect.x0, rubberRect.x1), ry = Math.min(rubberRect.y0, rubberRect.y1);
    var rw = Math.abs(rubberRect.x1 - rubberRect.x0), rh = Math.abs(rubberRect.y1 - rubberRect.y0);
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);
  }

  // new-box preview
  if (newBoxPreview) {
    var p0s = worldToScreen(newBoxPreview.x0, newBoxPreview.y0, im);
    var p1s = worldToScreen(newBoxPreview.x1, newBoxPreview.y1, im);
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = "#48d597";
    ctx.lineWidth = 1.6;
    ctx.strokeRect(Math.min(p0s[0], p1s[0]), Math.min(p0s[1], p1s[1]), Math.abs(p1s[0] - p0s[0]), Math.abs(p1s[1] - p0s[1]));
    ctx.setLineDash([]);
  }

  dom.statusText.textContent =
    boxes.length + " boxes on image \u00b7 " + visibleCount + " shown" +
    (hiddenCount ? " \u00b7 " + hiddenCount + " class-hidden" : "") +
    (sel.size ? " \u00b7 " + sel.size + " selected" : "");
}

var _colorCache = new Map();
function classColorCache(cid) {
  var c = _colorCache.get(cid);
  if (c) return c;
  var pos = classPos(cid);
  c = classColor(pos < 0 ? cid : pos);
  _colorCache.set(cid, c);
  return c;
}
function invalidateColorCache() { _colorCache.clear(); }

function addBoxPath(ctx, box, im, v) {
  var p = box.pts;
  var x0 = v.panX + p[0] * im.width * v.zoom, y0 = v.panY + p[1] * im.height * v.zoom;
  ctx.moveTo(x0, y0);
  for (var k = 2; k < 8; k += 2) {
    ctx.lineTo(v.panX + p[k] * im.width * v.zoom, v.panY + p[k + 1] * im.height * v.zoom);
  }
  ctx.closePath();
}

var HANDLE_R = 5;
function getHandlePositions(box, im, v) {
  var p = box.pts;
  var pts = [];
  for (var k = 0; k < 8; k += 2) {
    pts.push(worldToScreen(p[k], p[k + 1], im));
  }
  var cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  var cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  var midTopX = (pts[0][0] + pts[1][0]) / 2, midTopY = (pts[0][1] + pts[1][1]) / 2;
  var vx = midTopX - cx, vy = midTopY - cy;
  var len = Math.hypot(vx, vy) || 1;
  var rot = [midTopX + (vx / len) * 26, midTopY + (vy / len) * 26];
  return { corners: pts, center: [cx, cy], rotate: rot };
}

function drawHandles(ctx, box, im, v) {
  var h = getHandlePositions(box, im, v);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#ffd23f";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo((h.corners[0][0] + h.corners[1][0]) / 2, (h.corners[0][1] + h.corners[1][1]) / 2);
  ctx.lineTo(h.rotate[0], h.rotate[1]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#1b1d22";
  h.corners.forEach(function (c) {
    ctx.beginPath();
    ctx.rect(c[0] - HANDLE_R, c[1] - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
    ctx.fill(); ctx.stroke();
  });
  ctx.beginPath();
  ctx.arc(h.rotate[0], h.rotate[1], HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle = "#48d597";
  ctx.fill(); ctx.stroke();
}

/* ----------------------------------------------------------------- *
 *  HIT TESTING
 * ----------------------------------------------------------------- */
function pointInPolygonNorm(px, py, pts) {
  var inside = false;
  for (var i = 0, j = 6; i < 8; j = i, i += 2) {
    var xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    var intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findHandleAt(sx, sy, box, im, v) {
  if (!box) return null;
  var h = getHandlePositions(box, im, v);
  var rr = (HANDLE_R + 4);
  for (var i = 0; i < 4; i++) {
    var c = h.corners[i];
    if (Math.abs(sx - c[0]) <= rr && Math.abs(sy - c[1]) <= rr) return { type: "corner", index: i };
  }
  if (Math.hypot(sx - h.rotate[0], sy - h.rotate[1]) <= rr) return { type: "rotate" };
  return null;
}

function findBoxAtScreen(sx, sy) {
  var im = currentImage();
  if (!im) return null;
  var nx = (sx - state.view.panX) / state.view.zoom / im.width;
  var ny = (sy - state.view.panY) / state.view.zoom / im.height;
  var boxes = im.boxes;
  var best = null;
  for (var i = boxes.length - 1; i >= 0; i--) {
    var b = boxes[i];
    if (!b.labels.length) continue;
    var anyVisible = false;
    for (var li = 0; li < b.labels.length; li++) if (state.classVisible[b.labels[li]] !== false) { anyVisible = true; break; }
    if (!anyVisible) continue;
    var bb = b.bbox;
    if (nx < bb[0] || nx > bb[2] || ny < bb[1] || ny > bb[3]) continue;
    if (pointInPolygonNorm(nx, ny, b.pts)) { best = b; break; }
  }
  return best;
}

function boxesInRectScreen(x0, y0, x1, y1) {
  var im = currentImage();
  if (!im) return [];
  var lo = screenToWorldNorm(Math.min(x0, x1), Math.min(y0, y1), im);
  var hi = screenToWorldNorm(Math.max(x0, x1), Math.max(y0, y1), im);
  var out = [];
  im.boxes.forEach(function (b) {
    if (!b.labels.length) return;
    var anyVisible = false;
    for (var li = 0; li < b.labels.length; li++) if (state.classVisible[b.labels[li]] !== false) { anyVisible = true; break; }
    if (!anyVisible) return;
    var bb = b.bbox;
    // select if box bbox intersects the rect (fast, intuitive for rubber-band)
    if (bb[2] < lo[0] || bb[0] > hi[0] || bb[3] < lo[1] || bb[1] > hi[1]) return;
    out.push(b);
  });
  return out;
}

function rebuildBoxIndexCache() {
  var im = currentImage();
  if (!im) return;
  im.boxes.forEach(recomputeBBox);
}

/* ----------------------------------------------------------------- *
 *  POINTER INTERACTION
 * ----------------------------------------------------------------- */
var spaceHeld = false;

function getSelectedBoxSingle() {
  var im = currentImage();
  if (!im || state.selection.size !== 1) return null;
  var found = null;
  im.boxes.forEach(function (b) { if (state.selection.has(b.id)) found = b; });
  return found;
}

function clientToViewport(evt) {
  var rect = dom.viewport.getBoundingClientRect();
  return [evt.clientX - rect.left, evt.clientY - rect.top];
}

function onPointerDown(evt) {
  if (!state.loaded) return;
  var im = currentImage();
  if (!im) return;
  var sxy = clientToViewport(evt);
  var sx = sxy[0], sy = sxy[1];
  dom.viewport.setPointerCapture && dom.viewport.setPointerCapture(evt.pointerId);

  // right mouse button (2) and middle mouse button (1) always pan, regardless of tool;
  // the browser's own context menu is suppressed via the contextmenu listener below.
  var wantPan = spaceHeld || evt.button === 1 || evt.button === 2;

  if (wantPan) {
    evt.preventDefault();
    drag = { mode: "pan", startSx: sx, startSy: sy, startPanX: state.view.panX, startPanY: state.view.panY };
    dom.viewport.classList.add("panning");
    return;
  }
  if (evt.button !== 0) return; // ignore any other buttons for drawing/selecting

  if (state.tool === "draw") {
    var startNorm = screenToWorldNorm(sx, sy, im);
    drag = { mode: "draw", x0: startNorm[0], y0: startNorm[1] };
    newBoxPreview = { x0: startNorm[0], y0: startNorm[1], x1: startNorm[0], y1: startNorm[1] };
    requestRedraw();
    return;
  }

  // select tool
  var single = getSelectedBoxSingle();
  var handle = single ? findHandleAt(sx, sy, single, im, state.view) : null;
  if (handle) {
    drag = {
      mode: "handle", handle: handle, box: single,
      startPts: single.pts.slice(),
      alt: evt.altKey
    };
    return;
  }

  var hit = findBoxAtScreen(sx, sy);
  if (hit) {
    if (evt.shiftKey || evt.ctrlKey || evt.metaKey) {
      if (state.selection.has(hit.id)) state.selection.delete(hit.id);
      else state.selection.add(hit.id);
      syncSelectionPanels(); requestRedraw();
      drag = null;
      return;
    }
    if (!state.selection.has(hit.id)) {
      state.selection = new Set([hit.id]);
      syncSelectionPanels();
    }
    var ids = Array.from(state.selection);
    var startMap = {};
    im.boxes.forEach(function (b) { if (state.selection.has(b.id)) startMap[b.id] = b.pts.slice(); });
    drag = { mode: "move", ids: ids, startMap: startMap, startWorld: screenToWorldNorm(sx, sy, im), moved: false };
    requestRedraw();
    return;
  }

  // empty space -> rubber band select
  drag = { mode: "rubber", x0: sx, y0: sy, additive: evt.shiftKey };
  if (!evt.shiftKey) { state.selection = new Set(); syncSelectionPanels(); }
  rubberRect = { x0: sx, y0: sy, x1: sx, y1: sy };
  requestRedraw();
}

function onPointerMove(evt) {
  if (!drag) {
    // hover cursor hint for handles (cheap check only when single selected)
    return;
  }
  var im = currentImage();
  if (!im) return;
  var sxy = clientToViewport(evt);
  var sx = sxy[0], sy = sxy[1];

  if (drag.mode === "pan") {
    state.view.panX = drag.startPanX + (sx - drag.startSx);
    state.view.panY = drag.startPanY + (sy - drag.startSy);
    applyStageTransform();
    requestRedraw();
    return;
  }

  if (drag.mode === "draw") {
    var n = screenToWorldNorm(sx, sy, im);
    newBoxPreview.x1 = n[0]; newBoxPreview.y1 = n[1];
    requestRedraw();
    return;
  }

  if (drag.mode === "move") {
    var nowN = screenToWorldNorm(sx, sy, im);
    var dxN = nowN[0] - drag.startWorld[0], dyN = nowN[1] - drag.startWorld[1];
    if (Math.abs(dxN) > 1e-9 || Math.abs(dyN) > 1e-9) drag.moved = true;
    im.boxes.forEach(function (b) {
      var sp = drag.startMap[b.id];
      if (!sp) return;
      for (var k = 0; k < 8; k += 2) { b.pts[k] = sp[k] + dxN; b.pts[k + 1] = sp[k + 1] + dyN; }
      recomputeBBox(b);
    });
    requestRedraw();
    return;
  }

  if (drag.mode === "handle") {
    applyHandleDrag(drag, sx, sy, im);
    recomputeBBox(drag.box);
    requestRedraw();
    return;
  }

  if (drag.mode === "rubber") {
    rubberRect.x1 = sx; rubberRect.y1 = sy;
    requestRedraw();
    return;
  }
}

function applyHandleDrag(d, sx, sy, im) {
  var box = d.box;
  var n = screenToWorldNorm(sx, sy, im);

  if (d.handle.type === "rotate") {
    var sp = d.startPts;
    var cx = (sp[0] + sp[2] + sp[4] + sp[6]) / 4;
    var cy = (sp[1] + sp[3] + sp[5] + sp[7]) / 4;
    // account for aspect (normalized coords aren't square) -> work in pixel space for correct angles
    var aspect = im.width / im.height;
    var mx0 = (sp[0] + sp[2]) / 2 * aspect, my0 = (sp[1] + sp[3]) / 2;
    var a0 = Math.atan2(my0 - cy, mx0 - cx * aspect);
    var a1 = Math.atan2(n[1] - cy, n[0] * aspect - cx * aspect);
    var dAng = a1 - a0;
    var cosA = Math.cos(dAng), sinA = Math.sin(dAng);
    for (var k = 0; k < 8; k += 2) {
      var px = sp[k] * aspect - cx * aspect, py = sp[k + 1] - cy;
      var rx = px * cosA - py * sinA, ry = px * sinA + py * cosA;
      box.pts[k] = rx / aspect + cx;
      box.pts[k + 1] = ry + cy;
    }
    return;
  }

  // corner resize, rectangle-preserving unless Alt held (freeform single-vertex)
  var i = d.handle.index;
  if (d.alt) {
    box.pts[i * 2] = n[0]; box.pts[i * 2 + 1] = n[1];
    return;
  }
  var sp2 = d.startPts;
  var oppIdx = (i + 2) % 4;
  var prevIdx = (i + 3) % 4;
  var nextIdx = (i + 1) % 4;
  var O = [sp2[oppIdx * 2], sp2[oppIdx * 2 + 1]];
  var A = [sp2[prevIdx * 2], sp2[prevIdx * 2 + 1]]; // adjacent corner 1
  var B = [sp2[nextIdx * 2], sp2[nextIdx * 2 + 1]]; // adjacent corner 2
  var aspect2 = im.width / im.height;
  function toPix(pt) { return [pt[0] * aspect2, pt[1]]; }
  var Op = toPix(O), Ap = toPix(A), Bp = toPix(B), Np = [n[0] * aspect2, n[1]];
  var Ux = Ap[0] - Op[0], Uy = Ap[1] - Op[1];
  var Vx = Bp[0] - Op[0], Vy = Bp[1] - Op[1];
  var Ulen = Math.hypot(Ux, Uy) || 1e-9, Vlen = Math.hypot(Vx, Vy) || 1e-9;
  var Uhx = Ux / Ulen, Uhy = Uy / Ulen, Vhx = Vx / Vlen, Vhy = Vy / Vlen;
  var Px = Np[0] - Op[0], Py = Np[1] - Op[1];
  var u = Px * Uhx + Py * Uhy;
  var v = Px * Vhx + Py * Vhy;
  var newA = [Op[0] + Uhx * u, Op[1] + Uhy * u];
  var newB = [Op[0] + Vhx * v, Op[1] + Vhy * v];
  var newI = [Op[0] + Uhx * u + Vhx * v, Op[1] + Uhy * u + Vhy * v];
  function fromPix(pt) { return [pt[0] / aspect2, pt[1]]; }
  var nA = fromPix(newA), nB = fromPix(newB), nI = fromPix(newI);
  box.pts[prevIdx * 2] = nA[0]; box.pts[prevIdx * 2 + 1] = nA[1];
  box.pts[nextIdx * 2] = nB[0]; box.pts[nextIdx * 2 + 1] = nB[1];
  box.pts[i * 2] = nI[0]; box.pts[i * 2 + 1] = nI[1];
}

function onPointerUp(evt) {
  if (!drag) return;
  var im = currentImage();
  var d = drag; drag = null;
  dom.viewport.classList.remove("panning");

  if (d.mode === "pan") { return; }

  if (d.mode === "draw") {
    if (im && newBoxPreview) {
      var x0 = clamp(Math.min(newBoxPreview.x0, newBoxPreview.x1), -2, 2);
      var y0 = clamp(Math.min(newBoxPreview.y0, newBoxPreview.y1), -2, 2);
      var x1 = clamp(Math.max(newBoxPreview.x0, newBoxPreview.x1), -2, 2);
      var y1 = clamp(Math.max(newBoxPreview.y0, newBoxPreview.y1), -2, 2);
      var wNorm = x1 - x0, hNorm = y1 - y0;
      if (Math.abs(wNorm * im.width) > 3 && Math.abs(hNorm * im.height) > 3) {
        var defaultCid = state.classes.length ? state.classes[0].cid : null;
        var box = {
          id: im.nextBoxId++,
          pts: new Float64Array([x0, y0, x1, y0, x1, y1, x0, y1]),
          labels: defaultCid !== null ? [defaultCid] : []
        };
        recomputeBBox(box);
        im.boxes.push(box);
        var addedId = box.id;
        pushHistory({
          undo: function () { removeBoxById(im, addedId); },
          redo: function () { im.boxes.push(box); }
        });
        state.selection = new Set([box.id]);
        setTool("select");
        afterDataChange();
      }
    }
    newBoxPreview = null;
    requestRedraw();
    return;
  }

  if (d.mode === "move") {
    if (d.moved) {
      var endMap = {};
      im.boxes.forEach(function (b) { if (d.startMap[b.id]) endMap[b.id] = b.pts.slice(); });
      var startMap = d.startMap;
      pushHistory({
        undo: function () { applyPtsMap(im, startMap); },
        redo: function () { applyPtsMap(im, endMap); }
      });
      afterDataChange();
    }
    return;
  }

  if (d.mode === "handle") {
    var endPts = d.box.pts.slice();
    var startPts = d.startPts;
    var box = d.box;
    var changed = false;
    for (var k = 0; k < 8; k++) if (Math.abs(endPts[k] - startPts[k]) > 1e-12) { changed = true; break; }
    if (changed) {
      pushHistory({
        undo: function () { box.pts.set(startPts); recomputeBBox(box); },
        redo: function () { box.pts.set(endPts); recomputeBBox(box); }
      });
      afterDataChange();
    }
    return;
  }

  if (d.mode === "rubber") {
    var picked = boxesInRectScreen(d.x0, d.y0, rubberRect.x1, rubberRect.y1);
    var movedEnough = Math.hypot(rubberRect.x1 - d.x0, rubberRect.y1 - d.y0) > 3;
    if (movedEnough) {
      picked.forEach(function (b) { state.selection.add(b.id); });
    } else if (!d.additive) {
      // treat as empty click -> ensure selection cleared (already done on down)
    }
    rubberRect = null;
    syncSelectionPanels();
    requestRedraw();
    return;
  }
}

function applyPtsMap(im, map) {
  im.boxes.forEach(function (b) {
    var p = map[b.id];
    if (p) { b.pts.set(p); recomputeBBox(b); }
  });
}
function removeBoxById(im, id) {
  var idx = im.boxes.findIndex(function (b) { return b.id === id; });
  if (idx >= 0) im.boxes.splice(idx, 1);
  state.selection.delete(id);
}

function onWheel(evt) {
  if (!state.loaded) return;
  evt.preventDefault();
  var im = currentImage();
  if (!im) return;
  var sxy = clientToViewport(evt);
  var sx = sxy[0], sy = sxy[1];
  var factor = Math.pow(1.0015, -evt.deltaY);
  var newZoom = clamp(state.view.zoom * factor, 0.01, 40);
  var worldX = (sx - state.view.panX) / state.view.zoom;
  var worldY = (sy - state.view.panY) / state.view.zoom;
  state.view.zoom = newZoom;
  state.view.panX = sx - worldX * newZoom;
  state.view.panY = sy - worldY * newZoom;
  applyStageTransform();
  requestRedraw();
}

/* ----------------------------------------------------------------- *
 *  KEYBOARD SHORTCUTS
 * ----------------------------------------------------------------- */
function deleteSelection() {
  var im = currentImage();
  if (!im || !state.selection.size) return;
  var ids = Array.from(state.selection);
  var removed = [];
  ids.forEach(function (id) {
    var idx = im.boxes.findIndex(function (b) { return b.id === id; });
    if (idx >= 0) { removed.push({ box: im.boxes[idx], idx: idx }); }
  });
  removed.sort(function (a, b) { return a.idx - b.idx; });
  im.boxes = im.boxes.filter(function (b) { return ids.indexOf(b.id) === -1; });
  state.selection = new Set();
  pushHistory({
    undo: function () {
      removed.forEach(function (r) { im.boxes.splice(Math.min(r.idx, im.boxes.length), 0, r.box); });
    },
    redo: function () {
      var idSet = new Set(removed.map(function (r) { return r.box.id; }));
      im.boxes = im.boxes.filter(function (b) { return !idSet.has(b.id); });
    }
  });
  afterDataChange();
}

function duplicateSelection() {
  var im = currentImage();
  if (!im || !state.selection.size) return;
  var offset = 0.01;
  var newBoxes = [];
  im.boxes.forEach(function (b) {
    if (!state.selection.has(b.id)) return;
    var np = new Float64Array(8);
    for (var k = 0; k < 8; k += 2) { np[k] = b.pts[k] + offset; np[k + 1] = b.pts[k + 1] + offset; }
    var nb = { id: im.nextBoxId++, pts: np, labels: b.labels.slice() };
    recomputeBBox(nb);
    newBoxes.push(nb);
  });
  newBoxes.forEach(function (nb) { im.boxes.push(nb); });
  var ids = newBoxes.map(function (b) { return b.id; });
  pushHistory({
    undo: function () { im.boxes = im.boxes.filter(function (b) { return ids.indexOf(b.id) === -1; }); },
    redo: function () { newBoxes.forEach(function (nb) { im.boxes.push(nb); }); }
  });
  state.selection = new Set(ids);
  afterDataChange();
}

function nudgeSelection(dxPx, dyPx) {
  var im = currentImage();
  if (!im || !state.selection.size) return;
  var dxN = dxPx / state.view.zoom / im.width;
  var dyN = dyPx / state.view.zoom / im.height;
  var startMap = {};
  im.boxes.forEach(function (b) { if (state.selection.has(b.id)) startMap[b.id] = b.pts.slice(); });
  im.boxes.forEach(function (b) {
    if (!state.selection.has(b.id)) return;
    for (var k = 0; k < 8; k += 2) { b.pts[k] += dxN; b.pts[k + 1] += dyN; }
    recomputeBBox(b);
  });
  var endMap = {};
  im.boxes.forEach(function (b) { if (startMap[b.id]) endMap[b.id] = b.pts.slice(); });
  pushHistory({
    undo: function () { applyPtsMap(im, startMap); },
    redo: function () { applyPtsMap(im, endMap); }
  });
  afterDataChange();
}

function selectAll() {
  var im = currentImage();
  if (!im) return;
  var s = new Set();
  im.boxes.forEach(function (b) {
    if (!b.labels.length) return;
    var vis = false;
    for (var i = 0; i < b.labels.length; i++) if (state.classVisible[b.labels[i]] !== false) { vis = true; break; }
    if (vis) s.add(b.id);
  });
  state.selection = s;
  syncSelectionPanels();
  requestRedraw();
}

function onKeyDown(evt) {
  var tag = (document.activeElement && document.activeElement.tagName) || "";
  var typing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable;

  if (evt.code === "Space" && !typing) {
    spaceHeld = true;
    dom.viewport.classList.add("space-pan");
  }

  if (typing) {
    if (evt.key === "Escape") document.activeElement.blur();
    return;
  }

  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "z") {
    evt.preventDefault();
    if (evt.shiftKey) redo(); else undo();
    return;
  }
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "y") { evt.preventDefault(); redo(); return; }
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "s") { evt.preventDefault(); saveZip(); return; }
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "d") { evt.preventDefault(); duplicateSelection(); return; }
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "a") { evt.preventDefault(); selectAll(); return; }

  if (evt.key === "Delete" || evt.key === "Backspace") { evt.preventDefault(); deleteSelection(); return; }
  if (evt.key === "Escape") {
    state.selection = new Set(); rubberRect = null; newBoxPreview = null; drag = null;
    syncSelectionPanels(); requestRedraw(); return;
  }
  if (evt.key === "v" || evt.key === "V") { setTool("select"); return; }
  if (evt.key === "b" || evt.key === "B") { setTool("draw"); return; }
  if (evt.key === "f" || evt.key === "F") { fitToWindow(); return; }
  if (evt.key === "+" || evt.key === "=") { zoomBy(1.2); return; }
  if (evt.key === "-" || evt.key === "_") { zoomBy(1 / 1.2); return; }

  var step = evt.shiftKey ? 10 : 1;
  if (evt.key === "ArrowLeft") { evt.preventDefault(); nudgeSelection(-step, 0); return; }
  if (evt.key === "ArrowRight") { evt.preventDefault(); nudgeSelection(step, 0); return; }
  if (evt.key === "ArrowUp") { evt.preventDefault(); nudgeSelection(0, -step); return; }
  if (evt.key === "ArrowDown") { evt.preventDefault(); nudgeSelection(0, step); return; }
}
function onKeyUp(evt) {
  if (evt.code === "Space") { spaceHeld = false; dom.viewport.classList.remove("space-pan"); }
}

function zoomBy(factor) {
  var rect = dom.viewport.getBoundingClientRect();
  var cx = rect.width / 2, cy = rect.height / 2;
  var worldX = (cx - state.view.panX) / state.view.zoom;
  var worldY = (cy - state.view.panY) / state.view.zoom;
  state.view.zoom = clamp(state.view.zoom * factor, 0.01, 40);
  state.view.panX = cx - worldX * state.view.zoom;
  state.view.panY = cy - worldY * state.view.zoom;
  applyStageTransform();
  requestRedraw();
}

function setTool(t) {
  state.tool = t;
  dom.toolSelect.classList.toggle("active", t === "select");
  dom.toolDraw.classList.toggle("active", t === "draw");
  dom.viewport.classList.toggle("draw-mode", t === "draw");
}

/* ----------------------------------------------------------------- *
 *  LABEL EDITING (multi-label add/remove on selection)
 * ----------------------------------------------------------------- */
function labelStateForSelection(cid) {
  var im = currentImage();
  if (!im || !state.selection.size) return "none";
  var all = true, any = false;
  im.boxes.forEach(function (b) {
    if (!state.selection.has(b.id)) return;
    var has = b.labels.indexOf(cid) !== -1;
    if (has) any = true; else all = false;
  });
  if (any && all) return "all";
  if (any) return "some";
  return "none";
}

function toggleLabelOnSelection(cid) {
  var im = currentImage();
  if (!im || !state.selection.size) return;
  var st = labelStateForSelection(cid);
  var addMode = st !== "all"; // if not all-have-it, clicking adds to all missing; if all have it, remove from all
  var changes = [];
  im.boxes.forEach(function (b) {
    if (!state.selection.has(b.id)) return;
    var has = b.labels.indexOf(cid) !== -1;
    if (addMode && !has) { changes.push({ box: b, add: true }); }
    else if (!addMode && has) { changes.push({ box: b, add: false }); }
  });
  if (!changes.length) return;
  changes.forEach(function (c) {
    if (c.add) { c.box.labels.push(cid); c.box.labels.sort(function (a, z) { return a - z; }); }
    else { c.box.labels = c.box.labels.filter(function (x) { return x !== cid; }); }
  });
  pushHistory({
    undo: function () {
      changes.forEach(function (c) {
        if (c.add) c.box.labels = c.box.labels.filter(function (x) { return x !== cid; });
        else { c.box.labels.push(cid); c.box.labels.sort(function (a, z) { return a - z; }); }
      });
    },
    redo: function () {
      changes.forEach(function (c) {
        if (c.add) { c.box.labels.push(cid); c.box.labels.sort(function (a, z) { return a - z; }); }
        else c.box.labels = c.box.labels.filter(function (x) { return x !== cid; });
      });
    }
  });
  afterDataChange();
}

/* ----------------------------------------------------------------- *
 *  CLASS LIST PANEL
 * ----------------------------------------------------------------- */
function classUsageCount(cid) {
  var n = 0;
  state.images.forEach(function (im) {
    im.boxes.forEach(function (b) { if (b.labels.indexOf(cid) !== -1) n++; });
  });
  return n;
}

var dragClassIdx = null;

function renderClassList() {
  var host = dom.classList;
  host.innerHTML = "";
  dom.classCount.textContent = state.classes.length;
  state.classes.forEach(function (c, i) {
    var row = el("div", "class-row");
    row.draggable = true;
    row.dataset.idx = i;

    var reorder = el("div", "reorder");
    var up = el("span", null, "\u25B2"); up.title = "Move up";
    var down = el("span", null, "\u25BC"); down.title = "Move down";
    up.addEventListener("click", function (e) { e.stopPropagation(); moveClass(i, i - 1); });
    down.addEventListener("click", function (e) { e.stopPropagation(); moveClass(i, i + 1); });
    reorder.appendChild(up); reorder.appendChild(down);
    row.appendChild(reorder);

    var vis = el("span", "vis" + (state.classVisible[c.cid] === false ? " off" : ""), state.classVisible[c.cid] === false ? "\u25CB" : "\u25CF");
    vis.title = "Toggle visibility";
    vis.addEventListener("click", function () {
      state.classVisible[c.cid] = state.classVisible[c.cid] === false ? true : false;
      renderClassList(); requestRedraw();
    });
    row.appendChild(vis);

    var swatchWrap = el("input");
    swatchWrap.type = "color";
    swatchWrap.value = hslToHex(classColorCache(c.cid));
    swatchWrap.title = "Class color";
    swatchWrap.addEventListener("input", function () {
      _colorCache.set(c.cid, swatchWrap.value);
      requestRedraw();
    });
    row.appendChild(swatchWrap);

    var name = el("input", "cname");
    name.value = c.name;
    name.spellcheck = false;
    name.addEventListener("change", function () {
      var newName = name.value.trim() || c.name;
      var old = c.name;
      c.name = newName;
      pushHistory({ undo: function () { c.name = old; renderClassList(); syncSelectionPanels(); }, redo: function () { c.name = newName; renderClassList(); syncSelectionPanels(); } });
      renderClassList(); syncSelectionPanels();
    });
    row.appendChild(name);

    var count = el("span", "ccount", String(classUsageCount(c.cid)));
    row.appendChild(count);

    var del = el("span", "del", "\u2715");
    del.title = "Delete class";
    del.addEventListener("click", function () { deleteClass(c.cid); });
    row.appendChild(del);

    row.addEventListener("dragstart", function () { dragClassIdx = i; row.classList.add("dragging"); });
    row.addEventListener("dragend", function () { row.classList.remove("dragging"); });
    row.addEventListener("dragover", function (e) { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", function () { row.classList.remove("drag-over"); });
    row.addEventListener("drop", function (e) {
      e.preventDefault(); row.classList.remove("drag-over");
      if (dragClassIdx !== null && dragClassIdx !== i) moveClass(dragClassIdx, i);
      dragClassIdx = null;
    });

    host.appendChild(row);
  });
}

function hslToHex(hsl) {
  var m = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/.exec(hsl);
  if (!m) return "#888888";
  var h = parseFloat(m[1]) / 360, s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
  function hue2rgb(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
  var r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  function h2(x) { var s2 = Math.round(x * 255).toString(16); return s2.length === 1 ? "0" + s2 : s2; }
  return "#" + h2(r) + h2(g) + h2(b);
}

function moveClass(from, to) {
  if (to < 0 || to >= state.classes.length) return;
  var before = state.classes.slice();
  var arr = state.classes.slice();
  var item = arr.splice(from, 1)[0];
  arr.splice(to, 0, item);
  var after = arr;
  state.classes = after;
  pushHistory({
    undo: function () { state.classes = before; renderClassList(); syncSelectionPanels(); },
    redo: function () { state.classes = after; renderClassList(); syncSelectionPanels(); }
  });
  renderClassList();
  syncSelectionPanels();
  requestRedraw();
}

function addClass() {
  var name = "class_" + (state.classes.length);
  var c = { cid: uid(), name: name };
  state.classes.push(c);
  state.classVisible[c.cid] = true;
  pushHistory({
    undo: function () { state.classes = state.classes.filter(function (x) { return x !== c; }); renderClassList(); },
    redo: function () { state.classes.push(c); renderClassList(); }
  });
  renderClassList();
  syncSelectionPanels();
}

function deleteClass(cid) {
  if (state.classes.length <= 1) { toast("At least one class must remain.", "err"); return; }
  var used = classUsageCount(cid);
  if (used > 0) {
    var ok = confirm("This class is used on " + used + " box(es) across the project.\nDeleting it will remove the label from those boxes (boxes left with zero labels will be deleted).\n\nContinue?");
    if (!ok) return;
  }
  var clsIdx = state.classes.findIndex(function (c) { return c.cid === cid; });
  if (clsIdx < 0) return;
  var removedClass = state.classes[clsIdx];
  var beforeClasses = state.classes.slice();

  var perImageRemoved = []; // {im, removedBoxes:[{idx,box}], labelChanges:[{box, hadLabels}]}
  state.images.forEach(function (im) {
    var removedBoxes = [];
    var labelChanges = [];
    im.boxes.forEach(function (b, idx) {
      if (b.labels.indexOf(cid) === -1) return;
      labelChanges.push({ box: b, hadLabels: b.labels.slice() });
    });
    perImageRemoved.push({ im: im, labelChanges: labelChanges });
  });

  state.classes = state.classes.filter(function (c) { return c.cid !== cid; });
  delete state.classVisible[cid];

  perImageRemoved.forEach(function (rec) {
    rec.labelChanges.forEach(function (lc) {
      lc.box.labels = lc.box.labels.filter(function (x) { return x !== cid; });
    });
    rec.im.boxes = rec.im.boxes.filter(function (b) { return b.labels.length > 0; });
  });

  pushHistory({
    undo: function () {
      state.classes = beforeClasses;
      state.classVisible[cid] = true;
      perImageRemoved.forEach(function (rec) {
        rec.labelChanges.forEach(function (lc) {
          if (rec.im.boxes.indexOf(lc.box) === -1) rec.im.boxes.push(lc.box);
          lc.box.labels = lc.hadLabels.slice();
        });
      });
      renderClassList(); afterDataChange();
    },
    redo: function () {
      state.classes = state.classes.filter(function (c) { return c.cid !== cid; });
      delete state.classVisible[cid];
      perImageRemoved.forEach(function (rec) {
        rec.labelChanges.forEach(function (lc) {
          lc.box.labels = lc.box.labels.filter(function (x) { return x !== cid; });
        });
        rec.im.boxes = rec.im.boxes.filter(function (b) { return b.labels.length > 0; });
      });
      renderClassList(); afterDataChange();
    }
  });

  invalidateColorCache();
  renderClassList();
  afterDataChange();
  toast("Deleted class \u201c" + removedClass.name + "\u201d", "ok");
}

/* ----------------------------------------------------------------- *
 *  IMAGE LIST PANEL
 * ----------------------------------------------------------------- */
function renderImageList() {
  var host = dom.imageList;
  host.innerHTML = "";
  dom.imgCount.textContent = state.images.length;
  state.images.forEach(function (im, i) {
    var row = el("div", "img-row" + (i === state.currentImageIndex ? " active" : ""));
    var name = el("span", "name", im.name);
    var count = el("span", "count", String(im.boxes ? im.boxes.length : 0));
    var del = el("span", "imgdel", "\u2715");
    del.title = "Remove image from project";
    del.addEventListener("click", function (e) { e.stopPropagation(); removeImage(i); });
    row.appendChild(name); row.appendChild(count); row.appendChild(del);
    row.addEventListener("click", function () { switchToImage(i); });
    host.appendChild(row);
  });
  updateNoImagesHint();
}

function updateNoImagesHint() {
  dom.noImagesHint.hidden = !(state.loaded && state.images.length === 0);
}

function switchToImage(i) {
  if (i < 0 || i >= state.images.length || i === state.currentImageIndex) return;
  state.currentImageIndex = i;
  state.selection = new Set();
  var im = state.images[i];
  dom.mainImage.src = im.url;
  dom.mainImage.style.width = im.width + "px";
  dom.mainImage.style.height = im.height + "px";
  renderImageList();
  syncSelectionPanels();
  requestAnimationFrame(fitToWindow);
  scheduleAutosave(false);
}

/* ----------------------------------------------------------------- *
 *  NEW PROJECT / ADD & REMOVE IMAGES
 * ----------------------------------------------------------------- */
function clearViewportForEmptyProject() {
  state.currentImageIndex = -1;
  state.selection = new Set();
  dom.mainImage.removeAttribute("src");
  dom.mainImage.style.width = "";
  dom.mainImage.style.height = "";
  var ctx = dom.overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, dom.overlayCanvas.width, dom.overlayCanvas.height);
  dom.statusText.textContent = "";
}

function initBlankProject(name) {
  var c = { cid: uid(), name: "object" };
  state.classes = [c];
  state.classVisible = {};
  state.classVisible[c.cid] = true;
  state.images = [];
  state.projectName = name || "annotations";
  clearViewportForEmptyProject();
  state.history = []; state.future = [];
  state.loaded = true;
  state.dirty = false;
  invalidateColorCache();
}
function finishProjectInit() {
  $("#emptyState").hidden = true;
  $("#emptyState").style.display = "none";
  dom.btnSave.disabled = false;
  dom.projectNameInput.disabled = false;
  dom.projectNameInput.value = state.projectName;
  dom.restoreBanner.hidden = true;
  syncHistoryButtons();
  renderImageList();
  renderClassList();
  syncSelectionPanels();
  updateNoImagesHint();
}

function newProject() {
  if (state.loaded) {
    var ok = confirm("Start a new project? This discards the currently loaded project from view and its browser backup (make sure you've already saved a zip if you want to keep it).");
    if (!ok) return;
  }
  initBlankProject("annotations");
  finishProjectInit();
  clearAllPersistence().then(function () { scheduleAutosave(true); });
  toast("New project started. Add images to begin.", "ok");
}

async function addImagesFromFiles(fileList) {
  var files = Array.from(fileList || []).filter(function (f) {
    return /^image\//.test(f.type) || /\.(jpe?g|png|bmp|webp|gif)$/i.test(f.name);
  });
  if (!files.length) { toast("No image files found in the selection.", "err"); return; }

  if (!state.loaded) initBlankProject("annotations");

  var wasEmpty = state.images.length === 0;
  showLoading("Adding images\u2026", "0 / " + files.length);

  var added = [];
  var CONC = 4;
  var idx = 0;
  async function worker() {
    while (idx < files.length) {
      var myIdx = idx++;
      var file = files[myIdx];
      try {
        var typedBlob = file.type ? file : file.slice(0, file.size, guessMime(file.name));
        var url = URL.createObjectURL(typedBlob);
        var dims = await new Promise(function (resolve) {
          var settled = false;
          var timer = setTimeout(function () { if (settled) return; settled = true; resolve({ w: 1000, h: 1000, failed: true }); }, 20000);
          var img = new Image();
          img.onload = function () { if (settled) return; settled = true; clearTimeout(timer); resolve({ w: img.naturalWidth || 1000, h: img.naturalHeight || 1000 }); };
          img.onerror = function () { if (settled) return; settled = true; clearTimeout(timer); resolve({ w: 1000, h: 1000, failed: true }); };
          img.src = url;
        });
        var name = file.name;
        var base = name.replace(/\.[^.]+$/, "");
        var existingNames = {};
        state.images.forEach(function (im) { existingNames[im.name] = true; });
        added.forEach(function (im) { existingNames[im.name] = true; });
        var finalName = name, n2 = 1;
        while (existingNames[finalName]) { finalName = base + "_" + (n2++) + (name.match(/\.[^.]+$/) || [""])[0]; }
        added.push({
          name: finalName, path: finalName,
          width: dims.w, height: dims.h,
          blob: typedBlob, url: url,
          boxes: [], nextBoxId: 1
        });
      } catch (err) {
        console.error("[yolo-obb-editor] failed to add image", file.name, err);
      }
      updateLoading("Adding images\u2026", (myIdx + 1) + " / " + files.length);
    }
  }
  var workers = [];
  for (var w = 0; w < CONC; w++) workers.push(worker());
  await Promise.all(workers);

  added.forEach(function (im) { state.images.push(im); });
  var addedNames = added.map(function (im) { return im.name; });
  pushHistory({
    undo: function () {
      state.images = state.images.filter(function (im) { return addedNames.indexOf(im.name) === -1; });
      if (state.currentImageIndex >= state.images.length) state.currentImageIndex = state.images.length - 1;
    },
    redo: function () {
      added.forEach(function (im) { state.images.push(im); });
    }
  });

  hideLoading();
  finishProjectInit();
  if (wasEmpty && state.images.length) switchToImage(0);
  scheduleAutosave(true);
  toast("Added " + added.length + " image(s).", "ok");
}

function removeImage(i) {
  if (i < 0 || i >= state.images.length) return;
  var im = state.images[i];
  if (im.boxes && im.boxes.length) {
    var ok = confirm("\u201c" + im.name + "\u201d has " + im.boxes.length + " annotated box(es). Remove it from the project anyway?");
    if (!ok) return;
  }
  state.images.splice(i, 1);
  pushHistory({
    undo: function () { state.images.splice(i, 0, im); },
    redo: function () { var idx2 = state.images.indexOf(im); if (idx2 !== -1) state.images.splice(idx2, 1); }
  });

  if (state.currentImageIndex === i) {
    if (state.images.length) {
      var next = Math.min(i, state.images.length - 1);
      state.currentImageIndex = -1; // force switchToImage to act (it no-ops on equal index)
      switchToImage(next);
    } else {
      clearViewportForEmptyProject();
    }
  } else if (state.currentImageIndex > i) {
    state.currentImageIndex -= 1;
  }
  renderImageList();
  syncSelectionPanels();
  requestRedraw();
  scheduleAutosave(true);
}

/* ----------------------------------------------------------------- *
 *  SELECTION / RIGHT PANEL
 * ----------------------------------------------------------------- */
function syncSelectionPanels() {
  var im = currentImage();
  var selIds = Array.from(state.selection);
  dom.selCount.textContent = selIds.length;
  dom.btnDelete.disabled = selIds.length === 0;
  dom.btnDuplicate.disabled = selIds.length === 0;

  var selHost = dom.selDetails;
  selHost.innerHTML = "";
  if (!im || selIds.length === 0) {
    selHost.appendChild(el("div", "sel-empty", "Nothing selected. Click a box, shift-click to multi-select, or drag on empty space to rubber-band select."));
  } else if (selIds.length === 1) {
    var box = null;
    im.boxes.forEach(function (b) { if (b.id === selIds[0]) box = b; });
    if (box) {
      var info = el("div", null);
      info.appendChild(el("div", null, "Box #" + box.id + "  \u00b7  " + box.labels.length + " label(s)"));
      var grid = el("div", "coord-grid");
      ["1", "2", "3", "4"].forEach(function (lbl, idx) {
        grid.appendChild(el("label", null, "P" + lbl));
        var xi = el("input"); xi.type = "number"; xi.step = "any";
        var yi = el("input"); yi.type = "number"; yi.step = "any";
        xi.value = fmt(box.pts[idx * 2]);
        yi.value = fmt(box.pts[idx * 2 + 1]);
        function commit() {
          var before = box.pts.slice();
          var nx = parseFloat(xi.value), ny = parseFloat(yi.value);
          if (!isFinite(nx) || !isFinite(ny)) return;
          box.pts[idx * 2] = nx; box.pts[idx * 2 + 1] = ny;
          recomputeBBox(box);
          var after = box.pts.slice();
          pushHistory({
            undo: function () { box.pts.set(before); recomputeBBox(box); },
            redo: function () { box.pts.set(after); recomputeBBox(box); }
          });
          afterDataChange();
        }
        xi.addEventListener("change", commit);
        yi.addEventListener("change", commit);
        grid.appendChild(xi); grid.appendChild(yi);
      });
      info.appendChild(grid);
      selHost.appendChild(info);
    }
  } else {
    selHost.appendChild(el("div", "sel-empty", selIds.length + " boxes selected. Use the label checklist below to add/remove a label across all of them."));
  }

  renderLabelChecklist();
}

function renderLabelChecklist() {
  var host = dom.labelChecklist;
  host.innerHTML = "";
  var hasSelection = state.selection.size > 0;
  state.classes.forEach(function (c) {
    var row = el("div", "label-check-row");
    var swatch = el("span", "swatch");
    swatch.style.background = classColorCache(c.cid);
    var name = el("span", "name", c.name);
    var st = hasSelection ? labelStateForSelection(c.cid) : "none";
    var box = el("span", "tristate" + (st === "all" ? " all" : st === "some" ? " some" : ""));
    row.appendChild(swatch); row.appendChild(name); row.appendChild(box);
    if (hasSelection) {
      row.addEventListener("click", function () { toggleLabelOnSelection(c.cid); });
    } else {
      row.style.opacity = "0.45";
      row.style.cursor = "default";
    }
    host.appendChild(row);
  });
}

/* ----------------------------------------------------------------- *
 *  PROJECT LOAD HOOK / TOP LEVEL WIRING
 * ----------------------------------------------------------------- */
function onProjectLoaded() {
  invalidateColorCache();
  finishProjectInit();
  switchToImage(0);
  clearAllPersistence().then(function () { scheduleAutosave(true); });
}

function wireEvents() {
  dom.btnLoad.addEventListener("click", function () { dom.fileInput.click(); });
  var btnLoad2 = $("#btnLoad2");
  if (btnLoad2) btnLoad2.addEventListener("click", function () { dom.fileInput.click(); });
  dom.fileInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) loadZipFile(e.target.files[0]);
    e.target.value = "";
  });
  dom.btnSave.addEventListener("click", saveZip);

  dom.btnNewProject.addEventListener("click", newProject);
  var btnNewProject2 = $("#btnNewProject2");
  if (btnNewProject2) btnNewProject2.addEventListener("click", newProject);

  dom.btnAddImages.addEventListener("click", function () { dom.imageFilesInput.click(); });
  dom.imageFilesInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files.length) addImagesFromFiles(e.target.files);
    e.target.value = "";
  });

  dom.projectNameInput.addEventListener("change", function () {
    state.projectName = dom.projectNameInput.value.trim() || "annotations";
    dom.projectNameInput.value = state.projectName;
    state.dirty = true;
    scheduleAutosave(false);
  });

  dom.btnClearAutosave.addEventListener("click", function () {
    if (!confirm("Clear the autosaved browser backup? This does not affect any zip files you've already saved.")) return;
    clearAllPersistence();
  });
  dom.btnRestoreAutosave.addEventListener("click", restoreAutosavedProject);
  dom.btnDiscardAutosave.addEventListener("click", discardAutosavedProject);

  dom.toolSelect.addEventListener("click", function () { setTool("select"); });
  dom.toolDraw.addEventListener("click", function () { setTool("draw"); });

  dom.btnUndo.addEventListener("click", undo);
  dom.btnRedo.addEventListener("click", redo);
  dom.btnDuplicate.addEventListener("click", duplicateSelection);
  dom.btnDelete.addEventListener("click", deleteSelection);

  dom.btnZoomIn.addEventListener("click", function () { zoomBy(1.25); });
  dom.btnZoomOut.addEventListener("click", function () { zoomBy(1 / 1.25); });
  dom.btnZoomFit.addEventListener("click", fitToWindow);

  dom.btnAddClass.addEventListener("click", addClass);

  dom.viewport.addEventListener("pointerdown", onPointerDown);
  dom.viewport.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  dom.viewport.addEventListener("wheel", onWheel, { passive: false });
  dom.viewport.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", function () { sizeCanvasToViewport(); requestRedraw(); });

  // drag & drop: a .zip loads a project, image files add to the current (or a new) project
  var dropOverlay = $("#dropOverlay");
  var dragCounter = 0;
  window.addEventListener("dragenter", function (e) {
    if (!Array.from(e.dataTransfer.types || []).includes("Files")) return;
    dragCounter++; dropOverlay.hidden = false; e.preventDefault();
  });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("dragleave", function (e) {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dropOverlay.hidden = true;
  });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    dragCounter = 0; dropOverlay.hidden = true;
    var dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!dropped.length) return;
    var zipFile = dropped.find(function (f) { return /\.zip$/i.test(f.name); });
    if (zipFile) { loadZipFile(zipFile); return; }
    var imgFiles = dropped.filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|bmp|webp|gif)$/i.test(f.name); });
    if (imgFiles.length) { addImagesFromFiles(imgFiles); return; }
    toast("Drop a .zip project, or image files to add them.", "err");
  });

  window.addEventListener("beforeunload", function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

function initHelp() {
  dom.helpText.innerHTML =
    "<kbd>V</kbd> select &nbsp; <kbd>B</kbd> new box<br>" +
    "<kbd>Shift</kbd>/<kbd>Ctrl</kbd>+click multi-select<br>" +
    "Drag empty area to rubber-band select<br>" +
    "Drag box body to move &middot; corners to resize<br>" +
    "Green handle rotates &middot; <kbd>Alt</kbd>+corner = free vertex<br>" +
    "<kbd>Del</kbd> delete &middot; <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate<br>" +
    "<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> undo/redo<br>" +
    "Arrow keys nudge &middot; <kbd>Shift</kbd>+arrow = 10px<br>" +
    "Scroll to zoom &middot; Space/middle-drag to pan &middot; <kbd>F</kbd> fit<br>" +
    "<kbd>Ctrl</kbd>+<kbd>S</kbd> save zip";
}

document.addEventListener("DOMContentLoaded", function () {
  dom = {
    fileInput: $("#fileInput"),
    btnLoad: $("#btnLoad"), btnSave: $("#btnSave"), btnNewProject: $("#btnNewProject"),
    btnAddImages: $("#btnAddImages"), imageFilesInput: $("#imageFilesInput"),
    projectNameInput: $("#projectNameInput"), noImagesHint: $("#noImagesHint"),
    autosaveStatus: $("#autosaveStatus"), btnClearAutosave: $("#btnClearAutosave"),
    restoreBanner: $("#restoreBanner"), restoreBannerText: $("#restoreBannerText"),
    btnRestoreAutosave: $("#btnRestoreAutosave"), btnDiscardAutosave: $("#btnDiscardAutosave"),
    toolSelect: $("#toolSelect"), toolDraw: $("#toolDraw"),
    btnUndo: $("#btnUndo"), btnRedo: $("#btnRedo"),
    btnDuplicate: $("#btnDuplicate"), btnDelete: $("#btnDelete"),
    btnZoomIn: $("#btnZoomIn"), btnZoomOut: $("#btnZoomOut"), btnZoomFit: $("#btnZoomFit"),
    zoomLabel: $("#zoomLabel"), statusText: $("#statusText"),
    imageList: $("#imageList"), imgCount: $("#imgCount"),
    classList: $("#classList"), classCount: $("#classCount"), btnAddClass: $("#btnAddClass"),
    viewport: $("#viewport"), stage: $("#stage"), mainImage: $("#mainImage"), overlayCanvas: $("#overlayCanvas"),
    selCount: $("#selCount"), selDetails: $("#selDetails"), labelChecklist: $("#labelChecklist"),
    helpText: $("#helpText")
  };
  wireEvents();
  initHelp();
  sizeCanvasToViewport();
  applyStageTransform();
  checkForAutosavedProject();
  setInterval(function () { if (state.loaded && state.dirty) scheduleAutosave(false); }, 20000);
});

})();
