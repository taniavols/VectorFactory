//
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

// A generated clipping group has no template (S/SK) child.
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

// True if the (precomputed) bounds overlap the artboard at all.
function isInArtboard(b, abRect) {
  var cx = (b[0] + b[2]) / 2;
  var cy = (b[1] + b[3]) / 2;
  return (
    cx >= abRect[0] && cx <= abRect[2] && cy <= abRect[1] && cy >= abRect[3]
  );
}

// True if the bounds are fully inside the artboard (nothing spills out).
function isFullyInside(b, abRect) {
  return (
    b[0] >= abRect[0] &&
    b[2] <= abRect[2] &&
    b[1] <= abRect[1] &&
    b[3] >= abRect[3]
  );
}

// Copy an item like Ctrl+F: keep the same relative place on the new scaled
// artboard. Duplicates into destLayer (a Layer), never into a group.
function copyToLayer(item, destLayer, abRect, scale) {
  var sourceLeft = item.position[0];
  var sourceTop = item.position[1];
  var relativeLeft = sourceLeft - abRect[0];
  var relativeTop = abRect[1] - sourceTop;
  var newArtboardHeight = (abRect[1] - abRect[3]) * scale;

  var copy = item.duplicate(destLayer, ElementPlacement.PLACEATEND);

  if (scale != 1) {
    copy.resize(
      scale * 100,
      scale * 100,
      true,
      true,
      true,
      true,
      scale * 100,
      Transformation.TOPLEFT,
    );
  }

  copy.position = [
    relativeLeft * scale,
    newArtboardHeight - relativeTop * scale,
  ];

  return copy;
}

function getScaleTo25MP(width, height) {
  if (width <= 0 || height <= 0) return 1;
  return Math.sqrt(TARGET_EXPORT_PIXELS / (width * height));
}

// Rectangle mask (first item) used to clip a layer to the artboard.
function createClipGroup(parentLayer, width, height, groupName) {
  var clipGroup = parentLayer.groupItems.add();
  clipGroup.name = groupName;

  var mask = clipGroup.pathItems.rectangle(height, 0, width, height);
  mask.name = "ARTBOARD_MASK";
  mask.filled = true;
  mask.stroked = false;
  mask.move(clipGroup, ElementPlacement.PLACEATBEGINNING);
  mask.clipping = true;

  return clipGroup;
}

// Apply the mask; remove the group if it ended up empty.
function applyClip(clipGroup) {
  if (clipGroup.pageItems.length > 1) {
    clipGroup.clipped = true;
  } else {
    clipGroup.remove();
  }
}

// Copy items into the export layer. Fully-inside items are placed directly;
// only items that extend beyond the artboard are collected into a clip group.
function copyLayerItems(
  items,
  exportLayer,
  abRect,
  scale,
  exportWidth,
  exportHeight,
  clipName,
) {
  if (items.length === 0) return;

  var clipGroup = null;
  var lastUnmasked = null;

  for (var i = 0; i < items.length; i++) {
    var b = items[i].bounds;
    if (!isInArtboard(b, abRect)) continue;

    var copy = copyToLayer(items[i].item, exportLayer, abRect, scale);

    // Carry over group-level opacity / blending mode (set on the placeholder).
    if (items[i].opacity !== undefined) {
      copy.opacity = items[i].opacity;
      copy.blendingMode = items[i].blendingMode;
    }

    if (isFullyInside(b, abRect)) {
      if (lastUnmasked) copy.move(lastUnmasked, ElementPlacement.PLACEAFTER);
      else copy.move(exportLayer, ElementPlacement.PLACEATEND);
      lastUnmasked = copy;
    } else {
      if (!clipGroup)
        clipGroup = createClipGroup(
          exportLayer,
          exportWidth,
          exportHeight,
          clipName,
        );
      copy.move(clipGroup, ElementPlacement.PLACEATEND);
    }
  }

  if (clipGroup) applyClip(clipGroup);
}

