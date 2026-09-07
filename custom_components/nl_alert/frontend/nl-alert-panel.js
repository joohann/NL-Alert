/**
 * NL-Alert panel — settings UI + national alert map.
 *
 * Registered by panel.py at /nl-alert. Talks to websocket.py only; it never
 * touches config entries or hass.callService directly.
 *
 * Layout (single column, cards stack on narrow screens):
 *   1. Header       — live counters + refresh
 *   2. Problems     — validation from notifier.async_validate, one line per
 *                     broken setting. This is what turns "het test alarm doet
 *                     niets" into "media_player.bedroom_2 bestaat niet meer".
 *   3. Landelijk    — the national map: CARTO raster tiles under an SVG of
 *                     every active alert area, plus the monitored location.
 *                     Click an alert to zoom to it, click again to zoom out.
 *   4. Settings     — location, alarm + speech, notifications
 *   5. Tests        — the four dispatch tests with per-step results inline
 *
 * Why raster tiles in an SVG instead of Leaflet: Leaflet ships inside HA's
 * frontend bundle and isn't importable from a custom panel. An <svg> with
 * <image> tiles gives the same picture, scales itself, shares one coordinate
 * system with the polygons, and adds no dependency. Tiles that fail to load
 * are hidden, so the map degrades to plain silhouettes rather than breaking.
 *
 * No build step and no framework on purpose — plain custom element, HA theme
 * CSS variables for colours so it follows the user's theme.
 *
 * New in 0.3.0 (2026-08-09).
 */

// Gedeelde "Steun de ontwikkelaar"-knop + popup (Majikan). Eén bron van
// waarheid; ditzelfde bestand staat in elke Majikan-integratie.
import "./majikan-donate.js";

const TILE_SIZE = 256;
const REFRESH_MS = 30000;
// Zoom search range and the pixel budget a rendered map may occupy. The
// whole country lands on z8; a single municipality-sized alert area on ~z12,
// which keeps the tiles sharp when you click an alert to zoom in.
const ZOOM_MIN = 6;
// Esri serves down to street level; stopping at 13 meant the deepest view
// was still a whole neighbourhood.
const ZOOM_MAX = 18;
// Only a fallback for the first paint, before the map element has a size.
const MAX_MAP_PX = 700;
// Manual zoom steps around whatever the map is currently framing. Each step
// halves or doubles the visible span.
// Limits on how far the view may be zoomed, in degrees of latitude:
// roughly 1 km at the tight end, twice the country at the wide end.
const MIN_SPAN_LAT = 0.0012;
const MAX_SPAN_LAT = 6;

// NL-Alert's house style is yellow on black (nl-alert.nl). Yellow alone has
// poor contrast on a light map, so every shape gets a dark outline — the
// same yellow/black pairing the real thing uses.
const BRAND_YELLOW = "#ffe500";
const BRAND_BLACK = "#111111";
// Reticle ink: a near-black halo carrying a light yellow line.
const RETICLE_HALO = "#111111";
const RETICLE_LINE = "#ffe500";

const TYPE_COLORS = {
  alert: BRAND_YELLOW,
  test: "#1e88e5",
  amber: "#fb8c00",
  monitoring: "#8e24aa",
};
const TYPE_STROKES = { alert: BRAND_BLACK };

const STATUS_ICON = { ok: "✔", warning: "⚠", skipped: "–", error: "✖" };

// Shown once per installation, and reachable afterwards under "Over" in the
// settings. The disclaimer is the point: someone who installs this could
// reasonably assume it is an official channel, and it is not.
/**
 * Contextual help behind the "?" buttons in the settings dialog. Kept as
 * data rather than markup so a topic is one object, not a block of HTML
 * buried three levels into a template string.
 */
const HELP = {
  siren: {
    title: "Een sirene koppelen",
    body: [
      "Een speaker is makkelijk te overhoren. Hij staat in één kamer, en " +
        "hoe hard hij aangaat hangt af van wat je er als laatste op hebt " +
        "afgespeeld. Een sirene doet één ding, en doet dat hard.",
      "NL-Alert stuurt elke entiteit uit het siren-domein aan, en ook een " +
        "gewone switch — een sirene op een slimme stekker telt dus gewoon " +
        "mee. Bij een alert gaat hij tegelijk met het alarmgeluid aan en na " +
        "de ingestelde tijd vanzelf weer uit.",
    ],
    example: {
      head: "Bijvoorbeeld: Sonoff SNZB-09P",
      body:
        "Een Zigbee-sirene voor binnen. Koppel hem aan Zigbee2MQTT of ZHA, " +
        "dan verschijnt hij vanzelf in de lijst hierboven.",
      link: "sonoff.tech — SNZB-09P",
      href:
        "https://sonoff.tech/en-nl/products/" +
        "sonoff-zigbee-senseguard-indoor-siren-snzb-09p",
    },
    footer: [
      "Dat is een voorbeeld en geen aanbeveling: alles wat in Home " +
        "Assistant als siren of switch verschijnt werkt hier.",
      "Let op: nachtmodus geldt niet voor de sirene. Nachtmodus verlaagt " +
        "een volume, en een sirene heeft er geen — een sirene die om 03:00 " +
        "beleefd blijft is een sirene die zijn werk niet doet.",
    ],
  },
};

const WELCOME = {
  title: "NL-Alert in Home Assistant",
  intro:
    "Deze integratie haalt actieve NL-Alert berichten op en geeft ze door aan je speakers, telefoon en TV.",
  warnings: [
    {
      head: "Geen officiële integratie.",
      body:
        "Dit is een project van een particulier en heeft geen enkele band met de Rijksoverheid, het ministerie van Justitie en Veiligheid of de veiligheidsregio's.",
    },
    {
      head: "Niet leidend.",
      body:
        "Vertrouw hier nooit alleen op. NL-Alert op je telefoon, de sirene en de officiële kanalen blijven leidend. Deze integratie kan uitvallen door een storing, een internetprobleem of een speaker die niet reageert.",
    },
  ],
  sourcesTitle: "Bronnen",
  sources: [
    {
      label: "Alertberichten",
      value: "api.public-warning.app",
      href: "https://api.public-warning.app",
      note: "publieke API, niet van de overheid zelf",
    },
    {
      label: "Kaartmateriaal",
      value: "OpenStreetMap · CARTO",
      href: "https://www.openstreetmap.org/copyright",
      note: "kaarttegels",
    },
    {
      label: "Feestdagen",
      value: "Holiday-integratie van Home Assistant",
      href: "https://www.home-assistant.io/integrations/holiday/",
      note: "voor de maandelijkse test",
    },
  ],
  cta: "Aan de slag",
};

/* ── Web Mercator ─────────────────────────────────────────────────────────── */

function project(lat, lon, zoom) {
  const n = Math.pow(2, zoom) * TILE_SIZE;
  const x = ((lon + 180) / 360) * n;
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  const rad = (clamped * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [x, y];
}

/** Inverse of project(): world pixels back to (lat, lon). */
function unproject(x, y, zoom) {
  const n = Math.pow(2, zoom) * TILE_SIZE;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lat, lon];
}

/**
 * Largest zoom whose extent still fits the box it will be drawn in.
 *
 * Measured against the real container rather than a fixed budget: the SVG
 * scales its viewBox down to fit, so packing 1200 tile-pixels into a 500px
 * card shrank every place name by 2.4x and made the map unreadable. Sizing
 * the extent to the container keeps one tile-pixel at roughly one CSS pixel,
 * which is the size the cartography was designed for.
 */
function pickZoom(bounds, boxWidth, boxHeight) {
  const maxW = Math.max(240, boxWidth || MAX_MAP_PX);
  const maxH = Math.max(240, boxHeight || MAX_MAP_PX);
  for (let zoom = ZOOM_MAX; zoom > ZOOM_MIN; zoom--) {
    const [x1, y1] = project(bounds.max_lat, bounds.min_lon, zoom);
    const [x2, y2] = project(bounds.min_lat, bounds.max_lon, zoom);
    if (x2 - x1 <= maxW && y2 - y1 <= maxH) return zoom;
  }
  return ZOOM_MIN;
}

function boundsOfPolygons(polygons) {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  polygons.forEach((poly) =>
    poly.forEach(([lat, lon]) => {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    })
  );
  if (minLat > maxLat) return null;
  // Pad so a small municipality-sized area doesn't fill the whole frame.
  const padLat = Math.max((maxLat - minLat) * 0.35, 0.05);
  const padLon = Math.max((maxLon - minLon) * 0.35, 0.08);
  return {
    min_lat: minLat - padLat,
    max_lat: maxLat + padLat,
    min_lon: minLon - padLon,
    max_lon: maxLon + padLon,
  };
}

// CARTO watermarks every tile with "API KEY REQUIRED" since August 2026, and
// OpenStreetMap's own raster servers refuse third-party apps outright. Esri's
// World Street Map still serves labelled tiles without a key, and the URL is a
// setting so anyone can point at a provider they hold a key for.
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_ATTRIBUTION = "© OpenStreetMap contributors";

// One-click choices. OSM's tile policy allows exactly what this panel does —
// the tiles for the current viewport, requested by a person looking at them —
// but it is not the default: a HACS integration should not put its users'
// traffic on community-funded servers by choice.
const TILE_PRESETS = [
  {
    id: "osm",
    label: "OpenStreetMap (standaard)",
    url: DEFAULT_TILE_URL,
    attribution: DEFAULT_ATTRIBUTION,
  },
  {
    id: "esri",
    label: "Esri World Street Map",
    url:
      "https://server.arcgisonline.com/ArcGIS/rest/services/" +
      "World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "© Esri, HERE, Garmin, OpenStreetMap contributors",
  },
];

// Written as an SVG filter rather than the CSS `filter` property: CSS filter
// functions on an inline-SVG child are unreliable outside Chromium, which is
// why the map stayed light in dark mode on Safari. feComponentTransfer and
// feColorMatrix are plain SVG and behave the same everywhere.
const DARK_FILTER = `
  <filter id="nl-dark" color-interpolation-filters="sRGB">
    <feComponentTransfer>
      <feFuncR type="table" tableValues="1 0"/>
      <feFuncG type="table" tableValues="1 0"/>
      <feFuncB type="table" tableValues="1 0"/>
    </feComponentTransfer>
    <feColorMatrix type="hueRotate" values="180"/>
    <feColorMatrix type="saturate" values="0.45"/>
    <feComponentTransfer>
      <feFuncR type="linear" slope="0.86"/>
      <feFuncG type="linear" slope="0.86"/>
      <feFuncB type="linear" slope="0.86"/>
    </feComponentTransfer>
  </filter>`;

/** Fill {z}/{x}/{y} (and {s}) in a tile template. */
function tileUrl(template, zoom, x, y) {
  return (template || DEFAULT_TILE_URL)
    .replace(/{z}/g, zoom)
    .replace(/{x}/g, x)
    .replace(/{y}/g, y)
    .replace(/{s}/g, "a");
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/**
 * A multi-select that stays shut until you need it.
 *
 * The settings dialog used to render every pick-list open, each with its own
 * 190px scroll box inside the dialog's own scroll — six of them, and the
 * speaker list alone ran to 16 rows. Collapsed triggers turn that into six
 * one-line controls.
 *
 * Deliberately light DOM, no shadow root of its own: it lives inside the
 * panel's shadow tree, so the panel's stylesheet reaches it and there is one
 * place where these controls are styled instead of two.
 *
 * The list expands in flow rather than floating over the page. A floating
 * popup would be clipped by the dialog body's `overflow-y: auto` the moment
 * it opened near the bottom, and flipping upward only moves the problem to
 * short viewports.
 *
 * Keyboard follows the ARIA combobox pattern: the trigger opens, focus lands
 * on the search box (or the list itself when the list is short enough not to
 * need one), arrows move `aria-activedescendant` without moving real focus,
 * Space and Enter toggle, Escape closes and hands focus back to the trigger.
 */
class NlMultiSelect extends HTMLElement {
  constructor() {
    super();
    this._options = [];
    this._value = [];
    this._open = false;
    this._active = -1;
    this._query = "";
    this._id = `ms${Math.random().toString(36).slice(2, 8)}`;
    this._onOutside = (ev) => {
      if (this._open && !this.contains(ev.composedPath()[0])) this.close();
    };
  }

  /** [{ value, label, sub, group, gone }] */
  set options(list) {
    this._options = Array.isArray(list) ? list : [];
    this._render();
  }

  get options() {
    return this._options;
  }

  set value(list) {
    this._value = Array.isArray(list) ? [...list] : [];
    this._render();
  }

  get value() {
    return [...this._value];
  }

  connectedCallback() {
    // Pointerdown, not click: a click that starts inside and ends outside
    // (dragging across the list) should not count as "clicked away".
    this.getRootNode().addEventListener("pointerdown", this._onOutside, true);
    this._render();
  }

  disconnectedCallback() {
    this.getRootNode().removeEventListener("pointerdown", this._onOutside, true);
  }

  open() {
    if (this._open) return;
    this._open = true;
    this._active = this._visible().findIndex((o) =>
      this._value.includes(o.value)
    );
    this._render();
    const search = this.querySelector(".ms-search");
    (search || this.querySelector(".ms-list")).focus();
    // A list opening at the bottom of the dialog would otherwise expand out
    // of sight, leaving the user looking at an unchanged screen.
    this.querySelector(".ms-panel").scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }

  close({ focusTrigger = false } = {}) {
    if (!this._open) return;
    this._open = false;
    this._query = "";
    this._active = -1;
    this._render();
    if (focusTrigger) this.querySelector(".ms-trigger").focus();
  }

  toggle() {
    this._open ? this.close() : this.open();
  }

  _visible() {
    const needle = this._query.trim().toLowerCase();
    if (!needle) return this._options;
    // Anything already ticked stays listed whatever you type, so a filter can
    // never hide what you are about to switch off.
    return this._options.filter(
      (o) =>
        this._value.includes(o.value) ||
        (o.label || "").toLowerCase().includes(needle) ||
        (o.value || "").toLowerCase().includes(needle)
    );
  }

  _toggleValue(value) {
    this._value = this._value.includes(value)
      ? this._value.filter((v) => v !== value)
      : [...this._value, value];
    this._render();
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      })
    );
  }

  _summary() {
    if (!this._value.length) return this.dataset.placeholder || "— niets gekozen —";
    const labels = this._value.map((v) => {
      const found = this._options.find((o) => o.value === v);
      return found ? found.label : v;
    });
    if (labels.length <= 2) return labels.join(", ");
    return `${labels[0]}, ${labels[1]} +${labels.length - 2}`;
  }

  _render() {
    const visible = this._visible();
    const searchable = this._options.length > 7;
    const chosen = new Set(this._value);
    const listId = `${this._id}-list`;
    const activeId =
      this._active >= 0 && visible[this._active]
        ? `${this._id}-o${this._active}`
        : "";

    let lastGroup = null;
    const rows = visible
      .map((option, index) => {
        const head =
          option.group && option.group !== lastGroup
            ? `<div class="ms-group" role="presentation">${escapeHtml(option.group)}</div>`
            : "";
        lastGroup = option.group || lastGroup;
        return `${head}<div class="ms-opt${
          index === this._active ? " active" : ""
        }" role="option" id="${this._id}-o${index}"
             aria-selected="${chosen.has(option.value)}"
             data-value="${escapeHtml(option.value)}">
          <span class="ms-check" aria-hidden="true">${
            chosen.has(option.value) ? "✓" : ""
          }</span>
          <span class="ms-label">${escapeHtml(option.label)}
            <span class="sub">${escapeHtml(option.sub || "")}</span></span>
        </div>`;
      })
      .join("");

    this.className = `ms${this._open ? " open" : ""}` + (this.dataset.invalid === "true" ? " invalid" : "");
    this.innerHTML = `
      <button type="button" class="ms-trigger" aria-haspopup="listbox"
              aria-expanded="${this._open}" aria-controls="${listId}">
        <span class="ms-summary${this._value.length ? "" : " muted"}"
          >${escapeHtml(this._summary())}</span>
        ${
          this._value.length
            ? `<span class="ms-count">${this._value.length}</span>`
            : ""
        }
        <span class="ms-caret" aria-hidden="true">▾</span>
      </button>
      <div class="ms-panel" ${this._open ? "" : "hidden"}>
        ${
          searchable
            ? `<input type="text" class="ms-search" role="combobox"
                 aria-expanded="true" aria-controls="${listId}"
                 aria-autocomplete="list"
                 ${activeId ? `aria-activedescendant="${activeId}"` : ""}
                 aria-label="Zoeken in de lijst"
                 placeholder="Zoeken…" value="${escapeHtml(this._query)}">`
            : ""
        }
        <div class="ms-list" id="${listId}" role="listbox"
             aria-multiselectable="true"
             ${searchable ? "" : 'tabindex="-1"'}
             ${!searchable && activeId ? `aria-activedescendant="${activeId}"` : ""}
             aria-label="${escapeHtml(this.dataset.label || "Keuzelijst")}">
          ${
            rows ||
            `<div class="ms-empty muted">${
              this.dataset.empty || "Niets gevonden."
            }</div>`
          }
        </div>
        <div class="ms-foot">
          <button type="button" class="link" data-act="clear" ${
            this._value.length ? "" : "disabled"
          }>Alles wissen</button>
          <span class="muted">${this._value.length} van ${
            this._options.length
          }</span>
        </div>
      </div>`;

    this._wire();
  }

  _wire() {
    this.querySelector(".ms-trigger").addEventListener("click", () =>
      this.toggle()
    );
    if (!this._open) return;

    this.querySelectorAll(".ms-opt").forEach((node) =>
      node.addEventListener("click", () => this._toggleValue(node.dataset.value))
    );
    this.querySelector('[data-act="clear"]').addEventListener("click", () => {
      this._value = [];
      this._render();
      this.dispatchEvent(
        new CustomEvent("change", {
          detail: { value: [] },
          bubbles: true,
          composed: true,
        })
      );
      (this.querySelector(".ms-search") || this.querySelector(".ms-list")).focus();
    });

    const search = this.querySelector(".ms-search");
    if (search) {
      search.addEventListener("input", (ev) => {
        this._query = ev.target.value;
        this._active = -1;
        this._render();
        const again = this.querySelector(".ms-search");
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      });
    }
    const keyTarget = search || this.querySelector(".ms-list");
    keyTarget.addEventListener("keydown", (ev) => this._onKey(ev));
  }

  _onKey(ev) {
    const visible = this._visible();
    const move = (delta) => {
      ev.preventDefault();
      if (!visible.length) return;
      this._active =
        this._active < 0
          ? delta > 0
            ? 0
            : visible.length - 1
          : (this._active + delta + visible.length) % visible.length;
      this._paintActive();
    };

    switch (ev.key) {
      case "ArrowDown":
        return move(1);
      case "ArrowUp":
        return move(-1);
      case "Home":
        ev.preventDefault();
        this._active = 0;
        return this._paintActive();
      case "End":
        ev.preventDefault();
        this._active = visible.length - 1;
        return this._paintActive();
      case " ":
        // Only a shortcut when there is no search box. With one, a space
        // belongs in the query — you cannot type "tv slaapkamer" otherwise.
        if (this.querySelector(".ms-search")) return;
      // falls through
      case "Enter":
        if (this._active >= 0 && visible[this._active]) {
          ev.preventDefault();
          this._toggleValue(visible[this._active].value);
          (this.querySelector(".ms-search") || this.querySelector(".ms-list")).focus();
        }
        return;
      case "Escape":
        ev.preventDefault();
        // Stops here: the settings dialog behind this one also listens for
        // Escape, and closing both at once loses the user's place.
        ev.stopPropagation();
        return this.close({ focusTrigger: true });
      case "Tab":
        return this.close();
      default:
        return;
    }
  }

  /**
   * Moves the highlight without a re-render: rebuilding the list on every
   * arrow key would drop focus out of the search box mid-keystroke.
   */
  _paintActive() {
    const nodes = [...this.querySelectorAll(".ms-opt")];
    nodes.forEach((node, index) =>
      node.classList.toggle("active", index === this._active)
    );
    const current = nodes[this._active];
    const owner = this.querySelector(".ms-search") || this.querySelector(".ms-list");
    if (current) {
      owner.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      owner.removeAttribute("aria-activedescendant");
    }
  }
}

