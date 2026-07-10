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

  // Run a JSX file and update the status when done.
  function run(file, status, callback) {
    evalJsx(file, "", function () {
      setStatus(status);
      if (callback) callback();
    });
  }

  window.onload = function () {
    setToggle(true);

    document.getElementById("generate").onclick = function () {
      run("VF_Generate.jsx", "Generated");
      setToggle(false);
    };

    document.getElementById("clear").onclick = function () {
      run("VF_Clear.jsx", "Cleared");
      setToggle(true);
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
          setStatus(result || "Exported");
        },
      );
    };
  };

  // F5 / Ctrl+R reload the panel.
  document.addEventListener("keydown", function (e) {
    if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      location.reload();
    }
  });
})();
