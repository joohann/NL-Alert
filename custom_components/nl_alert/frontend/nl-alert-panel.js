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
  /* Boolean settings as switches. Only DIRECT children of .control — the
     checkboxes inside a picklist are a multi-select, not a setting, and a
     column of switches there reads as a switchboard rather than a list.
     The track radius matches the buttons (8px) instead of the usual pill,
     so the whole panel keeps one corner language. */
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
  .picklist input[type="checkbox"] { accent-color: #ffe500; }

  input[type="range"] { width: 100%; accent-color: #ffe500; }
  input.invalid, select.invalid, .picklist.invalid {
    border-color: var(--nl-accent); border-width: 2px;
  }

  .picklist {
    max-height: 190px; overflow-y: auto; width: 100%;
    border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px;
    padding: 4px 0;
  }
  .picklist .empty { padding: 10px 12px; }
  .picklist label {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 12px; font-size: 14px; cursor: pointer;
  }
  .picklist label:hover { background: var(--secondary-background-color, #f5f5f5); }
  .picklist .sub { color: var(--secondary-text-color, #727272); font-size: 12px; }

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
    this._lists = {
      players: [],
      notify: [],
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

    const [players, notify, power, tts, audio] = await Promise.all([
      this._safeWS("nl_alert/list_media_players", []),
      this._safeWS("nl_alert/list_notify_services", []),
      this._safeWS("nl_alert/list_power_entities", []),
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
      return await this._hass.callWS({ type });
    } catch (err) {
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
      <div id="dialog-root"></div>
      <div id="busy-root"></div>
      <div id="welcome-root"></div>`;
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

  /* ── Settings dialog ───────────────────────────────────────────────────── */

  _openDialog() {
    this._dialogOpen = true;
    this._renderDialog();
    this._escHandler = (ev) => {
      if (ev.key === "Escape") this._closeDialog();
    };
    window.addEventListener("keydown", this._escHandler);
  }

  _closeDialog() {
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
        <div class="dialog" role="dialog" aria-modal="true"
             aria-label="NL-Alert instellingen">
          <header>
            <h2>Instellingen</h2>
            <span class="grow" style="flex:1"></span>
            <button class="icon-btn" id="close" aria-label="Sluiten">✕</button>
          </header>
          <div class="body">
            <div id="settings"></div>
            <details class="card">
              <summary>Testen</summary>
              <div class="row"><div class="hint muted">Draait tegen de
                instellingen zoals ze nu op het scherm staan — je hoeft niet
                eerst op te slaan.</div></div>
              <div class="row"><div class="tests" id="tests"></div></div>
            </details>
          </div>
          <footer>
            <button id="save">Opslaan</button>
            <button class="ghost" id="cancel">Sluiten</button>
            <span class="grow"></span>
            <span class="toast" id="toast"></span>
          </footer>
        </div>
      </div>`;

    root.querySelector("#close").addEventListener("click", () =>
      this._closeDialog()
    );
    root.querySelector("#cancel").addEventListener("click", () =>
      this._closeDialog()
    );
    // Click-outside closes, but only when the click starts on the backdrop —
    // otherwise dragging the volume slider past the dialog edge closes it.
    const overlay = root.querySelector("#overlay");
    overlay.addEventListener("mousedown", (ev) => {
      if (ev.target === overlay) this._closeDialog();
    });
    root.querySelector("#save").addEventListener("click", () => this._save());

    this._renderSettings();
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
   * Which settings section a validated field belongs to. Used to auto-open
   * that section: with everything collapsed, "Dit werkt nu niet" would
   * otherwise tell you to fix something you cannot see.
   */
  _sectionOpen(fields) {
    return this._validation.some(
      (p) => p.status === "error" && fields.includes(p.field)
    )
      ? "open"
      : "";
  }

  _renderSettings() {
    const el = this.shadowRoot.getElementById("settings");
    if (!el) return;
    const o = this._options;
    const openLocation = this._sectionOpen([
      "latitude",
      "longitude",
      "scan_interval_minutes",
    ]);
    const openSpeech = this._sectionOpen([
      "media_players",
      "alarm_sound_url",
      "tts_service",
      "tts_entity",
      "translate_agent",
    ]);
    const openNight = this._sectionOpen(["night_alarm_sound_url"]);
    const openNotify = this._sectionOpen(["notify_services"]);
    const openCast = this._sectionOpen(["cast_entities", "cast_entity"]);
    const useHome = o.use_home_location !== false;

    const soundOptions = this._soundOptions(o.alarm_sound_url);

    el.innerHTML = `
      <details class="card" ${openLocation}>
        <summary>Locatie &amp; ophalen</summary>
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
        </div>
      </details>

      <details class="card" ${openSpeech}>
        <summary>Alarm &amp; spraak</summary>
        <div class="row">
          <label class="title">Speakers</label>
          <div class="control">
            <div class="picklist${
              this._fieldError("media_players") ? " invalid" : ""
            }" id="players">
              ${this._checkboxes(
                this._lists.players.map((p) => ({
                  value: p.entity_id,
                  label: p.name,
                  sub: p.entity_id,
                })),
                o.media_players || [],
                "player"
              )}
            </div>
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
        </div>
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
        </div>
      </details>

      <details class="card" ${openNight}>
        <summary>Nachtmodus</summary>
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
        </div>
      </details>

      <details class="card" ${openNotify}>
        <summary>Notificaties</summary>
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
            <div class="picklist${
              this._fieldError("notify_services") ? " invalid" : ""
            }" id="notify">
              ${this._checkboxes(
                this._lists.notify.map((n) => ({
                  value: n.service,
                  label: n.name,
                  sub: n.service,
                })),
                o.notify_services || [],
                "notify"
              )}
            </div>
          </div>
        </div>
        <div class="row">
          <label class="title">Uitspreken i.p.v. toon</label>
          <div class="control">
            <div class="picklist" id="notify-tts">
              ${this._checkboxes(
                this._lists.notify.map((n) => ({
                  value: n.service,
                  label: n.name,
                  sub: n.service,
                })),
                o.notify_tts_targets || [],
                "notifytts"
              )}
            </div>
          </div>
          <div class="hint muted">Voor toestellen die de alarm-stream
            negeren — veel Samsung-telefoons doen dat. De app spreekt het
            bericht dan uit via de alarm-stream. Per toestel, want het
            verandert wát de ontvanger hoort.</div>
        </div>
      </details>

      <details class="card">
        <summary>Maandelijkse test (luchtalarm)</summary>
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
        </div>
      </details>

      <details class="card" ${openCast}>
        <summary>Naar de TV</summary>
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
            <div class="picklist${
              this._fieldError("cast_entities") ? " invalid" : ""
            }" id="cast-targets">
              ${this._checkboxes(
                this._lists.players
                  .filter((p) => p.platform === "cast")
                  .map((p) => ({
                    value: p.entity_id,
                    label: p.name,
                    sub: p.entity_id,
                  })),
                o.cast_entities && o.cast_entities.length
                  ? o.cast_entities
                  : o.cast_entity
                    ? [o.cast_entity]
                    : [],
                "casttarget"
              )}
            </div>
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
            <div class="picklist" id="cast-power">
              ${this._checkboxes(
                (this._lists.power || []).map((p) => ({
                  value: p.entity_id,
                  label: p.name,
                  sub: p.entity_id,
                })),
                o.cast_power_entities || [],
                "castpower"
              )}
            </div>
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
        </div>
      </details>

      <details class="card">
        <summary>Paneel</summary>
        <div class="row">
          <label class="title" for="show_in_sidebar">NL-Alert in de zijbalk tonen</label>
          <div class="control"><input type="checkbox" id="show_in_sidebar" ${
            o.show_in_sidebar === false ? "" : "checked"
          }></div>
          <div class="hint muted">Uit? Het paneel blijft bereikbaar via
            <code>/nl-alert</code>.</div>
        </div>
      </details>

      <details class="card">
        <summary>Kaart</summary>
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
            plaatshouders. CARTO en OpenStreetMap weigeren inmiddels verzoeken
            zonder sleutel of van apps; heb je een sleutel bij een aanbieder,
            plak dan hier hun template.</div>
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
        </div>
      </details>

      <details class="card">
        <summary>Over NL-Alert</summary>
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
        </div>
      </details>`;

    this._wireSettings();
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

  _checkboxes(items, selected, name) {
    if (!items.length) {
      return `<div class="empty muted">Niets gevonden.</div>`;
    }
    const chosen = new Set(selected);
    // Anything stored but no longer present still gets a row, checked, so a
    // stale entity is visible instead of silently vanishing from the UI.
    const known = new Set(items.map((i) => i.value));
    const extras = [...chosen]
      .filter((v) => !known.has(v))
      .map((v) => ({ value: v, label: v, sub: "bestaat niet meer" }));
    return [...extras, ...items]
      .map(
        (item) => `
        <label>
          <input type="checkbox" data-group="${name}"
            value="${escapeHtml(item.value)}" ${
              chosen.has(item.value) ? "checked" : ""
            }>
          <span>${escapeHtml(item.label)}
            <span class="sub">${escapeHtml(item.sub || "")}</span></span>
        </label>`
      )
      .join("");
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

    root.querySelectorAll('input[data-group="player"]').forEach((node) =>
      node.addEventListener("change", () => {
        this._options.media_players = this._collect("player");
      })
    );
    root.querySelectorAll('input[data-group="notify"]').forEach((node) =>
      node.addEventListener("change", () => {
        this._options.notify_services = this._collect("notify");
      })
    );
    root.querySelectorAll('input[data-group="casttarget"]').forEach((node) =>
      node.addEventListener("change", () => {
        this._options.cast_entities = this._collect("casttarget");
      })
    );
    root.querySelectorAll('input[data-group="notifytts"]').forEach((node) =>
      node.addEventListener("change", () => {
        this._options.notify_tts_targets = this._collect("notifytts");
      })
    );
    root.querySelectorAll('input[data-group="castpower"]').forEach((node) =>
      node.addEventListener("change", () => {
        this._options.cast_power_entities = this._collect("castpower");
      })
    );
  }

  _collect(group) {
    return [
      ...this.shadowRoot.querySelectorAll(
        `input[data-group="${group}"]:checked`
      ),
    ].map((node) => node.value);
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

  async _save() {
    const button = this.shadowRoot.getElementById("save");
    button.disabled = true;
    try {
      const res = await this._hass.callWS({
        type: "nl_alert/save_config",
        options: this._writableOptions(),
      });
      this._options = res.options || this._options;
      this._validation = res.validation || [];
      this._renderProblems();
      this._renderSettings();
      this._showToast("Opgeslagen.", "ok");
    } catch (err) {
      this._showToast(`Opslaan mislukt: ${err.message || err}`, "error");
    }
    button.disabled = false;
  }

  _showToast(text, kind) {
    const el = this.shadowRoot.getElementById("toast");
    if (!el) return;
    el.textContent = text;
    el.className = `toast ${kind || ""}`;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => {
      el.textContent = "";
    }, 6000);
  }
}

customElements.define("nl-alert-panel", NlAlertPanel);
