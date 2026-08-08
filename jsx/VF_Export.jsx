//
#target illustrator
$.evalFile(File($.fileName).parent + "/VF_Common.jsx");
// Target artwork area in pixels (~24 MP). This is the Bounding Box / Artwork
// size, not the Artboard size. Stays below Shutterstock's 25 MP limit and
// within Adobe Stock / iStock Getty compatibility.
var TARGET_EXPORT_PIXELS = 20000000;

// Placeholder groups copied whole (with their appearance effects) during the
// current artboard's export. After ALL transfers finish, Expand Appearance is
// run on each so the live effect is baked into geometry. Reset per artboard.
var gEffectGroups = [];

// Safe string coercion for ExtendScript: always returns a primitive string,
// never a String object wrapper. String objects in ExtendScript do not reliably
// inherit String.prototype methods, so we unwrap by rebuilding char-by-char.
function asString(v) {
  if (v === null || v === undefined) return "";
  var s = v + "";
  if (typeof s === "object" && s !== null) {
    var result = "";
    for (var i = 0; i < s.length; i++) {
      result += s.charAt(i);
    }
    return result;
  }
  return s;
}

// Clean placeholder text for keywords: letters and spaces only, collapse
// spaces, no method chaining on potentially unsafe values.
function cleanPlaceholderText(text) {
  var s = asString(text);
  if (!s) return "";

  // Replace non-letter/non-space with space, build result char by char.
  var lettersOnly = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === " ") {
      lettersOnly += c;
    } else {
      lettersOnly += " ";
    }
  }

  // Collapse multiple spaces.
  var collapsed = "";
  var prevSpace = false;
  for (var j = 0; j < lettersOnly.length; j++) {
    if (lettersOnly.charAt(j) === " ") {
      if (!prevSpace) {
        collapsed += " ";
        prevSpace = true;
      }
    } else {
      collapsed += lettersOnly.charAt(j);
      prevSpace = false;
    }
  }

  // Trim left.
  while (collapsed.length > 0 && collapsed.charAt(0) === " ") {
    collapsed = collapsed.substring(1);
  }
  // Trim right.
  while (collapsed.length > 0 && collapsed.charAt(collapsed.length - 1) === " ") {
    collapsed = collapsed.substring(0, collapsed.length - 1);
  }

  return collapsed;
}

// ---- Progress reporting ----
// Writes the latest progress message to a separate file that the CEP panel
// polls during long operations. The file is overwritten (not appended) so
// the panel always sees the current status.
var _progressPath = null;
function progressLog(msg) {
  try {
    if (_progressPath === null) {
      _progressPath = File($.fileName).parent + "/export_progress.txt";
    }
    var f = new File(_progressPath);
    f.open("w");
    f.writeln(msg || "");
    f.close();
  } catch (e) {}
}
function clearProgress() {
  try {
    if (_progressPath === null) {
      _progressPath = File($.fileName).parent + "/export_progress.txt";
    }
    var f = new File(_progressPath);
    f.open("w");
    f.close();
  } catch (e) {}
}

// Short snapshot of the active document state for the log.
function _docState(label) {
  var ad = null;
  try { ad = app.activeDocument; } catch (e) {}
  var info = label + ": activeDoc=";
  if (ad) {
    info += '"' + ad.name + '"';
    try { info += " path=" + (ad.fullName || "(unsaved)"); } catch (e) {}
    try { info += " modified=" + ad.modified; } catch (e) {}
  } else {
    info += "(none)";
  }
  return info;
}

