#target illustrator

$.evalFile(File($.fileName).parent + "/VF_Common.jsx");

// ===== Artwork metadata panel support =====
// Two INDEPENDENT subsystems (see VF_Common.jsx):
//   1) ELEMENT metadata — belongs to ONE selected PageItem; stored in the
//      element's own note (Object Name + Keywords). Travels with the
//      element through copy / move / duplicate.
//   2) SET metadata — a user-defined composition (ordered member list
//      + Title + Keywords); stored as hidden SET_<id> frames in the
//      hidden VF_METADATA layer.
// This file only adds the selection-aware helpers the panel calls.

// ---------- ELEMENT metadata (single selected item) ----------

// Heuristic: is this single item likely the BACKGROUND (a rectangle that
// fills the whole active artboard) rather than the actual artwork? Used by
// the panel to warn the user when they select the background by mistake
// (e.g. clicking empty space) instead of the real artwork (монтажка).
// Conservative: only flags axis-aligned rectangles that cover the active
// artboard bounds (small tolerance). Returns false for anything else.
function isLikelyBackground(item) {
  try {
    if (!item || item.typename !== "PathItem") return false;
    if (!item.closed) return false;
    if (item.pathPoints.length !== 4) return false;
    var pts = item.pathPoints;
    var xs = [
      pts[0].anchor[0],
      pts[1].anchor[0],
      pts[2].anchor[0],
      pts[3].anchor[0],
    ];
    var ys = [
      pts[0].anchor[1],
      pts[1].anchor[1],
      pts[2].anchor[1],
      pts[3].anchor[1],
    ];
    // Axis-aligned rectangle => exactly 2 distinct x and 2 distinct y.
    var dx = {};
    var dy = {};
    for (var a = 0; a < 4; a++) {
      dx[xs[a]] = 1;
      dy[ys[a]] = 1;
    }
    if (Object.keys(dx).length !== 2 || Object.keys(dy).length !== 2) {
      return false;
    }
    var doc = app.activeDocument;
    var abRect = null;
    try {
      var idx = doc.artboards.getActiveArtboardIndex();
      abRect = doc.artboards[idx].artboardRect;
    } catch (e) {
      abRect = null;
    }
    if (!abRect) return false;
    var minX = Math.min(xs[0], xs[1], xs[2], xs[3]);
    var maxX = Math.max(xs[0], xs[1], xs[2], xs[3]);
    var minY = Math.min(ys[0], ys[1], ys[2], ys[3]);
    var maxY = Math.max(ys[0], ys[1], ys[2], ys[3]);
    var tol = 2; // points
    if (Math.abs(minX - abRect[0]) > tol) return false; // left
    if (Math.abs(maxX - abRect[2]) > tol) return false; // right
    if (Math.abs(maxY - abRect[1]) > tol) return false; // top
    if (Math.abs(minY - abRect[3]) > tol) return false; // bottom
    return true;
  } catch (e) {
    return false;
  }
}

// Read the selected element's own metadata. Shape:
//   { "has": true,  "vfid": "...", "objectName": "...", "keywords": [...],
//     "isBackground": true|false }
//   { "has": false, "reason": "no document" | "nothing selected" | "many selected" }
// NOTE: the panel (js/app.js) calls this as getSelectedArtworkMeta();
// the name must match exactly or the call throws and nothing is read.
function getSelectedArtworkMeta() {
  if (app.documents.length === 0) return '{"has":false,"reason":"no document"}';
  if (!app.selection || app.selection.length === 0) {
    return '{"has":false,"reason":"nothing selected"}';
  }
  if (app.selection.length > 1) {
    return '{"has":false,"reason":"many selected"}';
  }
  var item = app.selection[0];
  var vfid = getVfId(item); // VF_ID from the element's note
  var meta = getElementMeta(item); // { objectName, keywords }
  var objectName = meta ? meta.objectName : "";
  var kw = meta ? meta.keywords : [];
  var kwParts = [];
  for (var i = 0; i < kw.length; i++) {
    kwParts.push('"' + vfEscapeJson(kw[i]) + '"');
  }
  var bg = isLikelyBackground(item);
  return (
    '{"has":true,"vfid":"' +
    vfEscapeJson(vfid) +
    '","objectName":"' +
    vfEscapeJson(objectName) +
    '","keywords":[' +
    kwParts.join(",") +
    '],"isBackground":' +
    (bg ? "true" : "false") +
    "}"
  );
}

