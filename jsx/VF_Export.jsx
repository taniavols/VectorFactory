//
#target illustrator
var TARGET_EXPORT_PIXELS = 25000000;

// Placeholder groups copied whole (with their appearance effects) during the
// current artboard's export. After ALL transfers finish, Expand Appearance is
// run on each so the live effect is baked into geometry. Reset per artboard.
var gEffectGroups = [];

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
  return /^S(K)?\d*$/.test(name);
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

// True if the item itself carries a live effect (e.g. a transform/distort
// effect applied via the Appearance panel) or an envelope distortion.
function hasLiveEffect(item) {
  try {
    if (item.effects && item.effects.length > 0) return true;
  } catch (e) {}
  try {
    if (item.envelope != null) return true;
  } catch (e) {}
  return false;
}

// True if the item OR any of its descendants carries a live effect / envelope
// distortion. The user may apply the effect to an inner group, so we must
// search recursively; the whole (top-level) group is then copied to transfer
// the effect during export.
function groupOrChildHasEffect(item) {
  if (hasLiveEffect(item)) return true;
  try {
    var groups = item.groupItems;
    if (groups) {
      for (var i = 0; i < groups.length; i++) {
        if (groupOrChildHasEffect(groups[i])) return true;
      }
    }
  } catch (e) {}
  return false;
}

// After duplicating a placeholder group that carries appearance effects,
// remove everything except its generated ART (and any generated clipping
// group). This drops the hidden S/SK template and any backdrop from the
// export while keeping the group's appearance effects on the ART. The live
// effect is expanded later (after ALL transfers) via expandAllEffects().
function keepOnlyArt(group) {
  for (var i = group.pageItems.length - 1; i >= 0; i--) {
    var child = group.pageItems[i];
    if (child.name === "ART") continue;
    if (child.typename === "GroupItem" && child.clipped && !groupHasTemplate(child)) continue;
    child.remove();
  }
}

// Expand Appearance (Object -> Expand Appearance) on every effect group copied
// during this artboard's export. Done ONCE, after all transfers, so the live
// effect is baked into real geometry and survives the EPS / Illustrator 10
// export. Runs outside the copy loop to avoid disturbing the transfers.
function expandAllEffects() {
  for (var i = 0; i < gEffectGroups.length; i++) {
    try {
      app.selection = null;
      gEffectGroups[i].selected = true;
      app.executeMenuCommand("expandStyle");
      app.selection = null;
    } catch (e) {}
  }
}

function groupHasTemplate(group) {
  for (var i = 0; i < group.pageItems.length; i++) {
    if (isTemplateName(group.pageItems[i].name)) return true;
  }
  return false;
}

