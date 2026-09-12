/**
 * NL-Alert custom icon set — registers the brand mark so it can be used as
 * the sidebar/panel icon via "nlalert:nl-alert". Same mechanism HACS uses
 * for its own sidebar icon (window.customIcons).
 *
 * Traced from nl-alert-icon-hor.ai, which is a PDF inside and already laid
 * out on a 24x24 page. The wordmark that sits under the mark is left out;
 * at 24px it is a grey smear.
 *
 * Sidebar icons are single-colour paths that follow the theme, so the arrow
 * and the hatching are one path and the gaps between the bars are simply
 * unpainted. No counters, so nothing depends on winding here.
 *
 * Worth knowing before changing this: the horizontal lockup is 21.23 by 9.56,
 * a ratio of 2.2 to 1. Fitted to the width of a square icon it stands about
 * ten pixels tall and the hatch bars land near 1.4px, which is where a
 * diagonal starts to turn to mush. That is the cost of using the brand shape
 * as drawn rather than a squarer arrangement of the same elements.
 */
const ICONS = {
  "nl-alert":
    "M 10.86,16.87 L 15.7,12 L 10.86,7.14 L 1.2,7.14 L 1.2,16.87 Z M 22.8,16.86 L 22.8,15.43 L 21.37,16.86 Z M 19.82,16.86 L 22.8,13.86 L 22.8,12.42 L 18.39,16.86 Z M 16.83,16.86 L 22.8,10.86 L 22.8,9.42 L 15.4,16.86 Z M 13.14,16.86 L 13.85,16.86 L 22.8,7.85 L 22.8,7.13 L 22.09,7.13 L 13.14,16.14 Z M 13.14,14.58 L 20.53,7.14 L 19.1,7.14 L 13.14,13.14 Z M 13.14,11.58 L 17.55,7.14 L 16.12,7.14 L 13.14,10.14 Z M 14.57,7.13 L 13.14,7.13 L 13.14,8.57 Z",
};

window.customIcons = window.customIcons || {};
window.customIcons["nlalert"] = {
  getIcon: (name) =>
    Promise.resolve(ICONS[name] ? { path: ICONS[name] } : undefined),
  getIconList: () => Object.keys(ICONS).map((name) => ({ name })),
};
