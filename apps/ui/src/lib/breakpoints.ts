/**
 * The layout's breakpoints, as the script reads them. The stylesheets name the
 * same steps as `@custom-media` in `styles/breakpoints.css` (`@media (--phone)`),
 * the only place a stylesheet spells a width out; `design.test.ts` holds those
 * definitions to these numbers, and stylelint refuses a raw width query.
 */

/** Up to this window width the page is laid out for a phone. */
export const PHONE_MAX_WIDTH = 720;

/** From this window width a page has room for two panes side by side, or a rail. */
export const WIDE_MIN_WIDTH = 960;

/** From this window width the chat panel docks beside the transcript; below it, it overlays. */
export const DOCKED_MIN_WIDTH = 1280;

/** Up to this window height (a phone on its side) the transcript comes first: the chrome around it folds. */
export const SHORT_MAX_HEIGHT = 500;

/** The phone layout's media query. */
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
