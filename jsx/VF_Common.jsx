var targetGroups = [];
var placeholders = null;
function generate() {
  // ==================================================
  // Проверки
  // ==================================================

  if (app.documents.length === 0) {
    alert("Нет документа.");
    return;
  }

  var doc = app.activeDocument;

  var masterLayer;

  try {
    masterLayer = doc.layers.getByName("MASTER");
  } catch (e) {
    alert("Сначала нажми Set Element.");
    return;
  }

  if (masterLayer.pageItems.length == 0) {
    alert("Сначала нажми Set Element.");
    return;
  }

  var source = masterLayer.pageItems[0];
  var sourceIsText = source.typename == "TextFrame";

  placeholders = doc.layers.getByName("PLACEHOLDERS");

  // ==================================================
  // Главный цикл
  // ==================================================

  for (var i = 0; i < placeholders.groupItems.length; i++) {
    var group = placeholders.groupItems[i];

    // ==================================================
    // Проверка на Clipping Group (шаблон с маской)
    // ==================================================

    var templateCG = null;
    var generatedCG = null;

    for (var cg = 0; cg < group.groupItems.length; cg++) {
      var gItem = group.groupItems[cg];
      if (!gItem.clipped) continue;
      if (containsS(gItem)) {
        templateCG = gItem;
      } else {
        generatedCG = gItem;
      }
    }

    // если есть шаблонная Clipping Group — обрабатываем независимо
    // от наличия pageItems на верхнем уровне
    if (templateCG) {
      // удалить предыдущую сгенерированную Clipping Group
      if (generatedCG) {
        generatedCG.remove();
      }

      if (sourceIsText) {
        continue;
      }

      // найти S внутри шаблонной Clipping Group
      var targetS = null;
      for (var si = 0; si < templateCG.pageItems.length; si++) {
        if (
          templateCG.pageItems[si].name == "S" ||
          templateCG.pageItems[si].name == "SK"
        ) {
          targetS = templateCG.pageItems[si];
          break;
        }
      }

      if (!targetS) continue;

      var data = analyzeTarget(targetS);

      // создать новую Clipping Group (sibling для templateCG)
      var newCG = group.groupItems.add();
      newCG.name = "ART";

      // ART — первый объект, будет clipping mask
      var copy = source.duplicate();
      copy.name = "ART";
      copy.move(newCG, ElementPlacement.PLACEATBEGINNING);

      // подогнать ART под размер S
      fit(copy, data);
      rotate(copy, data);
      center(copy, data);

      // скопировать все pageItems из шаблонной Clipping Group, кроме S
      for (var t = 0; t < templateCG.pageItems.length; t++) {
        var templateItem = templateCG.pageItems[t];
        if (templateItem.name == "S" || templateItem.name == "SK") continue;
        var dup = templateItem.duplicate();
        dup.move(newCG, ElementPlacement.PLACEATEND);
      }

      // сделать ART clipping mask
      newCG.clipped = true;

      if (targetS.name == "S") {
        applyAppearance(copy, targetS);
      }

      continue;
    }

    // старая логика — только если есть pageItems на верхнем уровне
    if (group.pageItems.length == 0) continue;

    var target = getTarget(group);

    if (!target) continue;

    // удалить старый ART
    for (var k = group.pageItems.length - 1; k >= 0; k--) {
      if (group.pageItems[k].name == "ART") {
        group.pageItems[k].remove();
      }
    }

    // вставить новый ART
    if (sourceIsText) {
      continue;
    }

    // вставить новый ART
    var copy = source.duplicate(group, ElementPlacement.PLACEATEND);
    copy.name = "ART";

    var data = analyzeTarget(target);

    fit(copy, data);
    rotate(copy, data);
    center(copy, data);

    if (target.name == "S") {
      applyAppearance(copy, target);
    }
  }
  if (sourceIsText) {
    for (var i = 0; i < placeholders.textFrames.length; i++) {
      placeholders.textFrames[i].contents = source.contents;
    }

    return;
  }

  hideTargets();

  function getTarget(group) {
    for (var i = 0; i < group.pageItems.length; i++) {
      var item = group.pageItems[i];

      if (item.name == "S" || item.name == "SK") {
        return item;
      }
    }

    return null;
  }

  // ==================================================
  // Анализ прямоугольника S
  // ==================================================

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

      mirrored:
        (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]) >
        0,
    };
  }
  // ==================================================
  // Поворот
  // ==================================================
  function rotate(copy, data) {
    copy.rotate(data.angle);
    if (data.mirrored) {
      copy.resize(-100, 100);
      copy.rotate(180);
    }
  }
  // ==================================================
  // Масштабирование
  // ==================================================

  function fit(copy, data) {
    var b = copy.geometricBounds;

    var width = b[2] - b[0];
    var height = b[1] - b[3];

    var scale = Math.min(data.width / width, data.height / height);

    copy.resize(scale * 100, scale * 100);
  }

  // ==================================================
  // Центрирование
  // ==================================================

  function center(copy, data) {
    var x = copy.position[0] + copy.width / 2;
    var y = copy.position[1] - copy.height / 2;

    copy.translate(data.centerX - x, data.centerY - y);
  }

  // ==================================================
  // Расстояние между двумя точками
  // ==================================================

  function distance(a, b) {
    return Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
  }
  // ==================================================
  // Копирование оформления
  // ==================================================

  function applyAppearance(copy, target) {
    applyAppearanceRecursive(copy, target);
  }

  function applyAppearanceRecursive(item, target) {
    switch (item.typename) {
      case "PathItem":
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

        break;

      case "CompoundPathItem":
        for (var i = 0; i < item.pathItems.length; i++) {
          applyAppearanceRecursive(item.pathItems[i], target);
        }

        break;

      case "GroupItem":
        for (var j = 0; j < item.pageItems.length; j++) {
          applyAppearanceRecursive(item.pageItems[j], target);
        }

        break;
    }
  }
}

