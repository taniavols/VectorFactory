#target illustrator

// Temporary PNG export for AI Metadata analysis.
// Uses doc.imageCapture — the SAME technique as the Set Element master
// preview (VF_SetElement.jsx) — so NO temporary document is created and
// nothing flashes. The PNG is written next to preview.png in the extension
// folder and its path is returned. The source Illustrator document is NEVER
// modified (layer visibility is restored afterwards). No network / OpenAI
// calls happen here — this only prepares the image for the model.
//
// NOTE: VF_Common.jsx is loaded by the caller (evalJsx) BEFORE this file, so
// we must NOT $.evalFile it again here — re-loading the same file re-declares
// its top-level const/let/#target and throws a SyntaxError (Error 8).

// contextJson: { "type": "element" | "set" | "artboard", "setId": "..." }
// Returns JSON:
//   { "success": true, "path": "<png path>", "type": "..." }
//   { "errors": [...], "success": "..." }   (on failure)
function exportAIImage(contextJson) {
  // Helpers (vfError/vfResult/jsonParse/collectArtboardItems/...) are loaded
  // by the caller (evalJsx loads VF_Common.jsx first). Re-loading the file
  // here would re-declare its top-level const/let/#target and throw a
  // SyntaxError, so we only verify they are already present.
  if (
    typeof vfError !== "function" ||
    typeof vfResult !== "function" ||
    typeof jsonParse !== "function"
  ) {
    return '{"errors":["AI image export failed: helpers not loaded"],"success":""}';
  }

  VF_ERRORS = [];
  VF_SUCCESS = "";

  var ctx;
  try {
    ctx = jsonParse(contextJson);
  } catch (pe) {
    return '{"errors":["AI image export failed: bad context JSON"],"success":""}';
  }
  if (!ctx || !ctx.type) {
    vfError("Bad AI context.");
    return vfResult();
  }
  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }

  var doc = app.activeDocument;
  var items = [];

  if (ctx.type === "element") {
    // Current selection (one or more artwork objects).
    if (!app.selection || app.selection.length === 0) {
      vfError("Nothing selected.");
      return vfResult();
    }
    for (var i = 0; i < app.selection.length; i++) {
      items.push(app.selection[i]);
    }
  } else if (ctx.type === "set") {
    // Whole Set composition, resolved from its members (not just selection).
    if (!ctx.setId) {
      vfError("No Set id.");
      return vfResult();
    }
    var set = getSetMeta(ctx.setId);
    if (!set) {
      vfError("Set not found.");
      return vfResult();
    }
    for (var m = 0; m < set.members.length; m++) {
      var it = findItemByVfId(set.members[m]);
      if (it) items.push(it);
    }
    if (items.length === 0) {
      vfError("No Set members found in the document.");
      return vfResult();
    }
  } else if (ctx.type === "artboard") {
    // Active artboard: capture the whole board (all visible artwork inside
    // it, including placeholder rectangles). No layer hiding needed — we
    // grab exactly the artboard rectangle.
    var abIdx = -1;
    try {
      abIdx = doc.artboards.getActiveArtboardIndex();
    } catch (e) {}
    if (abIdx < 0) {
      vfError("No active artboard.");
      return vfResult();
    }
    var abRect = doc.artboards[abIdx].artboardRect;
    return captureRect(doc, abRect, ctx.type);
  } else {
    vfError("Unknown AI context type: " + ctx.type);
    return vfResult();
  }

  if (items.length === 0) {
    vfError("No artwork to capture.");
    return vfResult();
  }

  // Union bounding box of all items (geometric bounds: [L, T, R, B]).
  var L = Infinity, T = -Infinity, R = -Infinity, B = Infinity;
  for (var k = 0; k < items.length; k++) {
    var b = items[k].geometricBounds;
    if (b[0] < L) L = b[0];
    if (b[1] > T) T = b[1];
    if (b[2] > R) R = b[2];
    if (b[3] < B) B = b[3];
  }
  if (!isFinite(L) || !isFinite(R) || R <= L || B >= T) {
    vfError("Could not compute artwork bounds.");
    return vfResult();
  }

  // Save the current selection — hiding a layer drops the selection of any
  // item on it, and we must restore it afterwards so the panel does not
  // switch away from the selected element.
  var savedSel = [];
  try {
    for (var si = 0; si < app.selection.length; si++) {
      savedSel.push(app.selection[si]);
    }
  } catch (e) {}

  // Show ONLY the layers that contain our target items (hide everything
  // else) so imageCapture grabs just the artwork — exactly like the master
  // preview in VF_SetElement.jsx. Visibility is restored afterwards.
  var visibility = [];
  for (var li = 0; li < doc.layers.length; li++) {
    visibility[li] = doc.layers[li].visible;
    doc.layers[li].visible = false;
  }
  for (var ii = 0; ii < items.length; ii++) {
    try {
      items[ii].visible = true;
      var pl = items[ii].parent;
      while (pl && pl !== doc) {
        pl.visible = true;
        pl = pl.parent;
      }
    } catch (e) {}
  }

  var result = captureRect(doc, [L, T, R, B], ctx.type);

  // Restore layer visibility FIRST, then the selection (items on a hidden
  // layer cannot be selected). This keeps the panel on the same element.
  for (var lk = 0; lk < doc.layers.length; lk++) {
    doc.layers[lk].visible = visibility[lk];
  }
  try {
    if (savedSel.length > 0) app.selection = savedSel;
  } catch (e) {}

  return result;
}

// Capture `bounds` of `doc` to vf_ai_preview.png (next to preview.png, in the
// extension folder) and return a JSON success/path string. The path uses
// forward slashes so CEP's window.cep.fs.readFile can read it back.
function captureRect(doc, bounds, type) {
  try {
    var file = new File(
      File($.fileName).parent.parent + "/vf_ai_preview.png",
    );
    // Remove any previous capture so imageCapture can overwrite it.
    try {
      if (file.exists) file.remove();
    } catch (e) {}
    var options = new ImageCaptureOptions();
    options.resolution = 150;
    options.transparency = true;
    options.antiAliasing = true;
    doc.imageCapture(file, bounds, options);
    var pngPath = file.fsName.replace(/\\/g, "/");
    return (
      '{"success":true,"path":"' +
      vfEscapeJson(pngPath) +
      '","type":"' +
      vfEscapeJson(type) +
      '"}'
    );
  } catch (e) {
    var detail = (e && (e.message || e.description)) || "unknown error";
    if (e && e.number) detail += " (code " + e.number + ")";
    if (e && e.line) detail += " @line " + e.line;
    vfError("AI image export failed: " + detail);
    return vfResult();
  }
}