// Debug: collect a human-readable list of which placeholder groups carry a
// live effect, to diagnose export effect-transfer issues. Returns JSON array
// of {name, effect} for groups that have an effect.
function debugEffectGroups() {
  if (app.documents.length === 0) return "[]";
  var doc = app.activeDocument;
  var plLayer = getLayerByName(doc, "PLACEHOLDERS");
  if (!plLayer) return "[]";
  var out = [];
  for (var i = 0; i < plLayer.pageItems.length; i++) {
    var item = plLayer.pageItems[i];
    if (item.parent != plLayer) continue;
    if (item.typename !== "GroupItem") continue;
    if (groupOrChildHasEffect(item)) {
      var eff = "unknown";
      try {
        if (item.effects && item.effects.length > 0) eff = item.effects[0].name;
        else if (item.envelope != null) eff = "envelope";
      } catch (e) {}
      out.push('{"name":"' + vfEscapeJson(item.name) + '","effect":"' + vfEscapeJson(eff) + '"}');
    }
  }
  return "[" + out.join(",") + "]";
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

// Copy items into the export layer as TWO independent parts (per layer):
//   1) fully-inside objects placed directly, preserving their internal order;
//   2) a dedicated clipping group (clipName) for objects that spill beyond the
//      artboard, also preserving their internal order.
// The clip group is appended AFTER the normal objects, so in the Layers panel
// it sits just below this layer's content. Callers add layers in the desired
// top-to-bottom order; each call appends to the back (PLACEATEND), so the
// final stacking is exactly: FG, FG_CLIP, PLACEHOLDERS, ART_CLIP, BG, BG_CLIP.
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

  // Pass 1: fully-inside items, placed directly (internal order preserved).
  var lastUnmasked = null;
  for (var i = 0; i < items.length; i++) {
    var b = items[i].bounds;
    if (!isInArtboard(b, abRect)) continue;
    if (!isFullyInside(b, abRect)) continue;

    var copy = copyToLayer(items[i].item, exportLayer, abRect, scale);

    // Carry over group-level opacity / blending mode (set on the placeholder).
    if (items[i].opacity !== undefined) {
      copy.opacity = items[i].opacity;
      copy.blendingMode = items[i].blendingMode;
    }

    // For placeholder groups with appearance effects, drop the hidden S/SK
    // template / backdrop so only the generated ART keeps the group's effects.
    if (items[i].applyGroupEffect) {
      keepOnlyArt(copy);
      gEffectGroups.push(copy);
    }

    if (lastUnmasked) copy.move(lastUnmasked, ElementPlacement.PLACEAFTER);
    else copy.move(exportLayer, ElementPlacement.PLACEATEND);
    lastUnmasked = copy;
  }

  // Pass 2: overflow items collected into a dedicated clip group (internal
  // order preserved). The group is appended after the normal items above.
  var clipGroup = null;
  for (var j = 0; j < items.length; j++) {
    var b2 = items[j].bounds;
    if (!isInArtboard(b2, abRect)) continue;
    if (isFullyInside(b2, abRect)) continue;

    if (!clipGroup)
      clipGroup = createClipGroup(
        exportLayer,
        exportWidth,
        exportHeight,
        clipName,
      );

    var copy2 = copyToLayer(items[j].item, exportLayer, abRect, scale);
    if (items[j].opacity !== undefined) {
      copy2.opacity = items[j].opacity;
      copy2.blendingMode = items[j].blendingMode;
    }
    // For placeholder groups with appearance effects, drop the hidden S/SK
    // template / backdrop so only the generated ART keeps the group's effects.
    if (items[j].applyGroupEffect) {
      keepOnlyArt(copy2);
      gEffectGroups.push(copy2);
    }
    copy2.move(clipGroup, ElementPlacement.PLACEATEND);
  }

  if (clipGroup) {
    // groupItems.add() inserts the new group at the FRONT (top) of the layer,
    // which would put <layer>_CLIP above this layer's own content (and above
    // everything else). Move it to the back so it sits just below this layer's
    // normal objects and above the next layer's content — giving the required
    // panel order: <layer>, <layer>_CLIP.
    clipGroup.move(exportLayer, ElementPlacement.PLACEATEND);
    applyClip(clipGroup);
  }
}

// Returns a JSON array of artboard names (used by the "Export Selected" UI).
function getArtboardNames() {
  if (app.documents.length === 0) return "[]";
  var doc = app.activeDocument;
  var parts = [];
  for (var a = 0; a < doc.artboards.length; a++) {
    parts.push('"' + vfEscapeJson(doc.artboards[a].name) + '"');
  }
  return "[" + parts.join(",") + "]";
}

// Open a folder picker and return the chosen path (raw string), or "" if the
// user cancels. When `startPath` is provided, the dialog opens there (so
// "Change Path" resumes at the previously chosen folder). Used by the panel's
// "choose export folder" button.
function selectExportFolder(startPath) {
  var start = null;
  if (startPath && startPath.length > 0) {
    try {
      start = new Folder(startPath);
    } catch (e) {}
  }
  var f = Folder.selectDialog("Choose export folder", start);
  if (!f) return "";
  return f.fsName;
}

