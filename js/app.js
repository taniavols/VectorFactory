(function () {
  var cs = new CSInterface();
  var extensionPath = cs
    .getSystemPath(SystemPath.EXTENSION)
    .replace(/\\/g, "/");

  var shown = true;

  // ----- Artboard Metadata state -----
  // metaData: parsed .vfmeta object, keyed by artboard name.
  // metaArtboardNames: last-known artboard name list (for rename detection).
  // metaCurrentName: the artboard whose record is currently shown/edited.
  // metaPoll: interval id for polling the active artboard while on the tab.
  var metaData = {};
  var metaArtboardNames = null;
  var metaCurrentName = "";
  var metaPoll = null;
  var metaStatusTimer = null;

  // ----- Artwork Metadata state -----
  // awCurrentVfid: VF_ID of the artwork currently shown/edited ("" = none yet).
  // awHasSelection: an artwork is currently selected (so manual entry is allowed).
  // awPoll: interval id for polling the selection while on the tab.
  // awSaveTimer: debounce timer for saving after the user stops typing.
  var awCurrentVfid = "";
  var awHasSelection = false;
  var awPoll = null;
  var awStatusTimer = null;
  var awSaveTimer = null;

  // ----- Set Metadata state -----
  // currentSetId: the Set currently being edited in the panel ("" = none).
  // setSaveTimer: debounce timer for saving Set fields.
  var currentSetId = "";
  var setSaveTimer = null;
  var setStatusTimer = null;

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

  // Persist the chosen export folder inside the extension so it survives
  // reloads. Uses the CEP filesystem API (available in the panel context).
  var EXPORT_FOLDER_FILE =
    cs.getSystemPath(SystemPath.EXTENSION) + "/export_folder.txt";

  function saveExportFolder(path) {
    try {
      window.cep.fs.writeFile(EXPORT_FOLDER_FILE, path);
    } catch (e) {}
  }

  function loadExportFolder() {
    try {
      var r = window.cep.fs.readFile(EXPORT_FOLDER_FILE);
      if (r && r.err === 0 && r.data)
        return String(r.data).replace(/\r?\n$/, "");
    } catch (e) {}
    return "";
  }

  function setStatus(text) {
    document.getElementById("status").textContent = text;
  }

  function setToggle(isShown) {
    shown = isShown;
    document.getElementById("toggle").textContent = shown ? "Hide" : "Show";
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
      // Not JSON — just show the raw text.
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

  // Run a JSX file and update the status when done.
  function run(file, status, callback) {
    evalJsx(file, "", function (result) {
      showResult(result);
      if (callback) callback();
    });
  }

  window.onload = function () {
    setToggle(true);

    document.getElementById("generate").onclick = function () {
      run("VF_Generate.jsx", "Generated", function () {
        setToggle(false);
      });
    };

    document.getElementById("generateS").onclick = function () {
      evalJsx(["VF_Common.jsx"], 'generate("s")', function (result) {
        showResult(result);
        setToggle(false);
      });
    };

    document.getElementById("generateSK").onclick = function () {
      evalJsx(["VF_Common.jsx"], 'generate("sk")', function (result) {
        showResult(result);
        setToggle(false);
      });
    };

    document.getElementById("clear").onclick = function () {
      run("VF_Clear.jsx", "Cleared", function () {
        setToggle(true);
      });
    };

    document.getElementById("toggle").onclick = function () {
      run(shown ? "VF_Hide.jsx" : "VF_Show.jsx", shown ? "Hidden" : "Shown");
      setToggle(!shown);
    };

    // Show/hide the "No preview" placeholder based on whether an image is set.
    function updatePreviewState() {
      var img = document.getElementById("preview");
      var empty = document.querySelector("#previewBox .preview-empty");
      if (!empty) return;
      var hasSrc = img.getAttribute("src") && img.getAttribute("src") !== "";
      empty.style.display = hasSrc ? "none" : "flex";
    }

    document.getElementById("setElement").onclick = function () {
      run("VF_SetElement.jsx", "Element saved", function () {
        document.getElementById("preview").src = "preview.png?" + Date.now();
        updatePreviewState();
      });
    };

    // Initial state: hide the broken-image icon / show placeholder until set.
    updatePreviewState();

    // Restore the previously chosen export folder (persisted in the extension)
    // into the field on every panel open.
    var savedFolder = loadExportFolder();
    if (savedFolder) {
      document.getElementById("exportPath").value = savedFolder;
      document.getElementById("choosePathBtn").textContent = "Change Path";
    }

    document.getElementById("exportBtn").onclick = function () {
      var prefix = document.getElementById("prefix").value || "";
      var folder = document.getElementById("exportPath").value || "";
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        'exportArtboards("' +
          jsxString(prefix) +
          '",[],"' +
          jsxString(folder) +
          '")',
        function (result) {
          showResult(result);
        },
      );
    };

    // Choose export folder: open a folder picker in Illustrator (starting at
    // the already-chosen path, so "Change Path" resumes there) and store the
    // result in the read-only field. The button label switches to "Change
    // Path" once a folder is selected.
    document.getElementById("choosePathBtn").onclick = function () {
      var current = document.getElementById("exportPath").value || "";
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        'selectExportFolder("' + jsxString(current) + '")',
        function (result) {
          var path = (result || "").replace(/^"|"$/g, "");
          if (path && path.length > 0) {
            document.getElementById("exportPath").value = path;
            document.getElementById("choosePathBtn").textContent =
              "Change Path";
            // Persist the new folder, overwriting the previous one.
            saveExportFolder(path);
          }
        },
      );
    };

    document.getElementById("exportSelectedBtn").onclick = function () {
      // Fetch the list of artboard names from Illustrator, then show the
      // selection modal so the user can choose which to export.
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        "getArtboardNames()",
        function (result) {
          var names = [];
          try {
            names = JSON.parse(result);
          } catch (e) {
            names = [];
          }
          if (!names || names.length === 0) {
            setStatus("No artboards to export.");
            return;
          }
          openArtboardSelector(names);
        },
      );
    };

    document.getElementById("abCancel").onclick = function () {
      document.getElementById("abOverlay").classList.add("hidden");
    };

    document.getElementById("abSelectAll").onclick = function () {
      var boxes = document.querySelectorAll("#abList input[type=checkbox]");
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;
    };

    document.getElementById("abDeselectAll").onclick = function () {
      var boxes = document.querySelectorAll("#abList input[type=checkbox]");
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    };

    document.getElementById("abExport").onclick = function () {
      var overlay = document.getElementById("abOverlay");
      var checked = overlay.querySelectorAll("#abList input:checked");
      if (checked.length === 0) {
        overlay.classList.add("hidden");
        return;
      }
      var indices = [];
      for (var i = 0; i < checked.length; i++) {
        indices.push(parseInt(checked[i].value, 10));
      }
      overlay.classList.add("hidden");

      var prefix = document.getElementById("prefix").value || "";
      var folder = document.getElementById("exportPath").value || "";
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        'exportArtboards("' +
          jsxString(prefix) +
          '",[' +
          indices.join(",") +
          '],"' +
          jsxString(folder) +
          '")',
        function (result) {
          showResult(result);
        },
      );
    };

    // --- Remap Placeholders ---
    document.getElementById("remapBtn").onclick = function () {
      // Scan the current selection for S/SK* target names, then open the dialog.
      evalJsx(
        ["VF_Common.jsx", "VF_Remap.jsx"],
        "getRemapNames()",
        function (result) {
          var names = [];
          try {
            names = JSON.parse(result);
          } catch (e) {
            names = [];
          }
          if (!names || names.length === 0) {
            setStatus("No S/SK targets in selection.");
            return;
          }
          openRemapDialog(names);
        },
      );
    };

    document.getElementById("remapCancel").onclick = function () {
      document.getElementById("remapOverlay").classList.add("hidden");
    };

    document.getElementById("remapRename").onclick = function () {
      var overlay = document.getElementById("remapOverlay");
      var rows = overlay.querySelectorAll("#remapList .remap-row");
      var map = {};
      for (var i = 0; i < rows.length; i++) {
        var from = rows[i].getAttribute("data-from");
        var to = rows[i].querySelector("input").value;
        map[from] = to;
      }
      overlay.classList.add("hidden");

      // Pass the map as an ExtendScript object literal (no JSON.parse in JSX).
      var entries = [];
      for (var k in map) {
        entries.push('"' + jsxString(k) + '":"' + jsxString(map[k]) + '"');
      }
      var mapLiteral = "{" + entries.join(",") + "}";
      evalJsx(
        ["VF_Common.jsx", "VF_Remap.jsx"],
        "remapPlaceholders(" + mapLiteral + ")",
        function (result) {
          showResult(result);
        },
      );
    };

    // ----- Metadata tab wiring -----
    var tabButtons = document.querySelectorAll(".tab");
    for (var ti = 0; ti < tabButtons.length; ti++) {
      tabButtons[ti].onclick = function () {
        showTab(this.getAttribute("data-tab"));
      };
    }

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

    // ----- Delete All Sets -----
    document.getElementById("deleteAllSets").onclick = function () {
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "deleteAllSets()",
        function (result) {
          // Reset the active Set and clear the panel fields.
          currentSetId = "";
          document.getElementById("setInfo").textContent =
            "Select 2+ elements, then Set Object";
          document.getElementById("setFields").classList.add("hidden");
          document.getElementById("setMembers").innerHTML = "";
          document.getElementById("setTitle").value = "";
          document.getElementById("setKeywords").value = "";
          showResult(result);
        },
      );
    };
  };

  // Build and show the artboard selection modal.
  function openArtboardSelector(names) {
    var list = document.getElementById("abList");
    list.innerHTML = "";
    for (var i = 0; i < names.length; i++) {
      var label = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = String(i);
      cb.checked = true;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(names[i] || "artboard_" + i));
      list.appendChild(label);
    }
    document.getElementById("abOverlay").classList.remove("hidden");
  }

  // F5 / Ctrl+R reload the panel.
  document.addEventListener("keydown", function (e) {
    if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      location.reload();
    }
  });

  // Build the Remap dialog: one row per found name (left = current, right =
  // editable text field pre-filled with the same name).
  function openRemapDialog(names) {
    var list = document.getElementById("remapList");
    list.innerHTML = "";
    for (var i = 0; i < names.length; i++) {
      var row = document.createElement("div");
      row.className = "remap-row";
      row.setAttribute("data-from", names[i]);

      var from = document.createElement("span");
      from.className = "from";
      from.textContent = names[i];

      var arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "->";

      var input = document.createElement("input");
      input.type = "text";
      input.value = names[i];

      row.appendChild(from);
      row.appendChild(arrow);
      row.appendChild(input);
      list.appendChild(row);
    }
    document.getElementById("remapOverlay").classList.remove("hidden");
  }

  // ===== Artboard Metadata =====

  // Switch between the Tools and Metadata tabs. When entering the Metadata
  // tab we refresh (which also syncs the .vfmeta file with the artboards)
  // and start polling the active artboard so edits follow the selection.
  function showTab(tab) {
    var tabs = document.querySelectorAll(".tab");
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].classList.toggle(
        "active",
        tabs[t].getAttribute("data-tab") === tab,
      );
    }
    document
      .getElementById("tab-tools")
      .classList.toggle("hidden", tab !== "tools");
    document
      .getElementById("tab-metadata")
      .classList.toggle("hidden", tab !== "metadata");

    // Stop all polling, then start only what the entered tab needs.
    stopMetaPolling();
    stopArtworkPolling();
    if (tab === "metadata") {
      // The Metadata tab now hosts BOTH artboard and artwork metadata,
      // so both pollers run while it is active.
      refreshMeta();
      startMetaPolling();
      refreshArtworkMeta();
      startArtworkPolling();
    }
  }

  function startMetaPolling() {
    stopMetaPolling();
    metaPoll = setInterval(function () {
      evalJsx(
        ["VF_Common.jsx", "VF_ArtboardMeta.jsx"],
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

  // Reconcile the in-memory metadata with the current artboard names:
  //  - new artboard  -> create an empty record
  //  - deleted board  -> remove its record
  //  - exactly one removed + one added -> treat as a rename (move the data)
  function reconcileMeta(names) {
    var prev = metaArtboardNames || [];
    var removed = [];
    var added = [];
    for (var i = 0; i < prev.length; i++) {
      if (names.indexOf(prev[i]) === -1) removed.push(prev[i]);
    }
    for (var j = 0; j < names.length; j++) {
      if (prev.indexOf(names[j]) === -1) added.push(names[j]);
    }

    if (removed.length === 1 && added.length === 1) {
      metaData[added[0]] = metaData[removed[0]] || {
        titleTemplate: "",
        keywordsTemplate: "",
      };
      delete metaData[removed[0]];
    } else {
      for (var r = 0; r < removed.length; r++) delete metaData[removed[r]];
      for (var a = 0; a < added.length; a++) {
        if (!metaData[added[a]]) {
          metaData[added[a]] = { titleTemplate: "", keywordsTemplate: "" };
        }
      }
    }
    metaArtboardNames = names.slice();
  }

  // Full refresh: read the .vfmeta file, sync it with the artboards, persist
  // the synced result, then load the active artboard's record into the UI.
  function refreshMeta() {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtboardMeta.jsx"],
      "getArtboardMetaState()",
      function (result) {
        var state;
        try {
          state = JSON.parse(result);
        } catch (e) {
          return;
        }
        try {
          metaData = JSON.parse(state.content) || {};
        } catch (e) {
          metaData = {};
        }
        reconcileMeta(state.names || []);
        writeMetaFile();
        metaCurrentName = state.selected || "";
        fillMetaFields(metaCurrentName);
      },
    );
  }

  // Persist the current metaData object to the .vfmeta file. Only surface
  // errors in the global status (e.g. "save the document first"); successful
  // syncs are silent there so polling doesn't spam it. Positive feedback for
  // user edits is given by the in-tab "Saved" flash instead.
  function writeMetaFile() {
    var json = JSON.stringify(metaData);
    evalJsx(
      ["VF_Common.jsx", "VF_ArtboardMeta.jsx"],
      'writeArtboardMetaFile("' + jsxString(json) + '")',
      function (result) {
        if (!result) return;
        try {
          var p = JSON.parse(result);
          if (p.errors && p.errors.length > 0) showResult(result);
        } catch (e) {}
      },
    );
  }

  // Show the record for `name` in the two template fields.
  function fillMetaFields(name) {
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
    var rec = metaData[name] || { titleTemplate: "", keywordsTemplate: "" };
    titleEl.value = rec.titleTemplate || "";
    kwEl.value = rec.keywordsTemplate || "";
  }

  // Called on every keystroke in either field: update the in-memory record
  // for the active artboard and save the file immediately.
  function onMetaFieldEdit() {
    if (!metaCurrentName) return;
    if (!metaData[metaCurrentName]) {
      metaData[metaCurrentName] = { titleTemplate: "", keywordsTemplate: "" };
    }
    metaData[metaCurrentName].titleTemplate =
      document.getElementById("metaTitle").value;
    metaData[metaCurrentName].keywordsTemplate =
      document.getElementById("metaKeywords").value;
    writeMetaFile();
    flashMetaStatus("Saved");
  }

  // Brief "Saved" hint inside the Metadata tab (separate from the global
  // status area used by Generate / Export).
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
    awPoll = setInterval(function () {
      // Don't reload while a debounced save is still pending. This is the
      // ONLY guard needed: onArtworkFieldEdit / onSetFieldEdit set the
      // timer on every keystroke and clear it 400ms after the last one, so
      // in-progress typing is never clobbered. We deliberately do NOT
      // check document.activeElement — that value persists on the last-focused
      // field even after OS focus moves to Illustrator, which would make
      // the poll skip refresh forever (the "only refreshes after clicking
      // the panel" bug). Selection/metadata changes are reflected on the
      // next tick regardless of where focus is.
      if (awSaveTimer || setSaveTimer) return;
      // Do not reload the metadata fields while the user is actively editing
      // them: re-reading from the document would overwrite the in-progress
      // text (e.g. a trailing comma the user just typed) and move the caret.
      var ae = document.activeElement;
      if (
        ae === document.getElementById("awName") ||
        ae === document.getElementById("awKeywords") ||
        ae === document.getElementById("setTitle") ||
        ae === document.getElementById("setKeywords")
      ) {
        return;
      }
      refreshArtworkMeta();
      // Keep the active Set's fields in sync (editing one Set never
      // touches another — each is a separate record keyed by set id).
      if (currentSetId) refreshSetMeta();
    }, 300);
  }

  function stopArtworkPolling() {
    if (awPoll) clearInterval(awPoll);
    awPoll = null;
  }

  // Load the selected artwork's metadata (by VF_ID) into the fields.
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
        if (!st.has) {
          awCurrentVfid = "";
          if (st.reason === "nothing selected") {
            // Nothing selected: no target to attach metadata to.
            awHasSelection = false;
            document.getElementById("awVfid").textContent =
              "No artwork selected";
            document.getElementById("awName").value = "";
            document.getElementById("awKeywords").value = "";
            document.getElementById("awName").disabled = true;
            document.getElementById("awKeywords").disabled = true;
            return;
          }
          if (st.reason === "many selected") {
            // Multiple PageItems selected: Artwork Metadata is per-element,
            // so it does not apply here. Switch the UI to Set mode instead
            // of treating the selection as a single new artwork (which would
            // later make setSelectedArtworkMeta() reject the save with
            // "Select exactly one element"). Disable the artwork fields and
            // point the user to the Set Object section.
            awHasSelection = false;
            document.getElementById("awVfid").textContent =
              "Multiple elements — use Set Object below";
            document.getElementById("awName").value = "";
            document.getElementById("awKeywords").value = "";
            document.getElementById("awName").disabled = true;
            document.getElementById("awKeywords").disabled = true;
            if (!currentSetId) {
              document.getElementById("setInfo").textContent =
                "Multiple elements selected — click Set Object";
            }
            return;
          }
          // Artwork IS selected but has no VF_ID yet: allow manual
          // entry — saving will assign an ID automatically.
          awHasSelection = true;
          document.getElementById("awVfid").textContent =
            "New artwork — ID assigned on save";
          document.getElementById("awName").value = "";
          document.getElementById("awKeywords").value = "";
          document.getElementById("awName").disabled = false;
          document.getElementById("awKeywords").disabled = false;
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
    // Build a JS-array literal the JSX can parse: ["a","b"]
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

  // Brief "Saved" hint inside the Artwork tab.
  function flashAwStatus(text) {
    var el = document.getElementById("awStatus");
    if (!el) return;
    el.textContent = text;
    if (awStatusTimer) clearTimeout(awStatusTimer);
    awStatusTimer = setTimeout(function () {
      el.textContent = "";
    }, 1500);
  }

  // ===== Set Metadata =====
  // Independent of element metadata: a Set is a user-defined composition
  // (ordered member list + Title + Keywords) stored in MASTER_METADATA.

  // Load the active Set's record into the Set fields. Shows the ordered
  // member list (read-only) and fills Title / Keywords.
  function refreshSetMeta() {
    if (!currentSetId) {
      document.getElementById("setFields").classList.add("hidden");
      document.getElementById("setInfo").textContent =
        "Select 2+ elements, then Set Object";
      return;
    }
    if (currentSetId === "__set_error__") {
      // A Set Object error is being shown; keep it visible and do not let
      // the poll overwrite it with a default prompt or a Set lookup.
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
        // Ordered member list (selection order preserved, never sorted).
        var mem = document.getElementById("setMembers");
        mem.innerHTML = "";
        for (var i = 0; i < (st.members || []).length; i++) {
          var row = document.createElement("div");
          row.className = "member-row";
          row.textContent = i + 1 + ". " + st.members[i];
          mem.appendChild(row);
        }
        document.getElementById("setTitle").value = st.title || "";
        document.getElementById("setKeywords").value = (st.keywords || []).join(
          ", ",
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
