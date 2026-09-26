// The Agentelse symbol — a 4-point sparkle (matches the app's icon.png/
// apple-icon.png favicon glyph) as an inline SVG so it can be recolored per
// context: the header's logo tile, the decorative welcome-area mark, dark
// ink beside assistant messages. currentColor-based — set color via the
// `className`/`style` the caller passes, same convention as every lucide
// icon already used in this app.
export function AgentelseMark({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d="M12 0c.6 5.6 2 8.2 6.8 9.5.9.25.9 1.75 0 2-4.8 1.3-6.2 3.9-6.8 9.5-.08.7-1.12.7-1.2 0C10.2 15.4 8.8 12.8 4 11.5c-.9-.25-.9-1.75 0-2C8.8 8.2 10.2 5.6 10.8 0c.08-.7 1.12-.7 1.2 0Z" />
    </svg>
  );
}
