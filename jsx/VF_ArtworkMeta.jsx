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

// Read the selected element's own metadata. Shape:
//   { "has": true,  "vfid": "...", "objectName": "...", "keywords": [...] }
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
  return (
    '{"has":true,"vfid":"' +
    vfEscapeJson(vfid) +
    '","objectName":"' +
    vfEscapeJson(objectName) +
    '","keywords":[' +
    kwParts.join(",") +
    ']}'
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