customElements.define("nl-multiselect", NlMultiSelect);


/** Distance in km, rounded the way a person would say it. */
function formatKm(km) {
  if (km == null) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

function formatTime(iso, locale) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale || "nl-NL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── Styles ───────────────────────────────────────────────────────────────── */

const STYLE = `
  /* NL-Alert's palette is a yellow/black pair, so the accent flips with the
     theme instead of picking one colour that fights one of them: black reads
     as the strong colour on a light background, yellow on a dark one. The
     [dark] attribute is set from hass.themes.darkMode — HA's theme is a user
     setting, not necessarily the OS preference, so prefers-color-scheme
     would be wrong here. */
  :host {
    --nl-accent: #111111;
    --nl-on-accent: #ffffff;
    --nl-wordmark: #111111;
  }
  :host([dark]) {
    --nl-accent: #ffe500;
    --nl-on-accent: #111111;
    /* "Diapositief": the wordmark inverts to white, the yellow mark inside
       the logo keeps its own fill and needs no variant file. */
    --nl-wordmark: #ffffff;
  }
  :host {
    display: block;
    padding: 16px;
    max-width: 1100px;
    margin: 0 auto;
    box-sizing: border-box;
    color: var(--primary-text-color, #212121);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  }
  h1 { font-size: 24px; margin: 0; font-weight: 500; }
  h2 { font-size: 16px; margin: 0 0 12px; font-weight: 500; }
  .muted { color: var(--secondary-text-color, #727272); font-size: 13px; }
  /* Both logo files are cropped to their ink (viewBox "0 20 267.3 85"), so
     the element box has no dead space: the left edge lines up with the cards
     below, and header's align-items:center puts the wordmark on the same
     line as the buttons instead of 8px below them. */
  .logo { color: var(--nl-wordmark); }
  .logo svg { height: 48px; width: auto; display: block; }
  /* The mobile top bar already shows the wordmark, so shrink the big header
     logo on narrow screens to avoid a jumbo duplicate. */
  @media (max-width: 600px) { .logo svg { height: 32px; } }

  .busy {
    display: flex; flex-direction: column; align-items: center; gap: 14px;
    padding: 28px 36px; border-radius: 16px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    box-shadow: 0 24px 64px rgba(0,0,0,.35);
    font-size: 15px; animation: rise .18s ease-out;
  }
  .busy .spinner {
    width: 34px; height: 34px; border-radius: 50%;
    border: 3px solid var(--divider-color, #e0e0e0);
    border-top-color: var(--nl-accent);
    animation: spin .8s linear infinite;
  }
  .busy .done {
    width: 34px; height: 34px; border-radius: 50%; line-height: 34px;
    text-align: center; font-size: 18px;
    background: var(--nl-accent); color: var(--nl-on-accent);
  }
  @keyframes spin { to { transform: rotate(360deg) } }

  header {
    display: flex; align-items: center; gap: 16px;
    flex-wrap: wrap; margin-bottom: 16px;
  }
  header .grow { flex: 1; }

  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: 16px; font-size: 13px;
    background: var(--secondary-background-color, #e0e0e0);
  }
  .chip.hot { background: #ffe500; color: #111; font-weight: 500; }
  .chip .dot {
    width: 8px; height: 8px; border-radius: 50%; background: currentColor;
  }

  .card {
    background: var(--card-background-color, #fff);
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.12));
    padding: 16px; margin-bottom: 16px;
  }
  details.card { padding: 0; }
  details.card > summary {
    list-style: none; cursor: pointer; user-select: none;
    padding: 14px 16px; font-size: 16px; font-weight: 500;
    display: flex; align-items: center; gap: 10px;
  }
  details.card > summary::-webkit-details-marker { display: none; }
  details.card > summary::before {
    content: "›"; font-size: 20px; line-height: 1;
    transition: transform .15s ease; color: var(--secondary-text-color, #727272);
  }
  details.card[open] > summary::before { transform: rotate(90deg); }
  details.card > summary:hover { background: var(--secondary-background-color, #f5f5f5); }
  details.card > .row { margin: 0 16px; }
  details.card > .row:last-child { padding-bottom: 14px; }

  .card.problems { border-left: 4px solid var(--nl-accent); }
  .card.problems.warn-only { border-left-color: #fb8c00; }

  .problem { display: flex; gap: 8px; padding: 4px 0; font-size: 14px; }
  .problem .mark { flex: 0 0 auto; }
  .problem.error .mark { color: var(--nl-accent); }
  .problem.warning .mark { color: #fb8c00; }

  .row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 0; flex-wrap: wrap;
    border-top: 1px solid var(--divider-color, #e0e0e0);
  }
  .row:first-of-type { border-top: none; }
  .row label.title { flex: 1 1 200px; font-size: 14px; }
  .row .control { flex: 1 1 260px; display: flex; gap: 8px; align-items: center; }
  .row .hint { flex-basis: 100%; }

  input[type="text"], input[type="number"], select {
    width: 100%; box-sizing: border-box;
    padding: 8px 10px; font-size: 14px; font-family: inherit;
    color: var(--primary-text-color, #212121);
    background: var(--secondary-background-color, #fafafa);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 8px;
  }
  /* Boolean settings as switches. Only DIRECT children of .control, so the
     rule cannot reach into a multi-select. The track radius matches the
     buttons (8px) instead of the usual pill, so the whole panel keeps one
     corner language. */
  .row > .control > input[type="checkbox"] {
    appearance: none; -webkit-appearance: none; margin: 0;
    flex: 0 0 auto; position: relative; cursor: pointer;
    width: 48px; height: 28px; border-radius: 8px;
    background: var(--divider-color, #d5d9de);
    border: 1px solid var(--divider-color, #d5d9de);
    transition: background .18s ease;
  }
  .row > .control > input[type="checkbox"]::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 22px; height: 22px; border-radius: 6px;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35);
    transition: transform .18s ease, background .18s ease;
  }
  .row > .control > input[type="checkbox"]:checked {
    background: #ffe500; border-color: #ffe500;
  }
  .row > .control > input[type="checkbox"]:checked::after {
    transform: translateX(20px); background: #111111;
  }
  .row > .control > input[type="checkbox"]:focus-visible {
    outline: 2px solid var(--nl-accent); outline-offset: 2px;
  }
  /* The multi-selects stay checkboxes, but in the brand colour. */

  input[type="range"] { width: 100%; accent-color: #ffe500; }
  input.invalid, select.invalid {
    border-color: var(--nl-accent); border-width: 2px;
  }


  /* Multi-select. One line when shut, a list when open — see NlMultiSelect. */
  .ms { display: block; width: 100%; position: relative; }
  .ms-trigger {
    display: flex; align-items: center; gap: 8px; width: 100%;
    min-height: 44px; padding: 8px 12px; text-align: left; font-weight: 400;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px;
  }
  .ms-trigger:hover { border-color: var(--nl-accent); }
  .ms-trigger:focus-visible {
    outline: 2px solid var(--nl-accent); outline-offset: 2px;
  }
  .ms-summary {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ms-count {
    flex: none; min-width: 20px; padding: 1px 7px; border-radius: 10px;
    font-size: 12px; font-weight: 600; text-align: center;
    background: var(--nl-accent); color: var(--nl-on-accent);
  }
  .ms-caret { flex: none; font-size: 11px; transition: transform .15s ease; }
  .ms.open .ms-caret { transform: rotate(180deg); }
  .ms.open .ms-trigger {
    border-color: var(--nl-accent);
    border-bottom-left-radius: 0; border-bottom-right-radius: 0;
  }
  .ms-panel {
    border: 1px solid var(--nl-accent); border-top: none;
    border-radius: 0 0 8px 8px; padding: 8px;
    background: var(--card-background-color, #fff);
  }
  .ms-search {
    width: 100%; box-sizing: border-box; margin-bottom: 6px;
  }
  .ms-list { max-height: 240px; overflow-y: auto; }
  .ms-list:focus-visible { outline: 2px solid var(--nl-accent); outline-offset: 2px; }
  .ms-group {
    padding: 8px 8px 4px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em;
    color: var(--secondary-text-color, #727272);
  }
  .ms-opt {
    display: flex; align-items: center; gap: 10px; cursor: pointer;
    min-height: 44px; padding: 6px 8px; border-radius: 6px; font-size: 14px;
  }
  .ms-opt:hover, .ms-opt.active {
    background: var(--secondary-background-color, #f2f2f2);
  }
  /* The highlight is a ring as well as a fill, so it survives being the
     only cue for someone who cannot separate the two greys. */
  .ms-opt.active { box-shadow: inset 0 0 0 2px var(--nl-accent); }
  .ms-check {
    flex: none; width: 18px; height: 18px; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700;
    border: 1px solid var(--divider-color, #bdbdbd);
  }
  .ms-opt[aria-selected="true"] .ms-check {
    background: var(--nl-accent); color: var(--nl-on-accent);
    border-color: var(--nl-accent);
  }
  .ms-label { min-width: 0; }
  .ms-label .sub {
    color: var(--secondary-text-color, #727272); font-size: 12px;
  }
  .ms-empty { padding: 12px 8px; }
  .ms-foot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 8px 2px; font-size: 12px;
    border-top: 1px solid var(--divider-color, #eee); margin-top: 6px;
  }
  button.link {
    background: none; border: none; padding: 4px 0; font-size: 12px;
    color: var(--primary-text-color, #212121); text-decoration: underline;
  }
  button.link[disabled] { opacity: .4; text-decoration: none; cursor: default; }
  .ms.invalid .ms-trigger { border-color: #d32f2f; }
  @media (prefers-reduced-motion: reduce) {
    .ms-caret { transition: none; }
  }
  /* Small round "?" next to a label. Sized off the label so it never drags
     the row height around. */
  .help-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; padding: 0; margin-left: 6px;
    border-radius: 50%; font-size: 12px; font-weight: 700; line-height: 1;
    vertical-align: middle;
    background: var(--secondary-background-color, #f0f0f0);
    color: var(--secondary-text-color, #727272);
  }
  .help-btn:hover { background: var(--nl-accent); color: var(--nl-on-accent); }
  .dialog.help { width: min(520px, 100%); }
  .dialog.help .body { padding: 20px 24px 4px; }
  .dialog.help h2 { margin: 0 0 12px; font-size: 18px; }
  .dialog.help p { margin: 0 0 14px; font-size: 14px; line-height: 1.55; }
  .dialog.help a { color: inherit; }
  .dialog.help .example {
    border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px;
    padding: 12px 14px; margin: 0 0 14px;
  }
  .dialog.help .example strong { display: block; margin-bottom: 4px; }
  /* Above the settings dialog: this opens from inside it. */
  .overlay.help-overlay { z-index: 20; }

  button {
    font-family: inherit; font-size: 14px; cursor: pointer; font-weight: 500;
    padding: 8px 16px; border-radius: 8px; border: none;
    background: var(--nl-accent); color: var(--nl-on-accent);
  }
  button.ghost {
    background: transparent; color: var(--nl-accent);
    border: 1px solid var(--nl-accent);
  }
  .dialog.welcome { width: min(560px, 100%); }
  .dialog.welcome .body { padding: 24px 24px 8px; }
  .dialog.welcome h2 { font-size: 20px; margin: 0 0 8px; }
  .dialog.welcome h3 {
    font-size: 13px; margin: 20px 0 8px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .05em;
    color: var(--secondary-text-color, #727272);
  }
  .dialog.welcome p { margin: 0 0 16px; font-size: 14px; line-height: 1.5; }
  .welcome-logo { margin-bottom: 18px; color: var(--nl-wordmark); }
  .welcome-logo svg { height: 40px; width: auto; display: block; }
  .warn-block {
    margin-bottom: 12px; padding: 12px 14px; border-radius: 10px;
    font-size: 14px; line-height: 1.5;
    background: rgba(255, 229, 0, .16);
    border-left: 3px solid #ffe500;
  }
  .warn-block strong { display: block; margin-bottom: 2px; }
  ul.sources { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  ul.sources li {
    display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline;
    padding: 6px 0; border-top: 1px solid var(--divider-color, #e0e0e0);
  }
  ul.sources li:first-child { border-top: none; }
  .src-label { flex: 0 0 110px; color: var(--secondary-text-color, #727272); }
  ul.sources a { color: var(--nl-accent); }
  .src-note { flex-basis: 100%; color: var(--secondary-text-color, #727272); }

  .icon-btn { border: none; }
  button:disabled { opacity: .5; cursor: default; }

  .tests { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
  .test { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px; padding: 12px; }
  .test button { width: 100%; }
  .test .results { margin-top: 8px; font-size: 13px; }
  .test .results div { padding: 2px 0; display: flex; gap: 6px; }
  .test .results .ok { color: var(--success-color, #43a047); }
  .test .results .error { color: var(--nl-accent); }
  .test .results .warning { color: #fb8c00; }
  .test .results .skipped { color: var(--secondary-text-color, #727272); }
  .results { font-size: 13px; }
  .results div { padding: 2px 0; display: flex; gap: 6px; }
  .results .ok { color: var(--success-color, #43a047); }
  .results .error { color: var(--nl-accent); }
  .results .warning { color: #fb8c00; }
  .results .skipped { color: var(--secondary-text-color, #727272); }

  /* The Netherlands is portrait-shaped; at full card width the map would be
     ~1.2x taller than it is wide. Side-by-side with the alert list keeps both
     on screen, and collapses to one column on a phone or a narrow sidebar. */
  .map-body { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 860px) { .map-body { grid-template-columns: 1fr; } }

  .map-wrap { position: relative; height: 460px; }
  .map-wrap #map { height: 100%; }
  @keyframes punch-in {
    from { transform: scale(2.2); opacity: .35; }
    to   { transform: scale(1); opacity: 1; }
  }
  .map-wrap svg.zooming { animation: punch-in .9s cubic-bezier(.16,.84,.34,1); }
  .reticle .ping {
    transform-box: fill-box; transform-origin: center;
    animation: ping 2.2s ease-out infinite;
  }
  @keyframes ping {
    0%   { transform: scale(.55); opacity: .95; }
    70%  { transform: scale(1.7);  opacity: 0; }
    100% { transform: scale(1.7);  opacity: 0; }
  }
  .focus-bar {
    display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
    padding: 8px 12px; border-radius: 8px; font-size: 13px;
    background: var(--secondary-background-color, #f1f3f5);
  }
  .focus-bar .grow { flex: 1; }
  .hist { cursor: pointer; }
  .hist.focused { border-left-color: var(--nl-accent); }
  .hist.nogeo { cursor: default; }
  .map-wrap #map { overflow: hidden; border-radius: 10px; }
  .map-wrap svg {
    width: 100%; height: 100%; display: block; border-radius: 10px;
    cursor: grab; touch-action: none;
    user-select: none; -webkit-user-select: none;
  }
  .map-wrap svg.dragging { cursor: grabbing; }
  .map-wrap #map { cursor: grab; touch-action: none; }
  /* The tiles must not swallow the drag: pointer events belong to the SVG,
     and the browser must not offer the images as draggable content. */
  .map-wrap svg image { pointer-events: none; -webkit-user-drag: none; }
  /* The basemap has no dark edition, so it is inverted — the same trick HA
     uses for its own raster fallback. Rotating the hue back keeps water blue
     instead of orange. */
  .map-zoom {
    position: absolute; right: 8px; top: 8px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .map-zoom button {
    width: 30px; height: 30px; padding: 0; font-size: 18px; line-height: 1;
    border-radius: 6px; background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    border: 1px solid var(--divider-color, #e0e0e0);
    box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }
  .map-zoom button:hover { background: var(--nl-accent); color: var(--nl-on-accent); }
  .map-zoom button:disabled { opacity: .4; }
  .attribution {
    position: absolute; right: 6px; bottom: 4px; font-size: 10px;
    color: var(--secondary-text-color, #666);
    background: rgba(255,255,255,.6); padding: 0 4px; border-radius: 3px;
  }
  .alert-list {
    display: flex; flex-direction: column; gap: 8px;
    max-height: 460px; overflow-y: auto; padding-right: 4px;
  }
  .alert-item {
    display: flex; gap: 10px; padding: 10px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--divider-color, #e0e0e0);
  }
  .alert-item:hover { background: var(--secondary-background-color, #f5f5f5); }
  .alert-item.selected { border-color: var(--nl-accent); }
  .alert-item .bar { flex: 0 0 5px; border-radius: 2px; outline: 1px solid rgba(0,0,0,.25); }
  .alert-item .msg { font-size: 14px; line-height: 1.4; }
  .alert-item .meta { font-size: 12px; color: var(--secondary-text-color, #727272); }
  /* Blocks, not ruled lines: a stack of hairlines between wrapping
     multi-line messages reads as clutter. Each row is its own tinted card
     with a left edge that only lights up when it is the focused one. */
  .hist {
    display: flex; gap: 12px; align-items: flex-start;
    padding: 10px 12px; border-radius: 10px;
    background: var(--secondary-background-color, #f4f6f8);
    border-left: 3px solid transparent;
  }
  .hist + .hist { margin-top: 8px; }
  .hist-when { flex: 0 0 104px; font-size: 12px;
    color: var(--secondary-text-color, #727272); padding-top: 2px; }
  .hist-body { flex: 1; min-width: 0; }
  .hist-trash {
    flex: 0 0 auto; background: none; border: none; padding: 4px;
    color: var(--secondary-text-color, #9aa0a6); cursor: pointer;
    line-height: 0; border-radius: 6px;
  }
  .hist-trash:hover { color: var(--nl-accent); background: rgba(0,0,0,.06); }
  .hist-trash svg { width: 18px; height: 18px; }
  .hist-msg { font-size: 14px; line-height: 1.35; }
  .hist.test .hist-msg { font-style: italic; }
  .hist-meta { margin-top: 3px; display: flex; gap: 6px; }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 10px;
    background: var(--secondary-background-color, #eceff1);
    color: var(--secondary-text-color, #727272); }
  .tag.on { background: #ffe500; color: #111; }
  .warn { color: var(--nl-accent); font-weight: 500; }

  .alert-item .badge {
    font-size: 11px; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
    background: #ffe500; color: #111; font-weight: 500;
  }

  /* Settings live in a modal so the panel itself stays a compact
     "what is going on right now" view: counters, problems, map. */
  .overlay {
    position: fixed; inset: 0; z-index: 10;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; box-sizing: border-box;
    background: rgba(0, 0, 0, .38);
    backdrop-filter: blur(6px) saturate(120%);
    -webkit-backdrop-filter: blur(6px) saturate(120%);
    animation: fade .16s ease-out;
  }
  @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes rise {
    from { opacity: 0; transform: translateY(12px) scale(.99) }
    to { opacity: 1; transform: none }
  }
  .dialog {
    width: min(760px, 100%); max-height: 100%;
    display: flex; flex-direction: column;
    background: var(--card-background-color, #fff);
    border-radius: 16px; overflow: hidden;
    box-shadow: 0 24px 64px rgba(0,0,0,.35);
    animation: rise .18s ease-out;
  }
  .dialog > header {
    display: flex; align-items: center; gap: 12px; margin: 0;
    padding: 16px 20px; border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .dialog > header h2 { margin: 0; font-size: 18px; }
  .dialog .body { overflow-y: auto; padding: 4px 20px 8px; }
  /* Rail layout. One section on screen instead of nine accordions in a
     column: the full form ran to 4307px of scroll, and a section closing
     above you took your place with it. */
  /* The rail and the pane do their own scrolling, so the body must not
     add a third one around them. */
  .dialog .body.split-body { padding: 0; overflow: hidden; }
  /* One height for every section. Without this the dialog took its size
     from whichever pane was showing — Weergave is 480px, Naar de TV is 836 —
     so every click on the rail resized the window under the pointer, and
     opening a multi-select shoved it again. The panes scroll instead. */
  .dialog.settings { height: min(760px, 100%); }
  /* The height has to be handed down the whole chain. .split sits inside
     #settings, not straight in the body, and a percentage height against an
     auto-height parent resolves to auto — which is why the rail sometimes
     stopped short of the footer instead of running the full side. */
  .dialog.settings > .body {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
  }
  .dialog.settings > .body > #settings {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
  }
  .dialog.settings > .body > #settings > .split { flex: 1; min-height: 0; }
  @media (max-height: 620px) { .dialog.settings { height: 100%; } }
  /* height, not just min-height: the rail is a grid item and only
     stretches the full side of the dialog if the grid itself has one. */
  .split {
    display: grid; grid-template-columns: 190px 1fr;
    height: 100%; min-height: 0;
  }
  .rail {
    border-right: 1px solid var(--divider-color, #e0e0e0);
    padding: 10px 8px; overflow-y: auto;
    background: var(--secondary-background-color, #fafafa);
  }
  .rail button {
    display: flex; align-items: center; gap: 8px; width: 100%;
    min-height: 44px; padding: 9px 10px; margin-bottom: 2px;
    text-align: left; font-weight: 400; border-radius: 8px;
    background: none; color: var(--primary-text-color, #212121);
  }
  .rail button:hover { background: var(--card-background-color, #fff); }
  /* Selected, not shouting: a filled accent here would carry the same
     weight as the Opslaan button and flatten the hierarchy. A bar and a
     heavier label are enough, and the bar is not colour alone. */
  .rail button.on {
    background: var(--card-background-color, #fff); font-weight: 600;
    box-shadow: inset 3px 0 0 var(--nl-accent);
  }
  .rail button:focus-visible { outline: 2px solid var(--nl-accent); outline-offset: -2px; }
  .rail-label { flex: 1; }
  /* Not colour alone: the mark is a glyph, so it survives a palette a
     reader cannot separate. */
  .rail-bad {
    flex: none; width: 18px; height: 18px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; background: #d32f2f; color: #fff;
  }
  .pane { padding: 14px 20px 18px; overflow-y: auto; min-width: 0; }
  .pane:focus { outline: none; }
  .pane h3 { margin: 0 0 2px; font-size: 17px; }
  .pane { position: relative; }
  /* The sentence that used to sit under every row. Twenty-eight of them
     turned the form into a wall of grey; behind a "?" they are there when
     you want them and gone when you don't. */
  .tip {
    position: absolute; z-index: 5;
    width: min(340px, calc(100% - 24px)); box-sizing: border-box;
    padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.45;
    background: var(--primary-text-color, #212121);
    color: var(--card-background-color, #fff);
    box-shadow: 0 8px 24px rgba(0,0,0,.28);
  }
  .tip code {
    background: rgba(255,255,255,.16); border-radius: 4px; padding: 0 3px;
  }
  .title .help-btn { vertical-align: middle; }
  .pane .lead {
    margin: 0 0 10px; font-size: 13px; color: var(--secondary-text-color, #727272);
  }
  .pane > .row:first-of-type { border-top: none; }
  /* Under 640px two columns do not fit, so the rail lies down and scrolls
     sideways above the pane. */
  @media (max-width: 640px) {
    .split { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .rail {
      display: flex; gap: 6px; overflow-x: auto; padding: 8px;
      border-right: none;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
    }
    .rail button { width: auto; white-space: nowrap; margin: 0; }
    .rail button.on { box-shadow: inset 0 -3px 0 var(--nl-accent); }
    .rail-label { flex: none; }
  }
  /* Inside the dialog the sections are a list, not a stack of cards: no
     rounding, no shadow, just a hairline between them. Yellow on every
     divider would be seven loud lines; the accent is spent on the one
     section that is actually open instead. */
  .dialog .body .card {
    box-shadow: none; margin: 0; border-radius: 0;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  /* Direct child only: the settings sections live inside #settings, so a
     plain :last-child matched "Paneel" and dropped the line between it and
     "Testen". The one true last card in the body is Testen. */
  .dialog .body > .card:last-child { border-bottom: none; }
  .dialog .body details.card > summary { padding: 14px 4px; }
  .dialog .body details.card > .row { margin: 0 4px; }
  .dialog .body details.card[open] > summary {
    color: var(--nl-accent); font-weight: 600;
  }
  .dialog .body details.card[open] > summary::before { color: var(--nl-accent); }
  .dialog .body details.card[open] {
    box-shadow: inset 3px 0 0 0 var(--nl-accent);
  }
  .dialog .body details.card[open] > summary,
  .dialog .body details.card[open] > .row { padding-left: 12px; }
  .dialog > footer {
    flex-wrap: wrap;
    display: flex; gap: 12px; align-items: center;
    padding: 12px 20px; border-top: 1px solid var(--divider-color, #e0e0e0);
  }
  .dialog > footer .grow { flex: 1; }
  .dialog.welcome { width: min(560px, 100%); }
  .dialog.welcome .body { padding: 24px 24px 8px; }
  .dialog.welcome h2 { font-size: 20px; margin: 0 0 8px; }
  .dialog.welcome h3 {
    font-size: 13px; margin: 20px 0 8px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .05em;
    color: var(--secondary-text-color, #727272);
  }
  .dialog.welcome p { margin: 0 0 16px; font-size: 14px; line-height: 1.5; }
  .welcome-logo { margin-bottom: 18px; color: var(--nl-wordmark); }
  .welcome-logo svg { height: 40px; width: auto; display: block; }
  .warn-block {
    margin-bottom: 12px; padding: 12px 14px; border-radius: 10px;
    font-size: 14px; line-height: 1.5;
    background: rgba(255, 229, 0, .16);
    border-left: 3px solid #ffe500;
  }
  .warn-block strong { display: block; margin-bottom: 2px; }
  ul.sources { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  ul.sources li {
    display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline;
    padding: 6px 0; border-top: 1px solid var(--divider-color, #e0e0e0);
  }
  ul.sources li:first-child { border-top: none; }
  .src-label { flex: 0 0 110px; color: var(--secondary-text-color, #727272); }
  ul.sources a { color: var(--nl-accent); }
  .src-note { flex-basis: 100%; color: var(--secondary-text-color, #727272); }

  .icon-btn {
    background: transparent; color: var(--secondary-text-color, #727272);
    font-size: 22px; line-height: 1; padding: 4px 10px;
  }
  .toast { font-size: 14px; }
  .toast.ok { color: var(--success-color, #43a047); }
  .toast.error { color: var(--nl-accent); }
`;

/* ── Panel ────────────────────────────────────────────────────────────────── */

class NlAlertPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._loaded = false;
    this._options = {};
    this._validation = [];
    this._listErrors = new Set();
    this._lists = {
      players: [],
      notify: [],
      sirens: [],
      tts: { engines: [], services: [] },
      audio: { builtin: [], local: [] },
    };
    this._alerts = { active: [], local: [], fetched_at: null, monitored: {} };
    this._bounds = { min_lat: 50.7, max_lat: 53.6, min_lon: 3.2, max_lon: 7.3 };
    this._selected = null;
    this._testResults = {};
    this._testRunning = {};
    this._toast = null;
    this._timer = null;
    this._dialogOpen = false;
    this._escHandler = null;
    this._pollingChoices = [];
    this._holidayEntity = "";
    this._focus = null;
    this._focusAnimate = false;
    this._viewBounds = null;
    this._nextSirenTest = "";
    this._logoLight = "";
    this._logoDark = "";
    this._version = "";
    this._tileTemplate = DEFAULT_TILE_URL;
    this._attribution = DEFAULT_ATTRIBUTION;
    this._history = [];
  }

  set hass(hass) {
    this._hass = hass;
    const dark = !!(hass && hass.themes && hass.themes.darkMode);
    const flipped = dark !== this.hasAttribute("dark");
    this.toggleAttribute("dark", dark);
    if (flipped && this._loaded) this._renderHeader();
    if (!this._loaded) {
      this._loaded = true;
      this._bootstrap();
    }
  }

  // On mobile HA gives a custom panel no header, so there's no way back to the
  // sidebar. Render our own sticky top bar (only when narrow) with a menu button
  // that opens the HA sidebar via the standard hass-toggle-menu event.
  set narrow(value) {
    this._narrow = !!value;
    this._mountTopbar();
  }

  _mountTopbar() {
    const sr = this.shadowRoot;
    if (!sr) return;
    const ex = sr.getElementById("ha-topbar");
    if (ex) ex.remove();
    if (!this._narrow) return;
    const bar = document.createElement("div");
    bar.id = "ha-topbar";
    // Full-bleed: cancel the :host { padding:16px } so the bar spans edge to
    // edge and sits at the very top. NL-Alert's house style is yellow-on-black,
    // so default to the brand accent (--nl-accent / --nl-on-accent).
    bar.style.cssText =
      "position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:8px;height:52px;" +
      "margin:-16px -16px 14px;padding:0 12px;box-shadow:0 2px 6px rgba(0,0,0,.25);" +
      "background:var(--nl-alert-topbar-background,var(--nl-accent,#ffe500));" +
      "color:var(--nl-alert-topbar-text,var(--nl-on-accent,#111111))";
    // Use the real NL-Alert wordmark (its SVG uses currentColor, so tying it
    // to --nl-on-accent makes it dark on the yellow bar and white on the black
    // bar). Falls back to text until the logo SVG has loaded.
    const brand = this._logoLight
      ? '<span class="tblogo" style="display:flex;align-items:center;color:var(--nl-on-accent,#111)">' + this._logoLight + '</span>'
      : '<span style="font-size:18px;font-weight:600">NL-Alert</span>';
    bar.innerHTML =
      '<button aria-label="Menu" style="border:0;background:transparent;color:inherit;' +
      'cursor:pointer;width:44px;height:44px;border-radius:50%;display:grid;place-items:center">' +
      '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" ' +
      'd="M3 6h18v2H3V6m0 5h18v2H3v-2m0 5h18v2H3v-2Z"/></svg></button>' + brand;
    const logoSvg = bar.querySelector(".tblogo svg");
    if (logoSvg) {
      logoSvg.removeAttribute("width");
      logoSvg.removeAttribute("height");
      logoSvg.style.height = "24px";
      logoSvg.style.width = "auto";
      logoSvg.style.display = "block";
      // The wordmark's flag mark has a fixed yellow fill (#f9e11e) that is
      // invisible on the yellow bar — recolour it to match the (dark) text so
      // the whole lockup reads as one clean monochrome logo.
      bar.querySelectorAll('.tblogo [fill="#f9e11e"]').forEach(
        (p) => p.setAttribute("fill", "currentColor"));
    }
    bar.querySelector("button").addEventListener("click", () =>
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true })));
    sr.insertBefore(bar, sr.firstChild);
  }

  connectedCallback() {
    if (!this._timer) {
      this._timer = setInterval(() => this._loadAlerts(), REFRESH_MS);
    }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
    if (this._escHandler) window.removeEventListener("keydown", this._escHandler);
  }

  /* ── Data ──────────────────────────────────────────────────────────────── */

  async _bootstrap() {
    this._renderShell();
    this._mountTopbar();
    // Inlined rather than <img src> so the SVG scales with the header and
    // can inherit colour where it uses currentColor.
    if (!this._logoLight) {
      // Two authored files rather than one recoloured at runtime: the
      // diapositief version is a proper white cut, not the light logo with
      // its fills swapped.
      // Carry the module's own ?v=<version> onto the SVG fetches. Without
      // it the browser keeps the first copy it ever saw: the panel script is
      // cache-busted by panel.py, the assets it loads were not, so a fixed
      // logo would stay broken on a long-lived tab.
      const version = new URL(import.meta.url).search;
      this._version = new URLSearchParams(version).get("v") || "";
      const load = async (name) => {
        try {
          const response = await fetch(new URL(name + version, import.meta.url).href);
          return response.ok ? await response.text() : "";
        } catch (err) {
          return "";
        }
      };
      [this._logoLight, this._logoDark] = await Promise.all([
        load("nl-alert-logo.svg"),
        load("nl-alert-logo-diapositief.svg"),
      ]);
      this._mountTopbar();  // re-mount so the wordmark replaces the text fallback
    }
    try {
      const config = await this._hass.callWS({ type: "nl_alert/get_config" });
      this._options = config.options || {};
      this._validation = config.validation || [];
      this._bounds = config.bounds || this._bounds;
      this._pollingChoices = config.polling_choices || [];
      this._holidayEntity = config.holiday_entity || "";
      const mapDefaults = config.map_defaults || {};
      this._tileTemplate =
        this._options.map_tile_url || mapDefaults.tile_url || DEFAULT_TILE_URL;
      this._attribution =
        this._options.map_attribution ||
        mapDefaults.attribution ||
        DEFAULT_ATTRIBUTION;
      this._nextSirenTest = config.next_siren_test || "";
    } catch (err) {
      this._fatal(err);
      return;
    }

    const [players, notify, power, sirens, tts, audio] = await Promise.all([
      this._safeWS("nl_alert/list_media_players", []),
      this._safeWS("nl_alert/list_notify_services", []),
      this._safeWS("nl_alert/list_power_entities", []),
      this._safeWS("nl_alert/list_sirens", []),
      this._safeWS("nl_alert/list_tts_services", {
        engines: [],
        services: [],
        translators: [],
      }),
      this._safeWS("nl_alert/list_audio_files", { builtin: [], local: [] }),
    ]);
    // Normalised on arrival: one unexpected shape from a backend that is
    // mid-upgrade would otherwise throw inside the settings template and
    // blank every row below it, which reads as "the panel is broken".
    const asArray = (value) => (Array.isArray(value) ? value : []);
    this._lists = {
      players: asArray(players),
      notify: asArray(notify),
      power: asArray(power),
      sirens: asArray(sirens),
      tts: {
        engines: asArray(tts && tts.engines),
        services: asArray(tts && tts.services),
        translators: asArray(tts && tts.translators),
      },
      audio: {
        builtin: asArray(audio && audio.builtin),
        local: asArray(audio && audio.local),
      },
    };

    await this._loadAlerts();
    await this._loadHistory();
    this._renderAll();

    if (!this._options.welcome_seen) this._renderWelcome();
  }

  async _safeWS(type, fallback) {
    try {
      const res = await this._hass.callWS({ type });
      this._listErrors.delete(type);
      return res;
    } catch (err) {
      // Remembered, not just logged. A command the running backend does not
      // have yet — new frontend, integration not reloaded — used to end up
      // as an empty picker with no way to tell that apart from "you own no
      // such devices".
      this._listErrors.add(type);
      console.warn(`nl-alert: ${type} failed`, err); // eslint-disable-line no-console
      return fallback;
    }
  }

  async _loadAlerts() {
    if (!this._hass) return;
    try {
      const data = await this._hass.callWS({ type: "nl_alert/get_alerts" });
      this._alerts = data;
      if (data.bounds) this._bounds = data.bounds;
      this._renderHeader();
      this._renderMap();
    } catch (err) {
      // The coordinator may not be loaded yet (or is mid-reload after a save);
      // the next tick picks it up.
      console.debug("nl-alert: get_alerts unavailable", err); // eslint-disable-line no-console
    }
  }

  _fatal(err) {
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <div class="card">
        <h2>NL-Alert</h2>
        <p>Kon de instellingen niet laden: ${escapeHtml(
          err && err.message ? err.message : err
        )}</p>
        <p class="muted">Staat de integratie ingesteld onder Instellingen →
        Apparaten &amp; diensten?</p>
      </div>`;
    this._mountTopbar();
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <header id="header"></header>
      <div id="problems"></div>
      <div class="card">
        <h2>Landelijk overzicht</h2>
        <div id="focus-bar"></div>
        <div class="map-body">
          <div class="map-wrap">
            <div id="map"></div>
            <div class="map-zoom">
              <button id="zoom-in" title="Inzoomen" aria-label="Inzoomen">+</button>
              <button id="zoom-out" title="Uitzoomen" aria-label="Uitzoomen">−</button>
            </div>
            <div class="attribution" id="attribution"></div>
          </div>
          <div class="alert-list" id="alert-list"></div>
        </div>
      </div>
      <details class="card" id="history-card">
        <summary>Recente NL-Alerts</summary>
        <div class="row"><div id="history" class="grow"></div></div>
      </details>
      <majikan-donate lang="nl" accent="--nl-accent"></majikan-donate>
      <div id="dialog-root"></div>
      <div id="busy-root"></div>
      <div id="welcome-root"></div>
      <div id="help-root"></div>`;
  }

  _renderAll() {
    this._renderHeader();
    this._renderProblems();
    this._renderMap();
    this._renderHistory();
    if (this._dialogOpen) this._renderDialog();
  }

  /**
   * Everything this installation has seen, newest first — real alerts and
   * the tests you triggered, in one timeline. A test with no trace is
   * indistinguishable from a button that did nothing.
   */
  _renderHistory() {
    const el = this.shadowRoot.getElementById("history");
    if (!el) return;
    const entries = this._history || [];
    if (!entries.length) {
      el.innerHTML = `<p class="muted">Nog niets geregistreerd.</p>`;
      return;
    }

    const scopeLabel = {
      local: "jouw gebied",
      national: "landelijk",
      elsewhere: "elders",
      test: "test",
    };

    el.innerHTML =
      entries
        .map((entry) => {
          const dutch = String(entry.message || "").split("***")[0].trim();
          const when = formatTime(
            entry.start_at || entry.recorded_at,
            this._locale()
          );
          const isTest = entry.source === "test";
          const hasGeo = !!(entry.centroid && entry.bounds);
          const focused =
            this._focus && this._focus.key === (entry.id || entry.recorded_at);
          return `
            <div class="hist ${isTest ? "test" : ""} ${
              hasGeo ? "" : "nogeo"
            } ${focused ? "focused" : ""}" data-key="${escapeHtml(
              entry.id || entry.recorded_at
            )}">
              <div class="hist-when">${escapeHtml(when)}</div>
              <div class="hist-body">
                <div class="hist-msg">${escapeHtml(dutch)}</div>
                <div class="hist-meta">
                  <span class="tag">${escapeHtml(
                    scopeLabel[entry.scope] || entry.scope || ""
                  )}</span>
                  ${
                    entry.dispatched
                      ? '<span class="tag on">afgegaan</span>'
                      : '<span class="tag">alleen gelogd</span>'
                  }
                  ${
                    entry.distance_km != null && entry.distance_km > 0
                      ? `<span class="tag">${escapeHtml(
                          formatKm(entry.distance_km)
                        )}</span>`
                      : ""
                  }
                  ${hasGeo ? '<span class="tag">📍 op kaart</span>' : ""}
                </div>
              </div>
              <button class="hist-trash" data-del="${escapeHtml(
                entry.id || entry.recorded_at
              )}" title="Verwijderen" aria-label="Verwijderen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>
            </svg>
              </button>
            </div>`;
        })
        .join("");

    el.querySelectorAll(".hist").forEach((node) =>
      node.addEventListener("click", () => {
        const entry = entries.find(
          (e) => String(e.id || e.recorded_at) === node.dataset.key
        );
        if (entry && entry.centroid && entry.bounds) this._focusEntry(entry);
      })
    );

    el.querySelectorAll(".hist-trash").forEach((node) =>
      node.addEventListener("click", async (ev) => {
        // Without this the click also lands on the row and focuses the map on
        // an entry that is about to disappear.
        ev.stopPropagation();
        const key = node.dataset.del;
        try {
          await this._hass.callWS({
            type: "nl_alert/delete_history_entry",
            key,
          });
          this._history = this._history.filter(
            (e) => String(e.id || e.recorded_at) !== key
          );
          if (this._focus && this._focus.key === key) this._clearFocus();
          this._renderHistory();
        } catch (err) {
          this._showToast(`Verwijderen mislukt: ${err.message || err}`, "error");
        }
      })
    );
  }

  /**
   * Put the map on one past alert: fly in, drop a reticle on it, and offer a
   * way back. Only possible for entries recorded since 0.12.0 — older ones
   * have no geometry stored, and those rows are not clickable rather than
   * clickable-but-dead.
   */
  _focusEntry(entry) {
    const b = entry.bounds;
    // A bare bounding box of a small area is a tight box; pad it so the
    // reticle has room and the surroundings stay recognisable.
    // A tight box around a single industrial estate tells you nothing about
    // where in the country you are looking, so the frame never gets smaller
    // than roughly 13 x 13 km — enough to pull in the neighbouring towns.
    const MIN_LAT_SPAN = 0.12;
    const MIN_LON_SPAN = 0.19;
    const padLat = Math.max(
      (b.max_lat - b.min_lat) * 0.9,
      (MIN_LAT_SPAN - (b.max_lat - b.min_lat)) / 2,
      0.02
    );
    const padLon = Math.max(
      (b.max_lon - b.min_lon) * 0.9,
      (MIN_LON_SPAN - (b.max_lon - b.min_lon)) / 2,
      0.03
    );
    this._focus = {
      key: entry.id || entry.recorded_at,
      centroid: entry.centroid,
      // The warned area itself, unpadded: the reticle is sized from this so
      // it marks a piece of ground rather than a fixed slice of the screen.
      area: b,
      label: String(entry.message || "").split("***")[0].trim(),
      bounds: {
        min_lat: b.min_lat - padLat,
        max_lat: b.max_lat + padLat,
        min_lon: b.min_lon - padLon,
        max_lon: b.max_lon + padLon,
      },
    };
    this._focusAnimate = true;
    this._viewBounds = null;
    this._selected = null;
    this._renderMap();
    this._renderHistory();
    const wrap = this.shadowRoot.querySelector(".map-wrap");
    if (wrap && wrap.scrollIntoView) {
      wrap.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  _clearFocus() {
    this._focus = null;
    this._viewBounds = null;
    this._renderMap();
    this._renderHistory();
  }

  async _loadHistory() {
    try {
      const data = await this._hass.callWS({ type: "nl_alert/get_history" });
      this._history = (data && data.entries) || [];
    } catch (err) {
      this._history = [];
    }
    this._renderHistory();
  }

  /* ── Welcome ───────────────────────────────────────────────────────────── */

  _renderWelcome() {
    const root = this.shadowRoot.getElementById("welcome-root");
    if (!root) return;
    const w = WELCOME;
    root.innerHTML = `
      <div class="overlay" id="welcome-overlay">
        <div class="dialog welcome" role="dialog" aria-modal="true"
             aria-label="${escapeHtml(w.title)}">
          <div class="body">
            <div class="welcome-logo">${this._logoLight || ""}</div>
            <h2>${escapeHtml(w.title)}</h2>
            <p>${escapeHtml(w.intro)}</p>
            ${w.warnings
              .map(
                (item) => `<div class="warn-block">
                  <strong>${escapeHtml(item.head)}</strong>
                  ${escapeHtml(item.body)}
                </div>`
              )
              .join("")}
            <h3>${escapeHtml(w.sourcesTitle)}</h3>
            <ul class="sources">
              ${w.sources
                .map(
                  (src) => `<li>
                    <span class="src-label">${escapeHtml(src.label)}</span>
                    <a href="${escapeHtml(src.href)}" target="_blank"
                       rel="noopener noreferrer">${escapeHtml(src.value)}</a>
                    <span class="src-note">${escapeHtml(src.note)}</span>
                  </li>`
                )
                .join("")}
            </ul>
          </div>
          <footer>
            <button id="welcome-ok">${escapeHtml(w.cta)}</button>
            <span class="grow"></span>
            <majikan-donate inline lang="nl" accent="--nl-accent"></majikan-donate>
          </footer>
        </div>
      </div>`;

    root.querySelector("#welcome-ok").addEventListener("click", () =>
      this._dismissWelcome()
    );
  }

  async _dismissWelcome() {
    const root = this.shadowRoot.getElementById("welcome-root");
    if (root) root.innerHTML = "";
    this._options.welcome_seen = true;
    try {
      // Only this key: sending the whole form would write settings the user
      // has not touched, and a first-run dismissal should not save anything
      // else on their behalf.
      await this._hass.callWS({
        type: "nl_alert/save_config",
        options: { welcome_seen: true },
      });
    } catch (err) {
      // Not fatal — worst case the welcome shows again next time.
      console.debug("nl-alert: could not store welcome_seen", err); // eslint-disable-line no-console
    }
  }

  /* ── Help ──────────────────────────────────────────────────────────────── */

  _openHelp(topic) {
    const root = this.shadowRoot.getElementById("help-root");
    const help = HELP[topic];
    if (!root || !help) return;
    root.innerHTML = `
      <div class="overlay help-overlay" id="help-overlay">
        <div class="dialog help" role="dialog" aria-modal="true"
             aria-label="${escapeHtml(help.title)}">
          <header>
            <h2>${escapeHtml(help.title)}</h2>
            <span class="grow" style="flex:1"></span>
            <button class="icon-btn" id="help-close" aria-label="Sluiten">✕</button>
          </header>
          <div class="body">
            ${help.body.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
            <div class="example">
              <strong>${escapeHtml(help.example.head)}</strong>
              ${escapeHtml(help.example.body)}
              <p style="margin:8px 0 0"><a href="${escapeHtml(
                help.example.href
              )}" target="_blank" rel="noopener noreferrer"
                >${escapeHtml(help.example.link)}</a></p>
            </div>
            ${help.footer.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
          </div>
          <footer>
            <button id="help-ok">Duidelijk</button>
          </footer>
        </div>
      </div>`;

    const close = () => this._closeHelp();
    root.querySelector("#help-close").addEventListener("click", close);
    root.querySelector("#help-ok").addEventListener("click", close);
    const overlay = root.querySelector("#help-overlay");
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) close();
    });
    // Escape closes the top layer only; the settings dialog underneath
    // checks for this one before acting on the same key.
    this._helpEsc = (ev) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("keydown", this._helpEsc);
  }

  _closeHelp() {
    window.removeEventListener("keydown", this._helpEsc);
    const root = this.shadowRoot.getElementById("help-root");
    if (root) root.innerHTML = "";
  }

  /* ── Settings dialog ───────────────────────────────────────────────────── */

  _openDialog() {
    this._dialogOpen = true;
    this._renderDialog();
    this._escHandler = (ev) => {
      if (ev.key !== "Escape") return;
      if (this._openTip) {
        this._hideTip(this._openTip, true);
        return;
      }
      // The help layer sits on top and has its own Escape. Checking for it
      // here rather than leaning on stopPropagation: both handlers live on
      // window, and when window is the event target they fire in
      // registration order no matter which phase they asked for.
      const help = this.shadowRoot.getElementById("help-root");
      if (help && help.innerHTML) return;
      this._closeDialog();
    };
    window.addEventListener("keydown", this._escHandler);
  }

  _closeDialog() {
    // Anything still sitting in the debounce goes out now, or a setting
    // changed a second before closing would quietly never be written.
    this._flushSave();
    this._dialogOpen = false;
    window.removeEventListener("keydown", this._escHandler);
    const root = this.shadowRoot.getElementById("dialog-root");
    if (root) root.innerHTML = "";
  }

  _renderDialog() {
    const root = this.shadowRoot.getElementById("dialog-root");
    if (!root) return;
    root.innerHTML = `
      <div class="overlay" id="overlay">
        <div class="dialog settings" role="dialog" aria-modal="true"
             aria-label="NL-Alert instellingen">
          <header>
            <h2>Instellingen</h2>
            <span class="grow" style="flex:1"></span>
            <button class="icon-btn" id="close" aria-label="Sluiten">✕</button>
          </header>
          <div class="body split-body">
            <div id="settings"></div>
          </div>
          <footer>
            <span class="toast" id="toast"></span>
            <span class="grow"></span>
            <majikan-donate inline lang="nl" accent="--nl-accent"></majikan-donate>
          </footer>
        </div>
      </div>`;

    root.querySelector("#close").addEventListener("click", () =>
      this._closeDialog()
    );
    // Click-outside closes, but only when the click starts on the backdrop —
    // otherwise dragging the volume slider past the dialog edge closes it.
    const overlay = root.querySelector("#overlay");
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) this._closeDialog();
    });
    // One listener on the container instead of one per field: every control
    // in here mutates this._options in its own handler, and the multi-select
    // dispatches a composed change event that reaches this too.
    const settings = root.querySelector("#settings");
    settings.addEventListener("change", () => this._queueSave());
    settings.addEventListener("input", () => this._queueSave());

    this._renderSettings();
    this._wireSettings();
    this._wirePickers();
    this._renderTests();
  }

  _renderHeader() {
    const el = this.shadowRoot.getElementById("header");
    if (!el) return;
    const national = (this._alerts.active || []).length;
    const local = (this._alerts.local || []).length;
    el.innerHTML = `
      <div class="grow logo" aria-label="NL-Alert">${
        (this.hasAttribute("dark") ? this._logoDark : this._logoLight) ||
        this._logoLight ||
        "<h1>NL-Alert</h1>"
      }</div>
      <div class="chips">
        <span class="chip${local ? " hot" : ""}"><span class="dot"></span>
          ${local} in jouw gebied</span>
        <span class="chip"><span class="dot"></span>${national} landelijk actief</span>
      </div>
      <button class="ghost" id="refresh">Ververs</button>
      <button id="open-settings">Instellingen</button>`;
    el.querySelector("#open-settings").addEventListener("click", () =>
      this._openDialog()
    );
    el.querySelector("#refresh").addEventListener("click", () => this._refresh());
  }

  /**
   * Poll now, behind a blurred overlay.
   *
   * A refresh that finds nothing new changes nothing on screen, so the
   * button used to feel dead. The overlay makes the work visible and blocks
   * a second press while it runs; it holds "Bijgewerkt" briefly at the end
   * so a fast poll still registers as having happened.
   */
  async _refresh() {
    const root = this.shadowRoot.getElementById("busy-root");
    const paint = (label, done) => {
      root.innerHTML = `
        <div class="overlay">
          <div class="busy">
            <div class="${done ? "done" : "spinner"}">${done ? "✔" : ""}</div>
            <div>${escapeHtml(label)}</div>
          </div>
        </div>`;
    };

    paint("Gegevens ophalen…", false);
    try {
      await this._hass.callWS({ type: "nl_alert/refresh" });
    } catch (err) {
      /* coordinator not loaded — _loadAlerts reports it */
    }
    await this._loadAlerts();
    await this._loadHistory();
    paint("Bijgewerkt", true);
    setTimeout(() => {
      root.innerHTML = "";
    }, 900);
  }

  _renderProblems() {
    const el = this.shadowRoot.getElementById("problems");
    if (!el) return;
    if (!this._validation.length) {
      el.innerHTML = "";
      return;
    }
    const onlyWarnings = this._validation.every((p) => p.status !== "error");
    el.innerHTML = `
      <div class="card problems${onlyWarnings ? " warn-only" : ""}">
        <h2>${onlyWarnings ? "Let op" : "Dit werkt nu niet"}</h2>
        ${this._validation
          .map(
            (p) => `<div class="problem ${escapeHtml(p.status)}">
              <span class="mark">${p.status === "error" ? "✖" : "⚠"}</span>
              <span>${escapeHtml(p.detail)}</span>
            </div>`
          )
          .join("")}
        <div style="margin-top:12px">
          <button id="fix">Instellingen openen</button>
        </div>
      </div>`;
    el.querySelector("#fix").addEventListener("click", () => this._openDialog());
  }

  /* ── Map ───────────────────────────────────────────────────────────────── */

  /**
   * The rectangle the map draws.
   *
   * Zooming and panning both write an explicit rectangle into _viewBounds;
   * everything else (the country, a selected alert, a focused history entry)
   * only supplies the starting frame. One source of truth beats a base plus
   * a zoom step plus a pan offset that have to be composed in the right
   * order every time.
   */
  _activeBounds() {
    if (this._viewBounds) return this._viewBounds;
    if (this._focus) return this._focus.bounds;
    if (this._selected) {
      const alert = (this._alerts.active || []).find(
        (a) => a.id === this._selected
      );
      if (alert && alert.polygons && alert.polygons.length) {
        const b = boundsOfPolygons(alert.polygons);
        if (b) return b;
      }
    }
    return this._bounds;
  }

  _renderMap() {
    const el = this.shadowRoot.getElementById("map");
    if (!el) return;

    const bounds = this._activeBounds();
    const box = el.getBoundingClientRect();
    const zoom = pickZoom(bounds, box.width, box.height);
    const [x1, y1] = project(bounds.max_lat, bounds.min_lon, zoom);
    const [x2, y2] = project(bounds.min_lat, bounds.max_lon, zoom);
    const width = Math.max(x2 - x1, 1);
    const height = Math.max(y2 - y1, 1);
    // Everything below is drawn relative to (x1, y1) and the viewBox starts
    // at 0. World pixel coordinates run to 34 million at zoom 18, past the
    // float precision SVG rasterises with — the map simply stopped drawing.
    // The pan maths keeps using world coordinates; only the geometry that
    // reaches the DOM is shifted.

    const dark = this._hass && this._hass.themes && this._hass.themes.darkMode;
    // Ink has to contrast with the BASEMAP, not with the page: black lines
    // are invisible on the dark tiles, which is how the reticle vanished the
    // moment the map became readable enough to notice.
    const ink = dark ? BRAND_YELLOW : BRAND_BLACK;
    const counterInk = dark ? "#ffffff" : BRAND_YELLOW;
    const tiles = [];
    const tx0 = Math.floor(x1 / TILE_SIZE);
    const tx1 = Math.floor(x2 / TILE_SIZE);
    const ty0 = Math.floor(y1 / TILE_SIZE);
    const ty1 = Math.floor(y2 / TILE_SIZE);
    const max = Math.pow(2, zoom);
    // One tile of slack all round: during a drag the SVG is translated
    // before the grid is rebuilt, and without margin the edges go blank.
    for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) {
      for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) {
        if (tx < 0 || ty < 0 || tx >= max || ty >= max) continue;
        const url = tileUrl(this._tileTemplate, zoom, tx, ty);
        tiles.push(
          `<image href="${url}" x="${tx * TILE_SIZE - x1}" y="${ty * TILE_SIZE - y1}"
             width="${TILE_SIZE}" height="${TILE_SIZE}" class="tile" />`
        );
      }
    }

    const shapes = (this._alerts.active || [])
      .map((alert) => {
        const color = TYPE_COLORS[alert.type] || TYPE_COLORS.alert;
        const stroke =
          alert.type === "alert" || !TYPE_COLORS[alert.type]
            ? ink
            : TYPE_STROKES[alert.type] || color;
        const dim = this._selected && this._selected !== alert.id;
        return (alert.polygons || [])
          .map((poly) => {
            const points = poly
              .map(([lat, lon]) => {
                const [px, py] = project(lat, lon, zoom);
                return `${px - x1},${py - y1}`;
              })
              .join(" ");
            return `<polygon points="${points}" fill="${color}"
              fill-opacity="${dim ? 0.14 : 0.5}" stroke="${stroke}"
              stroke-opacity="${dim ? 0.3 : 0.95}" stroke-width="2"
              vector-effect="non-scaling-stroke" />`;
          })
          .join("");
      })
      .join("");

    const monitored = this._alerts.monitored || {};
    let marker = "";
    if (monitored.latitude != null && monitored.longitude != null) {
      const [mx0, my0] = project(monitored.latitude, monitored.longitude, zoom);
      const mx = mx0 - x1;
      const my = my0 - y1;
      marker = `
        <circle cx="${mx}" cy="${my}" r="9" fill="var(--primary-color, #03a9f4)"
          fill-opacity="0.25" />
        <circle cx="${mx}" cy="${my}" r="4" fill="var(--primary-color, #03a9f4)"
          stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke" />`;
    }

    // Sonar-style reticle on the focused spot: two rings and four ticks with
    // a gap in the middle, so the exact point stays readable underneath.
    let reticle = "";
    if (this._focus && this._focus.centroid) {
      const [cx0, cy0] = project(
        this._focus.centroid[0],
        this._focus.centroid[1],
        zoom
      );
      const cx = cx0 - x1;
      const cy = cy0 - y1;
      // Anchored to the ground, not to the frame: the ring encloses the
      // warned area, so zooming in grows it and zooming out shrinks it, the
      // way everything else on the map behaves. A floor keeps it visible
      // when the whole country is in view and the area is a few streets.
      const area = this._focus.area;
      let r = Math.min(width, height) * 0.16;
      if (area) {
        const [ax, ay] = project(area.max_lat, area.min_lon, zoom);
        const [bx, by] = project(area.min_lat, area.max_lon, zoom);
        r = (Math.hypot(bx - ax, by - ay) / 2) * 1.25;
      }
      // Floor so a few streets stay visible at national zoom; ceiling so
      // zooming to street level does not leave only the middle of the ring
      // on screen.
      const frame = Math.min(width, height);
      r = Math.max(frame * 0.05, Math.min(r, frame * 0.42));
      const tick = r * 0.55;

      // Every stroke is drawn twice: a dark halo first, the light yellow on
      // top. A single colour always loses somewhere — black vanished into
      // the dark basemap, plain yellow washed out against roads and labels.
      const stroke = (markup, colour, extra) =>
        markup.replace(/@C/g, colour).replace(/@W/g, String(extra));
      const shapes = (colour, extra) =>
        stroke(
          `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
             stroke="@C" stroke-width="@W" vector-effect="non-scaling-stroke" />
           <circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="none"
             stroke="@C" stroke-width="@W" vector-effect="non-scaling-stroke" />` +
            [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]
              .map(
                ([dx, dy]) => `<line
                  x1="${cx + dx * r * 0.45}" y1="${cy + dy * r * 0.45}"
                  x2="${cx + dx * (r + tick)}" y2="${cy + dy * (r + tick)}"
                  stroke="@C" stroke-width="@W"
                  vector-effect="non-scaling-stroke" />`
              )
              .join(""),
          colour,
          extra
        );

      reticle = `
        <g class="reticle">
          ${shapes(RETICLE_HALO, 7)}
          ${shapes(RETICLE_LINE, 3)}
          <circle class="ping" cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${RETICLE_LINE}" stroke-width="4"
            vector-effect="non-scaling-stroke" />
          <circle cx="${cx}" cy="${cy}" r="${r * 0.09}" fill="${RETICLE_HALO}" />
          <circle cx="${cx}" cy="${cy}" r="${r * 0.05}" fill="${RETICLE_LINE}" />
        </g>`;
    }

    el.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}"
           preserveAspectRatio="xMidYMid meet" role="img"
           aria-label="Kaart met actieve NL-Alerts">
        ${dark ? DARK_FILTER : ""}
        <g${dark ? ' filter="url(#nl-dark)"' : ""}>${tiles.join("")}</g>
        <g>${shapes}</g>
        <g>${marker}</g>
        ${reticle}
      </svg>`;

    // The punch-in. A true country-to-street fly-over would need tiles for
    // every zoom level along the way; scaling the finished target view in
    // from 2.2x reads as the same "locking on" motion for one tile set.
    if (this._focus && this._focusAnimate) {
      this._focusAnimate = false;
      const svg = el.querySelector("svg");
      svg.classList.add("zooming");
      svg.addEventListener(
        "animationend",
        () => svg.classList.remove("zooming"),
        { once: true }
      );
    }

    // What the current frame shows, so a drag can convert its pixels back
    // into coordinates without re-reading the DOM.
    this._mapView = { zoom, x: x1, y: y1, width, height };
    this._attachPan(el);

    // Listener rather than an inline onerror attribute: a stricter CSP would
    // drop the attribute, and a hard-failing tile would then show as a broken
    // image on top of the alert shapes.
    el.querySelectorAll("image.tile").forEach((tile) =>
      tile.addEventListener("error", () => {
        tile.style.display = "none";
      })
    );

    const zoomIn = this.shadowRoot.getElementById("zoom-in");
    const zoomOut = this.shadowRoot.getElementById("zoom-out");
    if (zoomIn && zoomOut) {
      // Clamped so you cannot zoom past a single street or out into the
      // Atlantic; the map has no panning, so both ends are dead space.
      const span = bounds.max_lat - bounds.min_lat;
      zoomIn.disabled = span / 2 < MIN_SPAN_LAT;
      zoomOut.disabled = span * 2 > MAX_SPAN_LAT;
      zoomIn.onclick = () => this._zoomBy(1);
      zoomOut.onclick = () => this._zoomBy(-1);
    }

    const credit = this.shadowRoot.getElementById("attribution");
    if (credit) credit.textContent = this._attribution || DEFAULT_ATTRIBUTION;

    this._renderFocusBar();
    this._renderAlertList();
  }

  /**
   * Drag the map.
   *
   * The drag only moves a CSS transform; the tiles are rebuilt once, on
   * release. Re-rendering per pointermove was both janky (a fresh tile grid
   * every frame) and broken: replacing the SVG destroyed the element the
   * pointer capture lived on, so the drag died after a single step.
   *
   * Handlers hang off the #map container, which survives a re-render, and
   * the current SVG is looked up when a drag starts.
   */
  _attachPan(el) {
    if (!el || el._panBound) return;
    el._panBound = true;
    let drag = null;

    el.addEventListener("pointerdown", (ev) => {
      const svg = el.querySelector("svg");
      if (!svg || !this._mapView) return;
      ev.preventDefault();
      drag = {
        x: ev.clientX,
        y: ev.clientY,
        svg,
        view: this._mapView,
        box: svg.getBoundingClientRect(),
      };
      el.setPointerCapture(ev.pointerId);
      svg.classList.add("dragging");
    });

    el.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      drag.dx = ev.clientX - drag.x;
      drag.dy = ev.clientY - drag.y;
      drag.svg.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
    });

    const finish = (ev) => {
      if (!drag) return;
      const { view, box, dx = 0, dy = 0, svg } = drag;
      drag = null;
      svg.classList.remove("dragging");
      svg.style.transform = "";
      if (el.hasPointerCapture(ev.pointerId)) {
        el.releasePointerCapture(ev.pointerId);
      }
      if (!dx && !dy) return;

      // One screen pixel is worth `viewBox / rendered size` world pixels.
      const scale = Math.min(box.width / view.width, box.height / view.height);
      const [maxLat, minLon] = unproject(
        view.x - dx / scale,
        view.y - dy / scale,
        view.zoom
      );
      const [minLat, maxLon] = unproject(
        view.x - dx / scale + view.width,
        view.y - dy / scale + view.height,
        view.zoom
      );
      this._viewBounds = {
        min_lat: minLat,
        max_lat: maxLat,
        min_lon: minLon,
        max_lon: maxLon,
      };
      this._renderMap();
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);

    el.addEventListener("dblclick", (ev) => {
      const svg = el.querySelector("svg");
      if (!svg || !this._mapView) return;
      ev.preventDefault();
      const point = this._pointAt(svg, ev.clientX, ev.clientY);
      if (point) this._zoomTo(point, 1);
    });
  }

  /**
   * The coordinates under a screen position.
   *
   * preserveAspectRatio="xMidYMid meet" centres the viewBox inside the box,
   * so the letterbox margins have to come off before the pixel offset means
   * anything — without that correction a double-click lands metres to one
   * side, which is exactly where you did not point.
   */
  _pointAt(svg, clientX, clientY) {
    const view = this._mapView;
    const box = svg.getBoundingClientRect();
    const scale = Math.min(box.width / view.width, box.height / view.height);
    const offsetX = (box.width - view.width * scale) / 2;
    const offsetY = (box.height - view.height * scale) / 2;
    const worldX = view.x + (clientX - box.left - offsetX) / scale;
    const worldY = view.y + (clientY - box.top - offsetY) / scale;
    const [lat, lon] = unproject(worldX, worldY, view.zoom);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  }

  /** Zoom by `step` around a given point rather than the frame's centre. */
  _zoomTo([lat, lon], step) {
    const b = this._activeBounds();
    const factor = Math.pow(2, -step);
    const spanLat = (b.max_lat - b.min_lat) * factor;
    if (spanLat < MIN_SPAN_LAT || spanLat > MAX_SPAN_LAT) return;
    const halfLat = spanLat / 2;
    const halfLon = ((b.max_lon - b.min_lon) * factor) / 2;
    this._viewBounds = {
      min_lat: lat - halfLat,
      max_lat: lat + halfLat,
      min_lon: lon - halfLon,
      max_lon: lon + halfLon,
    };
    this._renderMap();
  }

  _zoomBy(step) {
    const b = this._activeBounds();
    const midLat = (b.min_lat + b.max_lat) / 2;
    const midLon = (b.min_lon + b.max_lon) / 2;
    const factor = Math.pow(2, -step);
    const spanLat = (b.max_lat - b.min_lat) * factor;
    // Clamped on the geographic span rather than a step counter, so the
    // limits hold however you arrived at the current view.
    if (spanLat < MIN_SPAN_LAT || spanLat > MAX_SPAN_LAT) return;
    const halfLat = spanLat / 2;
    const halfLon = ((b.max_lon - b.min_lon) * factor) / 2;
    this._viewBounds = {
      min_lat: midLat - halfLat,
      max_lat: midLat + halfLat,
      min_lon: midLon - halfLon,
      max_lon: midLon + halfLon,
    };
    this._renderMap();
  }

  _renderFocusBar() {
    const el = this.shadowRoot.getElementById("focus-bar");
    if (!el) return;
    if (!this._focus) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <div class="focus-bar">
        <span class="grow">${escapeHtml(this._focus.label.slice(0, 140))}</span>
        <button class="ghost" id="focus-clear">Terug naar Nederland</button>
      </div>`;
    el.querySelector("#focus-clear").addEventListener("click", () =>
      this._clearFocus()
    );
  }

  _renderAlertList() {
    const el = this.shadowRoot.getElementById("alert-list");
    if (!el) return;
    const alerts = this._alerts.active || [];
    if (!alerts.length) {
      // "Geen alerts" is only reassuring if you know how fresh it is — an
      // empty list from an hour ago says nothing about right now.
      const checked = formatTime(this._alerts.fetched_at, this._locale());
      el.innerHTML = `<p class="muted">Geen actieve NL-Alerts in Nederland.${
        checked ? `<br>Gecontroleerd op ${escapeHtml(checked)}.` : ""
      }</p>`;
      return;
    }
    el.innerHTML = alerts
      .map((alert) => {
        const color = TYPE_COLORS[alert.type] || TYPE_COLORS.alert;
        const dutch = (alert.message || "").split("***")[0].trim();
        return `
          <div class="alert-item${
            this._selected === alert.id ? " selected" : ""
          }" data-id="${escapeHtml(alert.id)}">
            <div class="bar" style="background:${color}"></div>
            <div>
              <div class="msg">${escapeHtml(dutch)}</div>
              <div class="meta">${escapeHtml(
                formatTime(alert.start_at, this._locale())
              )}${
                alert.stop_at
                  ? ` – ${escapeHtml(formatTime(alert.stop_at, this._locale()))}`
                  : ""
              }${
                alert.distance_km != null && alert.distance_km > 0
                  ? ` · ${escapeHtml(formatKm(alert.distance_km))}`
                  : ""
              }${
                alert.is_local
                  ? '<span class="badge">jouw gebied</span>'
                  : ""
              }</div>
            </div>
          </div>`;
      })
      .join("");

    el.querySelectorAll(".alert-item").forEach((node) =>
      node.addEventListener("click", () => {
        const id = node.dataset.id;
        this._selected = this._selected === id ? null : id;
        this._viewBounds = null;
        this._renderMap();
      })
    );
  }

  /* ── Settings ──────────────────────────────────────────────────────────── */

  _locale() {
    return (this._hass && this._hass.language) || "nl";
  }

  _fieldError(field) {
    return this._validation.some(
      (p) => p.field === field && p.status === "error"
    );
  }


  /**
   * The settings sections, in rail order.
   *
   * `fields` is what makes a rail item flag itself when validation fails.
   * The old accordions solved that by springing open; with one pane visible
   * at a time an error could otherwise sit unseen behind another section.
   */
  _sections() {
    return [
      {
        id: "locatie",
        label: "Locatie",
        title: "Locatie &amp; ophalen",
        lead: "Waar je woont, en hoe vaak er bij NL-Alert gekeken wordt.",
        fields: ["latitude", "longitude", "scan_interval_minutes"],
        rows: (o) => {
    const useHome = o.use_home_location !== false;
          return `
        <div class="row">
          <label class="title" for="use_home">Thuislocatie van Home Assistant gebruiken</label>
          <div class="control"><input type="checkbox" id="use_home" ${
            useHome ? "checked" : ""
          }></div>
        </div>
        <div class="row">
          <label class="title" for="latitude">Breedtegraad</label>
          <div class="control"><input type="text" id="latitude" value="${escapeHtml(
            o.latitude ?? ""
          )}" ${useHome ? "disabled" : ""}></div>
        </div>
        <div class="row">
          <label class="title" for="longitude">Lengtegraad</label>
          <div class="control"><input type="text" id="longitude" value="${escapeHtml(
            o.longitude ?? ""
          )}" ${useHome ? "disabled" : ""}></div>
        </div>
        <div class="row">
          <label class="title" for="scan_interval">Ophaalinterval</label>
          <div class="control">
            <select id="scan_interval">
              ${(this._pollingChoices || [])
                .map(
                  (n) =>
                    `<option value="${escapeHtml(n)}" ${
                      String(o.scan_interval_minutes || 5) === String(n)
                        ? "selected"
                        : ""
                    }>${escapeHtml(n)} min</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="hint muted">Alerts komen binnen zodra ze in de API staan.</div>
        </div>
        <div class="row">
          <label class="title" for="alert_radius">Straal rondom je locatie</label>
          <div class="control">
            <input type="number" id="alert_radius" min="0" max="50" step="1"
              value="${escapeHtml(o.alert_radius_km ?? 0)}"> <span>km</span>
          </div>
          <div class="hint muted">Een alert telt als "jouw gebied" zodra de
            rand van het gewaarschuwde gebied binnen deze straal ligt.
            0 = alleen als je adres écht in het gebied valt.</div>
        </div>`;
        },
      },
      {
        id: "alarm",
        label: "Alarm",
        title: "Alarm",
        lead: "Wat er in huis afgaat zodra een NL-Alert jouw gebied raakt.",
        fields: ["media_players", "alarm_sound_url"],
        rows: (o) => {
    const soundOptions = this._soundOptions(o.alarm_sound_url);
          return `
        <div class="row">
          <label class="title">Speakers</label>
          <div class="control">
            <nl-multiselect id="players" data-label="Speakers"
              data-placeholder="— kies je speakers —"
              data-invalid="${this._fieldError("media_players") ? "true" : "false"}"
            ></nl-multiselect>
          </div>
        </div>
        <div class="row">
          <label class="title" for="alarm_sound">Alarmgeluid</label>
          <div class="control">
            <select id="alarm_sound" class="${
              this._fieldError("alarm_sound_url") ? "invalid" : ""
            }">
              <option value="">— geen —</option>
              ${soundOptions}
            </select>
            <button class="ghost" id="preview">▶</button>
          </div>
          <div class="hint muted">NL-Alert levert eigen geluiden mee; onder
            "Eigen bestanden" staat alles uit <code>/config/www</code>.
            ▶ speelt het geluid af in deze browser, niet op de speakers.</div>
        </div>
        <div class="row">
          <label class="title">Sirene<button type="button" class="help-btn"
            id="siren-help" aria-label="Uitleg over sirenes">?</button></label>
          <div class="control">
            <nl-multiselect id="sirens" data-label="Sirenes en schakelaars"
              data-placeholder="— geen sirene —"></nl-multiselect>
          </div>
          <div class="hint muted">Gaat tegelijk met het alarmgeluid af, en
            ook als je helemaal geen speakers hebt ingesteld. Nachtmodus
            verzacht het volume van de speakers, maar niet de sirene — die
            heeft geen volume om te verzachten.</div>
        </div>
        <div class="row">
          <label class="title" for="siren_follow">Sirene even lang als het alarmgeluid</label>
          <div class="control"><input type="checkbox" id="siren_follow" ${
            o.siren_follow_sound !== false ? "checked" : ""
          }></div>
          <div class="hint muted">De lengte wordt uit het geluidsbestand
            gelezen — precies bij wav, geschat bij mp3. Lukt dat niet, dan
            geldt de vaste tijd hieronder.</div>
        </div>
        <div class="row">
          <label class="title" for="siren_duration">Sirene blijft aan</label>
          <div class="control">
            <input type="number" id="siren_duration" min="0" max="600"
              value="${escapeHtml(o.siren_duration ?? 15)}" ${
                o.siren_follow_sound !== false ? "disabled" : ""
              }> <span>sec</span>
          </div>
          <div class="hint muted">0 = blijft aan tot je hem zelf uitzet. Zet
            je hem langer dan de wachttijd hieronder, dan loopt de sirene door
            de gesproken melding heen.</div>
        </div>
        <div class="row">
          <label class="title" for="volume">Volume (${escapeHtml(
            o.volume_pct ?? 70
          )}%)</label>
          <div class="control">
            <input type="range" id="volume" min="0" max="100" step="5"
              value="${escapeHtml(o.volume_pct ?? 70)}">
          </div>
        </div>
        <div class="row">
          <label class="title" for="alarm_duration">Wachttijd tussen alarm en spraak</label>
          <div class="control">
            <input type="number" id="alarm_duration" min="0" max="60"
              value="${escapeHtml(o.alarm_duration_seconds ?? 5)}"> <span>sec</span>
          </div>
        </div>`;
        },
      },
      {
        id: "spraak",
        label: "Spraak",
        title: "Spraak",
        lead: "Hoe de tekst wordt voorgelezen, en in welke talen.",
        fields: ["tts_service", "tts_entity", "translate_agent"],
        rows: (o) => {
          return `
        <div class="row">
          <label class="title" for="tts_service">Manier van uitspreken</label>
          <div class="control">
            <select id="tts_service" class="${
              this._fieldError("tts_service") ? "invalid" : ""
            }">
              <option value="">— geen spraak —</option>
              ${this._lists.tts.services
                .map(
                  (s) =>
                    `<option value="${escapeHtml(s.service)}" ${
                      o.tts_service === s.service ? "selected" : ""
                    }>${escapeHtml(s.name)} (${escapeHtml(s.service)})</option>`
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="row">
          <label class="title" for="tts_entity">Stem</label>
          <div class="control">
            <select id="tts_entity" class="${
              this._fieldError("tts_entity") ? "invalid" : ""
            }">
              <option value="">— kies een engine —</option>
              ${this._lists.tts.engines
                .map(
                  (e) =>
                    `<option value="${escapeHtml(e.entity_id)}" ${
                      o.tts_entity === e.entity_id ? "selected" : ""
                    }>${escapeHtml(e.name)}</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="hint muted">Verplicht: zowel <code>tts.speak</code> als
            <code>chime_tts.say</code> hebben een engine nodig, anders blijft
            het stil.</div>
        </div>
        <div class="row">
          <label class="title" for="preamble_enabled">Aankondiging vooraf</label>
          <div class="control"><input type="checkbox" id="preamble_enabled" ${
            o.preamble_enabled === false ? "" : "checked"
          }></div>
        </div>
        <div class="row">
          <label class="title" for="preamble_text">Tekst vooraf</label>
          <div class="control">
            <input type="text" id="preamble_text" value="${escapeHtml(
              o.preamble_text ?? "Attentie... Attentie... Dit is een NL-Alert."
            )}">
          </div>
          <div class="hint muted">Wordt vóór de alerttekst uitgesproken. De
            puntjes lezen als pauzes.</div>
        </div>
        <div class="row">
          <label class="title" for="speak_english">Ook de Engelse tekst uitspreken</label>
          <div class="control"><input type="checkbox" id="speak_english" ${
            o.speak_english === false ? "" : "checked"
          }></div>
          <div class="hint muted">Een NL-Alert is Nederlands, daarna Engels na
            <code>***</code>. Beide worden uitgesproken, in die volgorde.</div>
        </div>
        <div class="row">
          <label class="title" for="announce_language">Taal aankondigen per deel</label>
          <div class="control"><input type="checkbox" id="announce_language" ${
            o.announce_language === false ? "" : "checked"
          }></div>
          <div class="hint muted">Zegt "Nederlands." en "English." vóór het
            bijbehorende deel.</div>
        </div>
        <div class="row">
          <label class="title" for="translate_missing">Engels vertalen als het ontbreekt</label>
          <div class="control"><input type="checkbox" id="translate_missing" ${
            o.translate_missing_english === false ? "" : "checked"
          }></div>
        </div>
        <div class="row">
          <label class="title" for="translate_agent">Vertaler</label>
          <div class="control">
            <select id="translate_agent" class="${
              this._fieldError("translate_agent") ? "invalid" : ""
            }">
              <option value="">— eerste beschikbare —</option>
              ${(this._lists.tts.translators || [])
                .map(
                  (t) =>
                    `<option value="${escapeHtml(t.entity_id)}" ${
                      o.translate_agent === t.entity_id ? "selected" : ""
                    }>${escapeHtml(t.name)}</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="hint muted">Een AI Task-entiteit (Instellingen → Spraak).
            Zonder vertaler blijft zo'n alert alleen Nederlands.</div>
        </div>`;
        },
      },
      {
        id: "nacht",
        label: "Nachtmodus",
        title: "Nachtmodus",
        lead: "Zachter binnen een tijdvenster, zodat je er ’s nachts niet tegen het plafond van zit.",
        fields: ["night_alarm_sound_url"],
        rows: (o) => {
          return `
        <div class="row">
          <label class="title" for="night_enabled">Zachter tussen deze tijden</label>
          <div class="control"><input type="checkbox" id="night_enabled" ${
            o.night_enabled === false ? "" : "checked"
          }></div>
          <div class="hint muted">Een alert midden in de nacht moet je wakker
            maken, niet laten schrikken. Zet hem niet te zacht.</div>
        </div>
        <div class="row">
          <label class="title" for="night_start">Van</label>
          <div class="control">
            <input type="time" id="night_start" value="${escapeHtml(
              o.night_start || "22:30"
            )}">
            <label for="night_end">tot</label>
            <input type="time" id="night_end" value="${escapeHtml(
              o.night_end || "07:00"
            )}">
          </div>
        </div>
        <div class="row">
          <label class="title" for="night_volume">Nachtvolume (${escapeHtml(
            o.night_volume_pct ?? 40
          )}%)</label>
          <div class="control">
            <input type="range" id="night_volume" min="0" max="100" step="5"
              value="${escapeHtml(o.night_volume_pct ?? 40)}">
          </div>
        </div>
        <div class="row">
          <label class="title" for="night_sound">Ander alarmgeluid 's nachts</label>
          <div class="control">
            <select id="night_sound" class="${
              this._fieldError("night_alarm_sound_url") ? "invalid" : ""
            }">
              <option value="">— zelfde als overdag —</option>
              ${this._soundOptions(o.night_alarm_sound_url)}
            </select>
          </div>
        </div>`;
        },
      },
      {
        id: "notificaties",
        label: "Notificaties",
        title: "Notificaties",
        lead: "Wat er naar je telefoon gaat, en hoe hard dat aankomt.",
        fields: ["notify_services"],
        rows: (o) => {
          return `
        <div class="row">
          <label class="title" for="notify_critical">Kritieke melding</label>
          <div class="control"><input type="checkbox" id="notify_critical" ${
            o.notify_critical === false ? "" : "checked"
          }></div>
          <div class="hint muted">Vraagt de companion-app om door stil/DND
            heen te komen (iOS: critical alert, Android: alarm-stream). Op iOS
            werkt dat alleen als de app Apple's critical-alert-recht heeft.</div>
        </div>
        <div class="row">
          <label class="title">Notify-services</label>
          <div class="control">
            <nl-multiselect id="notify" data-label="Notify-services"
              data-placeholder="— geen notificaties —"
              data-invalid="${this._fieldError("notify_services") ? "true" : "false"}"
            ></nl-multiselect>
          </div>
        </div>
        <div class="row">
          <label class="title">Uitspreken i.p.v. toon</label>
          <div class="control">
            <nl-multiselect id="notify-tts" data-label="Toestellen die voorlezen"
              data-placeholder="— geen —"></nl-multiselect>
          </div>
          <div class="hint muted">Voor toestellen die de alarm-stream
            negeren — veel Samsung-telefoons doen dat. De app spreekt het
            bericht dan uit via de alarm-stream. Per toestel, want het
            verandert wát de ontvanger hoort.</div>
        </div>`;
        },
      },
      {
        id: "tv",
        label: "TV",
        title: "Naar de TV",
        lead: "Het gewaarschuwde gebied op het scherm zetten.",
        fields: ["cast_entities", "cast_entity"],
        rows: (o) => {
          return `
        <div class="row">
          <label class="title" for="cast_enabled">Bij een alert in jouw gebied casten</label>
          <div class="control"><input type="checkbox" id="cast_enabled" ${
            o.cast_enabled ? "checked" : ""
          }></div>
          <div class="hint muted">HA Cast toont een Lovelace-view, niet dit
            paneel. Zet de kaart <code>custom:nl-alert-card</code> op die view.
            Vereist dat je instantie via HTTPS bereikbaar is.</div>
        </div>
        <div class="row">
          <label class="title">TV's</label>
          <div class="control">
            <nl-multiselect id="cast-targets" data-label="TV's"
              data-placeholder="— kies een TV —"
              data-invalid="${this._fieldError("cast_entities") ? "true" : "false"}"
            ></nl-multiselect>
          </div>
          <div class="hint muted">Alleen apparaten van de cast-integratie —
            HA Cast werkt niet met andere media players.</div>
        </div>
        <div class="row">
          <label class="title" for="cast_dashboard">Dashboard-pad</label>
          <div class="control">
            <input type="text" id="cast_dashboard" placeholder="bijv. dashboard-tv"
              value="${escapeHtml(o.cast_dashboard_path || "")}">
          </div>
          <div class="hint muted">Leeg = het standaarddashboard.</div>
        </div>
        <div class="row">
          <label class="title" for="cast_view">View-pad</label>
          <div class="control">
            <input type="text" id="cast_view" placeholder="bijv. alert"
              value="${escapeHtml(o.cast_view_path || "")}">
          </div>
        </div>
        <div class="row">
          <label class="title">Nog geen view?</label>
          <div class="control">
            <button class="ghost" id="make-dashboard">Dashboard aanmaken</button>
          </div>
          <div class="hint muted">Maakt het dashboard <code>nl-alert-tv</code>
            met een view <code>alert</code> waarop de NL-Alert kaart staat, en
            vult de velden hierboven in. Bestaat het al, dan wordt er niets
            overschreven.</div>
        </div>
        <div class="row">
          <label class="title" for="cast_turn_on">TV aanzetten voor het casten</label>
          <div class="control"><input type="checkbox" id="cast_turn_on" ${
            o.cast_turn_on === false ? "" : "checked"
          }></div>
          <div class="hint muted">Een TV die helemaal uit staat wordt niet
            wakker van een cast-commando; hij wordt eerst aangezet en er wordt
            tot 15 seconden gewacht.</div>
        </div>
        <div class="row">
          <label class="title">Aanzetten via</label>
          <div class="control">
            <nl-multiselect id="cast-power" data-label="Entiteiten die de TV aanzetten"
              data-placeholder="— geen —"></nl-multiselect>
          </div>
          <div class="hint muted">Lukt het aanzetten via de cast-entiteit niet,
            kies dan hier de bijbehorende remote — bij een Android TV is dat
            meestal <code>remote.*</code> of de androidtv_remote media player.</div>
        </div>
        <div class="row">
          <label class="title" for="cast_at_night">Ook 's nachts naar de TV</label>
          <div class="control"><input type="checkbox" id="cast_at_night" ${
            o.cast_at_night ? "checked" : ""
          }></div>
          <div class="hint muted">Uit: binnen het nachtvenster blijft het bij
            geluid en notificatie.</div>
        </div>
        <div class="row">
          <label class="title">Uitproberen</label>
          <div class="control">
            <button id="cast-test">Nu naar de TV sturen</button>
          </div>
          <div class="hint results" id="cast-result">${this._renderResults(
            "cast"
          )}</div>
        </div>`;
        },
      },
      {
        id: "luchtalarm",
        label: "Luchtalarmtest",
        title: "Maandelijkse test (luchtalarm)",
        lead:
          "De sirenetest op de eerste maandag van de maand, om 12:00. " +
          "Een gekoppelde sirene gaat hier altijd in mee.",
        fields: [],
        rows: (o) => {
          return `
        <div class="row">
          <label class="title" for="siren_test_enabled">Eerste maandag 12:00 laten klinken</label>
          <div class="control"><input type="checkbox" id="siren_test_enabled" ${
            o.siren_test_enabled ? "checked" : ""
          }></div>
          <div class="hint muted">Zoals het echte luchtalarm: eerste maandag
            van de maand om 12:00:00, en overgeslagen op feestdagen.</div>
        </div>
        <div class="row">
          <label class="title" for="siren_test_lead">Waarschuwing vooraf</label>
          <div class="control">
            <input type="number" id="siren_test_lead" min="0" max="300"
              value="${escapeHtml(o.siren_test_lead ?? 30)}"> <span>sec</span>
          </div>
          <div class="hint muted">Notificatie zoveel seconden vóór het geluid.
            0 = geen waarschuwing.</div>
        </div>
        <div class="row">
          <label class="title">Feestdagen</label>
          <div class="control">
            <span class="${this._holidayEntity ? "" : "warn"}">${
              this._holidayEntity
                ? escapeHtml(this._holidayEntity)
                : "geen feestdagenkalender gevonden"
            }</span>
          </div>
          <div class="hint muted">${
            this._holidayEntity
              ? "Op deze dagen blijft het stil."
              : "Vereist: voeg de <b>Holiday</b>-integratie toe (Instellingen → Apparaten &amp; diensten → Integratie toevoegen → Holiday, land Nederland). Zonder kalender wordt de test elke maand overgeslagen."
          }</div>
        </div>
        <div class="row">
          <label class="title">Eerstvolgende</label>
          <div class="control"><span>${escapeHtml(
            formatTime(this._nextSirenTest, this._locale()) || "—"
          )}</span></div>
        </div>`;
        },
      },
      {
        id: "weergave",
        label: "Weergave",
        title: "Weergave",
        lead: "Het paneel in de zijbalk en het kaartmateriaal.",
        fields: [],
        rows: (o) => {
          return `
        <div class="row">
          <label class="title" for="show_in_sidebar">NL-Alert in de zijbalk tonen</label>
          <div class="control"><input type="checkbox" id="show_in_sidebar" ${
            o.show_in_sidebar === false ? "" : "checked"
          }></div>
          <div class="hint muted">Uit? Het paneel blijft bereikbaar via
            <code>/nl-alert</code>.</div>
        </div>
        <div class="row">
          <label class="title" for="tile_preset">Kaartlaag</label>
          <div class="control">
            <select id="tile_preset">
              ${TILE_PRESETS.map(
                (preset) =>
                  `<option value="${preset.id}" ${
                    (o.map_tile_url || DEFAULT_TILE_URL) === preset.url
                      ? "selected"
                      : ""
                  }>${escapeHtml(preset.label)}</option>`
              ).join("")}
              <option value="custom" ${
                TILE_PRESETS.some(
                  (p) => p.url === (o.map_tile_url || DEFAULT_TILE_URL)
                )
                  ? ""
                  : "selected"
              }>Eigen tegel-URL…</option>
            </select>
          </div>
          <div class="hint muted">OpenStreetMap draait op door de gemeenschap
            gefinancierde servers. Hun beleid staat toe wat dit paneel doet —
            de tegels van het beeld dat je nu bekijkt — maar niet vooruit
            inladen of gebieden opslaan; dat doet deze integratie ook niet.</div>
        </div>
        <div class="row">
          <label class="title" for="tile_url">Tegel-URL</label>
          <div class="control">
            <input type="text" id="tile_url" spellcheck="false"
              placeholder="${escapeHtml(DEFAULT_TILE_URL)}"
              value="${escapeHtml(o.map_tile_url || "")}">
          </div>
          <div class="hint muted">Leeg = de standaardkaart. Gebruik
            <code>{z}</code>, <code>{x}</code> en <code>{y}</code> als
            plaatshouders. CARTO zet zonder sleutel "API KEY REQUIRED" in
            elke tegel; heb je bij een aanbieder een sleutel, plak dan hier
            hun template.</div>
        </div>
        <div class="row">
          <label class="title" for="tile_attribution">Bronvermelding</label>
          <div class="control">
            <input type="text" id="tile_attribution"
              placeholder="${escapeHtml(DEFAULT_ATTRIBUTION)}"
              value="${escapeHtml(o.map_attribution || "")}">
          </div>
          <div class="hint muted">Verschijnt rechtsonder op de kaart. Vrijwel
            elke aanbieder verplicht dit.</div>
        </div>`;
        },
      },
      {
        id: "testen",
        label: "Testen",
        title: "Testen",
        lead:
          "Draait tegen de instellingen zoals ze nu op het scherm staan \u2014 " +
          "je hoeft niet eerst op te slaan.",
        fields: [],
        rows: () => `<div class="tests" id="tests"></div>`,
      },
      {
        id: "over",
        label: "Over NL-Alert",
        title: "Over NL-Alert",
        lead: "",
        fields: [],
        rows: (o) => `
        ${WELCOME.warnings
          .map(
            (item) => `<div class="row"><div class="hint">
              <div class="warn-block"><strong>${escapeHtml(item.head)}</strong>
              ${escapeHtml(item.body)}</div>
            </div></div>`
          )
          .join("")}
        <div class="row">
          <label class="title">Bronnen</label>
          <div class="control"><ul class="sources">
            ${WELCOME.sources
              .map(
                (src) => `<li>
                  <span class="src-label">${escapeHtml(src.label)}</span>
                  <a href="${escapeHtml(src.href)}" target="_blank"
                     rel="noopener noreferrer">${escapeHtml(src.value)}</a>
                </li>`
              )
              .join("")}
          </ul></div>
        </div>
        <div class="row">
          <label class="title">Versie</label>
          <div class="control"><span>${escapeHtml(this._version || "—")}</span></div>
        </div>
        <div class="row">
          <label class="title">Welkomstscherm</label>
          <div class="control">
            <button class="ghost" id="show-welcome">Opnieuw tonen</button>
          </div>
        </div>`,
      },
    ];
  }

  _sectionHasError(section) {
    return (section.fields || []).some((field) => this._fieldError(field));
  }

  _renderSettings() {
    const el = this.shadowRoot.getElementById("settings");
    if (!el) return;
    const o = this._options;
    const sections = this._sections();

    // A section carrying a failed field wins the opening pane, so a
    // validation error is never hidden behind another one.
    if (!this._section || !sections.some((s) => s.id === this._section)) {
      const broken = sections.find((s) => this._sectionHasError(s));
      this._section = (broken || sections[0]).id;
    }
    const active = sections.find((s) => s.id === this._section) || sections[0];

    el.innerHTML = `
      <div class="split">
        <nav class="rail" aria-label="Onderdelen">
          ${sections
            .map(
              (s) => `
            <button type="button" data-sec="${s.id}"
              class="${s.id === active.id ? "on" : ""}"
              aria-current="${s.id === active.id ? "page" : "false"}">
              <span class="rail-label">${escapeHtml(s.label)}</span>
              ${
                this._sectionHasError(s)
                  ? `<span class="rail-bad" aria-label="bevat een fout">!</span>`
                  : ""
              }
            </button>`
            )
            .join("")}
        </nav>
        <section class="pane" aria-label="${escapeHtml(active.title)}"
                 tabindex="-1">
          <h3>${active.title}</h3>
          ${active.lead ? `<p class="lead">${escapeHtml(active.lead)}</p>` : ""}
          ${active.rows(o)}
        </section>
      </div>`;

    this._applyHints(el.querySelector(".pane"));
    el.querySelectorAll(".rail button").forEach((node) =>
      node.addEventListener("click", () => this._showSection(node.dataset.sec))
    );
  }

  /**
   * Turns the explanation under every row into a "?" beside its label.
   *
   * Done as a pass over the rendered DOM rather than in the templates: there
   * are 28 of these, and the markup stays readable with the sentence sitting
   * next to the field it explains.
   *
   * A row that already carries its own "?" (the siren, which opens a longer
   * piece with a link) keeps that one and loses the inline sentence — two
   * question marks on one row explain nothing.
   */
  _applyHints(pane) {
    this._tips = new Map();
    this._tipPinned = null;
    this._openTip = null;
    let n = 0;
    pane.querySelectorAll(".row").forEach((row) => {
      const hint = row.querySelector(":scope > .hint");
      if (!hint) return;
      const existing = row.querySelector(".help-btn");
      if (existing) {
        hint.remove();
        return;
      }
      const id = `tip${++n}`;
      this._tips.set(id, hint.innerHTML);
      hint.remove();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "help-btn";
      button.dataset.tip = id;
      button.textContent = "?";
      button.setAttribute("aria-label", "Uitleg");
      const label = row.querySelector(".title") || row.firstElementChild;
      (label || row).appendChild(button);
    });

    const tip = document.createElement("div");
    tip.className = "tip";
    tip.id = "tip-bubble";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    pane.appendChild(tip);

    pane.querySelectorAll(".help-btn[data-tip]").forEach((button) => {
      // Hover and focus show it; a click pins it open. The two are tracked
      // apart on purpose — when they shared one flag, hovering opened the
      // bubble and the click that followed read as "close it again", so a
      // tap never showed anything at all.
      button.addEventListener("pointerenter", () => this._showTip(button));
      button.addEventListener("focus", () => this._showTip(button));
      button.addEventListener("pointerleave", () => this._hideTip(button));
      button.addEventListener("blur", () => this._hideTip(button));
      button.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (this._tipPinned === button) {
          this._tipPinned = null;
          this._hideTip(button, true);
        } else {
          this._tipPinned = button;
          this._showTip(button);
        }
      });
    });
    // Dismissible, and it stays put while the pointer is on it — the two
    // things WCAG 1.4.13 asks of content shown on hover.
    tip.addEventListener("pointerenter", () => clearTimeout(this._tipTimer));
    tip.addEventListener("pointerleave", () => this._hideTip());
    pane.addEventListener("scroll", () => this._hideTip(null, true), {
      passive: true,
    });
  }

  _showTip(button) {
    const pane = this.shadowRoot.querySelector(".pane");
    const tip = this.shadowRoot.getElementById("tip-bubble");
    if (!pane || !tip) return;
    clearTimeout(this._tipTimer);
    tip.innerHTML = this._tips.get(button.dataset.tip) || "";
    tip.hidden = false;
    this._openTip = button;
    button.setAttribute("aria-describedby", "tip-bubble");

    const b = button.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    // Width comes from CSS, not from a measurement here: reading
    // clientWidth mid-layout once produced a 16px bubble, one word per line.
    const width = tip.offsetWidth;

    let left = b.left - p.left + pane.scrollLeft - 8;
    left = Math.max(8, Math.min(left, pane.clientWidth - width - 8));
    tip.style.left = `${left}px`;

    // Placed below by default, above when there is not enough room —
    // the pane is the scroll container, so anything past its bottom edge
    // would simply be cut off.
    const below = b.bottom - p.top + pane.scrollTop + 6;
    const above = b.top - p.top + pane.scrollTop - tip.offsetHeight - 6;
    // Below by default; above only when it fits there, since the pane is the
    // scroll container and anything past its edge is simply cut off.
    const overflows =
      below + tip.offsetHeight > pane.scrollTop + pane.clientHeight - 8;
    tip.style.top = `${overflows && above >= pane.scrollTop ? above : below}px`;
  }

  _hideTip(button, force = false) {
    const tip = this.shadowRoot.getElementById("tip-bubble");
    if (!tip) return;
    if (!force && this._tipPinned) return;
    if (force) this._tipPinned = null;
    // A short grace period so the pointer can travel from the "?" onto the
    // bubble without it vanishing on the way.
    clearTimeout(this._tipTimer);
    this._tipTimer = setTimeout(() => {
      tip.hidden = true;
      if (this._openTip) this._openTip.removeAttribute("aria-describedby");
      this._openTip = null;
    }, 120);
    if (button) button.removeAttribute("aria-describedby");
  }

  _showSection(id) {
    this._section = id;
    this._renderSettings();
    this._wireSettings();
    this._wirePickers();
    if (id === "testen") this._renderTests();
    // Focus moves to the pane, not the first field: a screen reader should
    // hear which section it landed in before it hears a label.
    const pane = this.shadowRoot.querySelector(".pane");
    if (pane) {
      // preventScroll: a plain focus() scrolls the nearest scrollable
      // ancestor even when its overflow is hidden, which on a phone pushed
      // the rail clean off the top of the dialog.
      pane.focus({ preventScroll: true });
      pane.scrollTop = 0;
    }
  }


  /**
   * <optgroup>s for the alarm-sound picker: NL-Alert's own sounds first, the
   * user's /config/www files second, and — if the stored value matches
   * neither — a third group holding it so a stale path stays visible instead
   * of silently resetting to "geen".
   */
  _soundOptions(current) {
    const audio = this._lists.audio || {};
    const builtin = audio.builtin || [];
    const local = audio.local || [];
    const option = (value, label) =>
      `<option value="${escapeHtml(value)}" ${
        current === value ? "selected" : ""
      }>${escapeHtml(label)}</option>`;

    const groups = [];
    if (builtin.length) {
      groups.push(
        `<optgroup label="NL-Alert geluiden">${builtin
          .map((s) => option(s.url, s.name))
          .join("")}</optgroup>`
      );
    }
    if (local.length) {
      groups.push(
        `<optgroup label="Eigen bestanden">${local
          .map((f) => option(f, f.replace("/local/", "")))
          .join("")}</optgroup>`
      );
    }
    const known =
      !current ||
      builtin.some((s) => s.url === current) ||
      local.includes(current);
    if (!known) {
      groups.unshift(
        `<optgroup label="Huidige instelling (niet gevonden)">${option(
          current,
          current
        )}</optgroup>`
      );
    }
    return groups.join("");
  }

  /**
   * Every multi-select on the settings form, in one table: what goes in it,
   * what is currently ticked, and where a change lands. Keeping it here
   * rather than beside each control means the six of them cannot drift apart.
   */
  _pickers() {
    const o = this._options;
    const ent = (list) =>
      (list || []).map((x) => ({
        value: x.entity_id,
        label: x.name,
        sub: x.entity_id,
      }));
    const svc = (list) =>
      (list || []).map((x) => ({ value: x.service, label: x.name, sub: x.service }));

    return [
      {
        id: "players",
        options: ent(this._lists.players),
        value: o.media_players || [],
        apply: (v) => (this._options.media_players = v),
      },
      {
        id: "sirens",
        source: "nl_alert/list_sirens",
        options: (this._lists.sirens || []).map((x) => ({
          value: x.entity_id,
          label: x.name,
          sub: x.entity_id,
          group: x.domain === "siren" ? "Sirenes" : "Schakelaars",
        })),
        value: o.siren_entities || [],
        apply: (v) => (this._options.siren_entities = v),
      },
      {
        id: "notify",
        options: svc(this._lists.notify),
        value: o.notify_services || [],
        apply: (v) => (this._options.notify_services = v),
      },
      {
        id: "notify-tts",
        options: svc(this._lists.notify),
        value: o.notify_tts_targets || [],
        apply: (v) => (this._options.notify_tts_targets = v),
      },
      {
        id: "cast-targets",
        options: ent((this._lists.players || []).filter((x) => x.platform === "cast")),
        // cast_entity is the pre-0.12 single-TV setting; still honoured so an
        // upgrade does not silently forget which TV was chosen.
        value:
          o.cast_entities && o.cast_entities.length
            ? o.cast_entities
            : o.cast_entity
              ? [o.cast_entity]
              : [],
        apply: (v) => (this._options.cast_entities = v),
      },
      {
        id: "cast-power",
        options: ent(this._lists.power),
        value: o.cast_power_entities || [],
        apply: (v) => (this._options.cast_power_entities = v),
      },
    ];
  }

  _wirePickers() {
    for (const picker of this._pickers()) {
      const node = this.shadowRoot.getElementById(picker.id);
      if (!node) continue;
      node.dataset.empty =
        picker.source && this._listErrors.has(picker.source)
          ? "De lijst kon niet worden opgehaald. Dit onderdeel is nieuwer " +
            "dan de draaiende integratie — herstart Home Assistant."
          : "Niets gevonden.";
      const known = new Set(picker.options.map((x) => x.value));
      // A stored entity that has since disappeared still gets a row, ticked,
      // so it can be seen and switched off instead of vanishing silently.
      const stale = picker.value
        .filter((v) => !known.has(v))
        .map((v) => ({ value: v, label: v, sub: "bestaat niet meer" }));
      node.options = [...stale, ...picker.options];
      node.value = picker.value;
      node.addEventListener("change", (ev) => picker.apply(ev.detail.value));
    }
  }

  _wireSettings() {
    const root = this.shadowRoot;
    const on = (id, event, handler) => {
      const node = root.getElementById(id);
      if (node) node.addEventListener(event, handler);
    };

    on("use_home", "change", (ev) => {
      this._options.use_home_location = ev.target.checked;
      this._renderSettings();
    });
    on("latitude", "change", (ev) => {
      this._options.latitude = parseFloat(ev.target.value);
    });
    on("longitude", "change", (ev) => {
      this._options.longitude = parseFloat(ev.target.value);
    });
    on("alert_radius", "change", (ev) => {
      this._options.alert_radius_km = parseInt(ev.target.value, 10) || 0;
    });
    on("scan_interval", "change", (ev) => {
      this._options.scan_interval_minutes = parseInt(ev.target.value, 10);
    });
    on("alarm_sound", "change", (ev) => {
      this._options.alarm_sound_url = ev.target.value;
    });
    on("volume", "input", (ev) => {
      this._options.volume_pct = parseInt(ev.target.value, 10);
      const label = root.querySelector('label[for="volume"]');
      if (label) label.textContent = `Volume (${ev.target.value}%)`;
    });
    on("alarm_duration", "change", (ev) => {
      this._options.alarm_duration_seconds = parseInt(ev.target.value, 10) || 0;
    });
    on("tts_service", "change", (ev) => {
      this._options.tts_service = ev.target.value;
    });
    on("tts_entity", "change", (ev) => {
      this._options.tts_entity = ev.target.value;
    });
    on("night_enabled", "change", (ev) => {
      this._options.night_enabled = ev.target.checked;
    });
    on("night_start", "change", (ev) => {
      this._options.night_start = ev.target.value;
    });
    on("night_end", "change", (ev) => {
      this._options.night_end = ev.target.value;
    });
    on("night_volume", "input", (ev) => {
      this._options.night_volume_pct = parseInt(ev.target.value, 10);
      const label = root.querySelector('label[for="night_volume"]');
      if (label) label.textContent = `Nachtvolume (${ev.target.value}%)`;
    });
    on("night_sound", "change", (ev) => {
      this._options.night_alarm_sound_url = ev.target.value;
    });
    on("preamble_enabled", "change", (ev) => {
      this._options.preamble_enabled = ev.target.checked;
    });
    on("preamble_text", "change", (ev) => {
      this._options.preamble_text = ev.target.value;
    });
    on("speak_english", "change", (ev) => {
      this._options.speak_english = ev.target.checked;
    });
    on("announce_language", "change", (ev) => {
      this._options.announce_language = ev.target.checked;
    });
    on("translate_missing", "change", (ev) => {
      this._options.translate_missing_english = ev.target.checked;
    });
    on("translate_agent", "change", (ev) => {
      this._options.translate_agent = ev.target.value;
    });
    on("cast_enabled", "change", (ev) => {
      this._options.cast_enabled = ev.target.checked;
    });
    on("siren_test_enabled", "change", (ev) => {
      this._options.siren_test_enabled = ev.target.checked;
    });
    on("siren_test_lead", "change", (ev) => {
      this._options.siren_test_lead = parseInt(ev.target.value, 10) || 0;
    });
    on("notify_critical", "change", (ev) => {
      this._options.notify_critical = ev.target.checked;
    });
    on("cast_turn_on", "change", (ev) => {
      this._options.cast_turn_on = ev.target.checked;
    });
    on("cast-test", "click", () => this._runTest("cast"));
    on("cast_dashboard", "change", (ev) => {
      this._options.cast_dashboard_path = ev.target.value.trim();
    });
    on("cast_view", "change", (ev) => {
      this._options.cast_view_path = ev.target.value.trim();
    });
    on("cast_at_night", "change", (ev) => {
      this._options.cast_at_night = ev.target.checked;
    });
    on("tile_preset", "change", (ev) => {
      const preset = TILE_PRESETS.find((p) => p.id === ev.target.value);
      if (!preset) return;  // "Eigen": laat de velden staan om te bewerken
      this._options.map_tile_url = preset.url;
      this._options.map_attribution = preset.attribution;
      this._tileTemplate = preset.url;
      this._attribution = preset.attribution;
      this._renderSettings();
      this._renderMap();
    });
    on("tile_url", "change", (ev) => {
      this._options.map_tile_url = ev.target.value.trim();
      this._tileTemplate = this._options.map_tile_url || DEFAULT_TILE_URL;
      this._renderMap();
    });
    on("tile_attribution", "change", (ev) => {
      this._options.map_attribution = ev.target.value.trim();
      this._attribution = this._options.map_attribution || DEFAULT_ATTRIBUTION;
      this._renderMap();
    });
    on("show-welcome", "click", () => this._renderWelcome());
    on("show_in_sidebar", "change", (ev) => {
      this._options.show_in_sidebar = ev.target.checked;
    });
    on("preview", "click", () => this._previewSound());
    on("make-dashboard", "click", () => this._createDashboard());

    on("siren_follow", "change", (ev) => {
      this._options.siren_follow_sound = ev.target.checked;
      // Flip the one field it governs instead of re-rendering: _renderSettings
      // rebuilds every <details> from scratch, which collapses the section
      // the user is standing in.
      const field = root.getElementById("siren_duration");
      if (field) field.disabled = ev.target.checked;
    });
    on("siren_duration", "change", (ev) => {
      this._options.siren_duration = Math.max(
        0,
        parseInt(ev.target.value, 10) || 0
      );
    });
    on("siren-help", "click", () => this._openHelp("siren"));
  }


  _previewSound() {
    const url = this._options.alarm_sound_url;
    if (!url) {
      this._showToast("Geen alarmgeluid gekozen.", "error");
      return;
    }
    // The browser is already authenticated against HA, so a /local/ URL plays
    // straight from the page — handy for checking a file exists before
    // waking the house up with the speaker test.
    const audio = new Audio(encodeURI(url));
    audio.play().catch(() =>
      this._showToast(`Kan ${url} niet afspelen — bestaat het bestand?`, "error")
    );
  }

  /* ── Dashboard generator ───────────────────────────────────────────────── */

  /**
   * Create (or extend) a Lovelace dashboard holding the NL-Alert card, then
   * point the cast settings at it.
   *
   * Done here rather than in Python on purpose: creating a dashboard goes
   * through the admin websocket commands lovelace/dashboards/create and
   * lovelace/config/save, and the collection object behind them is a local
   * variable inside lovelace's async_setup — not reachable from another
   * integration. The panel already runs as an authenticated admin, so it is
   * the natural place.
   *
   * Never destructive: an existing dashboard keeps all its views, and the
   * NL-Alert view is only appended when it isn't there yet.
   */
  async _createDashboard() {
    const URL_PATH = "nl-alert-tv";
    const VIEW_PATH = "alert";
    const button = this.shadowRoot.getElementById("make-dashboard");
    if (button) button.disabled = true;

    try {
      const dashboards = await this._hass.callWS({
        type: "lovelace/dashboards/list",
      });
      const existing = (dashboards || []).find((d) => d.url_path === URL_PATH);

      if (!existing) {
        await this._hass.callWS({
          type: "lovelace/dashboards/create",
          url_path: URL_PATH,
          title: "NL-Alert TV",
          icon: "nlalert:nl-alert",
          show_in_sidebar: false,
          require_admin: false,
        });
      }

      // A dashboard with no config yet raises config_not_found; that is a
      // fresh dashboard, not an error.
      let config = { views: [] };
      try {
        config = await this._hass.callWS({
          type: "lovelace/config",
          url_path: URL_PATH,
          force: false,
        });
      } catch (err) {
        config = { views: [] };
      }
      if (!config || typeof config !== "object" || !Array.isArray(config.views)) {
        config = { views: [] };
      }

      const already = config.views.some((v) => v.path === VIEW_PATH);
      if (!already) {
        config = {
          ...config,
          views: [
            ...config.views,
            {
              title: "NL-Alert",
              path: VIEW_PATH,
              type: "panel",
              cards: [{ type: "custom:nl-alert-card", scope: "local" }],
            },
          ],
        };
        await this._hass.callWS({
          type: "lovelace/config/save",
          url_path: URL_PATH,
          config,
        });
      }

      this._options.cast_dashboard_path = URL_PATH;
      this._options.cast_view_path = VIEW_PATH;
      this._options.cast_enabled = true;
      await this._save();
      this._renderSettings();
      this._showToast(
        already
          ? `Bestond al — instellingen wijzen nu naar /${URL_PATH}/${VIEW_PATH}.`
          : `Aangemaakt: /${URL_PATH}/${VIEW_PATH}.`,
        "ok"
      );
    } catch (err) {
      this._showToast(
        `Dashboard aanmaken mislukt: ${err.message || err}`,
        "error"
      );
    }
    if (button) button.disabled = false;
  }

  /* ── Tests ─────────────────────────────────────────────────────────────── */

  _renderTests() {
    const el = this.shadowRoot.getElementById("tests");
    if (!el) return;
    const tests = [
      { kind: "alarm", label: "Alarmgeluid" },
      { kind: "announcement", label: "Aankondiging (alarm + spraak)" },
      { kind: "notify", label: "Notificatie" },
      { kind: "cast", label: "Naar TV casten" },
      { kind: "full", label: "Volledige alert" },
    ];
    el.innerHTML = tests
      .map(
        (t) => `
        <div class="test">
          <button data-kind="${t.kind}" ${
            this._testRunning[t.kind] ? "disabled" : ""
          }>${this._testRunning[t.kind] ? "Bezig…" : t.label}</button>
          <div class="results">${this._renderResults(t.kind)}</div>
        </div>`
      )
      .join("");

    el.querySelectorAll("button").forEach((node) =>
      node.addEventListener("click", () => this._runTest(node.dataset.kind))
    );
  }

  _renderResults(kind) {
    const results = this._testResults[kind];
    if (!results) return "";
    return results
      .map(
        (r) => `<div class="${escapeHtml(r.status)}">
          <span>${STATUS_ICON[r.status] || "•"}</span>
          <span>${escapeHtml(r.detail)}</span></div>`
      )
      .join("");
  }

  async _runTest(kind) {
    this._testRunning[kind] = true;
    this._renderTests();
    try {
      const res = await this._hass.callWS({
        type: "nl_alert/test",
        kind,
        options: this._writableOptions(),
      });
      this._testResults[kind] = res.results || [];
    } catch (err) {
      this._testResults[kind] = [
        { step: kind, status: "error", detail: String(err.message || err) },
      ];
    }
    this._testRunning[kind] = false;
    this._renderTests();
    // The cast test has a second home: a button inside the TV card, so the
    // result shows up where you pressed it rather than only further down.
    const inline = this.shadowRoot.getElementById(`${kind}-result`);
    if (inline) inline.innerHTML = this._renderResults(kind);
  }

  /* ── Save ──────────────────────────────────────────────────────────────── */

  _writableOptions() {
    const o = this._options;
    return {
      use_home_location: o.use_home_location !== false,
      latitude: o.latitude,
      longitude: o.longitude,
      scan_interval_minutes: o.scan_interval_minutes || 5,
      alert_radius_km: o.alert_radius_km ?? 0,
      media_players: o.media_players || [],
      alarm_sound_url: o.alarm_sound_url || "",
      alarm_duration_seconds: o.alarm_duration_seconds ?? 5,
      volume_pct: o.volume_pct ?? 70,
      siren_entities: o.siren_entities || [],
      siren_duration: o.siren_duration ?? 15,
      siren_follow_sound: o.siren_follow_sound !== false,
      night_enabled: o.night_enabled !== false,
      night_start: o.night_start || "22:30",
      night_end: o.night_end || "07:00",
      night_volume_pct: o.night_volume_pct ?? 40,
      night_alarm_sound_url: o.night_alarm_sound_url || "",
      tts_service: o.tts_service || "",
      tts_entity: o.tts_entity || "",
      preamble_enabled: o.preamble_enabled !== false,
      preamble_text: o.preamble_text ?? "",
      speak_english: o.speak_english !== false,
      announce_language: o.announce_language !== false,
      translate_missing_english: o.translate_missing_english !== false,
      translate_agent: o.translate_agent || "",
      notify_services: o.notify_services || [],
      siren_test_enabled: o.siren_test_enabled === true,
      siren_test_lead: o.siren_test_lead ?? 30,
      notify_critical: o.notify_critical !== false,
      notify_tts_targets: o.notify_tts_targets || [],
      cast_enabled: o.cast_enabled === true,
      cast_entities:
        o.cast_entities && o.cast_entities.length
          ? o.cast_entities
          : o.cast_entity
            ? [o.cast_entity]
            : [],
      cast_dashboard_path: o.cast_dashboard_path || "",
      cast_view_path: o.cast_view_path || "",
      cast_at_night: o.cast_at_night === true,
      cast_turn_on: o.cast_turn_on !== false,
      cast_power_entities: o.cast_power_entities || [],
      show_in_sidebar: o.show_in_sidebar !== false,
      map_tile_url: o.map_tile_url || "",
      map_attribution: o.map_attribution || "",
    };
  }

  /**
   * Autosave, debounced.
   *
   * Every write calls async_update_entry, and the update listener reloads
   * the whole config entry — coordinator, platforms, the lot. That is fine
   * once, wasteful per keystroke, hence the wait.
   */
  _queueSave() {
    clearTimeout(this._saveTimer);
    this._showToast("Opslaan…", "");
    this._saveTimer = setTimeout(() => this._save(), 900);
  }

  _flushSave() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._save();
  }

  async _save() {
    this._saveTimer = null;
    const payload = JSON.stringify(this._writableOptions());
    if (payload === this._savedPayload) return;
    try {
      const res = await this._hass.callWS({
        type: "nl_alert/save_config",
        options: JSON.parse(payload),
      });
      this._savedPayload = payload;
      // Deliberately NOT taking res.options back: the server echoes what it
      // received, and anything typed during the round trip would be undone
      // by it. The local object is the truth while the form is open.
      const before = this._brokenFields();
      this._validation = res.validation || [];
      this._renderProblems();
      // Re-rendering the form on every save would blow away focus mid-word,
      // so it only happens when the set of failing fields actually moved.
      if (this._brokenFields() !== before) {
        this._renderSettings();
        this._wireSettings();
        this._wirePickers();
      }
      this._showToast("Opgeslagen", "ok");
    } catch (err) {
      // No auto-clear on failure: a save that silently did not happen is
      // worse than a message that overstays.
      this._showToast(`Opslaan mislukt: ${err.message || err}`, "error", 0);
    }
  }

  _brokenFields() {
    return this._validation
      .filter((p) => p.status === "error")
      .map((p) => p.field)
      .sort()
      .join(",");
  }

  _showToast(text, kind, clearAfter = 4000) {
    const el = this.shadowRoot.getElementById("toast");
    if (!el) return;
    el.textContent = text;
    el.className = `toast ${kind || ""}`;
    clearTimeout(this._toast);
    if (!clearAfter) return;
    this._toast = setTimeout(() => {
      el.textContent = "";
    }, clearAfter);
  }
}

customElements.define("nl-alert-panel", NlAlertPanel);
