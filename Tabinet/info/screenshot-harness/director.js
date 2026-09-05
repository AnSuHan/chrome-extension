/* Screenshot harness only: replays a click or two so a shot can show an
   expanded group. Reads `#expand=<id>[,<id>]&top=<id>` from the iframe URL. */
(function () {
  const q = new URLSearchParams(location.hash.slice(1));
  const ids = (q.get("expand") || "").split(",").filter(Boolean);
  const top = q.get("top");
  if (!ids.length && !top) return;
  setTimeout(() => {
    for (const id of ids) {
      document.querySelector(`.g-head[data-gid="${id}"] .caret`)?.click();
    }
    if (top) {
      setTimeout(() => {
        const el = top === "saved"
          ? document.getElementById("saved-section")
          : document.querySelector(`.g-head[data-gid="${top}"]`)?.closest(".group");
        const scroller = document.querySelector("main.scroll");
        // Land the target flush under the sticky header (no half-cut row above).
        if (el && scroller) scroller.scrollTop += el.getBoundingClientRect().top - 48;
      }, 120);
    }
  }, 700);
})();
