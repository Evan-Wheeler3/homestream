// Mirrors the breakpoints documented in styles/tokens.css.
export const BREAKPOINTS = { sm: 600, md: 900, lg: 1200, xl: 1600, tv: 2200 } as const;
export const DESKTOP_QUERY = `(min-width: ${BREAKPOINTS.md}px)`;
