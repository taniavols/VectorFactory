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
