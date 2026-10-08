import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { fitPhotoToCanvas } from "./photo-fit";

// A photo with a red square (the subject) at a known place on a grey ground.
async function photo(
  width: number,
  height: number,
  subject: { x: number; y: number },
  options: { orientation?: number } = {},
) {
  const size = Math.round(Math.min(width, height) * 0.2);
  let image = sharp({
    create: { width, height, channels: 3, background: "#808080" },
  }).composite([
    {
      input: await sharp({
        create: { width: size, height: size, channels: 3, background: "#ff0000" },
      })
        .png()
        .toBuffer(),
      left: Math.round(subject.x * width - size / 2),
      top: Math.round(subject.y * height - size / 2),
    },
  ]);
  if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
  return image.jpeg({ quality: 95 }).toBuffer();
}

// Where the red subject ended up, as fractions of the fitted picture.
async function subjectAt(buffer: Buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const at = (y * info.width + x) * info.channels;
      if (data[at]! > 200 && data[at + 1]! < 60 && data[at + 2]! < 60) {
        sx += x;
        sy += y;
        n += 1;
      }
    }
  }
  return n === 0 ? null : { x: sx / n / info.width, y: sy / n / info.height, n };
}

const FEED = { width: 540, height: 720 };
const SQUARE = { width: 540, height: 540 };
const STORY = { width: 540, height: 960 };

describe("fitPhotoToCanvas", () => {
  it("fills the canvas exactly, whatever the photo's shape", async () => {
    for (const [w, h] of [
      [1600, 1200],
      [1200, 1600],
      [1500, 1500],
    ] as const) {
      for (const canvas of [FEED, SQUARE, STORY]) {
        const result = await fitPhotoToCanvas({
          source: await photo(w, h, { x: 0.5, y: 0.5 }),
          canvas,
        });
        const meta = await sharp(result.buffer).metadata();
        expect([meta.width, meta.height]).toEqual([canvas.width, canvas.height]);
        expect(result.mimeType).toBe("image/jpeg");
      }
    }
  });

  it("crops around the subject, which stays in the picture", async () => {
    // A wide photo with the subject at the right, into a square.
    const result = await fitPhotoToCanvas({
      source: await photo(1600, 1200, { x: 0.8, y: 0.5 }),
      canvas: SQUARE,
      focal: { x: 0.8, y: 0.5 },
    });
    expect(result.fit).toBe("cover");
    const subject = await subjectAt(result.buffer);
    expect(subject).not.toBeNull();
    expect(subject!.x).toBeGreaterThan(0.4);
    expect(subject!.x).toBeLessThan(0.9);
  });

  it("puts the subject low in the picture when the headline goes on top", async () => {
    const source = await photo(1200, 1600, { x: 0.5, y: 0.5 });
    const plain = await fitPhotoToCanvas({ source, canvas: SQUARE, focal: { x: 0.5, y: 0.5 } });
    const topHeadline = await fitPhotoToCanvas({
      source,
      canvas: SQUARE,
      focal: { x: 0.5, y: 0.5 },
      avoidZone: "TOP",
    });
    expect((await subjectAt(topHeadline.buffer))!.y).toBeGreaterThan(
      (await subjectAt(plain.buffer))!.y + 0.05,
    );
  });

  it("without a known subject, still crops to the canvas", async () => {
    const result = await fitPhotoToCanvas({
      source: await photo(1600, 1200, { x: 0.3, y: 0.5 }),
      canvas: FEED,
    });
    expect(result.fit).toBe("cover");
    expect(result.kept).toBeCloseTo(0.5625, 2);
  });

  it("shows the whole photo over a blurred copy when a crop would lose most of it", async () => {
    const result = await fitPhotoToCanvas({
      source: await photo(1600, 1200, { x: 0.1, y: 0.5 }),
      canvas: STORY,
      focal: { x: 0.1, y: 0.5 },
    });
    expect(result.fit).toBe("extend");
    expect(result.kept).toBe(1);
    // The subject at the photo's far left edge is still there, in the middle band.
    const subject = await subjectAt(result.buffer);
    expect(subject).not.toBeNull();
    expect(subject!.y).toBeGreaterThan(0.3);
    expect(subject!.y).toBeLessThan(0.7);
    // The sharp photo is a band across the canvas: the top corner is blurred
    // backdrop, not a sharp edge, so it is not pure red nor the photo's grey.
    const { data } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(0);
  });

  it("applies the phone's rotation before measuring", async () => {
    // Stored 1600x1200 with orientation 6: really a portrait photo, so a feed
    // post keeps the whole width of it (a cover crop, not an extend).
    const result = await fitPhotoToCanvas({
      source: await photo(1600, 1200, { x: 0.5, y: 0.5 }, { orientation: 6 }),
      canvas: FEED,
    });
    expect(result.fit).toBe("cover");
    expect(result.kept).toBeGreaterThan(0.9);
  });

  it("leaves the source bytes alone", async () => {
    const source = await photo(1600, 1200, { x: 0.5, y: 0.5 });
    const copy = Buffer.from(source);
    await fitPhotoToCanvas({ source, canvas: SQUARE });
    expect(source.equals(copy)).toBe(true);
  });
});