// Save the selected element's own metadata. `keywordsJson` is a JS
// array-literal string from the panel, e.g. '["a","b"]'. A VF_ID is
// assigned automatically if the element does not have one yet.
// NOTE: the panel (js/app.js) calls this as setSelectedArtworkMeta(...);
// the name must match exactly or the call throws and nothing is saved.
function setSelectedArtworkMeta(objectName, keywordsJson) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  if (!app.selection || app.selection.length === 0) {
    vfError("Select artwork first.");
    return vfResult();
  }
  if (app.selection.length > 1) {
    vfError("Select exactly one element.");
    return vfResult();
  }
  var item = app.selection[0];

  var keywords = [];
  try {
    // Accept EITHER a JSON-array string (e.g. '["a","b"]') OR an actual
    // Array (e.g. ["a","b"]). The panel passes a string today, but this
    // guard also covers any caller that passes a real Array — without it,
    // keywordsJson.replace(...) would throw on an Array (no .replace) and
    // the empty catch would silently leave keywords = [].
    if (keywordsJson instanceof Array) {
      for (var a = 0; a < keywordsJson.length; a++) {
        var av = String(keywordsJson[a]);
        if (av.length > 0) keywords.push(av);
      }
    } else {
      var cleaned = String(keywordsJson).replace(/^\[|\]$/g, "");
      if (cleaned.replace(/\s/g, "").length > 0) {
        var items = cleaned.split(",");
        for (var i = 0; i < items.length; i++) {
          var t = items[i]
            .replace(/^\s*["']|["']\s*$/g, "")
            .replace(/\\"/g, '"');
          if (t.length > 0) keywords.push(t);
        }
      }
    }
  } catch (e) {}

  // setElementMeta() is the SOLE writer of the element note: it loads any
  // existing record (preserving the id), sets the fields, and writes back.
  // Do NOT call ensureVfId() here first -- that would write a separate
  // note with empty keywords (via setVfId) before this write, and if that
  // earlier write is the one that persists, the keywords are lost.
  // setElementMeta assigns the id itself when missing.
  setElementMeta(item, objectName, keywords);
  vfSuccess("Element metadata saved.");
  return vfResult();
}

// Return which metadata panel section should be shown for the current
// selection. Returns JSON { "mode": "artboard" | "single" | "multiple" |
// "none" } so the panel can JSON.parse it reliably.
//   - "artboard": the selection is inside (or empty inside) the ACTIVE
//     artboard (монтажка) — show the Artboard Metadata panel. Note: in this
//     project element/Set artwork lives OUTSIDE artboards, so a normal
//     element/Set selection is NOT "artboard".
//   - "single": exactly one element selected (outside any artboard).
//   - "multiple": two or more elements selected (outside any artboard).
//   - "none": no document / no artboard at all.
function getSelectionPanelMode() {
  var mode = "none";
  if (app.documents.length === 0) {
    return '{"mode":"none"}';
  }
  if (!app.selection || app.selection.length === 0) {
    // Nothing selected. In this project elements and Sets always live
    // OUTSIDE artboards, so an empty selection means the user clicked
    // inside the artboard (монтажка) — show its panel.
    try {
      if (app.activeDocument.artboards.length > 0) mode = "artboard";
    } catch (e) {}
    return '{"mode":"' + mode + '"}';
  }

  var doc = app.activeDocument;
  var abRect = null;
  try {
    var idx = doc.artboards.getActiveArtboardIndex();
    abRect = doc.artboards[idx].artboardRect;
  } catch (e) {
    abRect = null;
  }

  // If every selected item is inside the active artboard -> artboard mode.
  if (abRect) {
    var allInside = true;
    for (var i = 0; i < app.selection.length; i++) {
      if (!isInArtboard(app.selection[i].geometricBounds, abRect)) {
        allInside = false;
        break;
      }
    }
    if (allInside) mode = "artboard";
  }

  if (mode === "none") {
    mode = app.selection.length === 1 ? "single" : "multiple";
  }
  return '{"mode":"' + mode + '"}';
}

// ---------- SET metadata (composition of selected items) ----------

// Create a Set from the current selection (order is significant) and return
// its record. Shape:
//   { "success": true, "setId": "...",
//     "title": "", "keywords": [], "members": ["id1","id2",...] }
//   { "success": false, "error": "..." }
function createSelectedSet() {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (app.documents.length === 0) {
    return '{"success":false,"error":"No document."}';
  }
  if (!app.selection || app.selection.length < 2) {
    return '{"success":false,"error":"Select two or more elements to create a Set."}';
  }
  var items = [];
  for (var i = 0; i < app.selection.length; i++) {
    items.push(app.selection[i]);
  }

  // Resolve the VF_ID of every selected element (assigns one if missing).
  var currentIds = [];
  for (var ci = 0; ci < items.length; ci++) {
    currentIds.push(ensureVfId(items[ci]));
  }

  // Reuse an existing Set whose members match the current selection exactly
  // (same count, same set of VF_IDs; order does not matter).
  var existingSetId = "";
  var allSets = getAllSets();
  for (var key in allSets) {
    var setMembers = allSets[key] ? allSets[key].members : null;
    if (!setMembers || setMembers.length !== currentIds.length) continue;
    var matched = true;
    for (var a = 0; a < currentIds.length; a++) {
      var found = false;
      for (var b = 0; b < setMembers.length; b++) {
        if (setMembers[b] === currentIds[a]) {
          found = true;
          break;
        }
      }
      if (!found) {
        matched = false;
        break;
      }
    }
    if (matched) {
      existingSetId = key;
      break;
    }
  }

  var setId;
  if (existingSetId) {
    setId = existingSetId; // reuse the existing Set, do not create a new one
  } else {
    setId = createSet(items); // assigns member VF_IDs, preserves order
  }

  var meta = getSetMeta(setId);
  var members = meta ? meta.members : [];
  var memParts = [];
  for (var m = 0; m < members.length; m++) {
    memParts.push('"' + vfEscapeJson(members[m]) + '"');
  }
  return (
    '{"success":true,"setId":"' +
    vfEscapeJson(setId) +
    '","title":"","keywords":[],"members":[' +
    memParts.join(",") +
    ']}'
  );
}

// Read-only: return the id of an EXISTING Set whose members exactly match the
// current selection (same count, same set of VF_IDs; order does not matter),
// or "" if none. Does NOT create a Set. Used by the panel to decide whether
// to show "Set Object" (create) or "Delete Object" (already a Set).
function findExistingSetForSelection() {
  if (app.documents.length === 0) return '{"setId":""}';
  if (!app.selection || app.selection.length < 2) return '{"setId":""}';
  var items = [];
  for (var i = 0; i < app.selection.length; i++) {
    items.push(app.selection[i]);
  }
  var currentIds = [];
  for (var ci = 0; ci < items.length; ci++) {
    currentIds.push(ensureVfId(items[ci]));
  }
  var allSets = getAllSets();
  for (var key in allSets) {
    var setMembers = allSets[key] ? allSets[key].members : null;
    if (!setMembers || setMembers.length !== currentIds.length) continue;
    var matched = true;
    for (var a = 0; a < currentIds.length; a++) {
      var found = false;
      for (var b = 0; b < setMembers.length; b++) {
        if (setMembers[b] === currentIds[a]) {
          found = true;
          break;
        }
      }
      if (!found) {
        matched = false;
        break;
      }
    }
    if (matched) return '{"setId":"' + vfEscapeJson(key) + '"}';
  }
  return '{"setId":""}';
}

// Delete a single Set (by id) — removes its SET_<id> frame from VF_METADATA.
// Returns the standard {errors, success} result.
function deleteSet(setId) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  if (!setId) {
    vfError("No Set id.");
    return vfResult();
  }
  var doc = app.activeDocument;
  var tf = getSetFrame(doc, setId, false);
  if (!tf) {
    vfError("Set not found.");
    return vfResult();
  }
  // The VF_METADATA layer is normally LOCKED (so it cannot be selected by
  // mouse). Removing a child from a locked layer throws Error 9024, so
  // temporarily unlock the layer (and its ancestors) around tf.remove().
  var layer = tf.parent;
  var wasLocked = layer.locked;
  layer.locked = false;
  var ancestors = [];
  var p = layer.parent;
  while (p && p.typename === "Layer") {
    ancestors.push({ layer: p, locked: p.locked });
    p.locked = false;
    p = p.parent;
  }
  try {
    tf.remove();
  } finally {
    layer.locked = wasLocked;
    for (var a = 0; a < ancestors.length; a++) {
      ancestors[a].layer.locked = ancestors[a].locked;
    }
  }
  vfSuccess("Set deleted.");
  return vfResult();
}

// Read a Set record by id. Shape:
//   { "success": true, "title": "...", "keywords": [...],
//     "members": ["id1","id2",...] }
//   { "success": false, "error": "Set not found." }
function getSetMetaById(setId) {
  var meta = getSetMeta(setId);
  if (!meta) return '{"success":false,"error":"Set not found."}';
  var kwParts = [];
  for (var i = 0; i < meta.keywords.length; i++) {
    kwParts.push('"' + vfEscapeJson(meta.keywords[i]) + '"');
  }
  var memParts = [];
  for (var j = 0; j < meta.members.length; j++) {
    memParts.push('"' + vfEscapeJson(meta.members[j]) + '"');
  }
  return (
    '{"success":true,"title":"' +
    vfEscapeJson(meta.title) +
    '","keywords":[' +
    kwParts.join(",") +
    '],"members":[' +
    memParts.join(",") +
    ']}'
  );
}

// Return the Set's members as a list of display NAMES (the element's
// Object Name) in member order, for showing in the panel instead of raw
// VF_ID codes. Shape: { "success": true, "names": ["Red apple", ...] }
//   { "success": false, "error": "Set not found." }
// A member whose element cannot be found (or has no name) falls back to its
// VF_ID so the row is never empty.
function getSetMemberTitles(setId) {
  var meta = getSetMeta(setId);
  if (!meta) return '{"success":false,"error":"Set not found."}';
  var members = meta.members || [];
  var nameParts = [];
  for (var i = 0; i < members.length; i++) {
    var item = findItemByVfId(members[i]);
    var name = "";
    if (item) {
      var em = getElementMeta(item);
      name = em ? em.objectName : "";
    }
    if (!name || name.length === 0) name = members[i]; // fall back to VF_ID
    nameParts.push('"' + vfEscapeJson(name) + '"');
  }
  return '{"success":true,"names":[' + nameParts.join(",") + "]}";
}

// Delete ALL VF_METADATA layers from the active document (only that layer
// name; user layers are never touched). Returns the standard result.
function deleteAllSets() {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  var doc = app.activeDocument;
  var removed = 0;
  for (var i = doc.layers.length - 1; i >= 0; i--) {
    if (doc.layers[i].name === "VF_METADATA") {
      // A hidden/locked layer cannot be removed directly (Error 9021), so
      // unlock and show it first, then delete.
      doc.layers[i].locked = false;
      doc.layers[i].visible = true;
      doc.layers[i].remove();
      removed++;
    }
  }
  vfSuccess("Removed " + removed + " metadata layer(s).");
  return vfResult();
}

// Save a Set's Title and Keywords (member order is fixed at creation).
// `keywordsJson` may be EITHER a JS array-literal string (e.g. '["a","b"]')
// OR an actual Array (e.g. ["a","b"]). The panel passes a string today, but
// if an Array arrives (e.g. via evalJsx string concatenation that embeds a
// literal), accept it directly instead of calling .replace() on it (which
// would throw and silently leave keywords empty).
function setSetMetaById(setId, title, keywordsJson) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  var existing = getSetMeta(setId);
  if (!existing) {
    vfError("Set not found.");
    return vfResult();
  }
  var keywords = [];
  try {
    if (keywordsJson instanceof Array) {
      for (var a = 0; a < keywordsJson.length; a++) {
        var av = String(keywordsJson[a]);
        if (av.length > 0) keywords.push(av);
      }
    } else {
      var cleaned = String(keywordsJson).replace(/^\[|\]$/g, "");
      if (cleaned.replace(/\s/g, "").length > 0) {
        var items = cleaned.split(",");
        for (var i = 0; i < items.length; i++) {
          var t = items[i]
            .replace(/^\s*["']|["']\s*$/g, "")
            .replace(/\\"/g, '"');
          if (t.length > 0) keywords.push(t);
        }
      }
    }
  } catch (e) {}
  // Merge into the EXISTING record so unchanged fields (including any
  // previously saved keywords) are preserved. setSetMeta() itself loads the
  // existing note and only overwrites title/keywords, keeping members and
  // timestamps intact.
  setSetMeta(setId, title, keywords);
  vfSuccess("Set metadata saved.");
  return vfResult();
}

// ---------- ARTBOARD metadata (keyed by artboard NAME) ----------

// Read an artboard's metadata by its current name. Shape:
//   { "success": true, "name": "...", "title": "...", "keywords": [...] }
//   { "success": false, "error": "Artboard not found." }
function getArtboardMetaByName(name) {
  var meta = getArtboardMeta(name);
  if (!meta) return '{"success":false,"error":"Artboard not found."}';
  var kwParts = [];
  for (var i = 0; i < meta.keywords.length; i++) {
    kwParts.push('"' + vfEscapeJson(meta.keywords[i]) + '"');
  }
  return (
    '{"success":true,"name":"' +
    vfEscapeJson(meta.name) +
    '","title":"' +
    vfEscapeJson(meta.title) +
    '","keywords":[' +
    kwParts.join(",") +
    ']}'
  );
}

// Save an artboard's Title and Keywords by its current name. `keywordsJson`
// accepts BOTH a string and an Array (same guard as setSetMetaById).
function setArtboardMetaByName(name, title, keywordsJson) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (!name) {
    vfError("No artboard name.");
    return vfResult();
  }
  var keywords = [];
  try {
    if (keywordsJson instanceof Array) {
      for (var a = 0; a < keywordsJson.length; a++) {
        var av = String(keywordsJson[a]);
        if (av.length > 0) keywords.push(av);
      }
    } else {
      var cleaned = String(keywordsJson).replace(/^\[|\]$/g, "");
      if (cleaned.replace(/\s/g, "").length > 0) {
        var items = cleaned.split(",");
        for (var i = 0; i < items.length; i++) {
          var t = items[i]
            .replace(/^\s*["']|["']\s*$/g, "")
            .replace(/\\"/g, '"');
          if (t.length > 0) keywords.push(t);
        }
      }
    }
  } catch (e) {}
  setArtboardMeta(name, title, keywords);
  vfSuccess("Artboard metadata saved.");
  return vfResult();
}
