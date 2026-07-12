#target illustrator

if (app.documents.length === 0) exit();

var doc = app.activeDocument;
var placeholders = doc.layers.getByName("PLACEHOLDERS");

clearGroups(placeholders);

function clearGroups(parent) {
  for (var i = parent.groupItems.length - 1; i >= 0; i--) {
    var group = parent.groupItems[i];

    // Note: ART is generated content; S/SK (and numbered S1/SK3) are
    // templates and must stay.
    if (group.name == "ART" && group.clipped) {
      group.remove();
      continue;
    }

    if (group.clipped) group.hidden = false;

    for (var j = group.pageItems.length - 1; j >= 0; j--) {
      var item = group.pageItems[j];

      if (item.name == "ART") {
        item.remove();
        continue;
      }

      // Un-hide any template target (S, SK, S1, SK2, S3, ...).
      if (/^S(K)?\d*$/.test(item.name)) {
        item.hidden = false;
      }
    }

    clearGroups(group);
  }
}
