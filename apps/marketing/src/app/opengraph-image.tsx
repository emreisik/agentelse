import { ImageResponse } from "next/og";

export const alt = "Agentelse — your AI social media team";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The share card: wordmark with its violet spark and the promise, drawn
// with the default font so it needs no file reads.
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background:
          "radial-gradient(circle at 50% -10%, rgba(139,92,246,0.22), rgba(255,255,255,0) 60%), #ffffff",
        color: "#14161d",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          fontSize: 44,
          fontWeight: 600,
        }}
      >
        agentelse
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          style={{ marginLeft: 4 }}
        >
          <path
            fill="#8b5cf6"
            d="M12 0c.9 6.4 5.1 10.8 12 12-6.9 1.2-11.1 5.6-12 12-.9-6.4-5.1-10.8-12-12C6.9 10.8 11.1 6.4 12 0Z"
          />
        </svg>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            fontSize: 92,
            fontWeight: 600,
            letterSpacing: -3,
            lineHeight: 1.02,
            maxWidth: 1000,
          }}
        >
          Your AI social media team.
        </div>
        <div style={{ fontSize: 30, color: "#5b6070" }}>
          Plans, designs and publishes your posts. You approve.
        </div>
      </div>
    </div>,
    size,
  );
}
