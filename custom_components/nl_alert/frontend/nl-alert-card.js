/**
 * NL-Alert Lovelace card — type: custom:nl-alert-card
 *
 * Deliberately a SEPARATE, self-contained file from nl-alert-panel.js. A
 * Lovelace card is a different custom element, loaded independently of the
 * sidebar panel, and it has to work on a Cast receiver where the panel does
 * not exist at all — HA Cast renders Lovelace views only, never custom
 * panels. That is the whole reason this card exists: it is what gets cast to
 * the TV when an alert covers your location.
 *
 * The projection helpers are duplicated from the panel rather than shared.
 * There is no build step here, so sharing would mean a third file that both
 * import — extra load order to get wrong on a TV that is already struggling.
 * Forty lines of Web Mercator is the cheaper copy.
 *
 * Config:
 *   type:     custom:nl-alert-card
 *   scope:    "local" (default) — only alerts covering your location
 *             "national"        — every active alert in the country
 *   show_map: true (default) — draw the alert area
 *   compact:  false (default) — true drops the map and shrinks the type,
 *             for a phone dashboard rather than a TV
 *
 * New in 0.6.0 (2026-08-09).
 */

const TILE_SIZE = 256;
const ZOOM_MIN = 6;
const ZOOM_MAX = 13;
const MAX_MAP_PX = 700;
const REFRESH_MS = 30000;

const NL_BOUNDS = { min_lat: 50.7, max_lat: 53.6, min_lon: 3.2, max_lon: 7.3 };

// NL-Alert's house style: yellow with black, never red (nl-alert.nl).
const BRAND_YELLOW = "#ffe500";
const BRAND_BLACK = "#111111";

