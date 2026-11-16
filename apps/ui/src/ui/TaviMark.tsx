/**
 * Tavi's mark: a speech bubble with a two-leaf sprout, one leaf in the sun.
 * It keeps one look in both themes, as an app icon does (`--mark-*` in
 * styles/tokens.css). `public/favicon.svg` is the same drawing with its
 * colours written in, since a favicon cannot read the page's tokens.
 */
export function TaviMark({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className === undefined ? "tavi-mark" : `tavi-mark ${className}`}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="tavi-mark-bubble"
        d="M22 10H42C49.7 10 56 16.3 56 24V34C56 41.7 49.7 48 42 48H27L17.6 55.2C16.9 55.7 16 55.2 16 54.4V46.7C11.3 44.6 8 39.7 8 34V24C8 16.3 14.3 10 22 10Z"
      />
      <path className="tavi-mark-stem" d="M32 41V27" />
      <path className="tavi-mark-leaf" d="M32 31.5C25.6 31.5 21.8 27.8 21.8 21.6 28 21.6 32 25.3 32 31.5Z" />
      <path className="tavi-mark-sun" d="M32 27.6C32 21.6 35.8 17.6 42.2 17.6 42.2 23.6 38.2 27.6 32 27.6Z" />
    </svg>
  );
}

/**
 * The wordmark: "tavi" in the display face with the sun as the dot on its i.
 * The drawn letters use a dotless i, so a screen reader hears the name from
 * the hidden text instead.
 */
export function Wordmark() {
  return (
    <>
      <span className="wordmark" aria-hidden="true">
        tav<span className="wordmark-i">ı</span>
      </span>
      <span className="visually-hidden">tavi</span>
    </>
  );
}
