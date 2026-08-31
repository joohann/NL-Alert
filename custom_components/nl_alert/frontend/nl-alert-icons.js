/**
 * NL-Alert custom icon set — registers the brand mark so it can be used as
 * the sidebar/panel icon via "nlalert:nl-alert". Same mechanism HACS uses
 * for its own sidebar icon (window.customIcons).
 *
 * Sidebar icons are single-colour paths that follow the theme, so this is a
 * silhouette of the wimpel from nl-alert-logo.svg with the brand hatching
 * knocked out as counters. The real lockup puts the hatching *below* the
 * wimpel, but that block is 38x85 units — at 24x24 the stripes end up under
 * a pixel wide. Folding them inside the shape keeps both elements legible.
 *
 * The counters are wound against the outer shape so they are holes under
 * nonzero fill: ha-icon renders a bare <path d> and gives no way to set
 * fill-rule, so evenodd is not an option.
 */
const ICONS = {
  "nl-alert":
    "M 4.75,15.6 L 12,22.8 L 19.25,15.6 L 19.25,1.2 L 4.75,1.2 L 4.75,15.6 Z M 7.04,5.96 L 7.04,3.49 L 9.51,3.49 Z M 7.04,11.48 L 7.04,9.01 L 12.56,3.49 L 15.04,3.49 Z M 8.22,15.82 L 7.04,14.65 L 7.04,14.53 L 16.96,4.61 L 16.96,7.08 Z M 10.99,18.58 L 9.75,17.34 L 16.96,10.13 L 16.96,12.61 Z",
};

window.customIcons = window.customIcons || {};
window.customIcons["nlalert"] = {
  getIcon: (name) =>
    Promise.resolve(ICONS[name] ? { path: ICONS[name] } : undefined),
  getIconList: () => Object.keys(ICONS).map((name) => ({ name })),
};
