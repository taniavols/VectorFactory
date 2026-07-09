#target illustrator

if (app.documents.length === 0) exit();

var doc = app.activeDocument;

if (doc.selection.length != 1) {
  alert("Select one object.");
  exit();
}

var source = doc.selection[0];
var artwork = getRequiredLayer("ARTWORK");
var masterLayer = getOrCreateLayer("MASTER");

// Note: MASTER stores one current source object for S/SK placeholders.
moveAllItems(masterLayer, artwork);
source.move(masterLayer, ElementPlacement.PLACEATEND);
masterLayer.zOrder(ZOrderMethod.BRINGTOFRONT);

var visibility = [];
for (var i = 0; i < doc.layers.length; i++) {
  visibility[i] = doc.layers[i].visible;
  doc.layers[i].visible = false;
}

// Note: preview shows only MASTER temporarily, then restores layer visibility.
masterLayer.visible = true;

var file = new File(File($.fileName).parent.parent + "/preview.png");
var options = new ImageCaptureOptions();
options.resolution = 150;
options.transparency = true;
options.antiAliasing = true;

doc.imageCapture(file, source.visibleBounds, options);

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
