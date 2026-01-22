/* ==========================================================================
   app.js (LOADER)
   - Loads split modules in order:
     1) app.core.js  (creates window.ANU_APP, state, util, dom, transcript, q, api)
     2) app.audio.js (mic/sys audio + realtime ASR)
     3) app.chat.js  (chat streaming + credits + resume + profile)
   - Then runs ANU_APP.init()
   ========================================================================== */

(() => {
  "use strict";

  function getBasePath() {
    const cur = document.currentScript?.src || "";
    // Example: https://site.com/js/app.js -> https://site.com/js/
    return cur ? cur.slice(0, cur.lastIndexOf("/") + 1) : "/js/";
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  async function boot() {
    const BASE = getBasePath();

    await loadScript(BASE + "app.core.js");
    await loadScript(BASE + "app.audio.js");
    await loadScript(BASE + "app.chat.js");

    if (!window.ANU_APP || typeof window.ANU_APP.init !== "function") {
      console.error("ANU_APP.init() missing. Check module load order.");
      return;
    }
    window.ANU_APP.init();
  }

  boot().catch((e) => console.error(e));
})();
