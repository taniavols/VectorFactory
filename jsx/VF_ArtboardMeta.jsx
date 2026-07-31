#target illustrator

$.evalFile(File($.fileName).parent + "/VF_Common.jsx");

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

// Rename the active artboard (identified by its CURRENT name) to `newName`,
// and migrate its metadata record so the Title/Keywords stay connected.
// The metadata frame is named "ARTBOARD_<safeName>" (see VF_Common.jsx); we
// simply rename that frame to the new safe name — the note (title/keywords)
// is preserved untouched. Returns the standard {errors, success} result.
function renameArtboardByName(oldName, newName) {
  VF_ERRORS = [];
  VF_SUCCESS = "";
  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  if (!oldName || !newName || !newName.replace(/^\s+|\s+$/g, "")) {
    vfError("Artboard name required.");
    return vfResult();
  }
  newName = newName.replace(/^\s+|\s+$/g, "");
  var doc = app.activeDocument;

  // 1) Find and rename the actual Illustrator artboard by its current name.
  var ab = null;
  for (var i = 0; i < doc.artboards.length; i++) {
    if (doc.artboards[i].name === oldName) {
      ab = doc.artboards[i];
      break;
    }
  }
  if (!ab) {
    vfError("Artboard not found: " + oldName);
    return vfResult();
  }
  ab.name = newName;

  // 2) Migrate the metadata frame: rename ARTBOARD_<oldSafe> to
  //    ARTBOARD_<newSafe> so the stored Title/Keywords remain attached.
  var oldSafe = String(oldName).replace(/[\\\/:*?"<>|]/g, "_");
  var newSafe = String(newName).replace(/[\\\/:*?"<>|]/g, "_");
  if (oldSafe !== newSafe) {
    var layer = getLayer(doc, "VF_METADATA");
    if (layer) {
      for (var f = 0; f < layer.textFrames.length; f++) {
        if (layer.textFrames[f].name === "ARTBOARD_" + oldSafe) {
          layer.textFrames[f].name = "ARTBOARD_" + newSafe;
          break;
        }
      }
    }
  }

  vfSuccess("Artboard renamed.");
  return vfResult();
}
