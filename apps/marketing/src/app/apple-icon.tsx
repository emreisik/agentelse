import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Same AgentelseMark glyph as icon.tsx — the signal path through decision →
// coordination → execution. iOS applies its own corner rounding to
// home-screen icons, so the badge fills edge-to-edge (rx=0) here, unlike
// the browser-tab icon.tsx.
export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex" }}>
      <svg width="180" height="180" viewBox="0 0 24 24">
        <rect width="24" height="24" fill="#0d0d0d" />
        <path
          d="M5.75 15.75L10.5 9.5L14 13L18.25 7.75"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.15"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="5.75" cy="15.75" r="1.65" fill="#ffffff" />
        <circle cx="10.5" cy="9.5" r="1.65" fill="#ffffff" />
        <circle cx="14" cy="13" r="1.65" fill="#ffffff" />
        <circle cx="18.25" cy="7.75" r="1.65" fill="#ffffff" />
      </svg>
    </div>,
    size,
  );
}