function exportArtboards(prefix, selectedIndices, folderPath, artboardMetaJson) {
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

  // Artboard templates (title/keywords) come from the project .vfmeta file,
  // passed in by the panel as a JSON object string keyed by artboard name.
  var artboardMeta = {};
  if (artboardMetaJson && artboardMetaJson.length > 0) {
    try {
      artboardMeta = eval("(" + artboardMetaJson + ")");
    } catch (e) {
      artboardMeta = {};
    }
  }

  // Use the folder chosen in the panel UI when provided; otherwise fall back
  // to a folder picker (keeps the old behavior if called without a path).
  var exportFolder = null;
  if (folderPath && folderPath.length > 0) {
    exportFolder = new Folder(folderPath);
  } else {
    exportFolder = Folder.selectDialog("Choose export folder");
  }
  if (!exportFolder) return vfResult();

  var srcDoc = app.activeDocument;
  var abCount = srcDoc.artboards.length;
  var abNames = [];
  var abRects = [];

  for (var a = 0; a < abCount; a++) {
    abNames[a] = srcDoc.artboards[a].name;
    abRects[a] = srcDoc.artboards[a].artboardRect;
  }

  // Resolve source layers and item bounds ONCE. geometricBounds is cheap
  // (no stroke/fill expansion) and is constant across artboards, so caching
  // it here avoids the N(artboards) x M(items) recomputation in the loop.
  // Overflow beyond the artboard is still clipped by the artboard mask below,
  // so using geometric (vs visible) bounds does not change the output.
  var bgLayer = getLayerByName(srcDoc, "BG");
  var plLayer = getLayerByName(srcDoc, "PLACEHOLDERS");
  var fgLayer = getLayerByName(srcDoc, "FG");

  var bgItems = [];
  if (bgLayer && !bgLayer.guideLayer) {
    for (var bi = 0; bi < bgLayer.pageItems.length; bi++) {
      bgItems.push({
        item: bgLayer.pageItems[bi],
        bounds: bgLayer.pageItems[bi].geometricBounds,
      });
    }
  }

  var fgItems = [];
  if (fgLayer && !fgLayer.guideLayer) {
    for (var fi = 0; fi < fgLayer.pageItems.length; fi++) {
      fgItems.push({
        item: fgLayer.pageItems[fi],
        bounds: fgLayer.pageItems[fi].geometricBounds,
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

        // Find the generated content (ART child or generated clipping group)
        // to base placement/clip decisions on its bounds (not the whole group,
        // which may include a large hidden S/SK template).
        var contentItem = null;
        var genCG = findGeneratedCG(grp);
        if (genCG) {
          contentItem = genCG;
        } else {
          for (var pi = 0; pi < grp.pageItems.length; pi++) {
            if (grp.pageItems[pi].name == "ART") {
              contentItem = grp.pageItems[pi];
              break;
            }
          }
        }

        if (contentItem) {
          // Copy the WHOLE group so any appearance effects applied to it (or a
          // descendant) — e.g. Distort & Transform -> Roughen — transfer to the
          // export. keepOnlyArt() later strips the hidden S/SK template and any
          // backdrop, leaving the generated ART carrying the group's effects.
          plItems.push({
            item: grp,
            bounds: contentItem.geometricBounds,
            opacity: grpOpacity,
            blendingMode: grpBlend,
            applyGroupEffect: true,
          });
          continue;
        }
      } else {
        plItems.push({
          item: item,
          bounds: item.geometricBounds,
        });
      }
    }
  }

  // Which artboards to export: a caller-supplied subset, or all by default.
  var indices = [];
  if (selectedIndices && selectedIndices.length > 0) {
    for (var si = 0; si < selectedIndices.length; si++) {
      var sidx = selectedIndices[si];
      if (sidx >= 0 && sidx < abCount) indices.push(sidx);
    }
  } else {
    for (var ai = 0; ai < abCount; ai++) indices.push(ai);
  }

  for (var li2 = 0; li2 < indices.length; li2++) {
    var a = indices[li2];
    var abRect = abRects[a];
    var abWidth = abRect[2] - abRect[0];
    var abHeight = abRect[1] - abRect[3];
    var scale = getScaleTo25MP(abWidth, abHeight);
    var exportWidth = abWidth * scale;
    var exportHeight = abHeight * scale;

    var abName = abNames[a] || "artboard_" + a;
    var safeName = sanitizeFilename(prefix + "_" + abName);
    if (safeName.length === 0) safeName = "export_" + a;

    // Reset the per-artboard collection of effect groups before this board's
    // transfers; they are expanded once, after all copies, below.
    gEffectGroups = [];

    var tempDoc = app.documents.add(
      DocumentColorSpace.RGB,
      exportWidth,
      exportHeight,
    );
    tempDoc.artboards[0].artboardRect = [0, exportHeight, exportWidth, 0];
    var exportLayer = tempDoc.layers[0];

    // Собираем экспортный слой в ФИКСИРОВАННОМ порядке (сверху вниз панели
    // Layers): FG, FG_CLIP, PLACEHOLDERS, ART_CLIP, BG, BG_CLIP.
    // Каждый слой копируется в две части — обычные объекты, затем clipping
    // group для объектов вне артборда (см. copyLayerItems). Так как каждый
    // вызов добавляет в "спину" (PLACEATEND), итоговый порядок совпадает с
    // нужным: FG выше всего, BG_CLIP — самый нижний.
    var exportOrder = [
      { layer: fgLayer, items: fgItems, clip: "FG_CLIP" },
      { layer: plLayer, items: plItems, clip: "ART_CLIP" },
      { layer: bgLayer, items: bgItems, clip: "BG_CLIP" },
    ];
    for (var li = 0; li < exportOrder.length; li++) {
      var ord = exportOrder[li];
      if (ord.layer && ord.items.length > 0) {
        copyLayerItems(
          ord.items,
          exportLayer,
          abRect,
          scale,
          exportWidth,
          exportHeight,
          ord.clip,
        );
      }
    }

    // All transfers done — now bake the live appearance effects (e.g. Distort &
    // Transform -> Roughen) into real geometry via Expand Appearance, once.
    expandAllEffects();

    // Подготовить временный документ к экспорту.
    // tempDoc уже активен сразу после app.documents.add(), поэтому лишний
    // activate() (переключение контекста) и лишний сброс выделения перед
    // selectall убраны — selectall сам очищает выделение.
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

  // Build ONE metadata.svg for the whole export, combining each artboard's
  // template (from .vfmeta) with the generated artwork metadata (from
  // MASTER_METADATA). Skipped silently if no artwork metadata exists.
  try {
    buildMetadataSvg(
      srcDoc,
      exportFolder,
      prefix,
      indices,
      abNames,
      abRects,
      [fgLayer, plLayer, bgLayer],
      artboardMeta,
    );
  } catch (e) {
    vfError("Metadata SVG failed: " + e.message);
  }

  vfSuccess(
    "Export complete: " +
      indices.length +
      " file(s)" +
      (indices.length === abCount ? "" : " (of " + abCount + ")") +
      ". For each artboard an EPS + JPG preview pair was created, scaled to 25 MP.",
  );
  return vfResult();
}

// Build a single metadata.svg next to the exported files. For each exported
// artboard: title = titleTemplate with "*" replaced by the joined generated
// object names; keywords = template keywords + generated keywords (deduped,
// template first). Writes <artboard> groups with <title>/<text> children.
function buildMetadataSvg(
  doc,
  exportFolder,
  prefix,
  indices,
  abNames,
  abRects,
  layers,
  artboardMeta,
) {
  var entries = [];
  for (var i = 0; i < indices.length; i++) {
    var a = indices[i];
    var abName = abNames[a] || "artboard_" + a;
    var meta = artboardMeta[abName] || {};
    var titleTemplate = meta.titleTemplate || "";
    var kwTemplate = meta.keywordsTemplate || "";

    // Generated artwork metadata for this artboard.
    var collected = collectArtboardMetadata(doc, abRects[a], layers);
    var objectNames = collected.objectNames;
    var generatedKw = collected.keywords;

    // Title: replace "*" with the joined object names.
    var title = titleTemplate;
    if (title.length > 0) {
      title = title.replace(/\*/g, objectNames.join(", "));
    } else {
      title = objectNames.join(", ");
    }

    // Keywords: template first, then generated, deduped.
    var tmplKw = [];
    if (kwTemplate.length > 0) {
      var parts = kwTemplate.split(",");
      for (var p = 0; p < parts.length; p++) {
        var t = parts[p].replace(/^\s+|\s+$/g, "");
        if (t.length > 0) tmplKw.push(t);
      }
    }
    var seen = {};
    var keywords = [];
    for (var k = 0; k < tmplKw.length; k++) {
      if (!seen[tmplKw[k]]) {
        seen[tmplKw[k]] = true;
        keywords.push(tmplKw[k]);
      }
    }
    for (var g = 0; g < generatedKw.length; g++) {
      if (!seen[generatedKw[g]]) {
        seen[generatedKw[g]] = true;
        keywords.push(generatedKw[g]);
      }
    }

    entries.push(
      '  <g class="artboard" data-name="' +
        vfEscapeXml(abName) +
        '">\n' +
        "    <title>" +
        vfEscapeXml(title) +
        "</title>\n" +
        '    <text class="keywords">' +
        vfEscapeXml(keywords.join(", ")) +
        "</text>\n" +
        "  </g>",
    );
  }

  if (entries.length === 0) return;

  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="adobe:stock:meta">\n' +
    entries.join("\n") +
    "\n</svg>\n";

  var svgFile = new File(exportFolder.fsName + "/" + sanitizeFilename(prefix) + "_metadata.svg");
  svgFile.open("w");
  svgFile.write(svg);
  svgFile.close();
}

// Escape a string for inclusion inside XML/SVG text content. Built from char
// codes so the source contains no raw entity literals (which the editor would
// otherwise mangle). amp=38, lt=60, gt=62, quot=34.
function vfEscapeXml(s) {
  var amp = String.fromCharCode(38);
  var str = String(s);
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c === amp) out += amp + "amp;";
    else if (c === "<") out += amp + "lt;";
    else if (c === ">") out += amp + "gt;";
    else if (c === '"') out += amp + "quot;";
    else out += c;
  }
  return out;
}
