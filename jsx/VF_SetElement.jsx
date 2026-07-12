#target illustrator

if (app.documents.length === 0) exit();

var doc = app.activeDocument;

if (doc.selection.length < 1) {
  alert("Select one or more objects.");
  exit();
}

var artwork = getRequiredLayer("ARTWORK");
var masterLayer = getOrCreateLayer("MASTER");

// MASTER holds the current source object(s) for S/SK placeholders.
// Multiple selected objects are sorted left-to-right by their X coordinate
// (selection order is ignored) and named MASTER1, MASTER2, ... so that
// MASTER1 maps to S1/SK1, MASTER2 to S2/SK2, etc.
moveAllItems(masterLayer, artwork);

// Collect selected items, sort by X (left edge of geometric bounds).
var sel = [];
for (var s = 0; s < doc.selection.length; s++) {
  sel.push(doc.selection[s]);
}
sel.sort(function (a, b) {
  return a.geometricBounds[0] - b.geometricBounds[0];
});

for (var n = 0; n < sel.length; n++) {
  var item = sel[n];
  item.move(masterLayer, ElementPlacement.PLACEATEND);
  // First object keeps the plain "MASTER" name (== MASTER1) for compatibility.
  item.name = n === 0 ? "MASTER" : "MASTER" + (n + 1);
}
masterLayer.zOrder(ZOrderMethod.BRINGTOFRONT);

// Capture only MASTER, then restore layer visibility.
var visibility = [];
for (var i = 0; i < doc.layers.length; i++) {
  visibility[i] = doc.layers[i].visible;
  doc.layers[i].visible = false;
}
masterLayer.visible = true;

var file = new File(File($.fileName).parent.parent + "/preview.png");
var options = new ImageCaptureOptions();
options.resolution = 150;
options.transparency = true;
options.antiAliasing = true;

// Capture the union of all MASTER objects.
var captureBounds = masterLayer.pageItems[0].visibleBounds;
for (var c = 1; c < masterLayer.pageItems.length; c++) {
  var b = masterLayer.pageItems[c].visibleBounds;
  captureBounds = [
    Math.min(captureBounds[0], b[0]),
    Math.max(captureBounds[1], b[1]),
    Math.max(captureBounds[2], b[2]),
    Math.min(captureBounds[3], b[3]),
  ];
}
doc.imageCapture(file, captureBounds, options);

for (var i = 0; i < doc.layers.length; i++) {
  doc.layers[i].visible = visibility[i];
}

function moveAllItems(fromLayer, toLayer) {
  while (fromLayer.pageItems.length > 0) {
    fromLayer.pageItems[0].move(toLayer, ElementPlacement.PLACEATEND);
  }
}

function getRequiredLayer(name) {
  try {
    return doc.layers.getByName(name);
  } catch (e) {
    alert("Layer not found: " + name + ".");
    exit();
  }
}

function getOrCreateLayer(name) {
  try {
    return doc.layers.getByName(name);
  } catch (e) {
    var layer = doc.layers.add();
    layer.name = name;
    return layer;
  }
}
