#target illustrator

// Vector Factory common functions for Generate / Hide / Show.
// Note: S copies placeholder appearance; SK keeps the original artwork appearance.

// Target names: S, SK, S1, SK2, ... (number = which MASTER to use; default 1).
// MASTER names: MASTER, MASTER1, MASTER3, ... (number = which master).
function isTargetName(name) {
  return /^S(K)?\d*$/.test(name);
}

function getTargetNumber(name) {
  var m = name.match(/\d+$/);
  return m ? parseInt(m[0], 10) : 1;
}

// S (not SK) copies placeholder appearance; SK keeps original.
function isCopyAppearance(name) {
  return /^S\d*$/.test(name);
}

// Generation mode: "all" = S + SK, "s" = only S/S1/S2..., "sk" = only SK/SK1/...
// Set by generate(mode) and read by isTarget() so the whole fill pipeline
// (findTarget, containsTarget, removeGeneratedArt, hideTargets) honors it.
var gGenMode = "all";

// True if a target name should be generated in the current mode.
function isTargetForMode(name, mode) {
  if (mode === "s") return /^S\d*$/.test(name);
  if (mode === "sk") return /^SK\d*$/.test(name);
  return isTargetName(name); // "all"
}

function getMasterNumber(name) {
  if (name === "MASTER") return 1;
  var m = name.match(/^MASTER(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Errors collected during generate/export and returned to the panel as a list.
var VF_ERRORS = [];
var VF_SUCCESS = "";

function vfError(msg) {
  VF_ERRORS.push(msg);
}

function vfSuccess(msg) {
  VF_SUCCESS = msg;
}

// ExtendScript (Illustrator) has no built-in JSON object, so we serialize
// manually. The panel (browser) parses this with JSON.parse, which is fine.
function vfEscapeJson(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Returns a JSON string: { "errors": [...], "success": "..." }.
function vfResult() {
  var parts = [];
  for (var i = 0; i < VF_ERRORS.length; i++) {
    parts.push('"' + vfEscapeJson(VF_ERRORS[i]) + '"');
  }
  return (
    '{"errors":[' +
    parts.join(",") +
    '],"success":"' +
    vfEscapeJson(VF_SUCCESS || "OK") +
    '"}'
  );
}

function generate(mode) {
  // Default to "all" when called without a mode (e.g. legacy VF_Generate.jsx).
  gGenMode = mode || "all";

  VF_ERRORS = [];
  VF_SUCCESS = "";

  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }

  var doc = app.activeDocument;
  var masterLayer = getLayer(doc, "MASTER");
  var placeholdersLayer = getLayer(doc, "PLACEHOLDERS");

  if (!masterLayer || masterLayer.pageItems.length === 0) {
    vfError("Click Set Element first.");
    return vfResult();
  }

  if (!placeholdersLayer) {
    vfError("Layer not found: PLACEHOLDERS.");
    return vfResult();
  }

  // Build a map: MASTER number -> source item. MASTER/MASTER1 -> 1, MASTER3 -> 3.
  var masterByNumber = {};
  for (var mi = 0; mi < masterLayer.pageItems.length; mi++) {
    var m = masterLayer.pageItems[mi];
    var num = getMasterNumber(m.name);
    if (num > 0) masterByNumber[num] = m;
  }

  // Note: a text MASTER (the first item) replaces text in all PLACEHOLDERS
  // text frames — original single-text-master behavior is preserved exactly.
  if (masterLayer.pageItems[0].typename === "TextFrame") {
    try {
      replacePlaceholderText(placeholdersLayer, masterLayer.pageItems[0].contents);
      vfSuccess("Generated (text)");
    } catch (e) {
      vfError("Error: " + e.message);
    }
    return vfResult();
  }

  try {
    for (var i = 0; i < placeholdersLayer.groupItems.length; i++) {
      fillPlaceholderGroup(placeholdersLayer.groupItems[i], masterByNumber);
    }
    hideTargets();
    vfSuccess("Generated (" + gGenMode + ")");
  } catch (e) {
    vfError("Error: " + e.message);
  }

  return vfResult();
}

function fillPlaceholderGroup(group, masterByNumber) {
  var clippingTemplate = findClippingTemplate(group);

  if (clippingTemplate) {
    fillClippingTemplate(group, clippingTemplate, masterByNumber);
    return;
  }

  fillSimpleTemplate(group, masterByNumber);
}

function fillClippingTemplate(group, template, masterByNumber) {
  removeGeneratedArt(group);

  var target = findTarget(template);
  if (!target) return;

  // Resolve which MASTER to use from the target number (S3/SK3 -> 3, S/SK -> 1).
  // If no matching MASTER exists, skip this placeholder silently.
  var source = masterByNumber[getTargetNumber(target.name)];
  if (!source) return;

  var artGroup = group.groupItems.add();
  artGroup.name = "ART";

  // 1) Копируем "подложку" шаблона (всё, кроме S/SK) — вниз группы.
  for (var i = 0; i < template.pageItems.length; i++) {
    var item = template.pageItems[i];

    if (isTarget(item)) continue;

    item.duplicate().move(artGroup, ElementPlacement.PLACEATEND);
  }

  // 2) Источник становится маской ПОВЕРХ подложки (как при
  //    "Создать обтравочную маску": фигура-маска — самая верхняя).
  var copy = source.duplicate();
  copy.name = "ART";
  copy.move(artGroup, ElementPlacement.PLACEATBEGINNING);

// Если источник — группа, создаём из её копии Compound Path
// только для использования как clipping mask.
if (copy.typename === "GroupItem") {
    app.selection = null;
    copy.selected = true;

    try {
        app.executeMenuCommand("group");
        app.executeMenuCommand("compoundPath");
        copy = app.selection[0];
        copy.name = "ART";
    } catch (e) {}
}

  fitToTarget(copy, target);

  if (isCopyAppearance(target.name)) copyAppearance(copy, target);

  // 3) Создаём обтравочную маску.
  //    - group.clipped = true падает для составного контура
  //      ("top item must be a path item");
  //    - item.clipping = true на CompoundPathItem внутри обычной группы не
  //      всегда отсекает соседние объекты.
  //    Нативная команда makeMask (аналог "Создать обтравочную маску")
  //    корректно работает и с PathItem, и с CompoundPathItem — берёт
  //    самый верхний выделенный объект маской.
  makeClippingMask(artGroup, copy);

  // Скрываем шаблон, чтобы экспортировалась только генерация
  template.hidden = true;
}

// Упрощает маску: убирает лишние опорные точки, чтобы составной контур
// перестал считаться "слишком сложным" для обтравочной маски (иначе
// Illustrator показывает предупреждение и блокирует скрипт).
function simplifyMask(mask) {
  try {
    if (mask.typename === "CompoundPathItem") {
      for (var i = 0; i < mask.pathItems.length; i++) {
        mask.pathItems[i].removeUnnecessaryPoints();
      }
    } else if (mask.typename === "PathItem") {
      mask.removeUnnecessaryPoints();
    }
  } catch (e) {}
}

// Делает mask (верхний объект artGroup) обтравочной маской для остальных
// объектов группы. Использует нативную команду Illustrator "makeMask";
// при сбое — откат на свойства clipping/clipped.
function makeClippingMask(artGroup, mask) {
  // Упрощаем геометрию маски, чтобы избежать предупреждения о сложности.
  simplifyMask(mask);

  // Подавляем диалог подтверждения "объект очень сложен…" на время команды.
  var prevLevel = app.userInteractionLevel;
  app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

  try {
    mask.selected = true;
    for (var i = 0; i < artGroup.pageItems.length; i++) {
      if (artGroup.pageItems[i] !== mask) artGroup.pageItems[i].selected = true;
    }
    app.executeMenuCommand("makeMask");
    app.selection = null;
    return;
  } catch (e) {
    app.selection = null;
  } finally {
    app.userInteractionLevel = prevLevel;
  }

  // Fallback: свойства clipping/clipped.
  if (mask.typename === "CompoundPathItem") {
    mask.filled = false;
    mask.stroked = false;
    mask.clipping = true;
  } else {
    artGroup.clipped = true;
  }
}

function fillSimpleTemplate(group, masterByNumber) {
  // Clear previous generation FIRST, before any early return, so regenerating
  // with new elements always starts from a clean template (old ART removed
  // even when there is no matching MASTER for this placeholder).
  removeGeneratedArt(group);

  var target = findTarget(group);
  if (!target) return;

  // Resolve MASTER by target number; skip silently if no matching MASTER.
  var source = masterByNumber[getTargetNumber(target.name)];
  if (!source) return;

  var copy = source.duplicate(group, ElementPlacement.PLACEATEND);
  copy.name = "ART";
  fitToTarget(copy, target);

  if (isCopyAppearance(target.name)) copyAppearance(copy, target);
}

function fitToTarget(item, target) {
  var data = analyzeTarget(target);
  scaleToFit(item, data);
  rotateToTarget(item, data);
  centerOnTarget(item, data);
}

function analyzeTarget(target) {
  // Default to bounds-based size/center, which works for BOTH PathItem and
  // CompoundPathItem. pathPoints only exists on PathItem, so the precise
  // angle/mirror detection below is guarded and skipped for compound paths
  // (otherwise target.pathPoints is undefined and the script throws).
  var bounds = target.geometricBounds; // [left, top, right, bottom]
  var left = bounds[0], top = bounds[1], right = bounds[2], bottom = bounds[3];
  var width = right - left;
  var height = top - bottom;
  var centerX = (left + right) / 2;
  var centerY = (top + bottom) / 2;
  var angle = 0;
  var mirrored = false;

  if (target.typename === "PathItem" && target.pathPoints.length >= 4) {
    var p0 = target.pathPoints[0].anchor;
    var p1 = target.pathPoints[1].anchor;
    var p2 = target.pathPoints[2].anchor;
    var p3 = target.pathPoints[3].anchor;
    var d01 = distance(p0, p1);
    var d12 = distance(p1, p2);
    var horizontal = d01 >= d12;

    width = horizontal ? d01 : d12;
    height = horizontal ? d12 : d01;
    centerX = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
    centerY = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;
    angle = (Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180) / Math.PI + 180;
    mirrored = crossProduct(p0, p1, p2) > 0;
  }

  return {
    width: width,
    height: height,
    centerX: centerX,
    centerY: centerY,
    angle: angle,
    mirrored: mirrored
  };
}

function scaleToFit(item, data) {
  var bounds = item.geometricBounds;
  var width = bounds[2] - bounds[0];
  var height = bounds[1] - bounds[3];
  var scale = Math.min(data.width / width, data.height / height) * 100;
  item.resize(scale, scale);
}

function rotateToTarget(item, data) {
  // Mirror FIRST, then rotate. The flip must be applied in the source's own
  // frame; the final rotation then aligns the already-flipped source with the
  // target. Rotating first and mirroring after produced wrong results for
  // horizontally mirrored + rotated targets (the mirror axis ended up rotated).
  if (data.mirrored) {
    item.resize(-100, 100);
    item.rotate(180);
  }
  item.rotate(data.angle);
}

function centerOnTarget(item, data) {
  // Use geometricBounds, which exists on BOTH PathItem and CompoundPathItem.
  // item.width / item.height are undefined on CompoundPathItem and produce
  // NaN, which breaks placement when the source is a compound path.
  var b = item.geometricBounds; // [left, top, right, bottom]
  var cx = (b[0] + b[2]) / 2;
  var cy = (b[1] + b[3]) / 2;
  item.translate(data.centerX - cx, data.centerY - cy);
}

function copyAppearance(item, target) {
  if (item.typename === "PathItem") {
    item.filled = target.filled;
    item.stroked = target.stroked;

    if (target.filled) item.fillColor = target.fillColor;
    if (target.stroked) {
      item.strokeColor = target.strokeColor;
      item.strokeWidth = target.strokeWidth;
      item.strokeCap = target.strokeCap;
      item.strokeJoin = target.strokeJoin;
      item.strokeMiterLimit = target.strokeMiterLimit;
      item.strokeDashes = target.strokeDashes;
      item.strokeDashOffset = target.strokeDashOffset;
    }

    item.opacity = target.opacity;
    item.blendingMode = target.blendingMode;
    return;
  }

  var children = item.typename === "CompoundPathItem" ? item.pathItems : item.pageItems;
  if (!children) return;

  for (var i = 0; i < children.length; i++) {
    copyAppearance(children[i], target);
  }
}

function hideTargets() {
  setTargetsVisible(false);
}

function showTargets() {
  setTargetsVisible(true);
}

function setTargetsVisible(visible) {
  if (app.documents.length === 0) return;

  var layer = getLayer(app.activeDocument, "PLACEHOLDERS");
  if (!layer) return;

  for (var i = 0; i < layer.groupItems.length; i++) {
    setTargetsVisibleInGroup(layer.groupItems[i], visible);
  }
}

function setTargetsVisibleInGroup(group, visible) {
  if (group.clipped && containsTarget(group)) {
    // Once a generated ART group exists, the template is hidden permanently and
    // only the generated art is toggled — leave the template alone.
    if (hasGeneratedSibling(group)) return;
    group.hidden = !visible;
    return;
  }

  for (var i = 0; i < group.pageItems.length; i++) {
    if (isTarget(group.pageItems[i])) group.pageItems[i].hidden = !visible;
  }

  for (var j = 0; j < group.groupItems.length; j++) {
    if (group.groupItems[j].clipped) setTargetsVisibleInGroup(group.groupItems[j], visible);
  }
}

// True if `group` has a sibling group named "ART" (the generated output).
function hasGeneratedSibling(group) {
  var parent = group.parent;
  if (!parent || !parent.groupItems) return false;
  for (var i = 0; i < parent.groupItems.length; i++) {
    if (parent.groupItems[i].name === "ART") return true;
  }
  return false;
}

function removeGeneratedArt(group) {
  // Only clear ART that belongs to the CURRENT generation mode, so generating
  // one set (e.g. "s") does not wipe the other set (e.g. "sk") already present.
  // gGenMode === "all" clears everything (used by the "Generate all" button).
  var clearAll = gGenMode === "all";

  // Find the template target (S/SK, any mode) to know which set this group
  // belongs to. If it matches the current mode (or we're clearing all), the
  // generated ART for this group is removed and the template is re-shown.
  var tgt = findTemplateTargetAnyMode(group);
  var tgtMode = tgt ? (isTargetForMode(tgt.name, "sk") ? "sk" : "s") : "all";
  var shouldClear = clearAll || tgtMode === gGenMode;

  // Remove any generated ART groups (named "ART", or clipped groups that no
  // longer contain a template target — i.e. the generated clipping output).
  for (var i = group.groupItems.length - 1; i >= 0; i--) {
    var childGroup = group.groupItems[i];
    if (childGroup.name === "ART" || (childGroup.clipped && !containsTarget(childGroup))) {
      if (shouldClear) childGroup.remove();
    }
  }

  // Remove generated ART page items (simple-template case).
  for (var j = group.pageItems.length - 1; j >= 0; j--) {
    if (group.pageItems[j].name === "ART") {
      if (shouldClear) group.pageItems[j].remove();
    }
  }

  // Un-hide the template target for THIS mode so the next generation of the
  // same set starts from a clean, visible template. Other modes stay hidden.
  // Covers the clipped template subgroup, a simple template page item, and the
  // group itself when it is the clipped template.
  if (group.clipped && containsTarget(group) && shouldClear) group.hidden = false;
  for (var k = 0; k < group.groupItems.length; k++) {
    var g = group.groupItems[k];
    if (g.clipped && containsTarget(g) && shouldClear) g.hidden = false;
  }
  for (var p = 0; p < group.pageItems.length; p++) {
    if (isTargetName(group.pageItems[p].name) && shouldClear) {
      group.pageItems[p].hidden = false;
    }
  }
}

// Find the template target (S/SK, any number) anywhere inside `container`,
// ignoring the current generation mode. Used by removeGeneratedArt to decide
// which generated set a group belongs to.
function findTemplateTargetAnyMode(container) {
  for (var i = 0; i < container.pageItems.length; i++) {
    if (isTargetName(container.pageItems[i].name)) return container.pageItems[i];
  }
  if (container.groupItems) {
    for (var j = 0; j < container.groupItems.length; j++) {
      var found = findTemplateTargetAnyMode(container.groupItems[j]);
      if (found) return found;
    }
  }
  return null;
}

function findClippingTemplate(group) {
  for (var i = 0; i < group.groupItems.length; i++) {
    if (group.groupItems[i].clipped && containsTarget(group.groupItems[i])) {
      return group.groupItems[i];
    }
  }
  return null;
}

function findTarget(container) {
  for (var i = 0; i < container.pageItems.length; i++) {
    if (isTarget(container.pageItems[i])) return container.pageItems[i];
  }
  return null;
}

function containsTarget(container) {
  return !!findTarget(container);
}

function isTarget(item) {
  return item && isTargetForMode(item.name, gGenMode);
}

function replacePlaceholderText(container, text) {
  for (var i = 0; i < container.textFrames.length; i++) {
    var tf = container.textFrames[i];

    // Save the template's original width and horizontal scale before changing
    // the text, so we can rescale only horizontally afterwards.
    var oldWidth = tf.width;
    var oldHorizontalScale = tf.textRange.characterAttributes.horizontalScale;

    tf.contents = text;

    // Measure the new (unscaled) width and compute a horizontal-scale factor
    // that brings it back to the original template width. Only the horizontal
    // scale is changed — font size and text height stay the same (no resize()).
    var newWidth = tf.width;
    if (newWidth > 0) {
      var scale = oldWidth / newWidth;
      // Don't squeeze below 60% — very long words would become unreadable
      // "noodles"; at that point the text clearly needs a manual fix.
      tf.textRange.characterAttributes.horizontalScale = Math.max(
        60,
        oldHorizontalScale * scale
      );
    }
  }
}

function getLayer(doc, name) {
  try {
    return doc.layers.getByName(name);
  } catch (e) {
    return null;
  }
}

function distance(a, b) {
  return Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
}

function crossProduct(p0, p1, p2) {
  return (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
}

// ===== Metadata system (two independent subsystems) =====
//
// 1) ELEMENT METADATA — belongs to ONE artwork element (PageItem). It is
//    stored as a SINGLE serialized object in the element's `note`:
//      {version:1, id:"...", objectName:"...", keywords:["...","..."]}
//    One object (not line-based KEY=value pairs) so it is versioned, easy
//    to extend (just add a property), and never needs new parsing rules.
//    The note travels with the element through copy / duplicate / move.
//
// 2) SET METADATA — a user-defined COMPOSITION of elements (an ordered
//    list of member ids plus a Title and Keywords). It is stored as one
//    serialized object per Set inside the hidden VF_METADATA layer:
//      {setId:"...", createdAt:"...", modifiedAt:"...",
//       members:["id1","id2"], title:"...", keywords:["...","..."]}
//    Multiple Sets can exist; each is independent and survives save/reopen.
//
// The two are completely decoupled.

// --- Shared helpers: valid JSON serialize / parse (no eval) ---
// ExtendScript has no built-in JSON object, so we provide a minimal,
// correct implementation. Metadata is ALWAYS stored as valid JSON in the
// note, and malformed input fails gracefully (jsonParse returns null)
// instead of executing anything. This replaces the old eval()-based
// parsing, making the metadata safer and portable.

// Serialize a value (object / array / string / number / bool / null) to
// valid JSON.
function jsonStringify(value) {
  if (value === null || value === undefined) return "null";
  var t = typeof value;
  if (t === "number") {
    if (isNaN(value) || !isFinite(value)) return "null";
    return String(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return jsonStringifyString(value);
  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      parts.push(jsonStringify(value[i]));
    }
    return "[" + parts.join(",") + "]";
  }
  // Plain object (our metadata records).
  var out = [];
  for (var k in value) {
    out.push(jsonStringifyString(k) + ":" + jsonStringify(value[k]));
  }
  return "{" + out.join(",") + "}";
}

function jsonStringifyString(s) {
  s = String(s);
  var res = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var cc = s.charCodeAt(i);
    if (c === '"') res += '\\"';
    else if (c === "\\") res += "\\\\";
    else if (c === "\n") res += "\\n";
    else if (c === "\r") res += "\\r";
    else if (c === "\t") res += "\\t";
    else if (cc < 0x20) {
      var hex = cc.toString(16);
      while (hex.length < 4) hex = "0" + hex;
      res += "\\u" + hex;
    } else {
      res += c;
    }
  }
  return res + '"';
}

// Parse valid JSON into a value, or null if the input is missing or
// malformed. Never throws and never executes code.
function jsonParse(str) {
  if (str === null || str === undefined) return null;
  str = String(str);
  var idx = 0;
  var len = str.length;

  function skipWs() {
    while (idx < len) {
      var c = str.charAt(idx);
      if (c === " " || c === "\t" || c === "\n" || c === "\r") idx++;
      else break;
    }
  }

  function parseValue() {
    skipWs();
    if (idx >= len) throw "eof";
    var c = str.charAt(idx);
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t" || c === "f") return parseBool();
    if (c === "n") return parseNull();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    throw "unexpected";
  }

  function parseObject() {
    idx++;
    var obj = {};
    skipWs();
    if (str.charAt(idx) === "}") {
      idx++;
      return obj;
    }
    while (true) {
      skipWs();
      if (str.charAt(idx) !== '"') throw "key";
      var key = parseString();
      skipWs();
      if (str.charAt(idx) !== ":") throw "colon";
      idx++;
      obj[key] = parseValue();
      skipWs();
      var ch = str.charAt(idx);
      if (ch === ",") {
        idx++;
        continue;
      }
      if (ch === "}") {
        idx++;
        break;
      }
      throw "obj-end";
    }
    return obj;
  }

  function parseArray() {
    idx++;
    var arr = [];
    skipWs();
    if (str.charAt(idx) === "]") {
      idx++;
      return arr;
    }
    while (true) {
      arr.push(parseValue());
      skipWs();
      var ch = str.charAt(idx);
      if (ch === ",") {
        idx++;
        continue;
      }
      if (ch === "]") {
        idx++;
        break;
      }
      throw "arr-end";
    }
    return arr;
  }

  function parseString() {
    idx++;
    var out = "";
    while (idx < len) {
      var c = str.charAt(idx);
      if (c === '"') {
        idx++;
        return out;
      }
      if (c === "\\") {
        idx++;
        var e = str.charAt(idx);
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "u") {
          var hx = str.substr(idx + 1, 4);
          idx += 4;
          out += String.fromCharCode(parseInt(hx, 16));
        } else out += e;
        idx++;
      } else {
        out += c;
        idx++;
      }
    }
    throw "string-eof";
  }

  function parseNumber() {
    var start = idx;
    if (str.charAt(idx) === "-") idx++;
    while (idx < len) {
      var c = str.charAt(idx);
      if (
        (c >= "0" && c <= "9") ||
        c === "." ||
        c === "e" ||
        c === "E" ||
        c === "+" ||
        c === "-"
      ) {
        idx++;
      } else break;
    }
    return parseFloat(str.substring(start, idx));
  }

  function parseBool() {
    if (str.substr(idx, 4) === "true") {
      idx += 4;
      return true;
    }
    if (str.substr(idx, 5) === "false") {
      idx += 5;
      return false;
    }
    throw "bool";
  }

  function parseNull() {
    if (str.substr(idx, 4) === "null") {
      idx += 4;
      return null;
    }
    throw "null";
  }

  try {
    var result = parseValue();
    skipWs();
    if (idx !== len) throw "trailing";
    return result;
  } catch (e) {
    return null;
  }
}

// ===== Metadata schema versions & migration =====
// Bump these when the schema changes; the loaders below migrate any
// older format up to the current one. Never hardcode the version number
// elsewhere — all newly written metadata uses these constants.
var ELEMENT_METADATA_VERSION = 1;
var SET_METADATA_VERSION = 1;

// Coerce an array-ish value into a clean array of non-empty strings.
function normalizeStringArray(arr) {
  var out = [];
  if (!arr) return out;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] != null && String(arr[i]).length > 0) out.push(String(arr[i]));
  }
  return out;
}

