(function () {
  var cs = new CSInterface();

  function run(file, status, callback) {
    var path = cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, "/");

    cs.evalScript(
      '$.evalFile("' + path + "/jsx/" + file + '")',
      function (result) {
        if (result && result !== "undefined") {
          console.log(result);
        }

        document.getElementById("status").textContent = status;

        if (callback) callback();
      },
    );
  }

  var shown = true;

  window.onload = function () {
    document.getElementById("toggle").textContent = "🙈 Hide";

    document.getElementById("generate").onclick = function () {
      run("VF_Generate.jsx", "Generated");
      shown = false;
      document.getElementById("toggle").textContent = "👁 Show";
    };

    document.getElementById("clear").onclick = function () {
      run("VF_Clear.jsx", "Cleared");
      shown = true;
      document.getElementById("toggle").textContent = "🙈 Hide";
    };

    document.getElementById("toggle").onclick = function () {
      var btn = document.getElementById("toggle");

      if (shown) {
        run("VF_Hide.jsx", "Hidden");
        btn.textContent = "👁 Show";
      } else {
        run("VF_Show.jsx", "Shown");
        btn.textContent = "🙈 Hide";
      }

      shown = !shown;
    };

    document.getElementById("setElement").onclick = function () {
      run("VF_SetElement.jsx", "Element saved", function () {
        document.getElementById("preview").src = "preview.png?" + Date.now();
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
