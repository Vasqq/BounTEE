// The nav's mark: the hex-and-bars glyph and "BounTEE", as on the landing page.
export function Wordmark({ href, label }: { href: string; label: string }) {
  return (
    <a className="mark" href={href} aria-label={label}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M9.2 8.6v7.2M14.8 8.6v7.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      BounTEE
    </a>
  );
}