function sanitizeFilename(name) {
  name = String(name || "")
    .replace(/[^a-zA-Z0-9_ ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "");
  if (name.length > 0) {
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }
  name = name.replace(/ /g, "_");
  name = name.replace(/^_+|_+$/g, "");
  name = name.replace(/_+/g, "_");
  return name;
}

function _pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// Replace visually similar Cyrillic characters with Latin equivalents in English text.
// Only replaces if the text appears to be primarily English (more Latin than Cyrillic chars).
function disambiguateCyrillic(text) {
  if (!text) return text;
  text = String(text);
  
  // Count Latin and Cyrillic characters to determine language
  var latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  var cyrillicCount = (text.match(/[\u0410-\u044F\u042E\u040E]/g) || []).length;
  
  // Only replace if text appears to be English (more Latin than Cyrillic)
  if (latinCount > cyrillicCount) {
    text = text
      .replace(/\u0421/g, "C")
      .replace(/\u0441/g, "c")
      .replace(/\u0410/g, "A")
      .replace(/\u0430/g, "a")
      .replace(/\u0415/g, "E")
      .replace(/\u0435/g, "e")
      .replace(/\u041E/g, "O")
      .replace(/\u043E/g, "o")
      .replace(/\u0420/g, "P")
      .replace(/\u0440/g, "p")
      .replace(/\u0425/g, "X")
      .replace(/\u0445/g, "x")
      .replace(/\u0412/g, "B")
      .replace(/\u041A/g, "K")
      .replace(/\u041C/g, "M")
      .replace(/\u0422/g, "T")
      .replace(/\u044E/g, "y");
  }
  return text;
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
    if (child.clipping) continue;
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
  var copy;

  try {
    copy = item.duplicate(destLayer, ElementPlacement.PLACEATEND);
  } catch (e) {
    var parentPath = [];
    try {
      var p = item.parent;
      while (p) {
        parentPath.push(p.name + "(" + p.typename + ")");
        p = p.parent;
      }
    } catch (ex) {}
    throw e;
  }

  // Convert text to outlines before any transforms.
  // Illustrator can incorrectly scale some large TextFrame objects.
  // Working with outlines avoids this export bug.
  if (copy.typename === "TextFrame") {
    copy = copy.createOutline();
  }

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

function computeExportRangeString(indices, abCount) {
  if (!indices || indices.length === 0) return "unknown";
  if (indices.length === abCount) return "all";
  if (indices.length === 1) return _pad2(indices[0] + 1);
  var minIdx = indices[0];
  var maxIdx = indices[0];
  for (var i = 1; i < indices.length; i++) {
    if (indices[i] < minIdx) minIdx = indices[i];
    if (indices[i] > maxIdx) maxIdx = indices[i];
  }
  return _pad2(minIdx + 1) + "-" + _pad2(maxIdx + 1);
}

// Rectangle mask (first item) used to clip a layer to the artboard.
function createClipGroup(parentLayer, width, height, groupName) {
  var clipGroup = null;
  try {
    clipGroup = parentLayer.groupItems.add();
  } catch (e) {
    var parentPath = [];
    try {
      var pp = parentLayer;
      while (pp) {
        parentPath.push(pp.name + "(" + pp.typename + ")");
        pp = pp.parent;
      }
    } catch (ex) {}
    var clipErrMsg =
      "Cannot create clip group in layer '" +
      (parentLayer ? parentLayer.name : "(none)") +
      "' parents=" +
      parentPath.join(" > ") +
      " layer.locked=" +
      (parentLayer ? parentLayer.locked : "n/a") +
      " layer.hidden=" +
      (parentLayer ? parentLayer.hidden : "n/a") +
      " error=" +
      jsonStringify(e.message);
    throw new Error(clipErrMsg);
  }
  try {
    clipGroup.name = groupName;
  } catch (e) {
    var nameErrMsg =
      "Cannot name clip group in layer '" +
      (parentLayer ? parentLayer.name : "(none)") +
      "': group=" +
      jsonStringify(clipGroup.name) +
      " error=" +
      jsonStringify(e.message);
    throw new Error(nameErrMsg);
  }

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
    } else if (items[i].isContainer) {
      function stripTemplatesInContainer(grp) {
        for (var ci = 0; ci < grp.groupItems.length; ci++) {
          var child = grp.groupItems[ci];
          if (child.clipped) continue;
          if (child.typename !== "GroupItem") continue;
          var hasArt = false;
          for (var pi = 0; pi < child.pageItems.length; pi++) {
            if (child.pageItems[pi].name === "ART") { hasArt = true; break; }
          }
          if (hasArt) {
            keepOnlyArt(child);
          } else {
            stripTemplatesInContainer(child);
          }
        }
      }
      if (copy.typename === "GroupItem") {
        try { stripTemplatesInContainer(copy); } catch (e) {}
      }
      if (items[i].expandEffects) {
        gEffectGroups.push(copy);
      }
    } else if (items[i].expandEffects) {
      gEffectGroups.push(copy);
    }

    if (lastUnmasked) {
      try {
        copy.move(lastUnmasked, ElementPlacement.PLACEAFTER);
      } catch (e) {
        var moveParentPath = [];
        try {
          var mp = copy.parent;
          while (mp) {
            moveParentPath.push(mp.name + "(" + mp.typename + ")");
            mp = mp.parent;
          }
        } catch (ex) {}
        var moveErrMsg =
          "Cannot move item in document '" +
          tempDoc.name +
          "' artboard '" +
          abName +
          "': item=" +
          jsonStringify(copy.name) +
          " type=" +
          copy.typename +
          " parents=" +
          moveParentPath.join(" > ") +
          " destLayer=" +
          (exportLayer ? exportLayer.name : "(none)") +
          " error=" +
          jsonStringify(e.message);
        vfError(moveErrMsg);
        progressLog("Export failed: " + moveErrMsg);
        throw e;
      }
    } else {
      try {
        copy.move(exportLayer, ElementPlacement.PLACEATEND);
      } catch (e) {
        var moveParentPath2 = [];
        try {
          var mp2 = copy.parent;
          while (mp2) {
            moveParentPath2.push(mp2.name + "(" + mp2.typename + ")");
            mp2 = mp2.parent;
          }
        } catch (ex) {}
        var moveErrMsg2 =
          "Cannot move item in document '" +
          tempDoc.name +
          "' artboard '" +
          abName +
          "': item=" +
          jsonStringify(copy.name) +
          " type=" +
          copy.typename +
          " parents=" +
          moveParentPath2.join(" > ") +
          " destLayer=" +
          (exportLayer ? exportLayer.name : "(none)") +
          " error=" +
          jsonStringify(e.message);
        vfError(moveErrMsg2);
        progressLog("Export failed: " + moveErrMsg2);
        throw e;
      }
    }
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
    } else if (items[j].isContainer) {
      function stripTemplatesInContainer2(grp) {
        for (var ci = 0; ci < grp.groupItems.length; ci++) {
          var child = grp.groupItems[ci];
          if (child.clipped) continue;
          if (child.typename !== "GroupItem") continue;
          var hasArt = false;
          for (var pi = 0; pi < child.pageItems.length; pi++) {
            if (child.pageItems[pi].name === "ART") { hasArt = true; break; }
          }
          if (hasArt) {
            keepOnlyArt(child);
          } else {
            stripTemplatesInContainer2(child);
          }
        }
      }
      if (copy2.typename === "GroupItem") {
        try { stripTemplatesInContainer2(copy2); } catch (e) {}
      }
      if (items[j].expandEffects) {
        gEffectGroups.push(copy2);
      }
    } else if (items[j].expandEffects) {
      gEffectGroups.push(copy2);
    }
    try {
      copy2.move(clipGroup, ElementPlacement.PLACEATEND);
    } catch (e) {
      var clipMovePath = [];
      try {
        var cmp = clipGroup.parent;
        while (cmp) {
          clipMovePath.push(cmp.name + "(" + cmp.typename + ")");
          cmp = cmp.parent;
        }
      } catch (ex) {}
      var clipMoveMsg =
        "Cannot move item to clip group in document '" +
        tempDoc.name +
        "' artboard '" +
        abName +
        "': item=" +
        jsonStringify(copy2.name) +
        " type=" +
        copy2.typename +
        " clipGroup=" +
        jsonStringify(clipGroup.name) +
        " clipGroup.parents=" +
        clipMovePath.join(" > ") +
        " error=" +
        jsonStringify(e.message);
      vfError(clipMoveMsg);
      progressLog("Export failed: " + clipMoveMsg);
      throw e;
    }
  }

  if (clipGroup) {
    try {
      if (lastUnmasked && lastUnmasked.parent == exportLayer) {
        clipGroup.move(lastUnmasked, ElementPlacement.PLACEAFTER);
      } else {
        clipGroup.move(exportLayer, ElementPlacement.PLACEATEND);
      }
    } catch (e) {
      var clipParentPath = [];
      try {
        var cp = clipGroup.parent;
        while (cp) {
          clipParentPath.push(cp.name + "(" + cp.typename + ")");
          cp = cp.parent;
        }
      } catch (ex) {}
      var clipErrMsg =
        "Cannot move clip group in document '" +
        tempDoc.name +
        "' artboard '" +
        abName +
        "': clipGroup=" +
        jsonStringify(clipGroup.name) +
        " type=" +
        clipGroup.typename +
        " parents=" +
        clipParentPath.join(" > ") +
        " exportLayer=" +
        (exportLayer ? exportLayer.name : "(none)") +
        " exportLayer.locked=" +
        (exportLayer ? exportLayer.locked : "n/a") +
        " exportLayer.hidden=" +
        (exportLayer ? exportLayer.hidden : "n/a") +
        " error=" +
        jsonStringify(e.message);
      vfError(clipErrMsg);
      progressLog("Export failed: " + clipErrMsg);
      throw e;
    }
    applyClip(clipGroup);
  }
}

