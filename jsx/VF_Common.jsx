#target illustrator

// Vector Factory common functions for Generate / Hide / Show.
// Note: S copies placeholder appearance; SK keeps the original artwork appearance.

var TARGET_NAMES = { S: true, SK: true };

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

function generate() {
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

  var source = masterLayer.pageItems[0];

  // Note: a text MASTER replaces text in all PLACEHOLDERS text frames.
  if (source.typename === "TextFrame") {
    try {
      replacePlaceholderText(placeholdersLayer, source.contents);
      vfSuccess("Generated (text)");
    } catch (e) {
      vfError("Error: " + e.message);
    }
    return vfResult();
  }

  try {
    for (var i = 0; i < placeholdersLayer.groupItems.length; i++) {
      fillPlaceholderGroup(placeholdersLayer.groupItems[i], source);
    }
    hideTargets();
    vfSuccess("Generated");
  } catch (e) {
    vfError("Error: " + e.message);
  }

  return vfResult();
}

function fillPlaceholderGroup(group, source) {
  var clippingTemplate = findClippingTemplate(group);

  if (clippingTemplate) {
    fillClippingTemplate(group, clippingTemplate, source);
    return;
  }

  fillSimpleTemplate(group, source);
}

function fillClippingTemplate(group, template, source) {
  removeGeneratedArt(group);

  var target = findTarget(template);
  if (!target) return;

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

  if (target.name === "S") copyAppearance(copy, target);

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

function fillSimpleTemplate(group, source) {
  var target = findTarget(group);
  if (!target) return;

  removeGeneratedArt(group);

  var copy = source.duplicate(group, ElementPlacement.PLACEATEND);
  copy.name = "ART";
  fitToTarget(copy, target);

  if (target.name === "S") copyAppearance(copy, target);
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
  item.rotate(data.angle);
  if (data.mirrored) {
    item.resize(-100, 100);
    item.rotate(180);
  }
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
  for (var i = group.groupItems.length - 1; i >= 0; i--) {
    var childGroup = group.groupItems[i];
    if (childGroup.name === "ART" || (childGroup.clipped && !containsTarget(childGroup))) {
      childGroup.remove();
    }
  }

  for (var j = group.pageItems.length - 1; j >= 0; j--) {
    if (group.pageItems[j].name === "ART") group.pageItems[j].remove();
  }
  for (var k = 0; k < group.groupItems.length; k++) {
  var g = group.groupItems[k];
  if (g.clipped && containsTarget(g)) {
    g.hidden = false;
  }
}
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
  return item && TARGET_NAMES[item.name] === true;
}

function replacePlaceholderText(container, text) {
  for (var i = 0; i < container.textFrames.length; i++) {
    container.textFrames[i].contents = text;
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

