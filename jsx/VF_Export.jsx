#target illustrator

var TARGET_EXPORT_PIXELS = 25000000;

function sanitizeFilename(name) {
  name = name.replace(/[^a-zA-Z0-9_ ]/g, "");
  name = name.replace(/ /g, "_");
  name = name.replace(/^_+|_+$/g, "");
  name = name.replace(/_+/g, "_");
  return name;
}

function getLayerByName(doc, name) {
  try {
    return doc.layers.getByName(name);
  } catch (e) {
    return null;
  }
}

function isTemplateName(name) {
  return name == "S" || name == "SK";
}

function findGeneratedCG(group) {
  for (var ci = 0; ci < group.groupItems.length; ci++) {
    var g = group.groupItems[ci];
    if (!g.clipped) continue;

    var hasTemplate = false;
    for (var pi = 0; pi < g.pageItems.length; pi++) {
      if (isTemplateName(g.pageItems[pi].name)) {
        hasTemplate = true;
        break;
      }
    }

    if (!hasTemplate) return g;
  }
  return null;
}

// Note: the item center decides which artboard it belongs to.
function isInArtboard(item, abRect) {
  var b = item.visibleBounds;
  var cx = (b[0] + b[2]) / 2;
  var cy = (b[1] + b[3]) / 2;
  return cx >= abRect[0] && cx <= abRect[2] && cy <= abRect[1] && cy >= abRect[3];
}

// Copy item like Ctrl+F: keep the same relative place on the new scaled artboard.
function copyToLayer(item, destLayer, abRect, scale) {
  var sourceLeft = item.position[0];
  var sourceTop = item.position[1];
  var relativeLeft = sourceLeft - abRect[0];
  var relativeTop = abRect[1] - sourceTop;
  var newArtboardHeight = (abRect[1] - abRect[3]) * scale;

  var copy = item.duplicate(destLayer, ElementPlacement.PLACEATEND);

  if (scale != 1) {
    copy.resize(scale * 100, scale * 100, true, true, true, true, scale * 100, Transformation.TOPLEFT);
  }

  copy.position = [relativeLeft * scale, newArtboardHeight - relativeTop * scale];

  return copy;
}

function getScaleTo25MP(width, height) {
  if (width <= 0 || height <= 0) return 1;
  return Math.sqrt(TARGET_EXPORT_PIXELS / (width * height));
}

// Create a clipping mask for items that extend beyond artboard bounds.
// Returns the clip group with mask already created.
function createClipGroup(parentLayer, width, height, groupName) {
  var clipGroup = parentLayer.groupItems.add();
  clipGroup.name = groupName || "ARTBOARD_CLIP";

  // Mask rectangle must be the first item in the clipped group.
  var mask = clipGroup.pathItems.rectangle(height, 0, width, height);
  mask.name = "ARTBOARD_MASK";
  mask.filled = true;
  mask.stroked = false;
  mask.move(clipGroup, ElementPlacement.PLACEATBEGINNING);
  mask.clipping = true;

  return clipGroup;
}

// Move items into a clipping group and apply the mask.
function applyClip(clipGroup) {
  if (clipGroup.pageItems.length > 1) {
    clipGroup.clipped = true;
  } else {
    // Not enough items for a mask, remove the group
    clipGroup.remove();
  }
}

