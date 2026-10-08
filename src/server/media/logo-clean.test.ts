import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  cleanLogo,
  isMonochromeLogo,
  knockoutLightBackground,
  logoForegroundLuminance,
  normalizeLogoUpload,
  tintLogo,
} from "./logo-clean";

async function markOnPaper(paper: string, mark: string, format: "png" | "jpeg") {
  const svg = `<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${paper}"/><rect x="60" y="60" width="280" height="80" fill="${mark}"/></svg>`;
  const image = sharp(Buffer.from(svg));
  return format === "png" ? image.png().toBuffer() : image.jpeg({ quality: 90 }).toBuffer();
}

async function pixel(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * 4;
  return { r: data[at]!, g: data[at + 1]!, b: data[at + 2]!, a: data[at + 3]! };
}

describe("knockoutLightBackground", () => {
  it("turns a plain white backdrop transparent and keeps the mark", async () => {
    const out = await knockoutLightBackground(
      await markOnPaper("#ffffff", "#0b3d2e", "jpeg"),
    );
    expect((await pixel(out, 5, 5)).a).toBe(0);
    const mark = await pixel(out, 200, 100);
    expect(mark.a).toBe(255);
    expect(mark.g).toBeGreaterThan(mark.r);
  });

  it("leaves a logo that is already transparent alone", async () => {
    const transparent = await sharp({
      create: {
        width: 100,
        height: 40,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 20, channels: 3, background: "#123456" },
          })
            .png()
            .toBuffer(),
          left: 30,
          top: 10,
        },
      ])
      .png()
      .toBuffer();
    expect(await knockoutLightBackground(transparent)).toBe(transparent);
  });

  it("leaves a coloured backdrop alone (it is part of the logo)", async () => {
    const badge = await markOnPaper("#0b3d2e", "#ffffff", "png");
    expect(await knockoutLightBackground(badge)).toBe(badge);
  });

  it("leaves a picture with no clear mark alone", async () => {
    const blank = await markOnPaper("#ffffff", "#ffffff", "png");
    expect(await knockoutLightBackground(blank)).toBe(blank);
  });

  it("returns garbage unchanged instead of throwing", async () => {
    const garbage = Buffer.from("not an image");
    expect(await knockoutLightBackground(garbage)).toBe(garbage);
  });
});

describe("cleanLogo", () => {
  it("also trims the empty border off the knocked-out mark", async () => {
    const out = await cleanLogo(await markOnPaper("#ffffff", "#0b3d2e", "png"));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeLessThan(330);
    expect(meta.height).toBeLessThan(110);
  });
});

describe("logo brightness and colour", () => {
  it("tells a dark mark from a light one by the mark, not its surroundings", async () => {
    const dark = await cleanLogo(await markOnPaper("#ffffff", "#101010", "png"));
    expect((await logoForegroundLuminance(dark))!).toBeLessThan(40);
    const light = await tintLogo(dark, "#ffffff");
    expect((await logoForegroundLuminance(light))!).toBeGreaterThan(240);
  });

  it("recognises a one-colour mark and a multi-colour one", async () => {
    const one = await cleanLogo(await markOnPaper("#ffffff", "#0b3d2e", "png"));
    expect(await isMonochromeLogo(one)).toBe(true);
    const two = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "#ff0000" },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 40, channels: 3, background: "#0000ff" },
          })
            .png()
            .toBuffer(),
          left: 40,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    expect(await isMonochromeLogo(two)).toBe(false);
  });

  it("repainting keeps the shape and the edges", async () => {
    const logo = await cleanLogo(await markOnPaper("#ffffff", "#0b3d2e", "png"));
    const before = await sharp(logo).metadata();
    const tinted = await tintLogo(logo, "#ffffff");
    const after = await sharp(tinted).metadata();
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect((await pixel(tinted, 10, 10)).a).toBe((await pixel(logo, 10, 10)).a);
  });
});

describe("black backdrops", () => {
  it("are kept unless the caller knows the logo was made on one", async () => {
    const onBlack = await markOnPaper("#000000", "#ffffff", "png");
    expect(await knockoutLightBackground(onBlack)).toBe(onBlack);
    const out = await knockoutLightBackground(onBlack, ["light", "dark"]);
    expect((await pixel(out, 5, 5)).a).toBe(0);
    expect((await pixel(out, 200, 100)).a).toBe(255);
  });
});

describe("normalizeLogoUpload", () => {
  it("stores the mark alone, with its real size", async () => {
    const result = await normalizeLogoUpload(
      await markOnPaper("#ffffff", "#0b3d2e", "jpeg"),
    );
    expect(result).not.toBeNull();
    expect(result!.width).toBeLessThan(330);
    expect(result!.height).toBeLessThan(110);
    const meta = await sharp(result!.png).metadata();
    expect([meta.width, meta.height]).toEqual([result!.width, result!.height]);
    expect(meta.format).toBe("png");
  });

  it("refuses what is not an image or is far too small", async () => {
    expect(await normalizeLogoUpload(Buffer.from("nope"))).toBeNull();
    const tiny = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    expect(await normalizeLogoUpload(tiny)).toBeNull();
  });
});
