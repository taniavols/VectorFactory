#target illustrator

$.evalFile(File($.fileName).parent + "/VF_Common.jsx");

// ===== Artboard Metadata system =====
// Per-artboard metadata (Title Template / Keywords Template) is stored in a
// single project file next to the Illustrator document:
//   Project.ai  ->  Project.vfmeta
// The artboard NAME is the key. The file is plain JSON of the form:
//   {
//     "Icons": {
//       "titleTemplate": "Icon set of * isolated on white background",
//       "keywordsTemplate": "icon, isolated, vector"
//     }
//   }
// ExtendScript has no JSON object, so this file only does raw file I/O and
// artboard queries. All JSON parsing/serialization and the sync (create /
// rename / delete records) happens in the panel (browser JS), which has a
// real JSON implementation.

// Return the .vfmeta File next to the active document, or null when there is
// no document or the document has NEVER been saved (no path on disk yet).
function getArtboardMetaFile() {
  if (app.documents.length === 0) return null;
  var doc = app.activeDocument;
  // NOTE: doc.saved is false whenever the document has unsaved changes,
  // even for a file that already lives on disk. So it must NOT be used to
  // decide whether metadata can be written. Instead we check doc.fullName:
  // it is only unavailable for a document that has never been saved, in
  // which case there is no valid path to place the .vfmeta file next to.
  var docFile = null;
  try {
    docFile = doc.fullName; // File object (undefined if never saved)
  } catch (e) {
    docFile = null;
  }
  if (!docFile) return null;
  var folder = docFile.path; // Folder object
  var name = docFile.name; // e.g. "Project.ai"
  var dot = name.lastIndexOf(".");
  var base = dot > 0 ? name.substring(0, dot) : name;
  return new File(folder.fsName + "/" + base + ".vfmeta");
}

// Read the raw .vfmeta content, or "{}" when there is no document, no file,
// or the file is empty.
function readArtboardMetaFile() {
  var f = getArtboardMetaFile();
  if (!f || !f.exists) return "{}";
  try {
    f.open("r");
    var content = f.read();
    f.close();
    if (!content || content.length === 0) return "{}";
    return content;
  } catch (e) {
    return "{}";
  }
}

// Write the given JSON string to the .vfmeta file. Returns the standard
// {errors, success} result for the panel.
function writeArtboardMetaFile(jsonString) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  var f = getArtboardMetaFile();
  if (!f) {
    vfError("Save the document first to enable artboard metadata.");
    return vfResult();
  }
  try {
    f.open("w");
    f.write(jsonString);
    f.close();
    vfSuccess("Metadata saved.");
  } catch (e) {
    vfError("Write failed: " + e.message);
  }
  return vfResult();
}

// Return the name of the artboard the user is currently working on.
// Illustrator's "active artboard" often does not follow artwork selection, so
// we prefer the artboard containing the selected artwork:
//   1) If something is selected, use the center of the first selected object
//      and return the artboard whose rect contains that point.
//   2) Only when nothing is selected, fall back to getActiveArtboardIndex().
function getArtboardNameAtPoint(doc, x, y) {
  for (var i = 0; i < doc.artboards.length; i++) {
    var r = doc.artboards[i].artboardRect; // [left, top, right, bottom]
    if (x >= r[0] && x <= r[2] && y <= r[1] && y >= r[3]) {
      return doc.artboards[i].name;
    }
  }
  return "";
}

function getActiveArtboardName() {
  if (app.documents.length === 0) return "";
  var doc = app.activeDocument;
  if (!doc || doc.artboards.length === 0) return "";

  // 1) Selected artwork -> artboard containing its center point.
  if (app.selection && app.selection.length > 0) {
    try {
      var b = app.selection[0].visibleBounds; // [left, top, right, bottom]
      var cx = (b[0] + b[2]) / 2;
      var cy = (b[1] + b[3]) / 2;
      var name = getArtboardNameAtPoint(doc, cx, cy);
      if (name) return name;
    } catch (e) {}
  }

  // 2) Nothing selected -> fall back to Illustrator's active artboard.
  var idx = 0;
  try {
    var a = doc.artboards.getActiveArtboardIndex();
    if (typeof a === "number" && a >= 0 && a < doc.artboards.length) {
      idx = a;
    }
  } catch (e) {}
  return doc.artboards[idx].name;
}

function getSelectedArtboardName() {
  return '{"name":"' + vfEscapeJson(getActiveArtboardName()) + '"}';
}

// One round-trip bundle used by the panel to refresh: the raw file content,
// the current list of artboard names, and the active artboard name.
// Shape: { "content": "<raw json>", "names": [...], "selected": "..." }
function getArtboardMetaState() {
  var content = readArtboardMetaFile();
  var names = [];
  var selName = "";
  if (app.documents.length > 0) {
    var doc = app.activeDocument;
    for (var a = 0; a < doc.artboards.length; a++) {
      names.push(doc.artboards[a].name);
    }
    selName = getActiveArtboardName();
  }
  var nameParts = [];
  for (var i = 0; i < names.length; i++) {
    nameParts.push('"' + vfEscapeJson(names[i]) + '"');
  }
  return (
    '{"content":"' +
    vfEscapeJson(content) +
    '","names":[' +
    nameParts.join(",") +
    '],"selected":"' +
    vfEscapeJson(selName) +
    '"}'
  );
}