// ---- Element metadata loader (single entry point) ----
// Parses `note`, detects the metadata version, migrates any older
// format up to the current schema, and ALWAYS returns the latest
// object structure: { version, id, objectName, keywords:[...] }.
// All migration logic lives here — no version checks elsewhere.
function loadElementMetadata(note) {
  note = note || "";
  // 1) Versioned JSON (current + future versions).
  var obj = jsonParse(note);
  if (obj) return migrateElementMeta(obj);
  // 2) Transitional single-object format (unquoted keys, pre-JSON).
  var trans = parseTransitionalElementMeta(note);
  if (trans) return trans;
  // 3) Legacy line-based format (OBJ_NAME=/ELEM_KW=/VF_ID=).
  var legacy = parseLegacyElementMeta(note);
  if (legacy) return legacy;
  // 4) Empty / unreadable -> fresh current-schema object.
  return {
    version: ELEMENT_METADATA_VERSION,
    id: "",
    objectName: "",
    keywords: []
  };
}

// Migrate a parsed element object to the current schema. Future upgrades
// are added here, oldest first (e.g. v1 -> v2 -> v3).
function migrateElementMeta(obj) {
  var v = typeof obj.version === "number" ? obj.version : 1;
  // if (v === 1) { obj = upgradeElementV1ToV2(obj); v = 2; }
  // if (v === 2) { obj = upgradeElementV2ToV3(obj); v = 3; }
  return {
    version: ELEMENT_METADATA_VERSION,
    id: obj.id != null ? String(obj.id) : "",
    objectName: obj.objectName != null ? String(obj.objectName) : "",
    keywords: normalizeStringArray(obj.keywords)
  };
}

