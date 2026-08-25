import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchInstagramPostPreview } from "@/server/media/instagram-post-preview";

function htmlWithMeta(image: string | null, description: string | null) {
  const tags = [
    image ? `<meta property="og:image" content="${image}" />` : "",
    description
      ? `<meta property="og:description" content="${description}" />`
      : "",
  ].join("\n");
  return `<html><head>${tags}</head><body></body></html>`;
}

function mockFetchOnce(response: {
  ok: boolean;
  status?: number;
  text: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? 200,
      text: async () => response.text,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchInstagramPostPreview", () => {
  it("extracts image URL and decoded caption from a valid post page", async () => {
    mockFetchOnce({
      ok: true,
      text: htmlWithMeta(
        "https://scontent.cdninstagram.com/photo.jpg?a=1&amp;b=2",
        "424K likes, 1,204 comments - agpfoto on April 1, 2026: &quot;NASA launches Artemis II&quot;.",
      ),
    });

    const result = await fetchInstagramPostPreview(
      "https://www.instagram.com/p/DWm8OQKlKvC/",
    );

    expect(result).toEqual({
      ok: true,
      imageUrl: "https://scontent.cdninstagram.com/photo.jpg?a=1&b=2",
      caption:
        '424K likes, 1,204 comments - agpfoto on April 1, 2026: "NASA launches Artemis II".',
    });
  });

  it("accepts reel URLs", async () => {
    mockFetchOnce({
      ok: true,
      text: htmlWithMeta("https://scontent.cdninstagram.com/cover.jpg", null),
    });

    const result = await fetchInstagramPostPreview(
      "https://www.instagram.com/reel/ABC123xyz/",
    );

    expect(result.ok).toBe(true);
  });

  it("rejects non-Instagram-post URLs without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchInstagramPostPreview(
      "https://www.instagram.com/somebrand/",
    );

    expect(result).toEqual({
      ok: false,
      reason: "Not an instagram.com post/reel link",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns ok:false when og:image is missing from the page", async () => {
    mockFetchOnce({ ok: true, text: htmlWithMeta(null, "some caption") });

    const result = await fetchInstagramPostPreview(
      "https://www.instagram.com/p/DWm8OQKlKvC/",
    );

    expect(result.ok).toBe(false);
  });

  it("returns ok:false on a non-OK HTTP response", async () => {
    mockFetchOnce({ ok: false, status: 404, text: "" });

    const result = await fetchInstagramPostPreview(
      "https://www.instagram.com/p/DWm8OQKlKvC/",
    );

    expect(result).toEqual({ ok: false, reason: "HTTP 404" });
  });

  it("returns ok:false instead of throwing when fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const result = await fetchInstagramPostPreview(
      "https://www.instagram.com/p/DWm8OQKlKvC/",
    );

    expect(result).toEqual({ ok: false, reason: "network down" });
  });
});
