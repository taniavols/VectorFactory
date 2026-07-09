#target illustrator

if (app.documents.length === 0) exit();

var doc = app.activeDocument;
var placeholders = doc.layers.getByName("PLACEHOLDERS");

clearGroups(placeholders);

function clearGroups(parent) {
  for (var i = parent.groupItems.length - 1; i >= 0; i--) {
    var group = parent.groupItems[i];

    // Note: ART is generated content; S/SK are templates and must stay.
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

      if (item.name == "S" || item.name == "SK") {
        item.hidden = false;
      }
    }

    clearGroups(group);
  }
}
