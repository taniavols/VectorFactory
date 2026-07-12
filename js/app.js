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

    document.getElementById("clear").onclick = function () {
      run("VF_Clear.jsx", "Cleared", function () {
        setToggle(true);
      });
    };

    document.getElementById("toggle").onclick = function () {
      run(shown ? "VF_Hide.jsx" : "VF_Show.jsx", shown ? "Hidden" : "Shown");
      setToggle(!shown);
    };

    document.getElementById("setElement").onclick = function () {
      run("VF_SetElement.jsx", "Element saved", function () {
        document.getElementById("preview").src = "preview.png?" + Date.now();
      });
    };

    document.getElementById("exportBtn").onclick = function () {
      var prefix = document.getElementById("prefix").value || "";
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        'exportArtboards("' + jsxString(prefix) + '")',
        function (result) {
          showResult(result);
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
      evalJsx(
        ["VF_Common.jsx", "VF_Export.jsx"],
        'exportArtboards("' +
          jsxString(prefix) +
          '",[' +
          indices.join(",") +
          "])",
        function (result) {
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
})();