// Best-effort recovery of the previous (eval-based) single-object
// format, which used unquoted keys and is NOT valid JSON. Extracted
// by regex (no eval) so old files are not lost.
function parseTransitionalElementMeta(note) {
  if (note.indexOf("{") === -1) return null;
  var idM = note.match(/id:\s*"([^"]*)"/);
  var nameM = note.match(/objectName:\s*"([^"]*)"/);
  var kwM = note.match(/keywords:\s*\[([^\]]*)\]/);
  if (!idM && !nameM && !kwM) return null;
  var keywords = [];
  if (kwM) {
    var re = /"([^"]*)"/g;
    var m;
    while ((m = re.exec(kwM[1])) !== null) keywords.push(m[1]);
  }
  return {
    version: ELEMENT_METADATA_VERSION,
    id: idM ? idM[1] : "",
    objectName: nameM ? nameM[1] : "",
    keywords: keywords
  };
}

// Recovery of the legacy line-based element format.
function parseLegacyElementMeta(note) {
  if (note.indexOf("OBJ_NAME=") === -1 && note.indexOf("VF_ID=") === -1) {
    return null;
  }
  var idM = note.match(/VF_ID=([0-9a-fA-F]+)/);
  var nameM = note.match(/OBJ_NAME=([^\n]*)/);
  var kwM = note.match(/ELEM_KW=([^\n]*)/);
  var keywords = [];
  if (kwM && kwM[1].length > 0) {
    var parts = kwM[1].split(",");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+|\s+$/g, "");
      if (p.length > 0) keywords.push(p);
    }
  }
  return {
    version: ELEMENT_METADATA_VERSION,
    id: idM ? idM[1] : "",
    objectName: nameM ? nameM[1] : "",
    keywords: keywords
  };
}