function project(lat, lon, zoom) {
  const n = Math.pow(2, zoom) * TILE_SIZE;
  const x = ((lon + 180) / 360) * n;
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  const rad = (clamped * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [x, y];
}

// Sized to the box it lands in, so place names stay at their designed size
// instead of being scaled down — on a TV across the room that difference is
// the whole point of showing a map.
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
  const padLat = Math.max((maxLat - minLat) * 0.4, 0.06);
  const padLon = Math.max((maxLon - minLon) * 0.4, 0.09);
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
const DEFAULT_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/" +
  "World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const DEFAULT_ATTRIBUTION = "© Esri, HERE, Garmin, OpenStreetMap contributors";

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

const STYLE = `
  ha-card {
    padding: 0; overflow: hidden;
    /* Sized in vw so the same card is readable on a phone and across a
       living room. Clamped so it stays sane on a very wide dashboard. */
    --nl-scale: clamp(14px, 1.35vw, 26px);
  }
  .alert ha-card, ha-card.alert { border: 2px solid #111; }
  .banner {
    display: flex; align-items: center; gap: .8em;
    padding: .7em 1em; background: #ffe500; color: #111;
    font-size: calc(var(--nl-scale) * 1.15); font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase;
  }
  .banner.quiet { background: var(--secondary-background-color, #eceff1);
    color: var(--primary-text-color, #212121); text-transform: none;
    letter-spacing: 0; font-weight: 500; }
  .banner .pulse {
    width: .7em; height: .7em; border-radius: 50%; background: #111;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  .body { padding: 1em 1.1em 1.2em; }
  .message {
    font-size: calc(var(--nl-scale) * 1.25); line-height: 1.35;
    color: var(--primary-text-color, #212121);
  }
  .english {
    margin-top: .6em; font-size: var(--nl-scale); line-height: 1.35;
    color: var(--secondary-text-color, #727272);
  }
  .meta {
    margin-top: .7em; font-size: calc(var(--nl-scale) * .8);
    color: var(--secondary-text-color, #727272);
  }
  .more { margin-top: .8em; font-size: calc(var(--nl-scale) * .85); }
  .more div { padding: .25em 0; }
  .map { margin-top: .9em; height: 40vh; min-height: 180px; position: relative; }
  .map svg { width: 100%; height: 100%; display: block; border-radius: 8px; }
  .tiles.dark { filter: invert(1) hue-rotate(180deg) brightness(.82) contrast(1.08); }
  .attribution {
    position: absolute; right: 5px; bottom: 3px; font-size: 10px;
    color: var(--secondary-text-color, #666);
    background: rgba(255,255,255,.6); padding: 0 4px; border-radius: 3px;
  }
  .calm { padding: 1.1em; display: flex; align-items: center; gap: .7em;
    font-size: var(--nl-scale); color: var(--secondary-text-color, #727272); }
  .calm .dot { width: .6em; height: .6em; border-radius: 50%;
    background: var(--success-color, #43a047); flex: 0 0 auto; }
  .calm .checked { opacity: .75; }
`;

class NlAlertCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = { scope: "local", show_map: true, compact: false };
    this._data = null;
    this._timer = null;
    this._loading = false;
  }

  setConfig(config) {
    this._config = {
      scope: config.scope === "national" ? "national" : "local",
      show_map: config.show_map !== false,
      compact: config.compact === true,
    };
    this._render();
  }

  getCardSize() {
    return this._config.show_map && !this._config.compact ? 8 : 4;
  }

  static getStubConfig() {
    return { type: "custom:nl-alert-card", scope: "local" };
  }

  set hass(hass) {
    const first = this._hass === null;
    this._hass = hass;
    if (first) this._load();
  }

  connectedCallback() {
    if (!this._timer) this._timer = setInterval(() => this._load(), REFRESH_MS);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _load() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      this._data = await this._hass.callWS({ type: "nl_alert/get_alerts" });
    } catch (err) {
      // Integration not loaded (or mid-reload). Keep whatever we last drew
      // rather than blanking the screen — on a TV a blank card reads as a
      // broken TV, not as "no alerts".
      if (!this._data) this._data = { active: [], local: [], error: true };
    }
    this._loading = false;
    this._render();
  }

  _alerts() {
    if (!this._data) return [];
    return this._config.scope === "national"
      ? this._data.active || []
      : this._data.local || [];
  }

  _render() {
    if (!this.shadowRoot) return;
    const alerts = this._alerts();
    const primary = alerts[0];

    if (!primary) {
      const locale = (this._hass && this._hass.language) || "nl";
      const checkedAt = this._data && this._data.fetched_at;
      const checked = checkedAt
        ? new Date(checkedAt).toLocaleString(locale, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      this.shadowRoot.innerHTML = `
        <style>${STYLE}</style>
        <ha-card>
          <div class="calm"><span class="dot"></span>
            <span>${
              this._data && this._data.error
                ? "NL-Alert is niet bereikbaar"
                : this._config.scope === "national"
                  ? "Geen actieve NL-Alerts in Nederland"
                  : "Geen NL-Alert voor jouw gebied"
            }${
              checked && !(this._data && this._data.error)
                ? ` <span class="checked">· gecontroleerd ${escapeHtml(
                    checked
                  )}</span>`
                : ""
            }</span>
          </div>
        </ha-card>`;
      return;
    }

    const [dutch, english] = String(primary.message || "").split("***");
    const locale = (this._hass && this._hass.language) || "nl";
    const period = [primary.start_at, primary.stop_at]
      .filter(Boolean)
      .map((iso) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
          ? ""
          : date.toLocaleString(locale, {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            });
      })
      .filter(Boolean)
      .join(" – ");

    const others = alerts.slice(1, 4);

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="alert">
        <div class="banner">
          <span class="pulse"></span>
          <span>NL-Alert${
            primary.is_local ? " — jouw gebied" : ""
          }</span>
        </div>
        <div class="body">
          <div class="message">${escapeHtml((dutch || "").trim())}</div>
          ${
            english && english.trim()
              ? `<div class="english">${escapeHtml(english.trim())}</div>`
              : ""
          }
          ${period ? `<div class="meta">${escapeHtml(period)}</div>` : ""}
          ${
            others.length
              ? `<div class="more">${others
                  .map(
                    (a) =>
                      `<div>• ${escapeHtml(
                        String(a.message || "").split("***")[0].trim().slice(0, 120)
                      )}</div>`
                  )
                  .join("")}</div>`
              : ""
          }
          ${
            this._config.show_map && !this._config.compact
              ? `<div class="map"><div id="map"></div>
                   <div class="attribution">${escapeHtml(
                     (this._data && this._data.attribution) || DEFAULT_ATTRIBUTION
                   )}</div></div>`
              : ""
          }
        </div>
      </ha-card>`;

    if (this._config.show_map && !this._config.compact) {
      this._renderMap(primary);
    }
  }

  _renderMap(alert) {
    const el = this.shadowRoot.getElementById("map");
    if (!el) return;

    this._tileTemplate =
      (this._data && this._data.tile_url) || DEFAULT_TILE_URL;
    const bounds =
      (alert.polygons && alert.polygons.length
        ? boundsOfPolygons(alert.polygons)
        : null) ||
      (this._data && this._data.bounds) ||
      NL_BOUNDS;

    const box = el.getBoundingClientRect();
    const zoom = pickZoom(bounds, box.width, box.height);
    const [x1, y1] = project(bounds.max_lat, bounds.min_lon, zoom);
    const [x2, y2] = project(bounds.min_lat, bounds.max_lon, zoom);
    const width = Math.max(x2 - x1, 1);
    const height = Math.max(y2 - y1, 1);

    const dark = this._hass && this._hass.themes && this._hass.themes.darkMode;
    // Contrast against the basemap, not the card: a black outline disappears
    // on the dark tiles.
    const ink = dark ? "#ffffff" : BRAND_BLACK;
    const tiles = [];
    const max = Math.pow(2, zoom);
    for (let tx = Math.floor(x1 / TILE_SIZE); tx <= Math.floor(x2 / TILE_SIZE); tx++) {
      for (let ty = Math.floor(y1 / TILE_SIZE); ty <= Math.floor(y2 / TILE_SIZE); ty++) {
        if (tx < 0 || ty < 0 || tx >= max || ty >= max) continue;
        tiles.push(
          `<image href="${tileUrl(this._tileTemplate, zoom, tx, ty)}"
             x="${tx * TILE_SIZE}" y="${ty * TILE_SIZE}"
             width="${TILE_SIZE}" height="${TILE_SIZE}" class="tile" />`
        );
      }
    }

    const shapes = (alert.polygons || [])
      .map((poly) => {
        const points = poly
          .map(([lat, lon]) => project(lat, lon, zoom).join(","))
          .join(" ");
        return `<polygon points="${points}" fill="${BRAND_YELLOW}"
          fill-opacity="0.5" stroke="${ink}" stroke-width="3"
          vector-effect="non-scaling-stroke" />`;
      })
      .join("");

    const monitored = (this._data && this._data.monitored) || {};
    let marker = "";
    if (monitored.latitude != null && monitored.longitude != null) {
      const [mx, my] = project(monitored.latitude, monitored.longitude, zoom);
      marker = `<circle cx="${mx}" cy="${my}" r="4" fill="#1e88e5"
        stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke" />`;
    }

    el.innerHTML = `
      <svg viewBox="${x1} ${y1} ${width} ${height}"
           preserveAspectRatio="xMidYMid meet" role="img"
           aria-label="Gebied van deze NL-Alert">
        <g class="tiles${dark ? " dark" : ""}">${tiles.join("")}</g><g>${shapes}</g><g>${marker}</g>
      </svg>`;

    el.querySelectorAll("image.tile").forEach((tile) =>
      tile.addEventListener("error", () => {
        tile.style.display = "none";
      })
    );
  }
}

customElements.define("nl-alert-card", NlAlertCard);

// Makes the card appear in the "Add card" picker instead of only being
// addable by hand-writing YAML.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "nl-alert-card",
  name: "NL-Alert",
  description: "Actieve NL-Alert met het gewaarschuwde gebied op de kaart.",
  preview: true,
});