// Returns a JSON array of artboard names (used by the "Export Selected" UI).
// Format: "01_ArtboardName" (1-based index with zero-padded 2-digit prefix).
function getArtboardNames() {
  if (app.documents.length === 0) return "[]";
  var doc = app.activeDocument;
  var parts = [];
  for (var a = 0; a < doc.artboards.length; a++) {
    var idx = a + 1;
    var idxStr = (idx < 10 ? "0" : "") + idx;
    var name = doc.artboards[a].name || "artboard_" + a;
    parts.push('"' + vfEscapeJson(idxStr + "_" + name) + '"');
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

  function validateExportStructure(doc) {
    var layers = doc.layers;
    var layerNames = {};
    for (var li = 0; li < layers.length; li++) {
      layerNames[layers[li].name] = layers[li];
    }

    var required = ["BG", "PLACEHOLDERS", "FG"];
    for (var ri = 0; ri < required.length; ri++) {
      if (!layerNames[required[ri]]) {
        return ['Layer "' + required[ri] + '" not found.'];
      }
    }

    var plLayer = layerNames["PLACEHOLDERS"];
    if (plLayer) {
      if (plLayer.guideLayer) {
        return [
          'Layer "PLACEHOLDERS" is a guide layer. It must be a normal layer.'
        ];
      }
      if (plLayer.name === "VF_METADATA") {
        return ['Layer "PLACEHOLDERS" has unexpected name "VF_METADATA".'];
      }
      function selectAndCenter(item) {
        try {
          app.activeDocument.selection = null;
          item.selected = true;
        } catch (e) {}
        try {
          var b = item.visibleBounds || item.geometricBounds;
          if (b && app.activeDocument.activeView) {
            app.activeDocument.activeView.bounds = [b[0], b[1], b[2], b[3]];
          }
        } catch (e) {}
      }

      for (var pi = 0; pi < plLayer.pageItems.length; pi++) {
        var topItem = plLayer.pageItems[pi];
        if (topItem.parent != plLayer) continue;

        if (topItem.typename !== "GroupItem" && topItem.typename !== "TextFrame") {
          selectAndCenter(topItem);
          return [
            "Invalid PLACEHOLDERS structure.\n\n" +
              "Object:\n" +
              "Name: " + topItem.name + "\n" +
              "Type: " + topItem.typename + "\n\n" +
              "Reason:\n" +
              "Top-level item must be either a GroupItem or TextFrame."
          ];
        }

        if (topItem.typename === "TextFrame") continue;

        if (topItem.typename === "GroupItem") {
          var children = [];
          for (var ci = 0; ci < topItem.pageItems.length; ci++) {
            if (topItem.pageItems[ci].parent === topItem) {
              children.push(topItem.pageItems[ci]);
            }
          }

          if (children.length !== 2) {
            var nestedPlaceholders = [];
            findPlaceholderGroups(topItem, nestedPlaceholders);
            if (nestedPlaceholders.length === 0) {
              selectAndCenter(topItem);
              var pathParts = [];
              var p = topItem;
              while (p) {
                pathParts.unshift(p.name);
                p = p.parent;
              }
              var pathStr = pathParts.join(" / ");
              var childInfo = "";
              for (var ci = 0; ci < children.length; ci++) {
                childInfo += (ci + 1) + ". " + children[ci].typename + " \"" + children[ci].name + "\"\n";
              }
              return [
                "Invalid PLACEHOLDERS structure.\n\n" +
                  "Object index: " + pi + "\n" +
                  "Object:\n" +
                  "Name: " + topItem.name + "\n" +
                  "Type: GroupItem\n" +
                  "Parent: " + (topItem.parent ? topItem.parent.name : "(none)") + "\n" +
                  "Path: " + pathStr + "\n" +
                  "Is top-level: " + (topItem.parent === plLayer ? "yes" : "no") + "\n\n" +
                  "Direct children (" + children.length + "):\n" + childInfo +
                  "Reason:\n" +
                  "Placeholder group must contain exactly 2 direct children."
              ];
            }
            continue;
          }

          var templateCount = 0;
          var templateVisible = false;

          function searchForTemplate(node) {
            if (isTemplateName(node.name || "")) {
              templateCount++;
              if (node.visible) templateVisible = true;
            }
            if (node.typename === "GroupItem") {
              var items = node.pageItems || [];
              for (var i = 0; i < items.length; i++) {
                searchForTemplate(items[i]);
              }
            }
          }

          for (var ci = 0; ci < children.length; ci++) {
            searchForTemplate(children[ci]);
          }

          if (templateCount !== 1) {
            selectAndCenter(topItem);
            return [
              "Invalid PLACEHOLDERS structure.\n\n" +
                "Object:\n" +
                "Name: " + topItem.name + "\n" +
                "Type: GroupItem\n" +
                "Parent: " + (topItem.parent ? topItem.parent.name : "(none)") + "\n\n" +
                "Reason:\n" +
                "Placeholder group must contain exactly:\n" +
                "- one hidden template (S/SK/S1/SK1...)"
            ];
          }

          if (templateVisible) {
            selectAndCenter(topItem);
            return [
              "Invalid PLACEHOLDERS structure.\n\n" +
                "Object:\n" +
                "Name: " + topItem.name + "\n" +
                "Type: GroupItem\n" +
                "Parent: " + (topItem.parent ? topItem.parent.name : "(none)") + "\n\n" +
                "Reason:\n" +
                "Placeholder group must contain exactly:\n" +
                "- one hidden template (S/SK/S1/SK1...)"
            ];
          }
        }
      }
    }

    var vfMeta = layerNames["VF_METADATA"];
    if (vfMeta) {
      for (var vi = 0; vi < vfMeta.pageItems.length; vi++) {
        var vfItem = vfMeta.pageItems[vi];
        if (vfItem.typename !== "TextFrame") {
          return ['Unexpected item in VF_METADATA: name=' + vfItem.name + ' type=' + vfItem.typename];
        }
      }
    }

    return [];
  }

  function exportArtboards(prefix, selectedIndices, folderPath, csvOnly, includeJpg, csvEnabled) {
    VF_ERRORS = [];
    VF_SUCCESS = "";
    includeJpg = !!includeJpg;
    csvEnabled = !!csvEnabled;

    if (app.documents.length === 0) {
      vfError("No document.");
      return vfResult();
    }

    if (!prefix || prefix.length === 0) {
      prefix = prompt("Enter Filename Prefix:");
      if (prefix === null) {
        vfError("Export cancelled.");
        return vfResult();
      }
      if (!prefix || prefix.length === 0) prefix = "export";
    }

    // Use the folder chosen in the panel UI when provided; otherwise fall back
    // to a folder picker (keeps the old behavior if called without a path).
    var exportFolder = null;
    if (folderPath && folderPath.length > 0) {
      exportFolder = new Folder(folderPath);
    } else {
      exportFolder = Folder.selectDialog("Choose export folder");
    }
    if (!exportFolder) {
      vfError("Export cancelled.");
      return vfResult();
    }

    // Guarantee the panel always receives a result, even if anything below
    // throws (e.g. saveAs/exportFile inside the loop). Without this, an
    // exception would abort the function, the evalScript callback would never
    // fire, and the export lock would never be released.
    try {
      clearProgress();
      progressLog("Starting export...");

    var srcDoc = app.activeDocument;

  // Validate document structure before export.
  var structureErrors = validateExportStructure(srcDoc);
  if (structureErrors.length > 0) {
    var errMsg = "Document structure invalid: " + structureErrors.join("; ");
    vfError(errMsg);
    progressLog("Export failed: invalid document structure");
    return vfResult();
  }

  progressLog("Structure valid.");
  vfSuccess("Structure valid.");

  var abCount = srcDoc.artboards.length;
  var abNames = [];
  var abRects = [];

  for (var a = 0; a < abCount; a++) {
    abNames[a] = srcDoc.artboards[a].name;
    abRects[a] = srcDoc.artboards[a].artboardRect;
  }

  progressLog("Scanning " + abCount + " artboard(s)...");

  // Resolve source layers and item bounds ONCE. geometricBounds is cheap
  // (no stroke/fill expansion) and is constant across artboards, so caching
  // it here avoids the N(artboards) x M(items) recomputation in the loop.
  // Overflow beyond the artboard is still clipped by the artboard mask below,
  // so using geometric (vs visible) bounds does not change the output.
  var bgLayer = getLayerByName(srcDoc, "BG");
  var plLayer = getLayerByName(srcDoc, "PLACEHOLDERS");
  var fgLayer = getLayerByName(srcDoc, "FG");

  var bgItems = [];
  if (bgLayer && !bgLayer.guideLayer && bgLayer.name !== "VF_METADATA") {
    for (var bi = 0; bi < bgLayer.pageItems.length; bi++) {
      bgItems.push({
        item: bgLayer.pageItems[bi],
        bounds: bgLayer.pageItems[bi].geometricBounds,
      });
    }
  }

  var fgItems = [];
  if (fgLayer && !fgLayer.guideLayer && fgLayer.name !== "VF_METADATA") {
    for (var fi = 0; fi < fgLayer.pageItems.length; fi++) {
      fgItems.push({
        item: fgLayer.pageItems[fi],
        bounds: fgLayer.pageItems[fi].geometricBounds,
      });
    }
  }

  var plItems = [];
  if (plLayer && !plLayer.guideLayer && plLayer.name !== "VF_METADATA") {
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
          var foundArt = null;
          function findArtRecursive(container) {
            for (var i = 0; i < container.pageItems.length; i++) {
              if (container.pageItems[i].name == "ART") return container.pageItems[i];
            }
            for (var j = 0; j < (container.groupItems || []).length; j++) {
              var hit = findArtRecursive(container.groupItems[j]);
              if (hit) return hit;
            }
            return null;
          }
          foundArt = findArtRecursive(grp);
          if (foundArt) {
            contentItem = foundArt;
          }
        }

        if (contentItem) {
          var nestedPlaceholders = [];
          findPlaceholderGroups(grp, nestedPlaceholders);
          var isContainer =
            nestedPlaceholders.length > 0 &&
            nestedPlaceholders[0] !== grp;
          var containerHasEffect = false;
          if (isContainer) {
            try {
              containerHasEffect = groupOrChildHasEffect(grp);
            } catch (e) {}
          }

          plItems.push({
            item: grp,
            bounds: contentItem.geometricBounds,
            opacity: grpOpacity,
            blendingMode: grpBlend,
            applyGroupEffect: !isContainer,
            expandEffects: isContainer && containerHasEffect,
            isContainer: isContainer,
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

  var rangeStr = computeExportRangeString(indices, abCount);

// CSV-only export: skip the EPS/JPG export entirely and just build the
// Adobe Stock CSV for the chosen artboards.
// Respect csvEnabled flag - if false, don't export CSV even in csvOnly mode.
if (csvOnly) {
  if (!csvEnabled) {
    vfSuccess("Exported:\n0 EPS\n0 CSV (CSV disabled)");
    return vfResult();
  }
  try {
    buildStockCsv(
      srcDoc,
      exportFolder,
      prefix,
      indices,
      abNames,
      abRects,
      [fgLayer, plLayer, bgLayer],
      rangeStr,
    );
  } catch (e) {
    vfError("Stock CSV failed: " + e.message);
  }
  vfSuccess("Exported:\n1 CSV");
  return vfResult();
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
      var boardIndex = a + 1;
      var boardIndexStr = boardIndex < 10 ? "0" + boardIndex : "" + boardIndex;
      var safeName = sanitizeFilename(boardIndexStr + "_" + prefix + "_" + abName);
      if (safeName.length === 0) safeName = "export_" + a;

      progressLog(
        "Exporting artboard " + (li2 + 1) + " of " + indices.length + ": " + abName
      );

      // Reset the per-artboard collection of effect groups before this board's
      // transfers; they are expanded once, after all copies, below.
      gEffectGroups = [];

     var tempDoc = app.documents.add(
       DocumentColorSpace.RGB,
       exportWidth,
       exportHeight,
     );
      tempDoc.artboards[0].artboardRect = [0, exportHeight, exportWidth, 0];
       var exportLayer = tempDoc.layers.add();
       try {
         exportLayer.name = "VF_EXPORT";
       } catch (e) {
         var abIdx = tempDoc.artboards.getActiveArtboardIndex();
         var abNameNow = abIdx >= 0 ? tempDoc.artboards[abIdx].name : "(unknown)";
         var errMsg =
           "Cannot modify export layer in document '" +
           tempDoc.name +
           "' artboard '" +
           abNameNow +
           "': " +
           e.message;
         vfError(errMsg);
         progressLog("Export failed: " + errMsg);
         throw e;
       }
       try { exportLayer.locked = false; } catch (e) {}
       try { exportLayer.hidden = false; } catch (e) {}

        try {
          for (var li = 0; li < tempDoc.layers.length; li++) {
            var layer = tempDoc.layers[li];
            if (layer.name === "VF_EXPORT") continue;
            layer.remove();
            break;
          }
        } catch (e) {
        }

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
         try {
           copyLayerItems(
             ord.items,
             exportLayer,
             abRect,
             scale,
             exportWidth,
             exportHeight,
             ord.clip,
           );
         } catch (e) {
           throw e;
         }
       }
     }

     try {
       expandAllEffects();
     } catch (e) {
       throw e;
     }

     // Подготовить временный документ к экспорту.
     // tempDoc уже активен сразу после app.documents.add(), поэтому лишний
     // activate() (переключение контекста) и лишний сброс выделения перед
     // selectall убраны — selectall сам очищает выделение.
     app.executeMenuCommand("selectall");

     // Создать кривые из текста
     try {
       app.executeMenuCommand("outline");
     } catch (e) {
     }

     // Еще раз выделить всё, потому что после outline выделение может измениться
     app.selection = null;
     app.executeMenuCommand("selectall");

     // Преобразовать обводки в кривые
     try {
       app.doScript("contour", "VF");
     } catch (e) {
     }

      var saveFile = new File(exportFolder.fsName + "/" + safeName + ".eps");
      var epsOptions = new EPSSaveOptions();
      epsOptions.compatibility = Compatibility.ILLUSTRATOR10;
      epsOptions.embedLinkedFiles = true;
      epsOptions.embedAllFonts = false;
      try {
        tempDoc.saveAs(saveFile, epsOptions);
      } catch (e) {
        var saveErrMsg =
          "Cannot save document '" +
          tempDoc.name +
          "' artboard '" +
          abName +
          "': " +
          e.message;
        vfError(saveErrMsg);
        progressLog("Export failed: " + saveErrMsg);
        throw e;
      }

      // JPG preview with the same base name (EPS + JPG pair for Adobe Stock).
      if (includeJpg) {
        var previewFile = new File(exportFolder.fsName + "/" + safeName + ".jpg");
        var jpgOptions = new ExportOptionsJPEG();
        jpgOptions.artBoardClipping = true;
        jpgOptions.qualitySetting = 100;
        jpgOptions.horizontalScale = 100;
        jpgOptions.verticalScale = 100;
        try {
          tempDoc.exportFile(previewFile, ExportType.JPEG, jpgOptions);
        } catch (e) {
          var exportErrMsg =
            "Cannot export JPG from document '" +
            tempDoc.name +
            "' artboard '" +
            abName +
            "': " +
            e.message;
          vfError(exportErrMsg);
          progressLog("Export failed: " + exportErrMsg);
          throw e;
        }
      }

      tempDoc.close(SaveOptions.DONOTSAVECHANGES);
    }

  srcDoc.activate();

  var csvCount = 0;
  if (csvEnabled) {
    progressLog("Writing 3 CSV files...");

    // Build three stock CSV files for the whole export (one row per artboard).
    try {
      buildStockCsv(
        srcDoc,
        exportFolder,
        prefix,
        indices,
        abNames,
        abRects,
        [fgLayer, plLayer, bgLayer],
        rangeStr,
      );
      csvCount = 3;
    } catch (e) {
      vfError("Stock CSV failed: " + e.message);
      progressLog("CSV failed: " + e.message);
    }
  }

  // One combined Adobe Stock CSV is written for the whole export batch.
  progressLog("Export complete");
  vfSuccess(
    "Exported:\n" +
      indices.length +
      " " + (includeJpg ? "EPS-JPEG" : "EPS") + "\n" +
      csvCount +
      " CSV",
  );
  } catch (e) {
    // Any unexpected error during export is reported (not thrown), so the
    // panel's evalScript callback always fires and the lock is released.
    vfError("Export failed: " + e.message);
    var failMsg = "Export failed";
    if (abName) failMsg += " at " + abName;
    failMsg += ": " + e.message;
    progressLog(failMsg);
  } finally {
    // Always return a result string to the panel, even on failure.
    return vfResult();
  }
}

// Build three stock CSV files next to the exported files. One row per
// exported artboard in each file.
//   - Adobe Stock:  Filename, Title, Keywords, Category, Releases
//   - Shutterstock: Filename, Description, Keywords, Categories,
//                   Editorial, Mature content, illustration
//   - iStock/Getty: file name, description, country, title, color, keywords
// Title and Keywords are computed exactly as before; only the output format
// and column layout change.
function buildStockCsv(
  doc,
  exportFolder,
  prefix,
  indices,
  abNames,
  abRects,
  layers,
  rangeStr,
) {
  var artboardData = [];
  var problems = [];

  // Find all TextFrames on the given artboard whose bounds intersect it.
  // Returns the non-empty TextFrame with the largest area (width Ч height
  // from geometricBounds), or null if none found.
  function findTextAreaOnArtboard(abRect) {
    var candidates = [];
    var searchLayers = doc.layers;
    for (var li = 0; li < searchLayers.length; li++) {
      var layer = searchLayers[li];
      if (layer.guideLayer) continue;
      collectTextFramesInContainer(layer, abRect, candidates);
    }
    if (candidates.length === 0) return null;

    var best = null;
    var bestArea = -1;
    for (var ci = 0; ci < candidates.length; ci++) {
      var tf = candidates[ci];
      try {
        var b = tf.geometricBounds;
        var w = b[2] - b[0];
        var h = b[1] - b[3];
        var area = w * h;
        if (area > bestArea) {
          bestArea = area;
          best = tf;
        }
      } catch (e) {}
    }
    return best;
  }

  function collectTextFramesInContainer(container, abRect, out) {
    if (!container) return;
    var items = container.pageItems;
    if (items) {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.typename === "TextFrame" || item.typename === "AreaText") {
          try {
            var b = item.geometricBounds;
            if (
              b[2] > abRect[0] &&
              b[0] < abRect[2] &&
              b[1] > abRect[3] &&
              b[3] < abRect[1]
            ) {
              var text = asString(item.contents || "").replace(/^\s+|\s+$/g, "");
              if (text.length > 0) {
                out.push(item);
              }
            }
          } catch (e) {}
        }
      }
    }
    var groups = container.groupItems;
    if (groups) {
      for (var g = 0; g < groups.length; g++) {
        collectTextFramesInContainer(groups[g], abRect, out);
      }
    }
  }

  // Pre-scan the source layers once and group items by artboard index.
  // Replaces 2 Ч indices.length Ч layers.length full recursive scans with
  // one pass + O(items) grouping.
  var allItems = [];
  for (var li = 0; li < layers.length; li++) {
    collectArtboardItems(layers[li], null, allItems);
  }

  var artboardItemsByIndex = {};
  for (var ii = 0; ii < allItems.length; ii++) {
    var item = allItems[ii];
    try {
      var ib = item.geometricBounds;
      for (var abi = 0; abi < abRects.length; abi++) {
        if (isInArtboard(ib, abRects[abi])) {
          if (!artboardItemsByIndex[abi]) artboardItemsByIndex[abi] = [];
          artboardItemsByIndex[abi].push(item);
          break;
        }
      }
    } catch (e) {}
  }

  for (var i = 0; i < indices.length; i++) {
    var a = indices[i];
    var abName = abNames[a] || "artboard_" + a;
    var boardIndex = a + 1;
    var boardIndexStr = boardIndex < 10 ? "0" + boardIndex : "" + boardIndex;
    var abMeta = getArtboardMeta(abName) || {};
    var abTitleTpl = abMeta.title || "";
    var abShortTitleTpl = abMeta.shortTitle || "";
    var abKeywords = abMeta.keywords || [];

    // Generated artwork metadata for this artboard (from pre-scanned items).
    var boardItems = artboardItemsByIndex[a] || [];
    var namesSeen = {};
    var kwSeen = {};
    var objectNames = [];
    var objKeywords = [];
    var objectCategory = "";
    for (var bi = 0; bi < boardItems.length; bi++) {
      var meta = getElementMeta(boardItems[bi]);
      if (meta.objectName && !namesSeen[meta.objectName]) {
        namesSeen[meta.objectName] = true;
        objectNames.push(meta.objectName);
        if (!objectCategory && meta.shutterstockCategory) {
          objectCategory = meta.shutterstockCategory;
        }
      }
      for (var k = 0; k < meta.keywords.length; k++) {
        if (!kwSeen[meta.keywords[k]]) {
          kwSeen[meta.keywords[k]] = true;
          objKeywords.push(meta.keywords[k]);
        }
      }
    }

    // If element metadata exists on this artboard, also grab the first
    // non-empty text from the PLACEHOLDERS layer (if any) so it can be
    // added as an extra keyword later.
    var placeholderText = "";
    if (objectNames.length > 0) {
      var plLayer = getLayer(doc, "PLACEHOLDERS");
      if (plLayer) {
        for (var pi = 0; pi < plLayer.textFrames.length; pi++) {
          var ptf = plLayer.textFrames[pi];
          try {
            var ptb = ptf.geometricBounds;
            if (isInArtboard(ptb, abRects[a])) {
              var pText = asString(ptf.contents || "").replace(/^\s+|\s+$/g, "");
              if (pText.length > 0) {
                placeholderText = pText;
                break;
              }
            }
          } catch (e) {}
        }
      }
    }

    var primaryTitle = ""; // object title (1) or Set title (>1)
    var primaryKeywords = []; // object or Set keywords (come first)
    var setFound = true;

    if (objectNames.length === 0) {
      // No artwork on this artboard: nothing to prepend.
    } else if (objectNames.length === 1) {
      primaryTitle = objectNames[0];
      primaryKeywords = objKeywords;
    } else {
      // Multiple objects: find the Set whose members EXACTLY match the set of
      // object ids on this artboard (no more, no fewer). We never pick a Set
      // that contains only a subset or has extra members not on the board.
      // The VF_ID collection is RECURSIVE so nested groups are included.
      var boardVfids = [];
      for (var bi2 = 0; bi2 < boardItems.length; bi2++) {
        var vfid = getVfId(boardItems[bi2]);
        if (vfid && !arrayContains(boardVfids, vfid)) boardVfids.push(vfid);
      }
      var matches = findSetsWithExactMembers(boardVfids);

      if (matches.length === 0) {

          // ===== Fallback: Set отсутствует =====
          setFound = false;

          // Title
          var names = [];
          var namesSeen = {};

          for (var ni = 0; ni < objectNames.length; ni++) {
              var nm = String(objectNames[ni]).replace(/^\s+|\s+$/g, "");
              if (nm.length && !namesSeen[nm]) {
                  namesSeen[nm] = true;
                  names.push(nm);
              }
          }

          if (names.length == 1) {
              primaryTitle = names[0];
          } else if (names.length == 2) {
              primaryTitle = names[0] + " and " + names[1];
          } else if (names.length > 2) {
              primaryTitle = "";
              for (var t = 0; t < names.length; t++) {
                  if (t == 0) {
                      primaryTitle = names[t];
                  } else if (t == names.length - 1) {
                      primaryTitle += " and " + names[t];
                  } else {
                      primaryTitle += ", " + names[t];
                  }
              }
          }

          // Keywords
          var kwSeen = {};
          primaryKeywords = [];

          for (var ki = 0; ki < objKeywords.length; ki++) {
              var kw = String(objKeywords[ki]).replace(/^\s+|\s+$/g, "");
              if (!kw.length) continue;
              if (kwSeen[kw]) continue;

              kwSeen[kw] = true;
              primaryKeywords.push(kw);

              if (primaryKeywords.length >= 40) break;
          }

      } else {

          // Sort matches by member count descending, then pick the first Set
          // that has both title and keywords filled. If none have metadata,
          // treat as no match and fall back to individual element metadata.
          matches.sort(function(a, b) {
            var ca = (a.members || []).length;
            var cb = (b.members || []).length;
            return cb - ca;
          });

          var chosen = null;
          for (var mi = 0; mi < matches.length; mi++) {
            var m = matches[mi];
            var mTitle = String(m.title || "").replace(/^\s+|\s+$/g, "");
            var mKw = m.keywords || [];
            if (mTitle.length > 0 && mKw.length > 0) {
              chosen = m;
              break;
            }
          }

          if (chosen) {
            setFound = true;
            primaryTitle = chosen.title || "";
            primaryKeywords = chosen.keywords || [];
          } else {
            setFound = false;
            // No usable Set metadata found; fall back to individual element
            // metadata so the title/keywords are never empty when objects exist.
            var names = [];
            var namesSeen = {};

            for (var ni = 0; ni < objectNames.length; ni++) {
                var nm = String(objectNames[ni]).replace(/^\s+|\s+$/g, "");
                if (nm.length && !namesSeen[nm]) {
                    namesSeen[nm] = true;
                    names.push(nm);
                }
            }

            if (names.length == 1) {
                primaryTitle = names[0];
            } else if (names.length == 2) {
                primaryTitle = names[0] + " and " + names[1];
            } else if (names.length > 2) {
                primaryTitle = "";
                for (var t = 0; t < names.length; t++) {
                    if (t == 0) {
                        primaryTitle = names[t];
                    } else if (t == names.length - 1) {
                        primaryTitle += " and " + names[t];
                    } else {
                        primaryTitle += ", " + names[t];
                    }
                }
            }

            var kwSeen = {};
            primaryKeywords = [];

            for (var ki = 0; ki < objKeywords.length; ki++) {
                var kw = String(objKeywords[ki]).replace(/^\s+|\s+$/g, "");
                if (!kw.length) continue;
                if (kwSeen[kw]) continue;

                kwSeen[kw] = true;
                primaryKeywords.push(kw);

                if (primaryKeywords.length >= 40) break;
            }
          }
      }
    }

    // ---- Validation (collect problems, do not abort) ----
    if (abTitleTpl.length === 0) {
      problems.push('Artboard "' + abName + '": Title Artboard is empty.');
    }
    if (abKeywords.length === 0) {
      problems.push('Artboard "' + abName + '": Keywords Artboard are empty.');
    }
    if (objectNames.length === 1) {
      if (primaryTitle.length === 0) {
        problems.push('Artboard "' + abName + '": Object Title is empty.');
      }
      if (objKeywords.length === 0) {
        problems.push('Artboard "' + abName + '": Object Keywords are empty.');
      }
    } else if (objectNames.length > 1) {
      if (!setFound) {
        // No Set matched this artboard; skip Set-specific validation.
      } else {
        if (primaryTitle.length === 0) {
          problems.push('Artboard "' + abName + '": Set Title is empty.');
        }
        if (primaryKeywords.length === 0) {
          problems.push('Artboard "' + abName + '": Set Keywords are empty.');
        }
      }
    }

    // ---- Text Area fallback (no object, no set) ----
    var textAreaText = "";
    var textAreaFallback = false;
    if (primaryTitle.length === 0 && objectNames.length === 0) {
      var textAreaItem = findTextAreaOnArtboard(abRects[a]);
      if (textAreaItem) {
        var rawText = asString(textAreaItem.contents || "").replace(/^\s+|\s+$/g, "");
        textAreaText = cleanPlaceholderText(rawText);
        if (textAreaText.length > 0) {
          textAreaFallback = true;
        }
      }
    }

    // ---- Title assembly ----
    var title = "";
    if (abTitleTpl.indexOf("*") >= 0) {
      // Template has "*": replace it with the primary title.
      // If no primary title is available, fall back to object names so the
      // placeholder never disappears without substitution.
      if (primaryTitle.length > 0) {
        title = abTitleTpl.replace(/\*/g, primaryTitle);
      } else if (textAreaFallback) {
        title = abTitleTpl.replace(/\*/g, textAreaText);
      } else {
        title = objectNames.join(", ");
      }
    } else {
      // No "*": prepend the primary title to the artboard title.
      if (primaryTitle.length > 0) {
        title = primaryTitle + " " + abTitleTpl;
      } else if (textAreaFallback) {
        title = textAreaText + " " + abTitleTpl;
      } else {
        title = abTitleTpl;
      }
    }
    if (title.length === 0) title = objectNames.join(", ");
    if (title.length === 0 && textAreaFallback) title = textAreaText;
    title = String(title)
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");

    // Capitalize sentences: first letter of the string and after . ! ?
    function capitalizeSentences(s) {
      if (!s) return s;
      s = s.charAt(0).toUpperCase() + s.slice(1);
      return s.replace(/([.!?]\s+)([a-z])/g, function(_, punct, letter) {
        return punct + letter.toUpperCase();
      });
    }

    title = capitalizeSentences(title);

    // If element metadata exists and there's placeholder text on this artboard,
    // append ". <Placeholder> text." to the LONG title only (not short title).
    // If the title already contains "with text", insert the placeholder word
    // between them without extra punctuation. If the title already ends with
    // a period, don't add another one.
    if (placeholderText && objectNames.length > 0) {
      var cleanForTitle = cleanPlaceholderText(placeholderText);
      if (cleanForTitle.length > 0) {
        var capitalized = cleanForTitle.charAt(0).toUpperCase() + cleanForTitle.slice(1);
        if (title.length > 0) {
          var lowerTitle = title.toLowerCase();
          var withIdx = lowerTitle.indexOf("with text");
          if (withIdx >= 0) {
            title =
              title.substring(0, withIdx + 4) +
              capitalized +
              " " +
              title.substring(withIdx + 4);
          } else {
            var andIdx = lowerTitle.indexOf("and text");
            if (andIdx >= 0) {
              title =
                title.substring(0, andIdx + 4) +
                capitalized +
                " " +
                title.substring(andIdx + 4);
            } else {
              var endsWithPeriod = title.charAt(title.length - 1) === ".";
              if (endsWithPeriod) {
                title = title + " " + capitalized + " text.";
              } else {
                title = title + ". " + capitalized + " text.";
              }
            }
          }
        }
      }
    }

    // ---- Short Title assembly ----
    // Format matches Title exactly: supports * placeholder, same data sources.
    // If no shortTitle template exists, fall back to the regular title for backward compatibility.
    var shortTitle = "";
    if (abShortTitleTpl.length === 0) {
      shortTitle = title;
    } else if (abShortTitleTpl.indexOf("*") >= 0) {
      if (primaryTitle.length > 0) {
        shortTitle = abShortTitleTpl.replace(/\*/g, primaryTitle);
      } else if (textAreaFallback) {
        shortTitle = abShortTitleTpl.replace(/\*/g, textAreaText);
      } else {
        shortTitle = objectNames.join(", ");
      }
    } else {
      if (primaryTitle.length > 0) {
        shortTitle = primaryTitle + " " + abShortTitleTpl;
      } else if (textAreaFallback) {
        shortTitle = textAreaText + " " + abShortTitleTpl;
      } else {
        shortTitle = abShortTitleTpl;
      }
    }
    if (shortTitle.length === 0) shortTitle = title;
    shortTitle = String(shortTitle)
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");

    // Keywords: walk the artboard template in order, substituting the AI
    // placeholders "*" (next unused primary keyword) and "**" (all remaining
    // unused primary keywords) with the linked Element/Set keywords. Any
    // primary keywords not consumed by a placeholder are appended at the end
    // so none are lost. Drop empties, dedupe preserving first-seen order,
    // join with ", ".
    var seen = {};
    var kw = [];
    var pkIdx = 0; // index of the next unused primary keyword
    var pkLen = primaryKeywords.length;
    var textAreaStarCount = 0;

    function pushKw(val) {
      var t = String(val).replace(/^\s+|\s+$/g, "");
      if (t.length === 0) return;
      if (!seen[t]) {
        seen[t] = true;
        kw.push(t);
      }
    }

    for (var k = 0; k < abKeywords.length; k++) {
      var ak = String(abKeywords[k]).replace(/^\s+|\s+$/g, "");
      if (ak === "*") {
        if (textAreaFallback) {
          if (textAreaStarCount === 0) {
            pushKw(textAreaText);
          } else if (textAreaStarCount === 1) {
            pushKw("text");
          } else if (textAreaStarCount === 2) {
            pushKw("typography");
          } else {
            // Further *: fall back to primary keywords as before
            while (pkIdx < pkLen) {
              var pk = primaryKeywords[pkIdx++];
              if (pk !== undefined && String(pk).length > 0) {
                pushKw(pk);
                break;
              }
            }
          }
          textAreaStarCount++;
        } else {
          // Insert the next unused primary keyword (if any remain).
          while (pkIdx < pkLen) {
            var pk = primaryKeywords[pkIdx++];
            if (pk !== undefined && String(pk).length > 0) {
              pushKw(pk);
              break;
            }
          }
        }
      } else if (ak === "**") {
        if (textAreaFallback) {
          // In text area fallback mode, ** inserts remaining primary keywords
          // after the special textArea/text/typography substitutions.
          while (pkIdx < pkLen) {
            var pk2 = primaryKeywords[pkIdx++];
            if (pk2 !== undefined && String(pk2).length > 0) {
              pushKw(pk2);
            }
          }
        } else {
          // Insert ALL remaining unused primary keywords.
          while (pkIdx < pkLen) {
            var pk2 = primaryKeywords[pkIdx++];
            if (pk2 !== undefined && String(pk2).length > 0) {
              pushKw(pk2);
            }
          }
        }
      } else {
        pushKw(ak);
      }
    }

    // If element metadata exists and there's placeholder text on this artboard,
    // add the cleaned placeholder text as the first keyword (letters and spaces
    // only — punctuation/digits/symbols stripped).
    if (placeholderText && objectNames.length > 0) {
      var cleanPlaceholder = cleanPlaceholderText(placeholderText);
      if (cleanPlaceholder.length > 0) {
        kw.unshift(cleanPlaceholder);
      }
    }

    var filename = sanitizeFilename(boardIndexStr + "_" + prefix + "_" + abName) + ".eps";
    // Disambiguate Cyrillic characters in English text
    var cleanTitle = disambiguateCyrillic(title);
    var cleanShortTitle = disambiguateCyrillic(shortTitle);
    var cleanKeywords = [];
    for (var ki = 0; ki < kw.length; ki++) {
      cleanKeywords.push(disambiguateCyrillic(kw[ki]));
    }

    var montageCategory = abMeta.shutterstockCategory || "";

    artboardData.push({
      filename: filename,
      title: cleanTitle,
      shortTitle: cleanShortTitle,
      keywords: cleanKeywords.join(", "),
      objectCategory: objectCategory,
      montageCategory: montageCategory
    });
  }

  if (artboardData.length === 0) return;

  // ---- Build three CSV files ----
  var baseName = "0_" + rangeStr + "_" + (sanitizeFilename(prefix) || "export");

  // --- Adobe Stock ---
  var adobeRows = [];
  adobeRows.push(
    csvEscapeCell("Filename") +
      "," +
      csvEscapeCell("Title") +
      "," +
      csvEscapeCell("Keywords") +
      "," +
      csvEscapeCell("Category") +
      "," +
      csvEscapeCell("Releases")
  );
  for (var ai = 0; ai < artboardData.length; ai++) {
    var ad = artboardData[ai];
    adobeRows.push(
      csvEscapeCell(ad.filename) +
        "," +
        csvEscapeCell(ad.title) +
        "," +
        csvEscapeCell(ad.keywords) +
        "," +
        csvEscapeCell("") +
        "," +
        csvEscapeCell("")
    );
  }
  // Helper: write CSV text as UTF-8 (ExtendScript adds BOM automatically with UTF-8 encoding).
  function writeCsv(file, csvText) {
    file.encoding = "UTF-8";
    file.open("w");
    file.write(csvText);
    file.close();
  }

  var adobeCsv = adobeRows.join("\r\n") + "\r\n";
  var adobeFile = new File(
    exportFolder.fsName + "/Adobe_" + baseName + ".csv"
  );
  writeCsv(adobeFile, adobeCsv);

  // --- Shutterstock ---
  var shutterRows = [];
  shutterRows.push(
    csvEscapeCell("Filename") +
      "," +
      csvEscapeCell("Description") +
      "," +
      csvEscapeCell("Keywords") +
      "," +
      csvEscapeCell("Categories") +
      "," +
      csvEscapeCell("Editorial") +
      "," +
      csvEscapeCell("Mature content") +
      "," +
      csvEscapeCell("illustration")
  );
  for (var si = 0; si < artboardData.length; si++) {
    var sd = artboardData[si];
    var categories = [];
    if (sd.objectCategory) categories.push(sd.objectCategory);
    if (sd.montageCategory) categories.push(sd.montageCategory);
    var categoryCell = categories.length > 0 ? categories.join(",") : "";
    shutterRows.push(
      csvEscapeCell(sd.filename) +
        "," +
        csvEscapeCell(sd.title) +
        "," +
        csvEscapeCell(sd.keywords) +
        "," +
        csvEscapeCell(categoryCell) +
        "," +
        csvEscapeCell("No") +
        "," +
        csvEscapeCell("No") +
        "," +
        csvEscapeCell("yes")
    );
  }
  var shutterCsv = shutterRows.join("\r\n") + "\r\n";
  var shutterFile = new File(
    exportFolder.fsName + "/Shutterstock_" + baseName + ".csv"
  );
  writeCsv(shutterFile, shutterCsv);

  // --- iStock/Getty ---
  // iStock CSV format (from official template):
  // file name,title,description,keywords
  var istockRows = [];
  istockRows.push(
    csvEscapeCell("file name") +
      "," +
      csvEscapeCell("title") +
      "," +
      csvEscapeCell("description") +
      "," +
      csvEscapeCell("keywords")
  );
  for (var ii = 0; ii < artboardData.length; ii++) {
    var id = artboardData[ii];
    istockRows.push(
      csvEscapeCell(id.filename) +
        "," +
        csvEscapeCell(id.shortTitle || id.title) +
        "," +
        csvEscapeCell(id.title) +
        "," +
        csvEscapeCell(id.keywords)
    );
  }
  var istockCsv = istockRows.join("\r\n") + "\r\n";
  var istockFile = new File(
    exportFolder.fsName + "/iStock_" + baseName + ".csv"
  );
  writeCsv(istockFile, istockCsv);

  // Report all validation problems at once (export already finished).
  if (problems.length > 0) {
    for (var p = 0; p < problems.length; p++) {
      vfError(problems[p]);
    }
  }
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