// ---- Set metadata loader (single entry point) ----
// Same contract as the element loader. Returns the latest structure:
// { setId, createdAt, modifiedAt, members:[...], title, keywords:[...] }.
function loadSetMetadata(note) {
  note = note || "";
  var obj = jsonParse(note);
  if (obj) {
    return migrateSetMeta(obj);
  }
  var trans = parseTransitionalSetMeta(note);
  if (trans) return trans;
  var legacy = parseLegacySetMeta(note);
  if (legacy) return legacy;
  return {
    setId: "",
    createdAt: "",
    modifiedAt: "",
    members: [],
    title: "",
    keywords: []
  };
}

function migrateSetMeta(obj) {
  var v = typeof obj.version === "number" ? obj.version : 1;
  // if (v === 1) { obj = upgradeSetV1ToV2(obj); v = 2; }
  return {
    setId: obj.setId != null ? String(obj.setId) : "",
    createdAt: obj.createdAt != null ? String(obj.createdAt) : "",
    modifiedAt: obj.modifiedAt != null ? String(obj.modifiedAt) : "",
    members: normalizeStringArray(obj.members),
    title: obj.title != null ? String(obj.title) : "",
    keywords: normalizeStringArray(obj.keywords)
  };
}

function parseTransitionalSetMeta(note) {
  if (note.indexOf("{") === -1) return null;
  var idM = note.match(/setId:\s*"([^"]*)"/);
  var caM = note.match(/createdAt:\s*"([^"]*)"/);
  var maM = note.match(/modifiedAt:\s*"([^"]*)"/);
  var titleM = note.match(/title:\s*"([^"]*)"/);
  var kwM = note.match(/keywords:\s*\[([^\]]*)\]/);
  var memM = note.match(/members:\s*\[([^\]]*)\]/);
  if (!idM && !titleM && !kwM && !memM) return null;
  var keywords = [];
  if (kwM) {
    var re = /"([^"]*)"/g;
    var m;
    while ((m = re.exec(kwM[1])) !== null) keywords.push(m[1]);
  }
  var members = [];
  if (memM) {
    var re2 = /"([^"]*)"/g;
    var m2;
    while ((m2 = re2.exec(memM[1])) !== null) members.push(m2[1]);
  }
  return {
    setId: idM ? idM[1] : "",
    createdAt: caM ? caM[1] : "",
    modifiedAt: maM ? maM[1] : "",
    members: members,
    title: titleM ? titleM[1] : "",
    keywords: keywords
  };
}

