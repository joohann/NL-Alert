/**
 * <majikan-donate> — herbruikbare "Steun de ontwikkelaar"-knop met
 * bevestigingspopup, voor alle Majikan-integraties (NL-Alert, Nida,
 * Chihiros Plus, ...).
 *
 * Eén bron van waarheid: elke integratie kopieert dit ene bestand naar zijn
 * eigen frontend/-map (HACS levert per integratie zijn eigen frontend) en
 * plaatst het element waar de knop moet komen.
 *
 * Gebruik:
 *   import "./majikan-donate.js";
 *   <majikan-donate accent="--nl-accent"></majikan-donate>          // balk
 *   <majikan-donate inline accent="--nl-accent"></majikan-donate>   // inline
 *
 * Attributen (optioneel):
 *   accent   CSS-variabelenaam voor de accentkleur van die integratie
 *            (bijv. "--nl-accent", "--chihiros-accent"). Valt terug op --primary-color.
 *   label    Knoptekst.  Standaard: "Support the developer".
 *   made     Wat er onder Majikan valt.  Standaard: "several open-source projects".
 *   url      PayPal-donatielink.  Standaard: de hosted Donate-knop hieronder.
 *   contact  Optionele contact-/formulier-URL. Toont een extra "Contact"-link
 *            in de bevestigingspopup (opent in een nieuw tabblad).
 *
 * De popup rendert in document.body (portal) met inline-stijlen, zodat een
 * transform-voorouder in het paneel de fixed-overlay niet kan breken.
 */

const DEFAULT_URL =
  "https://www.paypal.com/donate/?hosted_button_id=SGVVUM4GVYF66";

// Teksten per taal. Standaard Engels; NL-Alert gebruikt lang="nl".
const STRINGS = {
  en: {
    label: "Support the developer",
    redirect:
      "You'll be redirected to <strong>PayPal</strong> to complete your " +
      "donation. The payment page opens in a new tab.",
    made: "several open-source projects",
    note: (made) =>
      `<strong>Majikan</strong> is the developer's nickname behind ${made}.`,
    go: "Continue",
    cancel: "Cancel",
    contact: "Contact me",
  },
  nl: {
    label: "Steun de ontwikkelaar",
    redirect:
      "Je wordt doorgestuurd naar <strong>PayPal</strong> om je donatie af " +
      "te ronden. De betaalpagina opent in een nieuw tabblad.",
    made: "diverse open-source projecten",
    note: (made) =>
      `<strong>Majikan</strong> is the developer's nickname waaronder ` +
      `${made} worden ontwikkeld.`,
    go: "Doorgaan",
    cancel: "Annuleren",
    contact: "Neem contact op",
  },
};

const HEART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7' +
  'a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/></svg>';

