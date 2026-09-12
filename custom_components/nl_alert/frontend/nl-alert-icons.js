/**
 * NL-Alert custom icon set — registers the brand mark so it can be used as
 * the sidebar/panel icon via "nlalert:nl-alert". Same mechanism HACS uses
 * for its own sidebar icon (window.customIcons).
 *
 * Traced from "nl-alert horizontaal-squared.svg": the arrow, the hatching
 * and the nl-alert wordmark, as one path. Sidebar icons are a single colour
 * that follows the theme, so the gaps between the hatch bars are simply
 * unpainted — no counters, nothing here depends on winding.
 *
 * The wordmark is in on purpose. It is 3.4px tall at 24px and no one will
 * read it, but it squares the lockup off: mark alone is 2.2:1 and leaves
 * two thirds of the box empty, mark plus wordmark is 1.6:1 and fills it.
 * The hatch bars land near 1.5px either way, which is as thin as a diagonal
 * can be before it turns to mush.
 */
const ICONS = {
  "nl-alert":
    "M 10.84,15.05 L 15.77,10.1 L 10.84,5.15 L 1,5.15 L 1,15.05 L 10.84,15.05 Z M 23,15.05 L 23,13.59 L 21.55,15.05 L 23,15.05 Z M 19.96,15.05 L 23,11.99 L 23,10.53 L 18.51,15.05 L 19.96,15.05 Z M 16.92,15.05 L 23,8.93 L 23,7.47 L 15.47,15.05 L 16.92,15.05 Z M 13.16,15.05 L 13.88,15.05 L 23,5.87 L 23,5.14 L 22.27,5.14 L 13.16,14.32 L 13.16,15.05 Z M 13.16,12.73 L 20.69,5.14 L 19.23,5.14 L 13.16,11.26 L 13.16,12.73 Z M 13.16,9.67 L 17.65,5.14 L 16.2,5.14 L 13.16,8.2 L 13.16,9.67 Z M 14.61,5.14 L 13.16,5.14 L 13.16,6.61 L 14.61,5.14 Z M 9.3,18.8 l -0.56,0 l 0,-2.41 l 0.56,0 l 0,0.37 c 0.16,-0.23 0.38,-0.42 0.76,-0.42 c 0.55,0 0.86,0.36 0.86,0.93 l 0,1.54 l -0.56,0 l 0,-1.37 c 0,-0.37 -0.19,-0.59 -0.52,-0.59 s -0.55,0.22 -0.55,0.6 l 0,1.36 l 0,0 Z M 11.44,18.8 L 12,18.8 L 12,15.46 L 11.44,15.46 L 11.44,18.8 Z M 12.45,17.85 L 13.25,17.85 L 13.25,17.34 L 12.45,17.34 L 12.45,17.85 Z M 14.64,16.35 c -0.4,0 -0.66,0.08 -0.92,0.2 l 0.15,0.44 c 0.22,-0.09 0.42,-0.15 0.7,-0.15 c 0.39,0 0.6,0.18 0.6,0.52 l 0,0.06 c -0.19,-0.06 -0.38,-0.1 -0.67,-0.1 c -0.57,0 -0.98,0.26 -0.98,0.78 l 0,0.01 c 0,0.48 0.4,0.74 0.86,0.74 c 0.37,0 0.62,-0.15 0.79,-0.35 l 0,0.3 l 0.55,0 l 0,-1.43 c 0,-0.65 -0.35,-1.02 -1.07,-1.02 l 0,0 Z M 15.17,17.93 c 0,0.3 -0.28,0.51 -0.64,0.51 c -0.26,0 -0.47,-0.13 -0.47,-0.36 l 0,-0.01 c 0,-0.25 0.21,-0.39 0.56,-0.39 c 0.22,0 0.41,0.04 0.56,0.1 l 0,0.15 l -0,0 Z M 16.21,18.8 L 16.76,18.8 L 16.76,15.46 L 16.21,15.46 L 16.21,18.8 Z M 19.52,17.64 c 0,-0.7 -0.39,-1.3 -1.16,-1.3 c -0.7,0 -1.19,0.57 -1.19,1.26 c 0,0.75 0.54,1.26 1.25,1.26 c 0.45,0 0.76,-0.18 0.99,-0.45 l -0.33,-0.29 c -0.19,0.19 -0.39,0.29 -0.66,0.29 c -0.36,0 -0.64,-0.22 -0.7,-0.61 l 1.79,0 c 0.01,-0.05 0.01,-0.1 0.01,-0.15 l 0,0 Z M 17.72,17.43 c 0.05,-0.37 0.29,-0.64 0.63,-0.64 c 0.37,0 0.58,0.28 0.62,0.64 l -1.25,0 Z M 22.29,18.05 c 0,0.22 0.11,0.3 0.3,0.3 c 0.12,0 0.23,-0.03 0.34,-0.08 l 0,0.45 c -0.14,0.08 -0.29,0.12 -0.5,0.12 c -0.41,0 -0.7,-0.18 -0.7,-0.71 l 0,-1.27 l -0.27,0 l 0,-0.49 l 0.27,0 l 0,-0.65 l 0.56,0 l 0,0.65 l 0.64,0 l 0,0.49 l -0.64,0 l 0,1.18 l 0,0 Z M 21.26,16.37 c -0.39,0.01 -0.64,0.22 -0.79,0.56 l 0,-0.54 l -0.56,0 l 0,2.41 l 0.56,0 l 0,-0.92 c 0,-0.62 0.32,-1 0.79,-1.02 l 0,-0.5 l 0,0 Z",
};

window.customIcons = window.customIcons || {};
window.customIcons["nlalert"] = {
  getIcon: (name) =>
    Promise.resolve(ICONS[name] ? { path: ICONS[name] } : undefined),
  getIconList: () => Object.keys(ICONS).map((name) => ({ name })),
};