function parseLegacySetMeta(note) {
  if (note.indexOf("TITLE=") === -1 && note.indexOf("MEMBERS=") === -1) {
    return null;
  }
  var titleM = note.match(/TITLE=(.*)/);
  var kwM = note.match(/KEYWORDS=(.*)/);
  var memM = note.match(/MEMBERS=(.*)/);
  var keywords = [];
  if (kwM && kwM[1].length > 0) {
    var parts = kwM[1].split(",");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+|\s+$/g, "");
      if (p.length > 0) keywords.push(p);
    }
  }
  var members = [];
  if (memM && memM[1].length > 0) {
    var mp = memM[1].split(",");
    for (var j = 0; j < mp.length; j++) {
      var mm = mp[j].replace(/^\s+|\s+$/g, "");
      if (mm.length > 0) members.push(mm);
    }
  }
  return {
    setId: "",
    createdAt: "",
    modifiedAt: "",
    members: members,
    title: titleM ? titleM[1] : "",
    keywords: keywords
  };
}

// Current local timestamp for createdAt / modifiedAt (YYYY-MM-DD HH:MM:SS).
function metaNow() {
  var d = new Date();
  function p(n) {
    return (n < 10 ? "0" : "") + n;
  }
  return (
    d.getFullYear() +
    "-" + p(d.getMonth() + 1) +
    "-" + p(d.getDate()) +
    " " + p(d.getHours()) +
    ":" + p(d.getMinutes()) +
    ":" + p(d.getSeconds())
  );
}

