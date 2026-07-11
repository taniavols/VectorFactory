#target illustrator

// Vector Factory common functions for Generate / Hide / Show.
// Note: S copies placeholder appearance; SK keeps the original artwork appearance.

var TARGET_NAMES = { S: true, SK: true };

function generate() {
  if (app.documents.length === 0) {
    alert("No document.");
    return;
  }

  var doc = app.activeDocument;
  var masterLayer = getLayer(doc, "MASTER");
  var placeholdersLayer = getLayer(doc, "PLACEHOLDERS");

  if (!masterLayer || masterLayer.pageItems.length === 0) {
    alert("Click Set Element first.");
    return;
  }

  if (!placeholdersLayer) {
    alert("Layer not found: PLACEHOLDERS.");
    return;
  }

  var source = masterLayer.pageItems[0];

  // Note: a text MASTER replaces text in all PLACEHOLDERS text frames.
  if (source.typename === "TextFrame") {
    replacePlaceholderText(placeholdersLayer, source.contents);
    return;
  }

  for (var i = 0; i < placeholdersLayer.groupItems.length; i++) {
    fillPlaceholderGroup(placeholdersLayer.groupItems[i], source);
  }

  hideTargets();
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

  var copy = source.duplicate();
  copy.name = "ART";
  copy.move(artGroup, ElementPlacement.PLACEATBEGINNING);
  fitToTarget(copy, target);

  for (var i = 0; i < template.pageItems.length; i++) {
    if (!isTarget(template.pageItems[i])) {
      template.pageItems[i].duplicate().move(artGroup, ElementPlacement.PLACEATEND);
    }
  }

  artGroup.clipped = true;

  if (target.name === "S") {
    copyAppearance(copy, target);
  }

  template.hidden = true;
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
  var p0 = target.pathPoints[0].anchor;
  var p1 = target.pathPoints[1].anchor;
  var p2 = target.pathPoints[2].anchor;
  var p3 = target.pathPoints[3].anchor;
  var d01 = distance(p0, p1);
  var d12 = distance(p1, p2);
  var horizontal = d01 >= d12;

  return {
    width: horizontal ? d01 : d12,
    height: horizontal ? d12 : d01,
    centerX: (p0[0] + p1[0] + p2[0] + p3[0]) / 4,
    centerY: (p0[1] + p1[1] + p2[1] + p3[1]) / 4,
    angle: (Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180) / Math.PI + 180,
    mirrored: crossProduct(p0, p1, p2) > 0
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
  var x = item.position[0] + item.width / 2;
  var y = item.position[1] - item.height / 2;
  item.translate(data.centerX - x, data.centerY - y);
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

