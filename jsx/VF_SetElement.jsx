#target illustrator

if (app.documents.length === 0) exit();

var doc = app.activeDocument;

if (doc.selection.length != 1) {
    alert("Выдели один объект.");
    exit();
}

var source = doc.selection[0];

// -------------------------------------------------
// ARTWORK
// -------------------------------------------------

var artwork;

try {
    artwork = doc.layers.getByName("ARTWORK");
} catch (e) {
    alert("Не найден слой ARTWORK.");
    exit();
}

// -------------------------------------------------
// MASTER
// -------------------------------------------------

var masterLayer;

try {
    masterLayer = doc.layers.getByName("MASTER");
} catch (e) {
    masterLayer = doc.layers.add();
    masterLayer.name = "MASTER";
}

// -------------------------------------------------
// Вернуть старый MASTER в ARTWORK
// -------------------------------------------------

while (masterLayer.pageItems.length > 0) {

    masterLayer.pageItems[0].move(
        artwork,
        ElementPlacement.PLACEATEND
    );

}

// -------------------------------------------------
// Переместить новый объект в MASTER
// -------------------------------------------------

source.move(
    masterLayer,
    ElementPlacement.PLACEATEND
);
// ===============================
// CREATE PREVIEW
// ===============================

// MASTER наверх
masterLayer.zOrder(ZOrderMethod.BRINGTOFRONT);

// сохранить видимость
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

doc.imageCapture(
    file,
    source.visibleBounds,
    options
);

// вернуть видимость
for (var i = 0; i < doc.layers.length; i++) {
    doc.layers[i].visible = visibility[i];
}