// Generate a short random hex ID (no external dependencies).
function generateVfId() {
  var s = "";
  for (var i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

// --- Shared: stable per-element identity (id) ---
// Read the element's id via the central loader (handles all versions).
function getVfId(item) {
  try {
    return loadElementMetadata(item.note || "").id || "";
  } catch (e) {
    return "";
  }
}

// Store the id into the element's metadata (loader preserves other fields).
function setVfId(item, id) {
  try {
    var meta = loadElementMetadata(item.note || "");
    meta.version = ELEMENT_METADATA_VERSION;
    meta.id = id;
    item.note = jsonStringify(meta);
  } catch (e) {}
}

// Ensure the item has an id; assign a new one if missing. Returns the id.
function ensureVfId(item) {
  var id = getVfId(item);
  if (!id) {
    id = generateVfId();
    setVfId(item, id);
  }
  return id;
}

// --- ELEMENT METADATA (single JSON object in the element's own note) ---
// Read an element's metadata via the central loader. Returns
// { objectName, keywords:[] } (empty values if none / malformed).
function getElementMeta(item) {
  try {
    var meta = loadElementMetadata(item.note || "");
    return { objectName: meta.objectName, keywords: meta.keywords };
  } catch (e) {
    return { objectName: "", keywords: [] };
  }
}

// Write an element's metadata: load (migrate) the existing record,
// update the fields, and write back as current-version JSON. `keywords`
// is an array of strings; a missing id is assigned automatically.
function setElementMeta(item, objectName, keywords) {
  try {
    var meta = loadElementMetadata(item.note || "");
    meta.version = ELEMENT_METADATA_VERSION;
    meta.objectName = objectName || "";
    meta.keywords = normalizeStringArray(keywords);
    if (!meta.id) meta.id = generateVfId();
    item.note = jsonStringify(meta);
  } catch (e) {}
}

// --- SET METADATA (hidden VF_METADATA layer) ---
// The permanent hidden layer that holds one SET_<setid> text frame per Set.
// Renamed from MASTER_METADATA: it now stores general plugin data
// (Sets and future technical records), not only MASTER metadata.
function getMetadataLayer(doc) {
  var layer = getLayer(doc, "VF_METADATA");
  if (!layer) {
    // Migrate an old MASTER_METADATA layer so existing Sets are kept.
    var old = getLayer(doc, "MASTER_METADATA");
    if (old) {
      old.name = "VF_METADATA";
      layer = old;
    } else {
      layer = doc.layers.add();
      layer.name = "VF_METADATA";
    }
  }
  layer.visible = false;
  layer.locked = false;
  // A sub-layer inside a locked parent layer is still not modifiable, so
  // unlock every ancestor layer as well — otherwise textFrames.add() throws
  // "Cannot modify a layer that is locked" even though this layer is unlocked.
  // This MUST run for the migrated layer too, so do NOT return early above.
  var p = layer.parent;
  while (p && p.typename === "Layer") {
    p.locked = false;
    p = p.parent;
  }
  return layer;
}

// One hidden text frame per Set, named "SET_<setid>", stores its data as a
// single object in the note (see createSet / setSetMeta).
function getSetFrame(doc, setId, create) {
  var layer = getMetadataLayer(doc);
  for (var i = 0; i < layer.textFrames.length; i++) {
    if (layer.textFrames[i].name === "SET_" + setId) {
      return layer.textFrames[i];
    }
  }
  if (!create) return null;
  // Illustrator only allows adding page items to the document's activeLayer.
  // If another layer (e.g. ARTWORK) is active, layer.textFrames.add() throws
  // Error 9024 ("Cannot modify a layer that is locked") even though this layer
  // is unlocked — the message is misleading. Make VF_METADATA active first.
  doc.activeLayer = layer;
  // A hidden layer cannot receive new page items (Error 9024), so briefly
  // make it visible, add the frame, then restore the original visibility.
  var wasVisible = layer.visible;
  layer.visible = true;
  var tf = layer.textFrames.add();
  layer.visible = wasVisible;
  tf.name = "SET_" + setId;
  tf.contents = "";
  tf.note = "";
  return tf;
}

// Create a Set from an ordered list of member items. Assigns/ensures an id
// for each member, records them in selection order, and returns the new
// Set id. Title / keywords start empty; createdAt/modifiedAt are stamped.
function createSet(memberItems) {
  var doc = app.activeDocument;
  var setId = generateVfId();
  var memberIds = [];
  for (var i = 0; i < memberItems.length; i++) {
    memberIds.push(ensureVfId(memberItems[i]));
  }
  var now = metaNow();
  var obj = {
    version: SET_METADATA_VERSION,
    setId: setId,
    createdAt: now,
    modifiedAt: now,
    members: memberIds,
    title: "",
    keywords: []
  };
  var tf = getSetFrame(doc, setId, true);
  tf.note = jsonStringify(obj);
  return setId;
}

// Read a Set record, or null if none. Returns the latest schema
// { setId, createdAt, modifiedAt, title, keywords:[], members:[id,...] }
// (members in stored order). All version detection/migration is done
// by loadSetMetadata().
function getSetMeta(setId) {
  var doc = app.activeDocument;
  var tf = getSetFrame(doc, setId, false);
  if (!tf) return null;
  var meta = loadSetMetadata(tf.note || "");
  meta.setId = meta.setId || setId; // report the requested id
  return meta;
}

// Save (or update) a Set's Title and Keywords. Member order and the
// system timestamps are preserved/updated; createdAt is kept.
function setSetMeta(setId, title, keywords) {
  var doc = app.activeDocument;
  var tf = getSetFrame(doc, setId, false);
  if (!tf) return;
  var meta = loadSetMetadata(tf.note || "");
  meta.version = SET_METADATA_VERSION;
  meta.setId = setId;
  meta.modifiedAt = metaNow();
  if (!meta.createdAt) meta.createdAt = metaNow();
  meta.title = title || "";
  meta.keywords = normalizeStringArray(keywords);
  if (!meta.members) meta.members = [];
  tf.note = jsonStringify(meta);
}

// Collect every Set record currently stored, as a map setId -> record.
function getAllSets() {
  var doc = app.activeDocument;
  var layer = getMetadataLayer(doc);
  var out = {};
  for (var i = 0; i < layer.textFrames.length; i++) {
    var tf = layer.textFrames[i];
    var m = tf.name.match(/^SET_(.+)$/);
    if (!m) continue;
    out[m[1]] = getSetMeta(m[1]);
  }
  return out;
}

// Scan the given source layers and return the metadata for every artwork whose
// bounds fall inside `abRect`. Used during export to build per-artboard titles
// and keywords. Returns { objectNames: [], keywords: [] } (deduplicated).
// Reads ELEMENT metadata (now stored in each element's note).
function collectArtboardMetadata(doc, abRect, layers) {
  var namesSeen = {};
  var kwSeen = {};
  var objectNames = [];
  var keywords = [];

  for (var li = 0; li < layers.length; li++) {
    var layer = layers[li];
    if (!layer) continue;
    for (var i = 0; i < layer.pageItems.length; i++) {
      var item = layer.pageItems[i];
      if (!isInArtboard(item.geometricBounds, abRect)) continue;
      var meta = getElementMeta(item);
      if (meta.objectName && !namesSeen[meta.objectName]) {
        namesSeen[meta.objectName] = true;
        objectNames.push(meta.objectName);
      }
      for (var k = 0; k < meta.keywords.length; k++) {
        if (!kwSeen[meta.keywords[k]]) {
          kwSeen[meta.keywords[k]] = true;
          keywords.push(meta.keywords[k]);
        }
      }
    }
  }
  return { objectNames: objectNames, keywords: keywords };
}

// True if the bounds are inside the artboard at all (used by export).
function isInArtboard(b, abRect) {
  var cx = (b[0] + b[2]) / 2;
  var cy = (b[1] + b[3]) / 2;
  return (
    cx >= abRect[0] && cx <= abRect[2] && cy <= abRect[1] && cy >= abRect[3]
  );
}

// ===== Metadata public API =====
// Named wrappers over the storage primitives above. Element metadata is
// keyed by the element itself (stored in its note); Set metadata is keyed
// by a Set id (stored in MASTER_METADATA). The two are independent.

// Ensure the artwork has a permanent VF_ID (stored in its note).
// Returns the id. Call this whenever artwork enters MASTER.
function ensureArtworkId(item) {
  return ensureVfId(item);
}

// Read the artwork's VF_ID from its note, or "" if none.
function getArtworkId(item) {
  return getVfId(item);
}

// Read the element's own metadata: { objectName, keywords } or null.
function getArtworkMetadata(vfid) {
  // Element metadata is now stored in the element's note, not in a frame
  // keyed by VF_ID, so we resolve the item by VF_ID first.
  var item = findItemByVfId(vfid);
  return item ? getElementMeta(item) : null;
}

// Save (or update) the element's own metadata.
function setArtworkMetadata(vfid, objectName, keywords) {
  var item = findItemByVfId(vfid);
  if (item) setElementMeta(item, objectName, keywords);
}

// Resolve a PageItem by its VF_ID (linear scan; documents are small).
function findItemByVfId(vfid) {
  if (!vfid || app.documents.length === 0) return null;
  var doc = app.activeDocument;
  for (var i = 0; i < doc.pageItems.length; i++) {
    if (getVfId(doc.pageItems[i]) === vfid) return doc.pageItems[i];
  }
  return null;
}