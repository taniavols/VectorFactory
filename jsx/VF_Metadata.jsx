#target illustrator

$.evalFile(File($.fileName).parent + "/VF_Common.jsx");

// Prepare for "Find Keywords": assign ONE shared VF_ID to the whole selection
// (so a multi-object composition shares one metadata record), export the
// selection to a temporary PNG, and return { vfid, pngPath } as JSON. The
// panel then calls the (mocked) generateMetadata(image) and saveArtworkMeta().
function prepareFindKeywords() {
  VF_ERRORS = [];
  VF_SUCCESS = "";

  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  if (!app.selection || app.selection.length === 0) {
    vfError("Select one or more objects.");
    return vfResult();
  }

  var doc = app.activeDocument;

  // One shared ID for the entire selection (complex compositions share meta).
  var sharedId = generateVfId();
  for (var s = 0; s < app.selection.length; s++) {
    ensureVfId(app.selection[s]);
    // Overwrite each item's id with the shared one so they all match.
    setVfId(app.selection[s], sharedId);
  }

  // Export the current selection to a temp PNG (union of selected bounds).
  var union = app.selection[0].visibleBounds;
  for (var i = 1; i < app.selection.length; i++) {
    var b = app.selection[i].visibleBounds;
    union = [
      Math.min(union[0], b[0]),
      Math.max(union[1], b[1]),
      Math.max(union[2], b[2]),
      Math.min(union[3], b[3]),
    ];
  }

  // Hide everything except the selection so the capture shows only it.
  var visibility = [];
  for (var l = 0; l < doc.layers.length; l++) {
    visibility[l] = doc.layers[l].visible;
    doc.layers[l].visible = false;
  }
  for (var s2 = 0; s2 < app.selection.length; s2++) {
    if (app.selection[s2].layer) app.selection[s2].layer.visible = true;
  }

  var pngFile = new File(Folder.temp + "/vf_keywords_" + sharedId + ".png");
  var opts = new ImageCaptureOptions();
  opts.resolution = 300;
  opts.transparency = true;
  opts.antiAliasing = true;
  try {
    doc.imageCapture(pngFile, union, opts);
  } catch (e) {
    vfError("Capture failed: " + e.message);
  }

  for (var l2 = 0; l2 < doc.layers.length; l2++) {
    doc.layers[l2].visible = visibility[l2];
  }

  // Return vfid + png path for the panel.
  return (
    '{"errors":[' +
    errorsToJson() +
    '],"success":"' +
    vfEscapeJson(sharedId) +
    '","pngPath":"' +
    vfEscapeJson(pngFile.fsName) +
    '"}'
  );
}

function errorsToJson() {
  var parts = [];
  for (var i = 0; i < VF_ERRORS.length; i++) {
    parts.push('"' + vfEscapeJson(VF_ERRORS[i]) + '"');
  }
  return parts.join(",");
}

// Store a generated metadata record for a VF_ID (called by the panel after the
// mocked generateMetadata() returns object name + keywords).
function saveArtworkMeta(vfid, objectName, keywordsJson) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  // keywordsJson is a JS array literal string from the panel, e.g. '["a","b"]'.
  var keywords = [];
  try {
    var cleaned = keywordsJson.replace(/^\[|\]$/g, "");
    if (cleaned.replace(/\s/g, "").length > 0) {
      var items = cleaned.split(",");
      for (var i = 0; i < items.length; i++) {
        var t = items[i]
          .replace(/^\s*["']|["']\s*$/g, "")
          .replace(/\\"/g, '"');
        if (t.length > 0) keywords.push(t);
      }
    }
  } catch (e) {}
  setArtworkMeta(vfid, objectName, keywords);
  vfSuccess("Metadata saved for " + vfid);
  return vfResult();
}

// Return the metadata record(s) for the current selection as JSON, so the
// panel can display the generated Object Name / Keywords (read-only).
function getSelectionMeta() {
  if (app.documents.length === 0) return '{"records":[]}';
  var doc = app.activeDocument;
  if (!app.selection || app.selection.length === 0) return '{"records":[]}';

  var seen = {};
  var records = [];
  for (var s = 0; s < app.selection.length; s++) {
    var id = getVfId(app.selection[s]);
    if (!id || seen[id]) continue;
    seen[id] = true;
    var meta = getArtworkMeta(id);
    if (meta) {
      records.push(
        '{"vfid":"' +
          vfEscapeJson(id) +
          '","objectName":"' +
          vfEscapeJson(meta.objectName) +
          '","keywords":[' +
          meta.keywords
            .map(function (k) {
              return '"' + vfEscapeJson(k) + '"';
            })
            .join(",") +
          "]}",
      );
    }
  }
  return '{"records":[' + records.join(",") + "]}";
}