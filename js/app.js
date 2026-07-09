(function () {
  var cs = new CSInterface();
  var extensionPath = cs
    .getSystemPath(SystemPath.EXTENSION)
    .replace(/\\/g, "/");

  // Note: evalScript runs JSX inside Illustrator, not inside this HTML panel.
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

  function jsxString(value) {
    // Note: escape HTML input before inserting it into a JSX command string.
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function run(file, status, callback) {
    evalJsx(file, "", function () {
      document.getElementById("status").textContent = status;
      if (callback) callback();
    });
  }

  function setToggle(isShown) {
    shown = isShown;
    document.getElementById("toggle").textContent = shown ? "Hide" : "Show";
  }

  var shown = true;

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
      if (shown) {
        run("VF_Hide.jsx", "Hidden");
      } else {
        run("VF_Show.jsx", "Shown");
      }

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
          document.getElementById("status").textContent = result || "Exported";
        });
    };
  };

  document.addEventListener("keydown", function (e) {
    if (e.key === "F5") {
      e.preventDefault();
      location.reload();
    }

    if (e.ctrlKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      location.reload();
    }
  });
})();
