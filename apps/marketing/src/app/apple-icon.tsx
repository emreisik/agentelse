import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS applies its own corner rounding to home-screen icons, so this fills
// edge-to-edge (no border-radius) unlike the browser-tab icon.tsx.
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0d0d0d",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "9999px",
          background: "#ffffff",
        }}
      />
    </div>,
    size,
  );
}
