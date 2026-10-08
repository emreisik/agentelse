import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeBrandPhoto } from "./normalize";

const photo = (
  width: number,
  height: number,
  options: { orientation?: number; format?: "jpeg" | "png" | "webp" } = {},
) => {
  let image = sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } },
  });
  if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
  const format = options.format ?? "jpeg";
  return image[format]().toBuffer();
};

describe("normalizeBrandPhoto", () => {
  it("makes a phone photo upright: EXIF orientation applied, sides swapped", async () => {
    // Stored 1200x800 with orientation 6 (rotate 90): it is a portrait photo.
    const result = await normalizeBrandPhoto(await photo(1200, 800, { orientation: 6 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.image.width, result.image.height]).toEqual([800, 1200]);
    const meta = await sharp(result.image.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([800, 1200]);
  });

  it("strips embedded metadata such as location and device", async () => {
    const withExif = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#336699" },
    })
      .withExif({ IFD0: { Copyright: "Secret Studio", Make: "SomeCamera" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const result = await normalizeBrandPhoto(withExif);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await sharp(result.image.buffer).metadata()).exif).toBeUndefined();
  });

  it("brings a huge photo down to 2400px on its long side, keeping its shape", async () => {
    const result = await normalizeBrandPhoto(await photo(6000, 4000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.image.width, result.image.height]).toEqual([2400, 1600]);
  });

  it("leaves a normal photo at its own size and encodes JPEG, PNG with alpha kept", async () => {
    const jpeg = await normalizeBrandPhoto(await photo(1600, 1200, { format: "webp" }));
    expect(jpeg).toMatchObject({ ok: true, image: { mimeType: "image/jpeg", ext: "jpg", width: 1600 } });
    const png = await sharp({
      create: { width: 900, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    expect(await normalizeBrandPhoto(png)).toMatchObject({
      ok: true,
      image: { mimeType: "image/png", ext: "png" },
    });
  });

  it("gives the same fingerprint to the same photo and a different one to another", async () => {
    const a = await normalizeBrandPhoto(await photo(1000, 800));
    const b = await normalizeBrandPhoto(await photo(1000, 800));
    const c = await normalizeBrandPhoto(await photo(1000, 801));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!(a.ok && b.ok && c.ok)) return;
    expect(a.image.hash).toBe(b.image.hash);
    expect(a.image.hash).not.toBe(c.image.hash);
  });

  it("refuses a picture that is too small, and anything that is not a picture", async () => {
    const small = await normalizeBrandPhoto(await photo(300, 300));
    expect(small).toMatchObject({ ok: false });
    if (!small.ok) expect(small.reason).toContain("too small");
    expect(await normalizeBrandPhoto(Buffer.from("not an image"))).toMatchObject({
      ok: false,
      reason: "That file isn't a picture.",
    });
    const gif = await sharp({
      create: { width: 600, height: 600, channels: 3, background: "#fff" },
    })
      .gif()
      .toBuffer();
    expect(await normalizeBrandPhoto(gif)).toMatchObject({ ok: false });
  });
});
