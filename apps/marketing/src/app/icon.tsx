import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Same mark as AgentelseMark, simplified for legibility at favicon size:
// ink rounded-square badge, one white "signal" dot standing in for the
// full node/path glyph (which doesn't read at 16-32px). Monochrome, no
// signature color, matching the site's ink-on-white system.
export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0d0d0d",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          width: 11,
          height: 11,
          borderRadius: "9999px",
          background: "#ffffff",
        }}
      />
    </div>,
    size,
  );
}
