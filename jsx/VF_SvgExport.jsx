#target illustrator

$.evalFile(File($.fileName).parent + "/VF_Common.jsx");

// ===== SVG export of the selected artwork =====
// Returns a JSON string (the panel parses it with JSON.parse):
//   { "success": true,  "svg": "<svg ...>...</svg>" }
//   { "success": false, "error": "No artwork selected." }
//
// The SVG is produced by Illustrator's OWN SVG exporter (ExportType.SVG),
// so it is exactly what Illustrator would export — not a custom serializer.
// Vector paths, fills, strokes, compound paths, clipping masks, groups,
// transformations and text are all preserved by the native exporter.
//
// To keep the original document completely untouched, the selected artwork is
// duplicated into a throwaway temporary document, the temp artboard is fitted
// to it, that document is exported as SVG, the file is read into a string,
// then BOTH the temp document (closed without saving) and the temp SVG file
// are removed. Nothing permanent is created.

function exportSelectedArtworkAsSvg() {
  // --- Validation: structured errors, never raw ExtendScript exceptions ---
  if (app.documents.length === 0) {
    return svgResult(false, "No document.");
  }
  if (!app.selection || app.selection.length === 0) {
    return svgResult(false, "No artwork selected.");
  }
  if (app.selection.length > 1) {
    return svgResult(false, "Select exactly one artwork.");
  }

  var sourceDoc = app.activeDocument;
  var srcItem = app.selection[0];

  var tempDoc = null;
  var svgFile = null;
  var svgContent = "";

  try {
    // 1) Temporary document (system temp folder, never saved).
    tempDoc = app.documents.add(DocumentColorSpace.RGB);

    // 2) Duplicate the selected artwork into the temp document.
    var dup = null;
    try {
      dup = srcItem.duplicate(
        tempDoc.layers[0],
        ElementPlacement.PLACEATEND,
      );
    } catch (e) {
      dup = null;
    }
    // If the cross-document duplicate did not land in the temp doc,
    // fall back to clipboard copy/paste (does not alter the source selection).
    if (!dup || tempDoc.pageItems.length === 0) {
      dup = null;
      try {
        app.copy();
        app.activeDocument = tempDoc;
        tempDoc.paste();
        if (tempDoc.pageItems.length > 0) {
          dup = tempDoc.pageItems[tempDoc.pageItems.length - 1];
        }
      } catch (e) {
        dup = null;
      }
    }
    if (!dup) {
      return svgResult(false, "Could not duplicate the artwork.");
    }

    // 3) Fit the temp artboard exactly to the duplicated artwork.
    var b = dup.visibleBounds; // [left, top, right, bottom]
    tempDoc.artboards[0].artboardRect = [b[0], b[1], b[2], b[3]];

    // 4) Export the temp document as SVG using Illustrator's own exporter.
    svgFile = new File(
      Folder.temp + "/vf_temp_artwork_" + svgTempName() + ".svg",
    );
    var svgOpts = new ExportOptionsSVG();
    svgOpts.embedRasterImages = true; // keep the SVG self-contained
    tempDoc.exportFile(svgFile, ExportType.SVG, svgOpts);

    if (!svgFile.exists) {
      return svgResult(false, "SVG export failed.");
    }

    // 5) Read the SVG file into a string.
    svgFile.open("r");
    svgContent = svgFile.read();
    svgFile.close();

    if (!svgContent || svgContent.length === 0) {
      return svgResult(false, "SVG file could not be read.");
    }

    return svgResult(true, svgContent);
  } catch (e) {
    return svgResult(false, "SVG export error: " + e.message);
  } finally {
    // 6) Cleanup: delete the temp SVG file and close the temp doc (no save).
    try {
      if (svgFile && svgFile.exists) svgFile.remove();
    } catch (e) {}
    try {
      if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (e) {}
    // Restore the original document as active (it was never modified).
    try {
      app.activeDocument = sourceDoc;
    } catch (e) {}
  }
}

// Unique-ish suffix for the temp SVG filename.
function svgTempName() {
  var s = "";
  for (var i = 0; i < 6; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

// Build the JSON result string (ExtendScript has no JSON object).
function svgResult(success, svgOrError) {
  if (success) {
    return '{"success":true,"svg":"' + vfEscapeJson(svgOrError) + '"}';
  }
  return '{"success":false,"error":"' + vfEscapeJson(svgOrError) + '"}';
}