/** Zwarte of witte tekst kiezen die leesbaar is op de gegeven kleur. */
function readableOn(color) {
  let r, g, b;
  const m = color.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    [r, g, b] = m[1].split(",").map((n) => parseFloat(n));
  } else {
    let h = color.replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  if ([r, g, b].some((n) => Number.isNaN(n))) return "#111111";
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

class MajikanDonate extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;

    const lang = (this.getAttribute("lang") || "en")
      .toLowerCase()
      .startsWith("nl")
      ? "nl"
      : "en";
    this._t = STRINGS[lang];
    this._accentVar = this.getAttribute("accent") || "--primary-color";
    this._label = this.getAttribute("label") || this._t.label;
    this._made = this.getAttribute("made") || this._t.made;
    this._url = this.getAttribute("url") || DEFAULT_URL;
    this._contact = this.getAttribute("contact") || "";
    this._version = this.getAttribute("version") || "";

    const accent = `var(${this._accentVar}, var(--primary-color, #ffe500))`;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; }
        :host([inline]) { display: inline-block; }
        .bar { display: flex; justify-content: center; margin: 20px 0 4px; }
        :host([inline]) .bar { margin: 0; display: inline-flex; }
        button {
          font-family: inherit; font-size: 14px; font-weight: 500;
          cursor: pointer; padding: 8px 16px; border-radius: 8px;
          display: inline-flex; align-items: center; gap: 8px;
          background: transparent; color: ${accent};
          border: 1px solid ${accent};
        }
        button svg { width: 16px; height: 16px; }
        .ver { text-align: center; margin-top: 6px; font-size: 11px;
          color: var(--secondary-text-color, #9a9a9a); font-family: monospace; }
      </style>
      <div class="bar">
        <button class="trigger" title="${this._label}">${HEART} ${this._label}</button>
      </div>
      ${this._version ? `<div class="ver">v${this._version}</div>` : ""}`;

    root
      .querySelector(".trigger")
      .addEventListener("click", () => this._confirm());
  }

  disconnectedCallback() {
    this._close();
  }

  _confirm() {
    this._close();

    const cs = getComputedStyle(this);
    const val = (name, fallback) =>
      cs.getPropertyValue(name).trim() || fallback;
    const accent =
      val(this._accentVar, "") || val("--primary-color", "#ffe500");
    const card =
      val("--ha-card-background", "") ||
      val("--card-background-color", "#1c1c1c");
    const text = val("--primary-text-color", "#e9e9e9");
    const dim = val("--secondary-text-color", "#9a9a9a");
    const divider = val("--divider-color", "rgba(127,127,127,.25)");
    const onAccent = readableOn(accent);

    const ov = document.createElement("div");
    ov.id = "majikan-donate-confirm";
    ov.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);" +
      "backdrop-filter:blur(6px) saturate(120%);" +
      "-webkit-backdrop-filter:blur(6px) saturate(120%);" +
      "display:flex;align-items:center;justify-content:center;padding:16px;" +
      "font-family:var(--paper-font-body1_-_font-family,var(--mdc-typography-font-family,system-ui,sans-serif));";
    ov.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="${this._label}"
           style="width:min(460px,100%);background:${card};color:${text};
                  border-radius:16px;overflow:hidden;box-sizing:border-box;">
        <div style="padding:16px 20px;">
          <h2 style="margin:0;font-size:18px;font-weight:500;">${this._label}</h2>
        </div>
        <div style="padding:4px 20px 16px;border-top:1px solid ${divider};
                    border-bottom:1px solid ${divider};">
          <p style="margin:12px 0 0;font-size:14px;line-height:1.5;">
            ${this._t.redirect}</p>
          <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:${dim};">
            ${this._t.note(this._made)}</p>
        </div>
        <div style="display:flex;gap:12px;align-items:center;padding:12px 20px;">
          <button id="mjk-go" style="font:inherit;font-weight:500;font-size:14px;
            cursor:pointer;padding:8px 16px;border-radius:8px;border:none;
            background:${accent};color:${onAccent};">${this._t.go}</button>
          <button id="mjk-cancel" style="font:inherit;font-weight:500;
            font-size:14px;cursor:pointer;padding:8px 16px;border-radius:8px;
            background:transparent;color:${accent};border:1px solid ${accent};"
            >${this._t.cancel}</button>
          ${this._contact ? `<span style="flex:1"></span>
          <a href="${this._contact}" target="_blank" rel="noopener"
             style="font:inherit;font-weight:500;font-size:14px;text-decoration:none;
             display:inline-flex;align-items:center;gap:6px;padding:8px 16px;
             border-radius:8px;background:transparent;color:${accent};
             border:1px solid ${accent};"><svg viewBox="0 0 24 24" width="15"
             height="15" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
             ><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"
             /></svg>${this._t.contact}</a>` : ""}
        </div>
      </div>`;
    document.body.appendChild(ov);
    this._overlay = ov;

    ov.addEventListener("mousedown", (ev) => {
      if (ev.target === ov) this._close();
    });
    ov.querySelector("#mjk-cancel").addEventListener("click", () =>
      this._close()
    );
    ov.querySelector("#mjk-go").addEventListener("click", () => {
      window.open(this._url, "_blank", "noopener");
      this._close();
    });
    this._esc = (ev) => {
      if (ev.key === "Escape") this._close();
    };
    window.addEventListener("keydown", this._esc);
  }

  _close() {
    if (this._esc) {
      window.removeEventListener("keydown", this._esc);
      this._esc = null;
    }
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  }
}

if (!customElements.get("majikan-donate")) {
  customElements.define("majikan-donate", MajikanDonate);
}
