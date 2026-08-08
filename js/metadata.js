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
  // Throttle guards for the per-poll Set lookup (see updateSetButtonsForSelection).
  var setLookupBusy = false;
  var lastSetLookup = 0;

  // Selection identity that AI just filled into the fields. While it matches
  // the current selection, the pollers must NOT reload (and thus wipe) the
  // AI-filled text — we do NOT auto-save, so Illustrator still has the old
  // (empty) value. Cleared when the user edits a field or selects something
  // else. Format: "el:<vfid>" | "set:<setId>" | "ab:<artboardName>".
  var aiFilledKey = "";

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

  // Acquire / release the SAME lock the Tools panel uses. While the lock
  // file exists, the lock watchdog suspends this panel's pollers, so no
  // evalJsx reaches Illustrator concurrently with a long/blocking op.
  function setExportLock() {
    try {
      window.cep.fs.writeFile(EXPORT_LOCK_FILE, "1");
    } catch (e) {}
  }

  function clearExportLock() {
    try {
      window.cep.fs.deleteFile(EXPORT_LOCK_FILE);
    } catch (e) {}
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
  // Each $.evalFile and the trailing call go on their OWN line (not one long
  // line). ExtendScript is fragile when everything is concatenated into a
  // single line — a #target directive or any error then reports as
  // "Синтаксическая ошибка. Line: 1" with the whole script on one line.
  function evalJsx(files, call, done) {
    var lines = [];
    files = files instanceof Array ? files : [files];

    for (var i = 0; i < files.length; i++) {
      lines.push('$.evalFile("' + extensionPath + "/jsx/" + files[i] + '");');
    }
    if (call) lines.push(call);

    var script = lines.join("\n");

    cs.evalScript(script, function (result) {
      if (result && result !== "undefined") console.log(result);
      if (done) done(result);
    });
  }

  // Escape a string before embedding it in a JSX command string.
  function jsxString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function setStatus(text, isError) {
    var el = document.getElementById("status");
    if (!el) return;
    var textEl = document.getElementById("statusText");
    if (textEl) {
      textEl.textContent = text;
    } else {
      el.textContent = text;
    }
    if (isError) el.classList.add("has-error");
    else el.classList.remove("has-error");
  }

  function setSpinner(show) {
    var el = document.getElementById("status");
    if (!el) return;
    if (show) el.classList.add("spinning");
    else el.classList.remove("spinning");
  }

  // Render a result string (JSON {errors, success} or plain text) into the
  // status area as a list. Errors are shown in red, success in green.
  function showResult(result) {
    var statusEl = document.getElementById("status");
    var textEl = document.getElementById("statusText");
    if (!result || result === "undefined") {
      statusEl.className = "ok";
      if (textEl) textEl.textContent = "Done";
      else statusEl.textContent = "Done";
      return;
    }

    var errors = [];
    var success = "";
    var raw = String(result).trim();
    try {
      var parsed = JSON.parse(raw);
      errors = parsed.errors || [];
      success = parsed.success || "";
    } catch (e) {
      statusEl.className = "ok";
      if (textEl) textEl.textContent = raw;
      else statusEl.textContent = raw;
      return;
    }

    if (errors.length > 0) {
      var html =
        '<ul class="errlist">' +
        errors.map(function (err) { return "<li>" + escapeHtml(err) + "</li>"; }).join("") +
        "</ul>";
      statusEl.className = "has-error";
      statusEl.innerHTML = '<span class="status-spinner" id="statusSpinner"></span>' + html;
    } else {
      statusEl.className = "ok";
      if (success) {
        if (textEl) {
          textEl.innerHTML = escapeHtml(success).replace(/\n/g, "<br>");
        } else {
          statusEl.innerHTML = escapeHtml(success).replace(/\n/g, "<br>");
        }
      } else if (textEl) {
        textEl.textContent = raw;
      } else {
        statusEl.textContent = raw;
      }
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
  }

  // ===== Live field counters (word count for titles, keyword count for keyword fields) =====
  // Words = whitespace-separated non-empty tokens.
  function countWords(text) {
    var t = String(text).replace(/^\s+|\s+$/g, "");
    if (t.length === 0) return 0;
    return t.split(/\s+/).length;
  }
  // Keywords = comma-separated, trimmed, non-empty entries.
  function countKeywords(text) {
    var items = String(text).split(",");
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].replace(/^\s+|\s+$/g, "").length > 0) n++;
    }
    return n;
  }
  // Update one counter span from its paired input field.
  function updateFieldCounter(inputId, counterId, kind) {
    var input = document.getElementById(inputId);
    var counter = document.getElementById(counterId);
    if (!input || !counter) return;
    var n =
      kind === "words" ? countWords(input.value) : countKeywords(input.value);
    counter.textContent = String(n);
  }
  // Refresh all field counters from the current field values.
  function refreshAllCounters() {
    updateFieldCounter("metaTitle", "metaTitleCount", "words");
    updateFieldCounter("metaShortTitle", "metaShortTitleCount", "words");
    updateFieldCounter("metaKeywords", "metaKeywordsCount", "keywords");
    updateFieldCounter("awName", "awNameCount", "words");
    updateFieldCounter("awKeywords", "awKeywordsCount", "keywords");
    updateFieldCounter("setTitle", "setTitleCount", "words");
    updateFieldCounter("setKeywords", "setKeywordsCount", "keywords");
  }

  window.onload = function () {
    // ----- Artboard Metadata field wiring -----
    document
      .getElementById("metaTitle")
      .addEventListener("input", onMetaFieldEdit);
    document
      .getElementById("metaShortTitle")
      .addEventListener("input", onMetaFieldEdit);
    document
      .getElementById("metaKeywords")
      .addEventListener("input", onMetaFieldEdit);
    document
      .getElementById("metaCategory")
      .addEventListener("change", onMetaFieldEdit);

    // Editable artboard name: save on Enter or blur (rename in Illustrator).
    var abNameEl = document.getElementById("metaArtboardName");
    if (abNameEl) {
      abNameEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          abNameEl.blur(); // triggers the blur handler below
        }
      });
      abNameEl.addEventListener("blur", function () {
        renameArtboard();
      });
    }

    // ----- Artwork (Element) Metadata field wiring -----
    document
      .getElementById("awName")
      .addEventListener("input", onArtworkFieldEdit);
    document
      .getElementById("awKeywords")
      .addEventListener("input", onArtworkFieldEdit);
    document
      .getElementById("awCategory")
      .addEventListener("change", onArtworkFieldEdit);

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
          // Hide the Set button — this selection now represents an existing Set.
          document.getElementById("setObject").classList.add("hidden");
        },
      );
    };
    // ----- Unmake Set (delete Set entity entirely) -----
    document.getElementById("unmakeSet").onclick = function () {
      if (!currentSetId) return;
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        'unmakeSet("' + jsxString(currentSetId) + '")',
        function (result) {
          currentSetId = "";
          document.getElementById("setFields").classList.add("hidden");
          document.getElementById("setInfo").textContent =
            "Select 2+ elements, then Set";
          document.getElementById("setObject").classList.remove("hidden");
          document.getElementById("unmakeSet").classList.add("hidden");
          showResult(result);
        },
      );
    };
    document
      .getElementById("setTitle")
      .addEventListener("input", onSetFieldEdit);
    document
      .getElementById("setKeywords")
      .addEventListener("input", onSetFieldEdit);
    document
      .getElementById("setCategory")
      .addEventListener("change", onSetFieldEdit);

    // ----- Live field counters (word count for titles, keyword count for keyword fields) -----
    // Update immediately on every keystroke for snappy feedback...
    var counterFields = [
      "metaTitle",
      "metaShortTitle",
      "metaKeywords",
      "awName",
      "awKeywords",
      "setTitle",
      "setKeywords",
    ];
    for (var ci = 0; ci < counterFields.length; ci++) {
      var cf = document.getElementById(counterFields[ci]);
      if (cf) cf.addEventListener("input", refreshAllCounters);
    }
    // ...and on a light interval so programmatic fills/clears also stay in sync.
    setInterval(refreshAllCounters, 300);
    refreshAllCounters();



    // ----- Delete Active Metadata (element / set / artboard) -----
    document.getElementById("deleteActiveMeta").onclick = function () {
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "deleteActiveMetadata()",
        function (result) {
          showResult(result);
          // After deletion, refresh all panel sections.
          refreshArtworkMeta();
          if (currentSetId) refreshSetMeta();
        },
      );
    };

    // ----- Delete Selected Metadata (open the record-selection overlay) -----
    document.getElementById("deleteSelectedMeta").onclick = function () {
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "getAllMetadataRecords()",
        function (result) {
          var records = [];
          try {
            records = JSON.parse(result);
          } catch (e) {
            records = [];
          }
          if (!records || records.length === 0) {
            setStatus("No metadata records.");
            return;
          }
          openMetaDocSelector(records);
        },
      );
    };

    document.getElementById("metaCancel").onclick = function () {
      document.getElementById("metaDocInfoOverlay").classList.add("hidden");
    };

    document.getElementById("metaSelectAll").onclick = function () {
      var boxes = document.querySelectorAll("#metaDocList input[type=checkbox]");
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;
    };

    document.getElementById("metaDeselectAll").onclick = function () {
      var boxes = document.querySelectorAll("#metaDocList input[type=checkbox]");
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    };

    document.getElementById("metaDeleteOk").onclick = function () {
      var overlay = document.getElementById("metaDocInfoOverlay");
      var checked = overlay.querySelectorAll("#metaDocList input:checked");
      if (checked.length === 0) {
        overlay.classList.add("hidden");
        return;
      }
      var records = [];
      for (var i = 0; i < checked.length; i++) {
        try {
          records.push(JSON.parse(checked[i].value));
        } catch (e) {}
      }
      overlay.classList.add("hidden");

      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "deleteMetadataRecords(" + JSON.stringify(records) + ")",
        function (result) {
          showResult(result);
        },
      );
    };

    // ----- Delete All Metadata (with confirmation) -----
    document.getElementById("deleteAllMeta").onclick = function () {
      if (!window.confirm("Delete all metadata from this document?")) return;
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "deleteAllMetadataRecords()",
        function (result) {
          showResult(result);
        },
      );
    };

    // ----- Diagnose Metadata (show detailed table of Object records) -----
    var diagOutputEl = document.getElementById("diagOutput");
    var diagCloseBtn = document.getElementById("diagClose");

    function hideDiagOutput() {
      if (diagOutputEl) {
        diagOutputEl.textContent = "";
        diagOutputEl.classList.remove("visible", "has-content");
      }
      var diagBtn = document.getElementById("diagClose");
      if (diagBtn) diagBtn.classList.add("hidden");
    }

    document.getElementById("diagnoseMeta").onclick = function () {
      setExportLock();
      evalJsx(
        ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        "diagnoseMetadataRecords()",
        function (result) {
          clearExportLock();
          if (!result || result === "undefined") {
            if (diagOutputEl) {
              diagOutputEl.textContent = "No data returned from Illustrator.";
              diagOutputEl.classList.add("visible", "has-content");
            }
            return;
          }
          if (diagOutputEl) {
            diagOutputEl.textContent = result;
            diagOutputEl.classList.add("visible", "has-content");
          }
          var diagBtn = document.getElementById("diagClose");
          if (diagBtn) diagBtn.classList.remove("hidden");
        },
      );
    };

    if (diagCloseBtn) {
      diagCloseBtn.addEventListener("click", hideDiagOutput);
    }

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

    // AI Metadata settings UI (local config; no network calls yet).
    initAiSettings();
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
            fillMetaFields(name, st.title || "", st.shortTitle || "", st.keywords || [], st.shutterstockCategory || "");
          },
        );
      },
    );
  }

  // Show the record for `name` in the template fields.
  function fillMetaFields(name, title, shortTitle, keywords, shutterstockCategory) {
    var nameEl = document.getElementById("metaArtboardName");
    var titleEl = document.getElementById("metaTitle");
    var shortTitleEl = document.getElementById("metaShortTitle");
    var kwEl = document.getElementById("metaKeywords");
    var catEl = document.getElementById("metaCategory");

    if (!name) {
      nameEl.value = "No artboard (save the document)";
      nameEl.disabled = true;
      titleEl.value = "";
      shortTitleEl.value = "";
      kwEl.value = "";
      if (catEl) catEl.value = "";
      titleEl.disabled = true;
      shortTitleEl.disabled = true;
      kwEl.disabled = true;
      if (catEl) catEl.disabled = true;
      return;
    }
    nameEl.value = name;
    nameEl.disabled = false;
    titleEl.disabled = false;
    shortTitleEl.disabled = false;
    kwEl.disabled = false;
    if (catEl) catEl.disabled = false;
    // Don't reload (and wipe) fields that AI just filled for THIS artboard.
    // Keep the guard if name is empty (no artboard selected yet).
    if (
      aiFilledKey.indexOf("ab:") === 0 &&
      name &&
      aiFilledKey !== "ab:" + name
    ) {
      aiFilledKey = "";
    }
    var aiSkipAb = aiFilledKey === "ab:" + name;
    if (!aiSkipAb) {
      titleEl.value = title || "";
      shortTitleEl.value = shortTitle || "";
      kwEl.value = (keywords || []).join(", ");
      if (catEl) catEl.value = shutterstockCategory || "";
    }
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

  // Persist the current artboard Title / Short Title / Keywords / Category via setArtboardMetaByName().
  function saveMetaNow() {
    if (!metaCurrentName) return;
    var title = document.getElementById("metaTitle").value;
    var shortTitle = document.getElementById("metaShortTitle").value;
    var kwText = document.getElementById("metaKeywords").value;
    var category = document.getElementById("metaCategory").value || "";
    var kwItems = kwText.split(",");
    var kwParts = [];
    var seen = {};
    for (var i = 0; i < kwItems.length; i++) {
      var t = kwItems[i].replace(/^\s+|\s+$/g, "");
      if (t.length === 0) continue;
      if (t !== "*" && seen[t]) continue;
      seen[t] = true;
      kwParts.push('"' + jsxString(t) + '"');
    }
    var kwJson = "[" + kwParts.join(",") + "]";
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      'setArtboardMetaByName("' +
        jsxString(metaCurrentName) +
        '","' +
        jsxString(title) +
        '","' +
        jsxString(shortTitle) +
        '",' +
        kwJson +
        ',"' +
        jsxString(category) +
        '")',
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

  // Rename the active artboard to the value typed in the editable name field.
  // Called on Enter / blur. If the name is unchanged (or empty), does nothing.
  // After renaming in Illustrator, updates the internal reference and refreshes
  // the panel so Title/Keywords stay connected to the same artboard.
  function renameArtboard() {
    var nameEl = document.getElementById("metaArtboardName");
    if (!nameEl || nameEl.disabled) return;
    var newName = nameEl.value.trim();
    if (!newName) {
      // Restore the previous name if the field was cleared.
      nameEl.value = metaCurrentName;
      return;
    }
    if (newName === metaCurrentName) return; // no change
    var oldName = metaCurrentName;
    evalJsx(
      ["VF_Common.jsx", "VF_ArtboardMeta.jsx", "VF_ArtworkMeta.jsx"],
      'renameArtboardByName("' +
        jsxString(oldName) +
        '","' +
        jsxString(newName) +
        '")',
      function (result) {
        showResult(result);
        // Update the internal reference and refresh metadata state. The
        // Title/Keywords templates remain connected (the JSX migrated the
        // metadata record to the new artboard name).
        metaCurrentName = newName;
        refreshMeta();
      },
    );
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
      abEl.classList.remove("active-mode-artboard");
      artEl.classList.remove("active-mode-single");
      setEl.classList.remove("active-mode-multiple");
      return;
    }

    hintEl.classList.add("hidden");
    abEl.classList.toggle("hidden", mode !== "artboard");
    artEl.classList.toggle("hidden", mode !== "single");
    setEl.classList.toggle("hidden", mode !== "multiple");

    abEl.classList.toggle("active-mode-artboard", mode === "artboard");
    artEl.classList.toggle("active-mode-single", mode === "single");
    setEl.classList.toggle("active-mode-multiple", mode === "multiple");
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
            document.getElementById("awCategory").value = "";
            document.getElementById("awName").disabled = true;
            document.getElementById("awKeywords").disabled = true;
            document.getElementById("awCategory").disabled = true;
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
            document.getElementById("awCategory").value = "";
            document.getElementById("awName").disabled = true;
            document.getElementById("awKeywords").disabled = true;
            document.getElementById("awCategory").disabled = true;
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
          document.getElementById("awCategory").value = "";
          document.getElementById("awName").disabled = false;
          document.getElementById("awKeywords").disabled = false;
          document.getElementById("awCategory").disabled = false;
          applyPanelMode("single");
          return;
        }
        awCurrentVfid = st.vfid;
        awHasSelection = true;
        document.getElementById("awVfid").textContent = "VF_ID: " + st.vfid;
        document.getElementById("awName").disabled = false;
        document.getElementById("awKeywords").disabled = false;
        document.getElementById("awCategory").disabled = false;
        // Don't reload (and wipe) fields that AI just filled for THIS
        // selection — we don't auto-save, so Illustrator still has the old
        // value. The guard clears itself when the selection changes to a
        // DIFFERENT (non-empty) VF_ID. If st.vfid is empty (new artwork with no
        // ID yet), keep the guard so the AI text is not wiped by the poller.
        if (
          aiFilledKey.indexOf("el:") === 0 &&
          st.vfid &&
          aiFilledKey !== "el:" + st.vfid
        ) {
          aiFilledKey = "";
        }
        var aiSkipEl = aiFilledKey === "el:" + st.vfid;
        if (!aiSkipEl) {
          document.getElementById("awName").value = st.objectName || "";
          document.getElementById("awKeywords").value = (
            st.keywords || []
          ).join(", ");
          document.getElementById("awCategory").value = st.shutterstockCategory || "";
        }
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
  // forms an existing Set. If yes, load its metadata into the fields and hide
  // the "Set" button (the Set already exists). If no, show the "Set" button.
  // Keeps the panel in sync with the document without creating anything.
  // Only reloads Set data when the resolved id actually changes.
  function updateSetButtonsForSelection() {
    // Throttle: the polling loop calls this every 300ms, but
    // findExistingSetForSelection() runs a full getAllSets() scan — doing it
    // on every poll hammers Illustrator and can freeze the panel. Skip while a
    // lookup is in flight or if one ran <1s ago.
    if (setLookupBusy) return;
    var now = Date.now();
    if (now - lastSetLookup < 1000) return;
    lastSetLookup = now;
    setLookupBusy = true;
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      "findExistingSetForSelection()",
      function (result) {
        setLookupBusy = false;
        var setId = "";
        try {
          setId = JSON.parse(result).setId || "";
        } catch (e) {}
        var setBtn = document.getElementById("setObject");
        var unmakeBtn = document.getElementById("unmakeSet");
        if (setId) {
          if (currentSetId !== setId) {
            currentSetId = setId;
            refreshSetMeta(); // loads once; refreshSetMeta guards re-writes
          }
          if (setBtn) setBtn.classList.add("hidden");
          if (unmakeBtn) unmakeBtn.classList.remove("hidden");
        } else {
          if (currentSetId !== "") {
            currentSetId = "";
            document.getElementById("setFields").classList.add("hidden");
            document.getElementById("setInfo").textContent =
              "Select 2+ elements, then Set";
          }
          if (setBtn) setBtn.classList.remove("hidden");
          if (unmakeBtn) unmakeBtn.classList.add("hidden");
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
    var category = document.getElementById("awCategory").value || "";
    var kwItems = kwText.split(",");
    var kwParts = [];
    var seen = {};
    for (var i = 0; i < kwItems.length; i++) {
      var t = kwItems[i].replace(/^\s+|\s+$/g, "");
      if (t.length === 0) continue;
      if (t !== "*" && seen[t]) continue;
      seen[t] = true;
      kwParts.push('"' + jsxString(t) + '"');
    }
    var kwJson = "[" + kwParts.join(",") + "]";
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      'setSelectedArtworkMeta("' +
        jsxString(name) +
        '",' +
        kwJson +
        ',"' +
        jsxString(category) +
        '")',
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
        // Don't reload (and wipe) fields that AI just filled for THIS Set.
        // Keep the guard if currentSetId is empty (no Set selected yet).
        if (
          aiFilledKey.indexOf("set:") === 0 &&
          currentSetId &&
          aiFilledKey !== "set:" + currentSetId
        ) {
          aiFilledKey = "";
        }
        var aiSkipSet = aiFilledKey === "set:" + currentSetId;
        if (!aiSkipSet) {
          document.getElementById("setTitle").value = st.title || "";
          document.getElementById("setKeywords").value = (
            st.keywords || []
          ).join(", ");
          document.getElementById("setCategory").value = st.shutterstockCategory || "";
        }
        // Load member display NAMES (titles) instead of raw VF_ID codes.
        // evalJsx(
        //   ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
        //   'getSetMemberTitles("' + jsxString(currentSetId) + '")',
        //   function (res2) {
        //     var names = [];
        //     try {
        //       var p2 = JSON.parse(res2);
        //       if (p2.success) names = p2.names || [];
        //     } catch (e2) {}
        //     var mem = document.getElementById("setMembers");
        //     mem.innerHTML = "";
        //     for (var i = 0; i < names.length; i++) {
        //       var row = document.createElement("div");
        //       row.className = "member-row";
        //       row.textContent = i + 1 + ". " + names[i];
        //       mem.appendChild(row);
        //     }
        //   },
        // );
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

  // Persist the current Set Title / Keywords / Category via setSetMetaById().
  function saveSetMetaNow() {
    if (!currentSetId) return;
    var title = document.getElementById("setTitle").value;
    var kwText = document.getElementById("setKeywords").value;
    var category = document.getElementById("setCategory").value || "";
    var kwItems = kwText.split(",");
    var kwParts = [];
    var seen = {};
    for (var i = 0; i < kwItems.length; i++) {
      var t = kwItems[i].replace(/^\s+|\s+$/g, "");
      if (t.length === 0) continue;
      if (t !== "*" && seen[t]) continue;
      seen[t] = true;
      kwParts.push('"' + jsxString(t) + '"');
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
        ',"' +
        jsxString(category) +
        '")',
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

  // ===== AI Metadata settings (local, extensible) =====
  // Settings live ONLY in a JSON file next to the extension
  // (ai_settings.json) — never inside Illustrator documents or AI files.
  // The whole config is ONE object so future fields (temperature, language,
  // per-type prompts, Generate/Improve toggle, keyword count, ...) drop in
  // without reworking storage. Only openai_api_key + model are exposed today.
  var AI_SETTINGS_FILE = extensionPath + "/ai_settings.json";

  // Default shape. New keys are simply added here and read/written by the
  // generic load/save — no per-field storage code needed later.
  var AI_DEFAULTS = {
    openai_api_key: "",
    model: "gpt-4.1-mini",
    temperature: 0.2,
    // Optional recognition hint the user can write above "Run AI". The AI
    // should consider it when analyzing the image. Not required.
    hint: "",
    // Per-context custom prompts edited via "Edit Request". Empty string
    // means "use the built-in default prompt for this context".
    prompts: { element: "", set: "", artboard: "" },
  };

  var aiSettings = null; // loaded object (merged with defaults)

  // Read + parse the settings file. Returns a fresh copy of defaults merged
  // with whatever was stored (so missing/new keys always have a value).
  // MIGRATION: If prompts are empty or missing, initialize from defaults.
  // After first run, prompts are always user-edited and stay in sync.
  function loadAiSettings() {
    var merged = {};
    for (var k in AI_DEFAULTS) merged[k] = AI_DEFAULTS[k];
    try {
      var r = window.cep.fs.readFile(AI_SETTINGS_FILE);
      if (r && r.err === 0 && r.data) {
        var parsed = JSON.parse(r.data);
        if (parsed && typeof parsed === "object") {
          for (var pk in parsed) merged[pk] = parsed[pk];
        }
      }
    } catch (e) {}

    // MIGRATION: Ensure prompts exist for each context
    // If missing or empty, copy from defaults
    if (!merged.prompts) merged.prompts = {};
    if (!merged.prompts.element || !merged.prompts.element.trim()) {
      merged.prompts.element = AI_PROMPT_DEFAULTS.element;
    }
    if (!merged.prompts.set || !merged.prompts.set.trim()) {
      merged.prompts.set = AI_PROMPT_DEFAULTS.set;
    }
    if (!merged.prompts.artboard || !merged.prompts.artboard.trim()) {
      merged.prompts.artboard = AI_PROMPT_DEFAULTS.artboard;
    } else {
      // MIGRATE: Inject Short Title support into existing artboard prompt
      merged.prompts.artboard = migrateArtboardPrompt(merged.prompts.artboard);
    }

    return merged;
  }

  // MIGRATION: Add Short Title support to existing artboard prompt
  // If the prompt already has SHORT TITLE RULES, leave it unchanged.
  // Otherwise, inject the Short Title section before JSON output.
  function migrateArtboardPrompt(prompt) {
    if (!prompt || typeof prompt !== "string") return prompt;
    if (prompt.indexOf("SHORT TITLE RULES") >= 0) return prompt;
    if (prompt.indexOf('"shortTitle":""') >= 0) return prompt;

    var shortTitleSection = "SHORT TITLE RULES:\n" +
      "- Generate a SHORT TITLE in addition to the regular Title.\n" +
      "- Short Title must be a commercially valuable search query.\n" +
      "- Short Title must be short (2-4 words).\n" +
      "- Short Title must be usable as a title on its own.\n" +
      "- Short Title uses the SAME placeholder rules as Title (exactly one *).\n" +
      "- Short Title and Title should be DIFFERENT — Short Title is concise.\n" +
      "\n";

    // Insert SHORT TITLE RULES before KEYWORDS RULES
    var keywordsMarker = "KEYWORDS RULES:";
    var markerPos = prompt.indexOf(keywordsMarker);
    if (markerPos > 0) {
      prompt = prompt.substring(0, markerPos) +
        shortTitleSection +
        prompt.substring(markerPos);
    }

    // Ensure JSON output has shortTitle field
    if (prompt.indexOf('"shortTitle":""') < 0) {
      var jsonStart = prompt.indexOf('{\n  "title":"",');
      if (jsonStart < 0) jsonStart = prompt.indexOf('{"title":"",');
      if (jsonStart >= 0) {
        var jsonEnd = prompt.indexOf('}', jsonStart);
        if (jsonEnd > 0) {
          var jsonContent = prompt.substring(jsonStart, jsonEnd + 1);
          if (jsonContent.indexOf('"shortTitle"') < 0) {
            jsonContent = jsonContent.replace(
              '"title":"",',
              '"title":"",\n  "shortTitle":"",'
            );
            prompt = prompt.substring(0, jsonStart) + jsonContent + prompt.substring(jsonEnd + 1);
          }
        }
      }
    }

    return prompt;
  }

  // Persist the current aiSettings object as pretty JSON.
  function saveAiSettings() {
    try {
      window.cep.fs.writeFile(
        AI_SETTINGS_FILE,
        JSON.stringify(aiSettings, null, 2),
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  // Push the loaded settings into the UI controls. Switches the API-key area
  // between "view" (green "ключ есть" + [Edit][Test] row) and "edit"
  // (input + Show + Save).
  function applyAiSettingsToUi() {
    if (!aiSettings) return;
    var keyEl = document.getElementById("aiApiKey");
    var modelEl = document.getElementById("aiModel");
    var hintEl = document.getElementById("aiHint");
    var viewEl = document.getElementById("aiKeyView");
    var actionsEl = document.getElementById("aiKeyActions");
    var editEl = document.getElementById("aiKeyEdit");
    if (keyEl) keyEl.value = aiSettings.openai_api_key || "";
    if (modelEl) {
      // Keep the stored value even if it is not in the preset list.
      modelEl.value = aiSettings.model || AI_DEFAULTS.model;
    }
    if (hintEl) hintEl.value = aiSettings.hint || "";
    var hasKey = !!(
      aiSettings.openai_api_key && aiSettings.openai_api_key.trim()
    );
    if (viewEl && editEl && actionsEl) {
      if (hasKey) {
        viewEl.classList.remove("hidden");
        actionsEl.classList.remove("hidden");
        editEl.classList.add("hidden");
      } else {
        viewEl.classList.add("hidden");
        actionsEl.classList.add("hidden");
        editEl.classList.remove("hidden");
      }
    }
  }

  // Switch the API-key area into edit mode (input + Save visible).
  function showKeyEditMode() {
    var viewEl = document.getElementById("aiKeyView");
    var actionsEl = document.getElementById("aiKeyActions");
    var editEl = document.getElementById("aiKeyEdit");
    if (viewEl) viewEl.classList.add("hidden");
    if (actionsEl) actionsEl.classList.add("hidden");
    if (editEl) editEl.classList.remove("hidden");
  }

  // Collect the current UI values back into aiSettings (preserving any
  // unknown keys already stored, e.g. future fields).
  function readAiSettingsFromUi() {
    var keyEl = document.getElementById("aiApiKey");
    var modelEl = document.getElementById("aiModel");
    var hintEl = document.getElementById("aiHint");
    if (!aiSettings) aiSettings = loadAiSettings();
    if (keyEl) aiSettings.openai_api_key = keyEl.value;
    if (modelEl) aiSettings.model = modelEl.value;
    if (hintEl) aiSettings.hint = hintEl.value;
  }

  // Show a message in the bottom status line. isError tints it red.
  function aiStatus(text, isError) {
    setStatus(text, isError);
  }

  // Append a line to ai_debug.log next to the extension. Uses the CEP
  // filesystem API (window.cep.fs) — inside the panel we are in Chromium,
  // where the ExtendScript `File` object does NOT exist (new File() is the
  // Web API File with no open/writeln). Reading the old content first and
  // re-writing with the new line appends.
  var AI_DEBUG_PATH = extensionPath + "/ai_debug.log";
  function aiLog(msg) {
    try {
      var line = "[" + new Date().toLocaleTimeString() + "] " + msg + "\n";
      var prev = "";
      try {
        var r = window.cep.fs.readFile(AI_DEBUG_PATH);
        if (r && r.err === 0 && r.data) prev = r.data;
      } catch (e) {}
      window.cep.fs.writeFile(AI_DEBUG_PATH, prev + line);
    } catch (e) {}
  }

  // ===== AI Metadata context detection (prep for future generation) =====
  // No OpenAI calls, no network, no metadata writes. This only figures out
  // WHAT the user wants analyzed and prepares a context object. The actual
  // image export + API call are stubbed (exportAIImage) for later steps.
  //
  // Returns the context via the `done` callback (async: it queries
  // Illustrator through evalJsx to learn the current selection mode):
  //   { type: "element" | "set" | "artboard" | "none",
  //     items: [],          // placeholder: selected items / set members
  //     image: null,        // placeholder: exported image path (later)
  //     setId: "" }         // present only when type === "set"
  function getAIMetadataContext(done) {
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
      "getSelectionPanelMode()",
      function (modeRes) {
        var mode = "none";
        try {
          var m = JSON.parse(modeRes);
          if (m && m.mode) mode = m.mode;
        } catch (e) {}
        if (mode === "artboard") {
          done({ type: "artboard", items: [], image: null });
          return;
        }
        if (mode === "single") {
          done({ type: "element", items: [], image: null });
          return;
        }
        if (mode === "multiple") {
          // Multiple selected: it is a Set context only if the selection
          // already forms a saved Set; otherwise treat as a group of
          // elements (Element mode handles "object(s)" plural).
          evalJsx(
            ["VF_Common.jsx", "VF_ArtworkMeta.jsx"],
            "findExistingSetForSelection()",
            function (setRes) {
              var setId = "";
              try {
                setId = JSON.parse(setRes).setId || "";
              } catch (e) {}
              if (setId) {
                done({ type: "set", items: [], image: null, setId: setId });
              } else {
                done({ type: "element", items: [], image: null });
              }
            },
          );
          return;
        }
        done({ type: "none", items: [], image: null });
      },
    );
  }

  // Export the image for a given AI context so it can later be sent to the
  // model. Creates a temporary PNG via the JSX helper (no network, no AI
  // call yet) and reports the resulting file path through the `done`
  // callback: done(path, errMsg) where errMsg is null on success.
  function exportAIImage(context, done) {
    // Don't drive Illustrator while the Tools panel is exporting (the two
    // CEP panels talking to Illustrator at once crashed it before).
    if (isExportLocked()) {
      if (done) done("", "Export in progress — try again later");
      return;
    }
    // Acquire the SAME lock the Tools panel uses so the metadata pollers
    // (driven by the lock watchdog) suspend while imageCapture runs.
    // Without this, the 300ms pollers fire concurrent evalJsx calls
    // into Illustrator during the blocking imageCapture — the exact
    // concurrent-access condition that hangs/freezes Illustrator.
    setExportLock();
    evalJsx(
      ["VF_Common.jsx", "VF_ArtworkMeta.jsx", "VF_AIImage.jsx"],
      'exportAIImage("' + jsxString(JSON.stringify(context)) + '")',
      function (result) {
        var path = "";
        var errMsg = null;
        try {
          var r = JSON.parse(result);
          if (r && r.success === true && r.path) {
            path = r.path;
          } else if (r && r.errors && r.errors.length) {
            // r.errors[0] is "AI image export failed: <real cause>" — keep it.
            errMsg = r.errors[0];
          } else {
            errMsg = "AI image export failed";
          }
        } catch (e) {
          // The script came back as non-JSON text (e.g. an Illustrator
          // runtime error). Surface that raw text so the real cause shows.
          errMsg =
            result && typeof result === "string" && result.length > 0
              ? result
              : "AI image export failed";
        }
        if (errMsg) setStatus(errMsg, true); // also surface in bottom status
        if (done) done(path, errMsg);
        else aiStatus(errMsg || path, !!errMsg);
        clearExportLock();
      },
    );
  }

  // The built-in default prompt for each context. Each is a COMPLETE,
  // self-contained instruction set — the AI request receives ONLY the prompt
  // for the current context (never a merged/combined text). Users can
  // override any of them via "Edit Request" (stored in
  // aiSettings.prompts[contextType]).
  var AI_PROMPT_DEFAULTS = {
    element: [
      "You are an Adobe Stock metadata specialist.",
      "",
      "Analyze only the main object in this image.",
      "",
      "Create commercial stock metadata.",
      "",
      "TITLE:",
      "- 2-4 words.",
      "- Must be a realistic Adobe Stock search phrase.",
      "- Think how buyers search for this object.",
      "- Prefer searchable commercial names over generic object names.",
      "",
      "SHORT TITLE:",
      "- 2-4 words.",
      "- Must be a commercially valuable short search query.",
      "- Suitable for use as a title on its own.",
      "- Shorter than the main Title but equally searchable.",
      "",
      "Examples:",
      '"coffee cup" is better than "cup"',
      '"flower border element" is better than "flower"',
      "",
      "KEYWORDS:",
      "Return 7-15 keywords.",
      "",
      "Rules:",
      "- Sort keywords by commercial search importance.",
      "- First keywords are the most valuable.",
      "- Use common stock search terms.",
      "- Include useful synonyms.",
      "- Include usage only if strongly related.",
      "",
      "Do not use:",
      "- colors",
      "- style descriptions",
      "- marketing words",
      "- unnecessary adjectives",
      "",
      "Return only JSON:",
      "{",
      '  "title":"",',
      '  "shortTitle":"",',
      '  "keywords":[]',
      "}",
    ].join("\n"),

    set: [
      "You are an Adobe Stock metadata specialist.",
      "",
      "Analyze this image as a commercial collection/set.",
      "",
      "The image contains multiple related elements.",
      "Think about what buyers search for when they need this collection.",
      "",
      "TITLE:",
      "- 3-6 words.",
      "- Describe the whole collection theme.",
      "- Do not list every object separately.",
      "",
      "SHORT TITLE:",
      "- 2-4 words.",
      "- Must be a commercially valuable short search query.",
      "- Suitable for use as a title on its own.",
      "- Shorter than the main Title but equally searchable.",
      "",
      "KEYWORDS:",
      "Return 15-25 keywords.",
      "",
      "Rules:",
      "- Sort by commercial stock importance.",
      "- Include:",
      "  - main category",
      "  - collection theme",
      "  - important object groups",
      "  - possible usage",
      "",
      "Do not create a simple list of every visible object.",
      "",
      "Do not use:",
      "- colors",
      "- style descriptions",
      "- marketing words",
      "",
      "Return only JSON:",
      "{",
      '  "title":"",',
      '  "shortTitle":"",',
      '  "keywords":[]',
      "}",
    ].join("\n"),

    artboard: [
      "You are an Adobe Stock metadata specialist.",
      "",
      "Analyze this image as a reusable stock TEMPLATE.",
      "",
      "IMPORTANT:",
      "- Ignore the placeholder rectangles as objects.",
      "- Do NOT describe empty boxes.",
      "- Do NOT invent objects that are visible only because of placeholders.",
      "- Analyze the PURPOSE of the template and its stock usage.",
      "",
      "TITLE RULES:",
      '- Output EXACTLY ONE "*" character in the title.',
      '- The "*" is the position where the future object/set name will be inserted.',
      '- NEVER output any other "*" in the title.',
      '- Do NOT write the word "and" around the placeholder.',
      "- The final title (after replacement) should be 10-15 words total.",
      "",
      "Correct example:",
      '"* packaging design template for eco products"',
      "",
      "Wrong example (two placeholders / 'and' around placeholder):",
      '"* packaging template with * natural elements"',
      "",
      "SHORT TITLE RULES:",
      "- Generate a SHORT TITLE in addition to the regular Title.",
      "- Short Title must be a commercially valuable search query.",
      "- Short Title must be short (2-4 words).",
      "- Short Title must be usable as a title on its own.",
      "- Short Title uses the SAME placeholder rules as Title (exactly one *).",
      "- Short Title and Title should be DIFFERENT — Short Title is concise.",
      "",
      "KEYWORDS RULES:",
      "Generate 20-40 keywords.",
      "",
      "The keyword list is a TEMPLATE that will later receive keywords",
      "from an object/set. The placeholders are NOT keywords themselves;",
      "they are insertion points.",
      "",
      "Rules:",
      '- "*" represents ONE missing important keyword from the object/set.',
      '- "**" represents ALL remaining object/set keywords.',
      '- NEVER place "*" as the first keyword.',
      '- NEVER place "**" as the last keyword automatically.',
      "- Place placeholders where they make semantic sense.",
      "",
      "Correct example:",
      '"packaging, template, branding, *, design, sustainable, **, editable, mockup"',
      "",
      "The result must be a stock-ready template metadata structure where",
      "object/set keywords can later be merged into the placeholders.",
      "",
      "Return only JSON:",
      "{",
      '  "title":"",',
      '  "shortTitle":"",',
      '  "keywords":[]',
      "}",
    ].join("\n"),
  };

  // Return the prompt for a context: always use the saved prompt from aiSettings.
  // Prompts are initialized from defaults on first load/migration.
  function getBaseAIPrompt(contextType) {
    var prompts = aiSettings && aiSettings.prompts;
    if (prompts && prompts[contextType] && prompts[contextType].trim()) {
      return prompts[contextType];
    }
    return AI_PROMPT_DEFAULTS[contextType] || AI_PROMPT_DEFAULTS.element;
  }

  // Build the prompt for the current context. Returns ONLY the prompt for
  // this context (custom override if saved, else the built-in default) —
  // the AI request never receives a merged/combined prompt. The per-context
  // prompts are self-contained. If the user wrote an optional recognition
  // hint, it is wrapped in a clear "RECOGNITION HINT" block at the very
  // START of the prompt so the AI knows exactly what to identify/recognize
  // in the image before applying the rest of the rules.
  // The hint is read LIVE from the #aiHint field (source of truth) so it is
  // always current even if the debounced settings save has not fired yet.
  function buildAIPrompt(contextType, existing) {
    var prompt = getBaseAIPrompt(contextType);
    var hintEl = document.getElementById("aiHint");
    var hint = hintEl && hintEl.value ? hintEl.value.trim() : "";
    if (!hint && aiSettings && aiSettings.hint) hint = aiSettings.hint.trim();
    if (hint) {
      prompt =
        "RECOGNITION HINT — this is what you must identify/recognize in the " +
        "image (treat it as the primary subject to analyze):\n" +
        hint +
        "\n--- END OF RECOGNITION HINT ---\n\n" +
        prompt;
    }
    return prompt;
  }

  // Send the temporary PNG to the OpenAI Vision API and return parsed
  // metadata through `done`: done({ title, keywords }) on success, or
  // done({ error }) on any failure (missing key, API error, bad JSON).
  // Reads the saved API key + model from aiSettings (falls back to the
  // current UI field). Does NOT write anything into Illustrator.
  function requestAIMetadata(imagePath, contextType, done) {
    // Resolve the API key (saved settings first, then the live field).
    var key = "";
    if (aiSettings && aiSettings.openai_api_key) {
      key = aiSettings.openai_api_key;
    } else {
      var f = document.getElementById("aiApiKey");
      if (f) key = f.value || "";
    }
    if (!key || !key.trim()) {
      setStatus("API key missing", true);
      done({ error: "API key missing" });
      return;
    }
    var model = (aiSettings && aiSettings.model) || "gpt-4.1-mini";
    var temperature =
      aiSettings && typeof aiSettings.temperature === "number"
        ? aiSettings.temperature
        : 0.2;

    aiLog(
      "REQUEST context=" +
        contextType +
        " imagePath=" +
        imagePath +
        " model=" +
        model +
        " temp=" +
        temperature,
    );

    // Read the PNG as base64. Prefer CEP's filesystem API; if that fails
    // (e.g. encoding constant unavailable), fall back to a FileReader over a
    // file:// URL — the PNG lives in the extension folder, which CEP can
    // read. Both paths produce a base64 string for the data URL.
    function toBase64Then(b64) {
      if (b64) {
        sendB64(b64);
        return;
      }
      try {
        var url = "file:///" + imagePath.replace(/\\/g, "/");
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "blob";
        xhr.onload = function () {
          if (xhr.status !== 200 && xhr.status !== 0) {
            setStatus("Could not read image file", true);
            done({ error: "Could not read image file" });
            return;
          }
          var reader = new FileReader();
          reader.onloadend = function () {
            var dataUrl = reader.result || "";
            var comma = dataUrl.indexOf(",");
            sendB64(comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl);
          };
          reader.onerror = function () {
            setStatus("Could not read image file", true);
            done({ error: "Could not read image file" });
          };
          reader.readAsDataURL(xhr.response);
        };
        xhr.onerror = function () {
          setStatus("Could not read image file", true);
          done({ error: "Could not read image file" });
        };
        xhr.send();
      } catch (e) {
        setStatus("Could not read image file", true);
        done({ error: "Could not read image file" });
      }
    }

    function sendB64(b64) {
      // Read the CURRENT field values so we can pass them to the model as a
      // hint (improve / keep / rewrite) — the user asked to feed existing
      // title/keywords back into the prompt.
      var ids = aiFieldIds(contextType);
      var existingTitle = "";
      var existingKw = "";
      if (ids) {
        var tEl = document.getElementById(ids.title);
        var kEl = document.getElementById(ids.keywords);
        if (tEl) existingTitle = tEl.value;
        if (kEl) existingKw = kEl.value;
      }
      var prompt = buildAIPrompt(contextType, {
        title: existingTitle,
        keywords: existingKw,
      });
      aiLog("PROMPT(" + contextType + "): " + prompt);
      aiLog("BASE64 length=" + (b64 ? b64.length : 0));
      var body = {
        model: model,
        temperature: temperature,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a stock-image metadata assistant. Always reply with " +
              "valid JSON only, no prose, no markdown code fences.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64," + b64 },
              },
            ],
          },
        ],
      };

      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify(body),
      })
        .then(function (resp) {
          if (!resp.ok) {
            return resp.text().then(function (t) {
              // OpenAI blocks requests from unsupported regions with 403 +
              // unsupported_country_region_territory — tell the user to use a
              // VPN instead of dumping the raw error.
              if (
                resp.status === 403 &&
                /unsupported_country_region_territory/i.test(t)
              ) {
                throw new Error("Включи ВПН");
              }
              throw new Error("API error " + resp.status + ": " + t);
            });
          }
          return resp.json();
        })
.then(function (data) {
           // Log the RAW API response so we can see exactly what came back.
           aiLog("API RAW: " + JSON.stringify(data));
           var content =
             data &&
             data.choices &&
             data.choices[0] &&
             data.choices[0].message &&
             data.choices[0].message.content;
           if (!content) throw new Error("Empty response from API");
           var parsed = JSON.parse(content); // throws -> invalid JSON
           aiLog(
             "PARSED title=" +
               JSON.stringify(parsed.title) +
               " shortTitle=" +
               JSON.stringify(parsed.shortTitle) +
               " keywords=" +
               JSON.stringify(parsed.keywords),
           );
           done({
             title: parsed.title || "",
             shortTitle: parsed.shortTitle || "",
             keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
           });
         })
        .catch(function (err) {
          var msg = err && err.message ? err.message : "AI request failed";
          if (/Unexpected|JSON|Syntax/i.test(msg)) {
            msg = "Invalid JSON response from API";
          }
          aiLog("ERROR: " + msg);
          done({ error: msg });
          setStatus(msg, true);
        });
    }

    var b64 = null;
    try {
      var r = window.cep.fs.readFile(imagePath, window.cep.fs.encoding.Base64);
      if (r && r.err === 0 && r.data) b64 = r.data;
    } catch (e) {}
    toBase64Then(b64);
  }

  // ===== Apply AI result to the existing metadata UI fields =====
  // Fills the correct field trio (Element / Set / Artboard) with the AI
  // title, shortTitle and keywords. Does NOT save to Illustrator.
  function aiFieldIds(contextType) {
    if (contextType === "set")
      return { title: "setTitle", keywords: "setKeywords" };
    if (contextType === "artboard")
      return { title: "metaTitle", shortTitle: "metaShortTitle", keywords: "metaKeywords" };
    return { title: "awName", keywords: "awKeywords" }; // element
  }

  // Selection identity used by the poller guard (so it won't wipe AI text).
  function aiFillKeyFor(contextType) {
    if (contextType === "set") return "set:" + currentSetId;
    if (contextType === "artboard") return "ab:" + metaCurrentName;
    return "el:" + awCurrentVfid; // element
  }

  function fillAiFields(titleEl, shortTitleEl, kwEl, title, shortTitle, keywords) {
    titleEl.value = title || "";
    if (shortTitleEl) shortTitleEl.value = shortTitle || "";
    kwEl.value = (keywords || []).join(", ");
  }

  // Fill the AI result into the current field trio and persist. The old
  // in-place Replace/Keep confirmation used to live in the removed #aiStatus
  // area; now we just apply directly.
  function applyAIMetadataToFields(contextType, title, shortTitle, keywords) {
    var ids = aiFieldIds(contextType);
    if (!ids) return;
    var titleEl = document.getElementById(ids.title);
    var shortTitleEl = ids.shortTitle ? document.getElementById(ids.shortTitle) : null;
    var kwEl = document.getElementById(ids.keywords);
    if (!titleEl || !kwEl) return;

    fillAiFields(titleEl, shortTitleEl, kwEl, title, shortTitle, keywords);
    aiFilledKey = aiFillKeyFor(contextType);
    saveAIMetadata();
  }

  // Persist the AI-filled (or user-edited) metadata into Illustrator using
  // the EXISTING save functions — no metadata-writing code is duplicated.
  // The current field values are saved (so manual edits win over the raw AI
  // response). After the debounced save fires, the poller guard is cleared
  // and the fields are refreshed from Illustrator.
  function saveAIMetadata() {
    // Decide which context to save: prefer what AI just filled, else the
    // current panel selection.
    var type = null;
    if (aiFilledKey.indexOf("el:") === 0) type = "element";
    else if (aiFilledKey.indexOf("set:") === 0) type = "set";
    else if (aiFilledKey.indexOf("ab:") === 0) type = "artboard";
    if (!type) {
      if (currentSetId) type = "set";
      else if (metaCurrentName) type = "artboard";
      else if (awHasSelection) type = "element";
    }

    if (type === "set") {
      if (!currentSetId) {
        aiStatus("No Set selected", true);
        setStatus("No Set selected", true);
        return;
      }
      saveSetMetaNow();
    } else if (type === "artboard") {
      if (!metaCurrentName) {
        aiStatus("No artboard selected", true);
        setStatus("No artboard selected", true);
        return;
      }
      saveMetaNow();
    } else if (type === "element") {
      if (!awHasSelection) {
        aiStatus("No artwork selected", true);
        setStatus("No artwork selected", true);
        return;
      }
      saveArtworkMetaNow();
    } else {
      aiStatus("Nothing to save", true);
      setStatus("Nothing to save", true);
      return;
    }

    // Keep aiFilledKey set through the 400ms debounce so the poller cannot
    // reload (and wipe) the fields before the save reads them. Then clear
    // the guard and refresh from Illustrator.
    setTimeout(function () {
      aiFilledKey = "";
      if (type === "set") refreshSetMeta();
      else if (type === "artboard") refreshMeta();
      else refreshArtworkMeta();
    }, 500);
    aiStatus("AI metadata saved", false);
  }

  // Wire the AI Metadata section controls. Called once on load.
  function initAiSettings() {
    aiSettings = loadAiSettings();
    applyAiSettingsToUi();

    // Collapsible header.
    var header = document.getElementById("aiMetaHeader");
    var section = document.getElementById("aiMetaSection");
    if (header && section) {
      header.addEventListener("click", function () {
        section.classList.toggle("collapsed");
      });
    }

    // Show / Hide API key.
    var showBtn = document.getElementById("aiShowKey");
    var keyEl = document.getElementById("aiApiKey");
    if (showBtn && keyEl) {
      showBtn.addEventListener("click", function () {
        if (keyEl.type === "password") {
          keyEl.type = "text";
          showBtn.textContent = "Hide";
        } else {
          keyEl.type = "password";
          showBtn.textContent = "Show";
        }
      });
    }

    // Save settings to local config.
    var saveBtn = document.getElementById("aiSave");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        readAiSettingsFromUi();
        if (saveAiSettings()) aiStatus("Settings saved", false);
        else aiStatus("Could not write settings file", true);
      });
    }

    // Optional recognition hint: persist it locally as the user types
    // (debounced). It is not required, but should survive a panel reload.
    var hintEl = document.getElementById("aiHint");
    if (hintEl) {
      hintEl.addEventListener("input", function () {
        if (!aiSettings) aiSettings = loadAiSettings();
        aiSettings.hint = hintEl.value;
        if (saveAiSettingsTimer) clearTimeout(saveAiSettingsTimer);
        saveAiSettingsTimer = setTimeout(function () {
          saveAiSettingsTimer = null;
          saveAiSettings();
        }, 400);
      });
    }

    // Test Connection: perform a real lightweight API call (list models)
    // to verify the key works, and report the result in the status line.
    var testBtn = document.getElementById("aiTest");
    if (testBtn) {
      testBtn.addEventListener("click", function () {
        var k = (document.getElementById("aiApiKey").value || "").trim();
        if (!k) {
          aiStatus("API key missing", true);
          return;
        }
        aiStatus("Testing connection…", false);
        fetch("https://api.openai.com/v1/models", {
          method: "GET",
          headers: { Authorization: "Bearer " + k },
        })
          .then(function (resp) {
            if (resp.status === 200) aiStatus("Connection OK", false);
            else if (resp.status === 401) aiStatus("Invalid API key", true);
            else if (resp.status === 403) aiStatus("Включи ВПН", true);
            else aiStatus("API error " + resp.status, true);
          })
          .catch(function () {
            aiStatus("Network error — check connection", true);
          });
      });
    }

    // Generate AI Metadata: detect context -> export PNG -> send to OpenAI
    // -> show the returned JSON in the status line. Nothing is written to
    // Illustrator yet.
    var genBtn = document.getElementById("aiGenerate");
    if (genBtn) {
      genBtn.addEventListener("click", function () {
        aiSettings = loadAiSettings();
        getAIMetadataContext(function (ctx) {
          if (ctx.type === "none") {
            aiStatus("Nothing selected", true);
            setStatus("Nothing selected", true);
            return;
          }
          var hintEl = document.getElementById("aiHint");
          var liveHint = hintEl && hintEl.value ? hintEl.value.trim() : "";
          if (liveHint) {
            aiStatus("Hint: " + liveHint, false);
          } else {
            aiStatus("Generating…", false);
          }
          setStatus("Generating AI metadata…");
          setSpinner(true);
          exportAIImage(ctx, function (path, err) {
            if (err) {
              setSpinner(false);
              aiStatus(err, true);
              setStatus(err, true);
              return;
            }
            setStatus("AI request sent, waiting for response…");
            requestAIMetadata(path, ctx.type, function (res) {
              setSpinner(false);
              if (res.error) {
                aiStatus(res.error, true);
                setStatus(res.error, true);
                return;
              }
              aiStatus(
                (liveHint ? "Hint: " + liveHint + "\n" : "") +
                  "AI: title=" +
                  JSON.stringify(res.title) +
                  " shortTitle=" +
                  JSON.stringify(res.shortTitle) +
                  " keywords=" +
                  JSON.stringify(res.keywords),
                false,
              );
              setStatus("AI metadata received");
              applyAIMetadataToFields(ctx.type, res.title, res.shortTitle, res.keywords);
            });
          });
        });
      });
    }

    // "Изменить" key: switch the API-key area into edit mode.
    var editKeyBtn = document.getElementById("aiEditKey");
    if (editKeyBtn) {
      editKeyBtn.addEventListener("click", showKeyEditMode);
    }

    // Edit Request: detect the current AI context, then open the AI Request
    // Editor as an IN-PANEL modal overlay. The current prompt for the context
    // is loaded into the textarea; Save writes it back into
    // aiSettings.prompts[context] (persisted to ai_settings.json). No second
    // CEP extension / window is used.
    var editReqBtn = document.getElementById("aiEditRequest");
    var aiModal = document.getElementById("aiRequestModal");
    var aiModalCtx = document.getElementById("aiModalCtx");
    var aiModalPrompt = document.getElementById("aiModalPrompt");
    var aiModalSave = document.getElementById("aiModalSave");
    var aiModalCancel = document.getElementById("aiModalCancel");
    var aiModalContext = ""; // context type for the open modal

    function openAiModal(contextType) {
      aiModalContext = contextType;
      var label =
        contextType === "set"
          ? "Set"
          : contextType === "artboard"
            ? "Artboard"
            : "Element";
      if (aiModalCtx) aiModalCtx.textContent = label;
      if (aiModalPrompt) aiModalPrompt.value = getBaseAIPrompt(contextType);
      if (aiModal) aiModal.classList.remove("hidden");
      if (aiModalPrompt) aiModalPrompt.focus();
    }

    function closeAiModal() {
      if (aiModal) aiModal.classList.add("hidden");
      aiModalContext = "";
    }

    if (editReqBtn) {
      editReqBtn.addEventListener("click", function () {
        getAIMetadataContext(function (ctx) {
          if (ctx.type === "none") {
            aiStatus("Nothing selected", true);
            setStatus("Nothing selected", true);
            return;
          }
          openAiModal(ctx.type);
        });
      });
    }

    if (aiModalCancel) {
      aiModalCancel.addEventListener("click", closeAiModal);
    }

    // Click on the dark overlay (outside the modal box) also closes it.
    if (aiModal) {
      aiModal.addEventListener("click", function (e) {
        if (e.target === aiModal) closeAiModal();
      });
    }

    if (aiModalSave) {
      aiModalSave.addEventListener("click", function () {
        if (!aiModalContext) {
          closeAiModal();
          return;
        }
        if (!aiSettings) aiSettings = loadAiSettings();
        if (!aiSettings.prompts) {
          aiSettings.prompts = { element: "", set: "", artboard: "" };
        }
        aiSettings.prompts[aiModalContext] = aiModalPrompt
          ? aiModalPrompt.value
          : "";
        if (saveAiSettings()) aiStatus("Request saved", false);
        else aiStatus("Could not save request", true);
        closeAiModal();
      });
    }
  }

  // Build and show the metadata record deletion checklist modal.
  function openMetaDocSelector(records) {
    var list = document.getElementById("metaDocList");
    list.innerHTML = "";
    for (var i = 0; i < records.length; i++) {
      var label = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = JSON.stringify(records[i]);
      cb.checked = true;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(records[i].label || ""));
      list.appendChild(label);
    }
    document.getElementById("metaDocInfoOverlay").classList.remove("hidden");
  }
})();
