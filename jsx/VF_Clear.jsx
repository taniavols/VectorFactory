#target illustrator

if (app.documents.length === 0) exit();

var doc = app.activeDocument;
var placeholders = doc.layers.getByName("PLACEHOLDERS");

clearGroups(placeholders);

function clearGroups(parent) {

    for (var i = 0; i < parent.groupItems.length; i++) {

        var group = parent.groupItems[i];

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