function exportArtboards(prefix) {
  VF_ERRORS = [];
  VF_SUCCESS = "";

  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }

  if (!prefix || prefix.length === 0) {
    prefix = prompt("Enter Filename Prefix:");
    if (!prefix || prefix.length === 0) prefix = "export";
  }

  var exportFolder = Folder.selectDialog("Choose export folder");
  if (!exportFolder) return vfResult();

  var srcDoc = app.activeDocument;
  var abCount = srcDoc.artboards.length;
  var abNames = [];
  var abRects = [];

  for (var a = 0; a < abCount; a++) {
    abNames[a] = srcDoc.artboards[a].name;
    abRects[a] = srcDoc.artboards[a].artboardRect;
  }

  // Resolve source layers and item bounds ONCE. visibleBounds is expensive
  // (forces ink/stroke recompute) and is constant across artboards, so caching
  // it here avoids the N(artboards) x M(items) recomputation in the loop.
  var bgLayer = getLayerByName(srcDoc, "BG");
  var plLayer = getLayerByName(srcDoc, "PLACEHOLDERS");
  var fgLayer = getLayerByName(srcDoc, "FG");

  var bgItems = [];
  if (bgLayer && !bgLayer.guideLayer) {
    for (var bi = 0; bi < bgLayer.pageItems.length; bi++) {
      bgItems.push({
        item: bgLayer.pageItems[bi],
        bounds: bgLayer.pageItems[bi].visibleBounds,
      });
    }
  }

  var fgItems = [];
  if (fgLayer && !fgLayer.guideLayer) {
    for (var fi = 0; fi < fgLayer.pageItems.length; fi++) {
      fgItems.push({
        item: fgLayer.pageItems[fi],
        bounds: fgLayer.pageItems[fi].visibleBounds,
      });
    }
  }

  var plItems = [];
  if (plLayer && !plLayer.guideLayer) {
    for (var i = 0; i < plLayer.pageItems.length; i++) {
      var item = plLayer.pageItems[i];

      // Только верхний уровень
      if (item.parent != plLayer) continue;

      if (item.typename == "GroupItem") {
        var grp = item;
        var grpOpacity = grp.opacity;
        var grpBlend = grp.blendingMode;

        var genCG = findGeneratedCG(grp);
        if (genCG) {
          plItems.push({
            item: genCG,
            bounds: genCG.visibleBounds,
            opacity: grpOpacity,
            blendingMode: grpBlend,
          });
          continue;
        }

        for (var pi = 0; pi < grp.pageItems.length; pi++) {
          if (grp.pageItems[pi].name == "ART") {
            plItems.push({
              item: grp.pageItems[pi],
              bounds: grp.pageItems[pi].visibleBounds,
              opacity: grpOpacity,
              blendingMode: grpBlend,
            });
            break;
          }
        }
      } else {
        plItems.push({
          item: item,
          bounds: item.visibleBounds,
        });
      }
    }
  }

  for (var a = 0; a < abCount; a++) {
    var abRect = abRects[a];
    var abWidth = abRect[2] - abRect[0];
    var abHeight = abRect[1] - abRect[3];
    var scale = getScaleTo25MP(abWidth, abHeight);
    var exportWidth = abWidth * scale;
    var exportHeight = abHeight * scale;

    var abName = abNames[a] || "artboard_" + a;
    var safeName = sanitizeFilename(prefix + "_" + abName);
    if (safeName.length === 0) safeName = "export_" + a;

    var tempDoc = app.documents.add(
      DocumentColorSpace.RGB,
      exportWidth,
      exportHeight,
    );
    tempDoc.artboards[0].artboardRect = [0, exportHeight, exportWidth, 0];
    var exportLayer = tempDoc.layers[0];

    // BG -> PLACEHOLDERS -> FG (bottom to top). A clip mask is created only
    // for items that extend beyond the artboard; fully-inside items are
    // placed directly.
    copyLayerItems(
      bgItems,
      exportLayer,
      abRect,
      scale,
      exportWidth,
      exportHeight,
      "BG_CLIP",
    );
    copyLayerItems(
      plItems,
      exportLayer,
      abRect,
      scale,
      exportWidth,
      exportHeight,
      "ART_CLIP",
    );
    copyLayerItems(
      fgItems,
      exportLayer,
      abRect,
      scale,
      exportWidth,
      exportHeight,
      "FG_CLIP",
    );

    // Подготовить временный документ к экспорту
    tempDoc.activate();

    app.selection = null;
    app.executeMenuCommand("selectall");

    // Создать кривые из текста
    try {
      app.executeMenuCommand("outline");
    } catch (e) {}

    // Еще раз выделить всё, потому что после outline выделение может измениться
    app.selection = null;
    app.executeMenuCommand("selectall");

    // Преобразовать обводки в кривые
    try {
      app.doScript("contour", "VF");
    } catch (e) {}

    var saveFile = new File(exportFolder.fsName + "/" + safeName + ".eps");
    var epsOptions = new EPSSaveOptions();
    epsOptions.compatibility = Compatibility.ILLUSTRATOR10;
    epsOptions.embedLinkedFiles = true;
    epsOptions.embedAllFonts = false;
    tempDoc.saveAs(saveFile, epsOptions);

    // JPG preview with the same base name (EPS + JPG pair for Adobe Stock).
    var previewFile = new File(exportFolder.fsName + "/" + safeName + ".jpg");
    var jpgOptions = new ExportOptionsJPEG();
    jpgOptions.artBoardClipping = true;
    jpgOptions.qualitySetting = 100;
    jpgOptions.horizontalScale = 100;
    jpgOptions.verticalScale = 100;
    tempDoc.exportFile(previewFile, ExportType.JPEG, jpgOptions);

    tempDoc.close(SaveOptions.DONOTSAVECHANGES);
  }

  srcDoc.activate();
  vfSuccess(
    "Export complete: " +
      abCount +
      " file(s). For each artboard an EPS + JPG preview pair was created, scaled to 25 MP.",
  );
  return vfResult();
}
