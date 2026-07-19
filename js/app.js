(function () {
  var cs = new CSInterface();
  var extensionPath = cs
    .getSystemPath(SystemPath.EXTENSION)
    .replace(/\\/g, "/");

  var shown = true;

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

  // A lock file shared between the Tools panel and the Metadata panel. While
  // it exists, the Metadata panel suspends its polling (no evalScript calls
  // into Illustrator) so two CEP panels never drive Illustrator at the same
  // time during a long export — which previously crashed Illustrator.
  var EXPORT_LOCK_FILE =
    cs.getSystemPath(SystemPath.EXTENSION) + "/exporting.lock";

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

  // The full export folder path is kept in memory (currentExportFolder) and
  // used for the actual export. The read-only field shows only the last two
  // segments (parent / folder) so long paths fit without overflowing.
  var currentExportFolder = "";

  function shortenPath(path) {
    if (!path) return "";
    var norm = String(path).replace(/\\/g, "/");
    var parts = norm.split("/").filter(function (p) {
      return p.length > 0;
    });
    if (parts.length <= 2) return norm;
    return parts[parts.length - 2] + "/" + parts[parts.length - 1];
  }

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

  // Run an export call with the shared lock held. The lock is ALWAYS cleared
  // afterwards — both on the normal async result and if evalJsx throws
  // synchronously (e.g. the panel is torn down mid-call). Without this, a
  // crashed export would leave exporting.lock behind and the Metadata panel
  // would stay suspended forever.
  function exportWithLock(prefix, indices, folder) {
    setExportLock();
    var call =
      'exportArtboards("' +
      jsxString(prefix) +
      '",[' +
      indices.join(",") +
      '],"' +
      jsxString(folder) +
      '")';
    try {
      evalJsx(["VF_Common.jsx", "VF_Export.jsx"], call, function (result) {
        clearExportLock();
        showResult(result);
      });
    } catch (e) {
      // evalJsx itself failed (panel closed, host gone) — release the lock so
      // a later export or the Metadata panel is not blocked indefinitely.
      clearExportLock();
    }
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
    // into the field on every panel open. The field shows only the last two
    // path segments; the full path is kept in currentExportFolder for export.
    var savedFolder = loadExportFolder();
    if (savedFolder) {
      currentExportFolder = savedFolder;
      document.getElementById("exportPath").value = shortenPath(savedFolder);
      document.getElementById("choosePathBtn").textContent = "Change Path";
    }

    document.getElementById("exportBtn").onclick = function () {
      var prefix = document.getElementById("prefix").value || "";
      // Use the full path (currentExportFolder), not the shortened display.
      var folder = currentExportFolder || "";
      // exportWithLock holds the shared lock and ALWAYS clears it afterwards
      // (normal result or synchronous failure), so the Metadata panel never
      // stays suspended after a crashed export.
      exportWithLock(prefix, [], folder);
    };

    // Choose export folder: open a folder picker in Illustrator (starting at
    // the already-chosen path, so "Change Path" resumes there) and store the
    // result in the read-only field. The button label switches to "Change
    // Path" once a folder is selected.
    document.getElementById("choosePathBtn").onclick = function () {
      var current = currentExportFolder || "";
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        'selectExportFolder("' + jsxString(current) + '")',
        function (result) {
          var path = (result || "").replace(/^"|"$/g, "");
          if (path && path.length > 0) {
            currentExportFolder = path;
            document.getElementById("exportPath").value = shortenPath(path);
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
      // Use the full path (currentExportFolder), not the shortened display.
      var folder = currentExportFolder || "";
      exportWithLock(prefix, indices, folder);
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

    // ----- (Metadata UI moved to the separate Metadata panel) -----
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

  // ===== (Metadata UI moved to the separate Metadata panel: js/metadata.js) =====
})();