function containsS(group) {
  for (var ci = 0; ci < group.pageItems.length; ci++) {
    if (group.pageItems[ci].name == "S" || group.pageItems[ci].name == "SK") {
      return true;
    }
  }
  return false;
}

function replaceText(group, source) {
  replaceTextRecursive(group, source.contents);
}

function replaceTextRecursive(item, text) {
  switch (item.typename) {
    case "TextFrame":
      item.contents = text;
      break;

    case "GroupItem":
      for (var i = 0; i < item.pageItems.length; i++) {
        replaceTextRecursive(item.pageItems[i], text);
      }
      break;

    case "CompoundPathItem":
      break;
  }
}
// ==================================================
// Скрыть все прямоугольники S и SK
// ==================================================

function hideTargets() {
  if (app.documents.length === 0) return;

  var doc = app.activeDocument;
  var placeholders = doc.layers.getByName("PLACEHOLDERS");

  for (var i = 0; i < placeholders.groupItems.length; i++) {
    var group = placeholders.groupItems[i];
    hideTargetsInGroup(group);
  }
}

function hideTargetsInGroup(group) {
  // если это Clipping Group с S/SK — скрыть всю группу
  if (group.clipped && containsS(group)) {
    group.hidden = true;
    return;
  }
  // иначе — поиск S/SK среди прямых pageItems (старая логика)
  for (var i = 0; i < group.pageItems.length; i++) {
    var item = group.pageItems[i];
    if (item.name == "S" || item.name == "SK") {
      item.hidden = true;
    }
  }
  // рекурсивный поиск внутри вложенных Clipping Groups
  for (var i = 0; i < group.groupItems.length; i++) {
    if (group.groupItems[i].clipped) {
      hideTargetsInGroup(group.groupItems[i]);
    }
  }
}

function showTargets() {
  if (app.documents.length === 0) return;

  var doc = app.activeDocument;
  var placeholders = doc.layers.getByName("PLACEHOLDERS");

  for (var i = 0; i < placeholders.groupItems.length; i++) {
    var group = placeholders.groupItems[i];
    showTargetsInGroup(group);
  }
}

function showTargetsInGroup(group) {
  // если это Clipping Group с S/SK — показать всю группу
  if (group.clipped && containsS(group)) {
    group.hidden = false;
    return;
  }
  // иначе — поиск S/SK среди прямых pageItems (старая логика)
  for (var i = 0; i < group.pageItems.length; i++) {
    var item = group.pageItems[i];
    if (item.name == "S" || item.name == "SK") {
      item.hidden = false;
    }
  }
  // рекурсивный поиск внутри вложенных Clipping Groups
  for (var i = 0; i < group.groupItems.length; i++) {
    if (group.groupItems[i].clipped) {
      showTargetsInGroup(group.groupItems[i]);
    }
  }
}

// ==================================================
// Поиск всех S
// ==================================================
function groupPlaceholders() {
  if (app.documents.length === 0) return;

  var doc = app.activeDocument;
  var layer = doc.layers.getByName("PLACEHOLDERS");

  groupLayer(layer);

  alert("Готово.");
}

function groupLayer(parent) {
  var list = [];

  for (var i = 0; i < parent.pageItems.length; i++) {
    var item = parent.pageItems[i];

    if (item.name == "S" || item.name == "SK") {
      if (item.parent.typename != "GroupItem") {
        list.push(item);
      }
    }
  }

  for (var i = 0; i < list.length; i++) {
    var g = parent.groupItems.add();

    list[i].move(g, ElementPlacement.PLACEATBEGINNING);
  }

  for (var j = 0; j < parent.layers.length; j++) {
    groupLayer(parent.layers[j]);
  }
}

// groupPlaceholders();
