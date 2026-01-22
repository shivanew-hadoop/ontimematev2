/* ==========================================================================
 * app.js (LOADER)
 * Loads split modules in order, then calls ANU_APP.init()
 * ========================================================================== */
(() => {
  "use strict";

  const cur = document.currentScript?.src || "";
  const base = cur ? cur.substring(0, cur.lastIndexOf("/") + 1) : "/js/";

  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  (async () => {
    try {
      await load(base + "app.core.js");
      await load(base + "app.audio.js");
      await load(base + "app.chat.js");

      if (window.ANU_APP?.init) window.ANU_APP.init();
      else throw new Error("ANU_APP.init() missing");
    } catch (e) {
      console.error(e);
      const b = document.getElementById("bannerTop");
      if (b) {
        b.textContent = "App failed to load. Check console/network for missing JS files.";
        b.classList.remove("hidden");
        b.classList.add("bg-red-600");
      }
    }
  })();
})();
