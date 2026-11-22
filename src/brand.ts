// Savepoint brand: an open infinity loop in ink and red with a red "save" dot.
// One source for the mark so the site, sign-in pages, favicon and MCP icon match.

export const BRAND = {
  ink: "#12171d",
  red: "#e0242b",
  redDark: "#b81c22",
  redSoft: "#fdecec",
} as const;

/** Mark paths drawn in a 0 0 100 100 box. `inkColor` lets dark backgrounds use a light left loop. */
export function markPaths(inkColor: string = BRAND.ink, red: string = BRAND.red): string {
  return (
    `<path d="M17.2 61.6A17.7 17.7 0 1 1 39.0 34.8" fill="none" stroke="${inkColor}" stroke-width="10.5" stroke-linecap="round"/>` +
    `<path d="M34.2 61.4L62.5 33.1A17.7 17.7 0 1 1 61.0 56.6" fill="none" stroke="${red}" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="25.4" cy="72.5" r="4.8" fill="${red}"/>`
  );
}

/** Inline mark for HTML pages (inherits size from CSS). */
export function markSvg(cls = "mark", inkColor: string = BRAND.ink): string {
  return `<svg class="${cls}" viewBox="0 0 100 100" role="img" aria-label="SavePoint">${markPaths(inkColor)}</svg>`;
}

/** Standalone icon file: mark on a white rounded tile so it reads on any background. */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#ffffff"/>` +
  `<g transform="translate(5 5) scale(.9)">${markPaths()}</g></svg>`;

/** Wordmark: "Save" in ink, "Point" in red, matching the logo. */
export function wordmark(inkColor: string = BRAND.ink): string {
  return `<span class="wordmark"><span style="color:${inkColor}">Save</span><span style="color:${BRAND.red}">Point</span></span>`;
}
