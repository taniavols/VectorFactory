#target illustrator

$.evalFile(File($.fileName).parent + "/VF_Common.jsx");

// Scan the current selection (groups on the PLACEHOLDERS layer) and return a
// JSON array of the unique placeholder target names (matching ^SK?\d*$) found
// anywhere inside the selected groups. Used to build the Remap dialog.
function getRemapNames() {
  if (app.documents.length === 0) return "[]";
  var doc = app.activeDocument;
  var plLayer = getLayer(doc, "PLACEHOLDERS");
  if (!plLayer) return "[]";

  var sel = app.selection;
  if (!sel || sel.length === 0) return "[]";

  var found = {};
  for (var s = 0; s < sel.length; s++) {
    var item = sel[s];
    if (item.typename !== "GroupItem") continue;
    if (item.parent !== plLayer) continue;
    collectTargets(item, found);
  }

  var names = [];
  for (var k in found) names.push(k);
  names.sort();
  var parts = [];
  for (var i = 0; i < names.length; i++) {
    parts.push('"' + vfEscapeJson(names[i]) + '"');
  }
  return "[" + parts.join(",") + "]";
}

// Recursively collect every S/SK* target name inside a container.
function collectTargets(container, found) {
  var items = container.pageItems;
  for (var i = 0; i < items.length; i++) {
    if (isTargetName(items[i].name)) found[items[i].name] = true;
  }
  var groups = container.groupItems;
  for (var j = 0; j < groups.length; j++) {
    collectTargets(groups[j], found);
  }
}

// Apply a name mapping (object: from -> to) to the currently selected groups
// on the PLACEHOLDERS layer. Only S/SK* target names are ever changed; ART,
// MASTER, other names, text content and the groups themselves are untouched.
// `map` is passed as an ExtendScript object literal (no JSON.parse available).
function remapPlaceholders(map) {
  VF_ERRORS = [];
  VF_SUCCESS = "";

  // Validate every new name up front; if any is invalid, change nothing.
  for (var from in map) {
    if (!isTargetName(map[from])) {
      vfError("Invalid placeholder name.");
      return vfResult();
    }
  }

  if (app.documents.length === 0) {
    vfError("No document.");
    return vfResult();
  }
  var doc = app.activeDocument;
  var plLayer = getLayer(doc, "PLACEHOLDERS");
  if (!plLayer) {
    vfError("Layer not found: PLACEHOLDERS.");
    return vfResult();
  }

  // The PLACEHOLDERS layer must be editable. A locked or guide/template layer
  // cannot be modified and Illustrator throws "Target layer cannot be
  // modified" when renaming items on it — report this clearly instead.
  // NOTE: LayerType is not a defined global in this ExtendScript build, so we
  // compare layerType against its string value ("guide"/"template") safely.
  var plType = "";
  try {
    plType = String(plLayer.layerType);
  } catch (e) {}
  if (plLayer.locked || plType === "guide" || plType === "template") {
    vfError("PLACEHOLDERS layer is locked or a guide layer. Unlock it to remap.");
    return vfResult();
  }

  var sel = app.selection;
  if (!sel || sel.length === 0) {
    vfError("Select one or more groups on PLACEHOLDERS.");
    return vfResult();
  }

  try {
    for (var s = 0; s < sel.length; s++) {
      var item = sel[s];
      if (item.typename !== "GroupItem") continue;
      if (item.parent !== plLayer) continue;
      applyRemap(item, map);
    }
    vfSuccess("Remapped placeholders.");
  } catch (e) {
    vfError("Error: " + e.message);
  }
  return vfResult();
}

function applyRemap(container, map) {
  var items = container.pageItems;
  for (var i = 0; i < items.length; i++) {
    var nm = items[i].name;
    if (map[nm] !== undefined) items[i].name = map[nm];
  }
  var groups = container.groupItems;
  for (var j = 0; j < groups.length; j++) {
    applyRemap(groups[j], map);
  }
}