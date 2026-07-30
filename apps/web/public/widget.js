(() => {
  "use strict";
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  const merchant = script.dataset.merchant;
  const product = script.dataset.product;
  if (!merchant || !product) {
    console.error("[Project Visualizer] data-merchant and data-product are required.");
    return;
  }
  const base = new URL(script.src).origin;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = script.dataset.label || "Voir chez moi";
  button.setAttribute("aria-haspopup", "dialog");
  button.style.cssText = [
    "border:0",
    "border-radius:999px",
    "padding:13px 22px",
    "background:" + (script.dataset.color || "#667052"),
    "color:white",
    "font:700 14px system-ui,sans-serif",
    "cursor:pointer",
  ].join(";");
  script.insertAdjacentElement("afterend", button);

  button.addEventListener("click", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Visualiser le produit chez moi");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(24,25,21,.7);padding:clamp(8px,3vw,32px);display:grid;place-items:center";
    const frame = document.createElement("iframe");
    frame.title = "Project Visualizer";
    frame.src = `${base}/visualizer/${encodeURIComponent(merchant)}/${encodeURIComponent(product)}`;
    frame.allow = "clipboard-write";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.style.cssText = "width:min(1180px,100%);height:min(880px,100%);border:0;border-radius:24px;background:#fbfaf6";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Fermer";
    close.setAttribute("aria-label", "Fermer le visualiseur");
    close.style.cssText = "position:fixed;top:12px;right:16px;z-index:2;border:0;border-radius:999px;padding:9px 14px;background:#fff;color:#20231e;font:700 13px system-ui;cursor:pointer";
    const remove = () => {
      window.removeEventListener("message", onMessage);
      overlay.remove();
      button.focus();
    };
    const onMessage = (event) => {
      if (event.origin === base && event.data && event.data.type === "visualizer:close") remove();
    };
    close.addEventListener("click", remove);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) remove();
    });
    window.addEventListener("message", onMessage);
    overlay.append(frame, close);
    document.body.append(overlay);
    close.focus();
  });
})();

