(function () {
  var cs = new CSInterface();
  var extensionPath = cs
    .getSystemPath(SystemPath.EXTENSION)
    .replace(/\\/g, "/");

  // ----- Artboard Metadata state -----
  var metaCurrentName = "";
  var metaPoll = null;
  var metaSaveTimer = null;
  var metaStatusTimer = null;

  // ----- Artwork Metadata state -----
  var awCurrentVfid = "";
  var awHasSelection = false;
  var awPoll = null;
  var awStatusTimer = null;
  var awSaveTimer = null;

  // ----- Set Metadata state -----
  var currentSetId = "";
  var setSaveTimer = null;
  var setStatusTimer = null;

  // ----- Which section is currently shown (artboard | single | multiple) -----
  // "none" hides all three sections and shows the "выдели что-то" hint.
  // Exactly one of the three sections is visible whenever a selection exists.

  // ----- Export lock (shared with the Tools panel) -----
  // While exporting.lock exists in the extension folder, the Tools panel is
  // driving Illustrator (export creates/closes temp documents). We must NOT
  // issue any evalScript from this panel at the same time — two CEP panels
  // talking to Illustrator concurrently crashed it. A lightweight watchdog
  // checks the lock file and suspends/resumes the pollers accordingly.
  var EXPORT_LOCK_FILE =
    cs.getSystemPath(SystemPath.EXTENSION) + "/exporting.lock";
  var lockWatchdog = null;
  var pollingSuspended = false;

  function isExportLocked() {
    try {
      var r = window.cep.fs.readFile(EXPORT_LOCK_FILE);
      return r && r.err === 0 && r.data && String(r.data).length > 0;
    } catch (e) {
      return false;
    }
  }

  // Stop both pollers (no evalScript into Illustrator while exporting).
  function suspendPolling() {
    if (pollingSuspended) return;
    pollingSuspended = true;
    stopMetaPolling();
    stopArtworkPolling();
  }

  // Resume both pollers after the export finished.
  function resumePolling() {
    if (!pollingSuspended) return;
    pollingSuspended = false;
    startMetaPolling();
    startArtworkPolling();
  }

  // Watch the lock file every 500ms. Cheap (no Illustrator access) and keeps
  // the heavy evalScript polling fully off while the Tools panel exports.
  function startLockWatchdog() {
    stopLockWatchdog();
    lockWatchdog = setInterval(function () {
      if (isExportLocked()) suspendPolling();
      else resumePolling();
    }, 500);
  }

  function stopLockWatchdog() {
    if (lockWatchdog) clearInterval(lockWatchdog);
    lockWatchdog = null;
  }

  // If a stale lock file is left over from a previous crashed export (e.g.
  // Illustrator or the Tools panel died mid-export), remove it on startup so
  // this panel does not stay suspended forever after a crash.
  function clearStaleLock() {
    if (isExportLocked()) {
      try {
        window.cep.fs.deleteFile(EXPORT_LOCK_FILE);
      } catch (e) {}
    }
  }

  // Run one or more JSX files (and an optional trailing call) inside Illustrator.
  function evalJsx(files, call, done) {
    var script = "";
    files = files instanceof Array ? files : [files];

    for (var i = 0; i < files.length; i++) {
      script += '$.evalFile("' + extensionPath + "/jsx/" + files[i] + '"); ';
    }
    if (call) script += call;

    cs.evalScript(script, function (result) {
      if (result && result !== "undefined") console.log(result);
      if (done) done(result);
    });
  }

  // Escape a string before embedding it in a JSX command string.
  function jsxString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function setStatus(text) {
    document.getElementById("status").textContent = text;
  }

  // Render a result string (JSON {errors, success} or plain text) into the
  // status area as a list. Errors are shown in red, success in green.
  function showResult(result) {
    var statusEl = document.getElementById("status");
    if (!result || result === "undefined") {
      statusEl.className = "ok";
      statusEl.innerHTML = "Done";
      return;
    }

    var errors = [];
    var success = "";
    try {
      var parsed = JSON.parse(result);
      errors = parsed.errors || [];
      success = parsed.success || "";
    } catch (e) {
      statusEl.className = "ok";
      statusEl.textContent = result;
      return;
    }

    var html = "";
    if (success) {
      html += '<div class="ok">' + escapeHtml(success) + "</div>";
    }
    if (errors.length > 0) {
      html += '<ul class="errlist">';
      for (var i = 0; i < errors.length; i++) {
        html += "<li>" + escapeHtml(errors[i]) + "</li>";
      }
      html += "</ul>";
    }
    statusEl.className = errors.length > 0 ? "has-error" : "ok";
    statusEl.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
  }

  window.onload = function () {
    // ----- Artboard Metadata field wiring -----
    document
      .getElementById("metaTitle")
      .addEventListener("input", onMetaFieldEdit);
    document
      .getElementById("metaKeywords")
      .addEventListener("input", onMetaFieldEdit);

    // ----- Artwork (Element) Metadata field wiring -----
    document
      .getElementById("awName")
      .addEventListener("input", onArtworkFieldEdit);
    document
      .getElementById("awKeywords")
      .addEventListener("input", onArtworkFieldEdit);

    // ----- Set Metadata wiring -----
    document.getElementById("setObject").onclick = function () {
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "createSelectedSet()",
        function (result) {
          var st;
          try {
            st = JSON.parse(result);
          } catch (e) {
            currentSetId = "__set_error__";
            document.getElementById("setInfo").textContent =
              "Set error: " + (result || "unknown");
            return;
          }
          if (st.success !== true) {
            currentSetId = "__set_error__";
            document.getElementById("setInfo").textContent =
              st.error || "Could not create Set.";
            document.getElementById("setFields").classList.add("hidden");
            return;
          }
          // Enter Set mode: load the new Set's record into the fields.
          currentSetId = st.setId;
          refreshSetMeta();
        },
      );
    };
    document
      .getElementById("setTitle")
      .addEventListener("input", onSetFieldEdit);
    document
      .getElementById("setKeywords")
      .addEventListener("input", onSetFieldEdit);

    // ----- Delete a single existing Set (when the selection already forms one) -----
    document.getElementById("deleteObject").onclick = function () {
      if (!currentSetId) return;
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        'deleteSet("' + jsxString(currentSetId) + '")',
        function (result) {
          currentSetId = "";
          document.getElementById("setInfo").textContent =
            "Select 2+ elements, then Set";
          document.getElementById("setFields").classList.add("hidden");
          document.getElementById("setMembers").innerHTML = "";
          document.getElementById("setTitle").value = "";
          document.getElementById("setKeywords").value = "";
          showResult(result);
        },
      );
    };

    // ----- Delete All Sets (with confirmation) -----
    document.getElementById("deleteAllSets").onclick = function () {
      if (!window.confirm("Все удалить, точно?")) return;
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "deleteAllSets()",
        function (result) {
          // Reset the active Set and clear the panel fields.
          currentSetId = "";
          document.getElementById("setInfo").textContent =
            "Select 2+ elements, then Set";
          document.getElementById("setFields").classList.add("hidden");
          document.getElementById("setMembers").innerHTML = "";
          document.getElementById("setTitle").value = "";
          document.getElementById("setKeywords").value = "";
          showResult(result);
        },
      );
    };

    // F5 / Ctrl+R reload the panel.
    document.addEventListener("keydown", function (e) {
      if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        location.reload();
      }
    });

    // This panel IS the metadata UI, so start polling immediately on load.
    // The lock watchdog suspends polling while the Tools panel exports, so
    // the two CEP panels never drive Illustrator at the same time.
    // Clear any stale lock left by a previous crashed export before we start.
    clearStaleLock();
    refreshMeta();
    startMetaPolling();
    refreshArtworkMeta();
    startArtworkPolling();
    startLockWatchdog();
  };

  // ===== Artboard Metadata =====

  function startMetaPolling() {
    stopMetaPolling();
    if (pollingSuspended) return; // watchdog will restart us after export
    metaPoll = setInterval(function () {
      evalJsx(
        ["VF_Common.jsx", "VF_ArtboardMeta.jsx", "VF_ArtworkMeta.jsx"],
        "getSelectedArtboardName()",
        function (result) {
          var name = "";
          try {
            name = JSON.parse(result).name || "";
          } catch (e) {}
          if (name !== metaCurrentName) refreshMeta();
        },
      );
    }, 250);
  }

  function stopMetaPolling() {
    if (metaPoll) clearInterval(metaPoll);
    metaPoll = null;
  }

  // Full refresh: read the active artboard's metadata from VF_METADATA
  // (keyed by artboard name) and load it into the UI.
  function refreshMeta() {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtboardMeta.jsx", "VF_ArtworkMeta.jsx"],
      "getSelectedArtboardName()",
      function (result) {
        var name = "";
        try {
          name = JSON.parse(result).name || "";
        } catch (e) {}
        metaCurrentName = name;
        if (!name) {
          fillMetaFields("");
          return;
        }
        evalJsx(
          ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
          'getArtboardMetaByName("' + jsxString(name) + '")',
          function (res2) {
            var st;
            try {
              st = JSON.parse(res2);
            } catch (e) {
              return;
            }
            if (!st.success) {
              fillMetaFields(name);
              return;
            }
            fillMetaFields(name, st.title || "", st.keywords || []);
          },
        );
      },
    );
  }

  // Show the record for `name` in the two template fields.
  function fillMetaFields(name, title, keywords) {
    var nameEl = document.getElementById("metaArtboardName");
    var titleEl = document.getElementById("metaTitle");
    var kwEl = document.getElementById("metaKeywords");

    if (!name) {
      nameEl.textContent = "No artboard (save the document)";
      titleEl.value = "";
      kwEl.value = "";
      titleEl.disabled = true;
      kwEl.disabled = true;
      return;
    }
    nameEl.textContent = name;
    titleEl.disabled = false;
    kwEl.disabled = false;
    titleEl.value = title || "";
    kwEl.value = (keywords || []).join(", ");
  }

  // Called on every keystroke in either field: debounce ~400ms, then save
  // the active artboard's metadata via setArtboardMetaByName().
  function onMetaFieldEdit() {
    if (!metaCurrentName) return;
    if (metaSaveTimer) clearTimeout(metaSaveTimer);
    metaSaveTimer = setTimeout(function () {
      metaSaveTimer = null;
      saveMetaNow();
    }, 400);
  }

  // Persist the current artboard Title / Keywords via setArtboardMetaByName().
  function saveMetaNow() {
    if (!metaCurrentName) return;
    var title = document.getElementById("metaTitle").value;
    var kwText = document.getElementById("metaKeywords").value;
    var kwItems = kwText.split(",");
    var kwParts = [];
    for (var i = 0; i < kwItems.length; i++) {
      var t = kwItems[i].replace(/^\s+|\s+$/g, "");
      if (t.length > 0) kwParts.push('"' + jsxString(t) + '"');
    }
    var kwJson = "[" + kwParts.join(",") + "]";
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      'setArtboardMetaByName("' +
        jsxString(metaCurrentName) +
        '","' +
        jsxString(title) +
        '",' +
        kwJson +
        ")",
      function (result) {
        if (result) {
          try {
            var p = JSON.parse(result);
            if (p.errors && p.errors.length > 0) showResult(result);
          } catch (e) {}
        }
        flashMetaStatus("Saved");
      },
    );
  }

  // Brief "Saved" hint inside the Artboard section.
  function flashMetaStatus(text) {
    var el = document.getElementById("metaStatus");
    if (!el) return;
    el.textContent = text;
    if (metaStatusTimer) clearTimeout(metaStatusTimer);
    metaStatusTimer = setTimeout(function () {
      el.textContent = "";
    }, 1500);
  }

  // ===== Artwork Metadata =====

  function startArtworkPolling() {
    stopArtworkPolling();
    if (pollingSuspended) return; // watchdog will restart us after export
    awPoll = setInterval(function () {
      // Don't reload while a debounced save is still pending (the user is
      // actively typing). The pending timer already protects against
      // overwriting in-progress text, so we do NOT also block on input focus
      // — otherwise, after typing and then selecting another object in
      // Illustrator (focus stays on the panel input), the refresh would be
      // skipped forever and the panel would not switch to the new object.
      if (awSaveTimer || setSaveTimer) return;
      refreshArtworkMeta();
      // Keep the active Set's fields in sync.
      if (currentSetId) refreshSetMeta();
    }, 300);
  }

  function stopArtworkPolling() {
    if (awPoll) clearInterval(awPoll);
    awPoll = null;
  }

  // Show EXACTLY ONE of the three sections based on the panel mode:
  //   "artboard" -> Artboard Metadata
  //   "single"   -> ART data
  //   "multiple" -> Set
  //   "none"     -> hide all three and show the "выдели что-то" hint.
  function applyPanelMode(mode) {
    var abEl = document.getElementById("metaArtboardSection");
    var artEl = document.getElementById("artDataSection");
    var setEl = document.getElementById("setSection");
    var hintEl = document.getElementById("emptyHint");
    if (!abEl || !artEl || !setEl || !hintEl) return;

    if (mode === "none") {
      abEl.classList.add("hidden");
      artEl.classList.add("hidden");
      setEl.classList.add("hidden");
      hintEl.classList.remove("hidden");
      return;
    }

    hintEl.classList.add("hidden");
    abEl.classList.toggle("hidden", mode !== "artboard");
    artEl.classList.toggle("hidden", mode !== "single");
    setEl.classList.toggle("hidden", mode !== "multiple");
  }

  // Poll the current selection mode from Illustrator and switch the visible
  // section accordingly. getSelectionPanelMode() returns { "mode": ... }.
  function refreshPanelMode() {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      "getSelectionPanelMode()",
      function (result) {
        var mode = "none";
        try {
          var m = JSON.parse(result);
          if (m && m.mode) mode = m.mode;
        } catch (e) {}
        if (mode !== "artboard" && mode !== "single" && mode !== "multiple") {
          mode = "none";
        }
        applyPanelMode(mode);
      },
    );
  }

  // Load the selected artwork's metadata (by VF_ID) into the fields, and
  // switch the visible section based on the selection. The mode is derived
  // from THIS result (which we already fetch reliably); getSelectionPanelMode()
  // is consulted only to upgrade to "artboard" when the selection lies inside
  // the active artboard. Any failure falls back to the element-based mode.
  function refreshArtworkMeta() {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      "getSelectedArtworkMeta()",
      function (result) {
        var st;
        try {
          st = JSON.parse(result);
        } catch (e) {
          return;
        }
        // Determine the element-based mode from this result.
        var elementMode = "none";
        if (st.has) {
          elementMode = "single";
        } else if (st.reason === "many selected") {
          elementMode = "multiple";
        } else if (st.reason === "nothing selected") {
          elementMode = "none";
        } else {
          // selected but no VF_ID yet -> treat as single (allow entry)
          elementMode = "single";
        }

        if (!st.has) {
          awCurrentVfid = "";
          if (st.reason === "nothing selected") {
            awHasSelection = false;
            hideAwWarn();
            document.getElementById("awVfid").textContent =
              "No artwork selected";
            document.getElementById("awName").value = "";
            document.getElementById("awKeywords").value = "";
            document.getElementById("awName").disabled = true;
            document.getElementById("awKeywords").disabled = true;
            // An empty selection means the user clicked inside the artboard
            // (монтажка) — getSelectionPanelMode() returns "artboard" there,
            // so the Artboard Metadata panel shows. Route through it.
            applyPanelModeFromElement("none");
            return;
          }
          if (st.reason === "many selected") {
            awHasSelection = false;
            hideAwWarn();
            document.getElementById("awVfid").textContent =
              "Multiple elements — use Set below";
            document.getElementById("awName").value = "";
            document.getElementById("awKeywords").value = "";
            document.getElementById("awName").disabled = true;
            document.getElementById("awKeywords").disabled = true;
            applyPanelMode("multiple");
            // Swap Set Object / Delete Object based on whether the selection
            // already forms an existing Set.
            updateSetButtonsForSelection();
            return;
          }
          // Artwork IS selected but has no VF_ID yet: allow manual entry.
          awHasSelection = true;
          hideAwWarn();
          document.getElementById("awVfid").textContent =
            "New artwork — ID assigned on save";
          document.getElementById("awName").value = "";
          document.getElementById("awKeywords").value = "";
          document.getElementById("awName").disabled = false;
          document.getElementById("awKeywords").disabled = false;
          applyPanelMode("single");
          return;
        }
        awCurrentVfid = st.vfid;
        awHasSelection = true;
        document.getElementById("awVfid").textContent = "VF_ID: " + st.vfid;
        document.getElementById("awName").disabled = false;
        document.getElementById("awKeywords").disabled = false;
        document.getElementById("awName").value = st.objectName || "";
        document.getElementById("awKeywords").value = (st.keywords || []).join(
          ", ",
        );
        // Warn if the selected item looks like the background (a rectangle
        // filling the artboard) rather than the actual artwork (монтажка).
        if (st.isBackground) {
          showAwWarn(
            "Похоже, выбран ФОН (прямоугольник во весь артборд), а не монтажка. Выберите саму картинку, чтобы задать ей данные.",
          );
        } else {
          hideAwWarn();
        }
        // Single element selected: show ART data, unless it is inside the
        // active artboard (then show Artboard Metadata instead).
        applyPanelModeFromElement(elementMode);
      },
    );
  }

  // Decide which section to show. getSelectionPanelMode() (JSX) is the single
  // source of truth: it returns { "mode": "artboard" } when the selection is
  // inside (or empty inside) the active artboard, "single" for one element
  // outside, "multiple" for 2+ elements, "none" only when there is no
  // artboard at all. Elements and Sets always live OUTSIDE artboards, so an
  // empty selection means the user clicked inside the artboard (монтажка)
  // -> show its panel.
  function applyPanelModeFromElement(elementMode) {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      "getSelectionPanelMode()",
      function (result) {
        var mode = elementMode;
        try {
          var m = JSON.parse(result);
          if (m && m.mode) mode = m.mode;
        } catch (e) {}
        applyPanelMode(mode);
        if (mode === "multiple") updateSetButtonsForSelection();
      },
    );
  }

  // When in Set (multiple) mode, check whether the current selection already
  // forms an existing Set. If yes, show "Delete Object" (and load that Set);
  // otherwise show "Set Object" (create). Keeps the panel in sync with the
  // document without creating anything. Only reloads Set data when the
  // resolved id actually changes, so the name/title fields do not flicker.
  function updateSetButtonsForSelection() {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      "findExistingSetForSelection()",
      function (result) {
        var setId = "";
        try {
          setId = JSON.parse(result).setId || "";
        } catch (e) {}
        var setBtn = document.getElementById("setObject");
        var delBtn = document.getElementById("deleteObject");
        if (setId) {
          // Already a Set: offer delete instead of create.
          setBtn.classList.add("hidden");
          delBtn.classList.remove("hidden");
          if (currentSetId !== setId) {
            currentSetId = setId;
            refreshSetMeta(); // loads once; refreshSetMeta guards re-writes
          }
        } else {
          // Not a Set yet: offer create.
          if (currentSetId !== "") {
            currentSetId = "";
            document.getElementById("setFields").classList.add("hidden");
          }
          setBtn.classList.remove("hidden");
          delBtn.classList.add("hidden");
          document.getElementById("setInfo").textContent =
            "Select 2+ elements, then Set";
        }
      },
    );
  }

  // Called on every keystroke: debounce so we save ~400ms after the user
  // stops typing, rather than on every single keystroke.
  function onArtworkFieldEdit() {
    if (!awHasSelection) return;
    if (awSaveTimer) clearTimeout(awSaveTimer);
    awSaveTimer = setTimeout(function () {
      awSaveTimer = null;
      saveArtworkMetaNow();
    }, 400);
  }

  // Persist the current field values for the selected artwork via
  // setSelectedArtworkMeta() (which assigns a VF_ID if missing).
  function saveArtworkMetaNow() {
    if (!awHasSelection) return;
    var name = document.getElementById("awName").value;
    var kwText = document.getElementById("awKeywords").value;
    var kwItems = kwText.split(",");
    var kwParts = [];
    for (var i = 0; i < kwItems.length; i++) {
      var t = kwItems[i].replace(/^\s+|\s+$/g, "");
      if (t.length > 0) kwParts.push('"' + jsxString(t) + '"');
    }
    var kwJson = "[" + kwParts.join(",") + "]";
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      'setSelectedArtworkMeta("' + jsxString(name) + '",' + kwJson + ")",
      function (result) {
        if (result) {
          try {
            var p = JSON.parse(result);
            if (p.errors && p.errors.length > 0) showResult(result);
          } catch (e) {}
        }
        flashAwStatus("Saved");
      },
    );
  }

  // Brief "Saved" hint inside the Artwork section.
  function flashAwStatus(text) {
    var el = document.getElementById("awStatus");
    if (!el) return;
    el.textContent = text;
    if (awStatusTimer) clearTimeout(awStatusTimer);
    awStatusTimer = setTimeout(function () {
      el.textContent = "";
    }, 1500);
  }

  // Show / hide the background warning banner in the ART data section.
  function showAwWarn(text) {
    var el = document.getElementById("awWarn");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function hideAwWarn() {
    var el = document.getElementById("awWarn");
    if (!el) return;
    el.classList.add("hidden");
    el.textContent = "";
  }

  // ===== Set Metadata =====
  // Independent of element metadata: a Set is a user-defined composition
  // (ordered member list + Title + Keywords) stored in MASTER_METADATA.

  // Load the active Set's record into the Set fields. Shows the ordered
  // member list (read-only, by display NAME) and fills Title / Keywords.
  function refreshSetMeta() {
    if (!currentSetId) {
      document.getElementById("setFields").classList.add("hidden");
      document.getElementById("setInfo").textContent =
        "Select 2+ elements, then Set";
      return;
    }
    if (currentSetId === "__set_error__") {
      document.getElementById("setFields").classList.add("hidden");
      return;
    }
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      'getSetMetaById("' + jsxString(currentSetId) + '")',
      function (result) {
        var st;
        try {
          st = JSON.parse(result);
        } catch (e) {
          return;
        }
        if (!st.success) {
          currentSetId = "";
          document.getElementById("setFields").classList.add("hidden");
          document.getElementById("setInfo").textContent =
            st.error || "Set not found.";
          return;
        }
        document.getElementById("setInfo").textContent = "Set " + currentSetId;
        document.getElementById("setFields").classList.remove("hidden");
        document.getElementById("setTitle").value = st.title || "";
        document.getElementById("setKeywords").value = (st.keywords || []).join(
          ", ",
        );
        // Load member display NAMES (titles) instead of raw VF_ID codes.
        evalJsx(
          ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
          'getSetMemberTitles("' + jsxString(currentSetId) + '")',
          function (res2) {
            var names = [];
            try {
              var p2 = JSON.parse(res2);
              if (p2.success) names = p2.names || [];
            } catch (e2) {}
            var mem = document.getElementById("setMembers");
            mem.innerHTML = "";
            for (var i = 0; i < names.length; i++) {
              var row = document.createElement("div");
              row.className = "member-row";
              row.textContent = i + 1 + ". " + names[i];
              mem.appendChild(row);
            }
          },
        );
      },
    );
  }

  // Called on every keystroke in a Set field: debounce ~400ms, then save.
  function onSetFieldEdit() {
    if (!currentSetId) return;
    if (setSaveTimer) clearTimeout(setSaveTimer);
    setSaveTimer = setTimeout(function () {
      setSaveTimer = null;
      saveSetMetaNow();
    }, 400);
  }

  // Persist the current Set Title / Keywords via setSetMetaById().
  function saveSetMetaNow() {
    if (!currentSetId) return;
    var title = document.getElementById("setTitle").value;
    var kwText = document.getElementById("setKeywords").value;
    var kwItems = kwText.split(",");
    var kwParts = [];
    for (var i = 0; i < kwItems.length; i++) {
      var t = kwItems[i].replace(/^\s+|\s+$/g, "");
      if (t.length > 0) kwParts.push('"' + jsxString(t) + '"');
    }
    var kwJson = "[" + kwParts.join(",") + "]";
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      'setSetMetaById("' +
        jsxString(currentSetId) +
        '","' +
        jsxString(title) +
        '",' +
        kwJson +
        ")",
      function (result) {
        if (result) {
          try {
            var p = JSON.parse(result);
            if (p.errors && p.errors.length > 0) showResult(result);
          } catch (e) {}
        }
        flashSetStatus("Saved");
      },
    );
  }

  // Brief "Saved" hint inside the Set section.
  function flashSetStatus(text) {
    var el = document.getElementById("setStatus");
    if (!el) return;
    el.textContent = text;
    if (setStatusTimer) clearTimeout(setStatusTimer);
    setStatusTimer = setTimeout(function () {
      el.textContent = "";
    }, 1500);
  }
})();