function exportArtboards(prefix) {
  if (app.documents.length === 0) {
    alert("No document.");
    return;
  }

  if (!prefix || prefix.length === 0) {
    prefix = prompt("Enter Filename Prefix:");
    if (!prefix || prefix.length === 0) prefix = "export";
  }

  // Note: one EPS is created for each artboard.
  var exportFolder = Folder.selectDialog("Choose export folder");
  if (!exportFolder) return;

  var srcDoc = app.activeDocument;
  var abCount = srcDoc.artboards.length;
  var abNames = [];
  var abRects = [];

  for (var a = 0; a < abCount; a++) {
    abNames[a] = srcDoc.artboards[a].name;
    abRects[a] = srcDoc.artboards[a].artboardRect;
  }

  for (var a = 0; a < abCount; a++) {
    var abRect = abRects[a];
    var abWidth = abRect[2] - abRect[0];
    var abHeight = abRect[1] - abRect[3];
    var scale = getScaleTo25MP(abWidth, abHeight);
    var exportWidth = abWidth * scale;
    var exportHeight = abHeight * scale;

    var abName = abNames[a] || ("artboard_" + a);
    var safeName = sanitizeFilename(prefix + "_" + abName);
    if (safeName.length === 0) safeName = "export_" + a;

    // Note: temp document artboard and all copied content are scaled to 25 MP.
    var tempDoc = app.documents.add(DocumentColorSpace.RGB, exportWidth, exportHeight);
    tempDoc.artboards[0].artboardRect = [0, exportHeight, exportWidth, 0];

    // Use the first (default) layer directly - no EXPORT layer wrapper.
    var exportLayer = tempDoc.layers[0];

    // Layer copy order: BG -> ART -> FG (bottom to top in Illustrator).
    // Each layer gets its own clipping mask if needed.

    // BG layer: copy all items, then clip to artboard bounds.
    var bgLayer = getLayerByName(srcDoc, "BG");
    if (bgLayer && !bgLayer.guideLayer) {
      var bgClipGroup = createClipGroup(exportLayer, exportWidth, exportHeight, "BG_CLIP");
      for (var bi = 0; bi < bgLayer.pageItems.length; bi++) {
        var copy = copyToLayer(bgLayer.pageItems[bi], exportLayer, abRect, scale);
        copy.move(bgClipGroup, ElementPlacement.PLACEATEND);
      }
      applyClip(bgClipGroup);
    }

    // PLACEHOLDERS: copy generated ART or generated clipping group.
    var plLayer = getLayerByName(srcDoc, "PLACEHOLDERS");
    if (plLayer && !plLayer.guideLayer) {
      var artClipGroup = createClipGroup(exportLayer, exportWidth, exportHeight, "ART_CLIP");
      for (var g = 0; g < plLayer.groupItems.length; g++) {
        var grp = plLayer.groupItems[g];
        var genCG = findGeneratedCG(grp);
        if (genCG) {
          if (isInArtboard(genCG, abRect)) {
            var copy = copyToLayer(genCG, exportLayer, abRect, scale);
            copy.move(artClipGroup, ElementPlacement.PLACEATEND);
          }
          continue;
        }

        for (var pi = grp.pageItems.length - 1; pi >= 0; pi--) {
          if (grp.pageItems[pi].name == "ART") {
            if (isInArtboard(grp.pageItems[pi], abRect)) {
              var copy = copyToLayer(grp.pageItems[pi], exportLayer, abRect, scale);
              copy.move(artClipGroup, ElementPlacement.PLACEATEND);
            }
            break;
          }
        }
      }
      applyClip(artClipGroup);
    }

    // FG layer: copy items within artboard, then clip to artboard bounds.
    var fgLayer = getLayerByName(srcDoc, "FG");
    if (fgLayer && !fgLayer.guideLayer) {
      var fgClipGroup = createClipGroup(exportLayer, exportWidth, exportHeight, "FG_CLIP");
      for (var fi = 0; fi < fgLayer.pageItems.length; fi++) {
        if (!isInArtboard(fgLayer.pageItems[fi], abRect)) continue;
        var copy = copyToLayer(fgLayer.pageItems[fi], exportLayer, abRect, scale);
        copy.move(fgClipGroup, ElementPlacement.PLACEATEND);
      }
      applyClip(fgClipGroup);
    }

    // Save EPS 10 and close temp document.
    var saveFile = new File(exportFolder.fsName + "/" + safeName + ".eps");
    var epsOptions = new EPSSaveOptions();
    epsOptions.compatibility = Compatibility.ILLUSTRATOR10;
    epsOptions.embedLinkedFiles = true;
    epsOptions.embedAllFonts = false;

    tempDoc.saveAs(saveFile, epsOptions);
    tempDoc.close(SaveOptions.DONOTSAVECHANGES);
    srcDoc.activate();
  }

  alert("Export complete: " + abCount + " file(s). Each artboard is scaled to 25 MP.");
}