import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logos: new Map<string, Buffer>(),
  assetFindMany: vi.fn(),
  assetFindFirst: vi.fn(),
  style: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandDossier: {
      findUnique: async () => ({ approvedFonts: ["Montserrat"], language: "tr" }),
    },
    project: { findUnique: async () => ({ language: "tr" }) },
    asset: {
      findMany: mocks.assetFindMany,
      findFirst: mocks.assetFindFirst,
      findUnique: async ({ where }: { where: { id: string } }) => ({
        storageKey: where.id,
      }),
    },
  },
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: async (key: string) => mocks.logos.get(key)!,
}));
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext: mocks.style,
}));

import { ARCHETYPES } from "@/lib/auto-layout";
import {
  PREVIEW_FORMAT_KEYS,
  listPreviewPhotos,
  previewLookKey,
  renderDesignPreview,
  resetDesignPreviewCaches,
  sampleWordsFor,
} from "./design-preview";

const wordmark = (color: string) =>
  sharp(
    Buffer.from(
      `<svg width="600" height="160"><text x="5" y="120" font-size="120" font-weight="700" font-family="Helvetica" fill="${color}">bagna</text></svg>`,
    ),
  )
    .png()
    .toBuffer();

const identity = (enabled = true) => ({
  primaryColors: [{ hex: "#0b3d2e" }],
  secondaryColors: [],
  accentColors: [{ hex: "#f2b134" }],
  template: { enabled },
});

describe("design previews", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetDesignPreviewCaches();
    mocks.logos.set("L", await wordmark("#ffffff"));
    mocks.logos.set("D", await wordmark("#0b3d2e"));
    mocks.assetFindMany.mockResolvedValue([]);
    mocks.assetFindFirst.mockResolvedValue(null);
    mocks.style.mockResolvedValue({
      logoAssetId: "L",
      darkLogoAssetId: "D",
      legacyApprovedColors: null,
      visualIdentity: identity(),
    });
  });

  it("draws every design on every format, as a 640px-wide picture in the format's shape", async () => {
    const shapes = { feed: 3 / 4, square: 1, landscape: 1080 / 566, story: 9 / 16 };
    for (const format of PREVIEW_FORMAT_KEYS) {
      for (const design of ARCHETYPES) {
        const image = await renderDesignPreview({
          projectId: "p1",
          brandId: "b1",
          design,
          format,
        });
        const meta = await sharp(image).metadata();
        expect(meta.format).toBe("webp");
        expect(meta.width).toBe(640);
        expect(Math.abs(meta.width! / meta.height! - shapes[format])).toBeLessThan(0.02);
      }
    }
  }, 60_000);

  it("shows different designs differently, and the same design the same", async () => {
    const draw = (design: (typeof ARCHETYPES)[number]) =>
      renderDesignPreview({ projectId: "p1", brandId: "b1", design, format: "feed" });
    const [a, b, a2] = await Promise.all([draw("editorial"), draw("promo"), draw("editorial")]);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(a2)).toBe(true);
  });

  it("changes when the brand's logo or colours change", async () => {
    const draw = () =>
      renderDesignPreview({ projectId: "p1", brandId: "b1", design: "statement", format: "square" });
    const before = await draw();
    mocks.style.mockResolvedValue({
      logoAssetId: "L",
      darkLogoAssetId: "D",
      legacyApprovedColors: null,
      visualIdentity: {
        ...identity(),
        primaryColors: [{ hex: "#7a1030" }],
        accentColors: [{ hex: "#10a0c0" }],
      },
    });
    // What was read about the brand is kept for a moment (six cards, one read);
    // a change shows once that has lapsed.
    resetDesignPreviewCaches();
    expect(before.equals(await draw())).toBe(false);
  });

  it("reads the brand once for all the cards of a page", async () => {
    await Promise.all(
      ARCHETYPES.map((design) =>
        renderDesignPreview({ projectId: "p1", brandId: "b1", design, format: "feed" }),
      ),
    );
    expect(mocks.style).toHaveBeenCalledTimes(1);
  });

  it("gives a look key that changes with the look and only then", async () => {
    const first = await previewLookKey("p1", "b1");
    expect(await previewLookKey("p1", "b1")).toBe(first);
    mocks.style.mockResolvedValue({
      logoAssetId: "L2",
      darkLogoAssetId: "D",
      legacyApprovedColors: null,
      visualIdentity: identity(),
    });
    resetDesignPreviewCaches();
    mocks.logos.set("L2", await wordmark("#ffffff"));
    expect(await previewLookKey("p1", "b1")).not.toBe(first);
  });

  it("uses the brand's own photo when it has one, and falls back to a sample when it is not theirs", async () => {
    mocks.logos.set(
      "photo-1",
      await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3366cc" } })
        .jpeg()
        .toBuffer(),
    );
    mocks.assetFindFirst.mockResolvedValue({ storageKey: "photo-1" });
    const own = await renderDesignPreview({
      projectId: "p1", brandId: "b1", design: "minimal-luxe", format: "square", photo: "ownphoto",
    });
    mocks.assetFindFirst.mockResolvedValue(null);
    const stranger = await renderDesignPreview({
      projectId: "p1", brandId: "b1", design: "minimal-luxe", format: "square", photo: "someone-elses",
    });
    const sample = await renderDesignPreview({
      projectId: "p1", brandId: "b1", design: "minimal-luxe", format: "square", photo: "sample-1",
    });
    expect(own.equals(sample)).toBe(false);
    // A picture that is not the brand's never shows: it falls back to the sample.
    expect(stranger.equals(sample)).toBe(true);
    // The lookup is always scoped to the project.
    expect(mocks.assetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "p1", type: "IMAGE" }),
      }),
    );
  });

  it("lists only the project's own uploaded pictures", async () => {
    mocks.assetFindMany.mockResolvedValue([{ id: "a" }]);
    expect(await listPreviewPhotos("p1")).toEqual([{ id: "a" }]);
    expect(mocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "p1",
          type: "IMAGE",
          source: "CUSTOMER_UPLOAD",
        }),
      }),
    );
  });
});

describe("sampleWordsFor", () => {
  it("speaks the brand's language", () => {
    expect(sampleWordsFor("tr").cta).toBe("Hemen keşfet");
    expect(sampleWordsFor("mk-MK").cta).toBe("Откриј сега");
    expect(sampleWordsFor("xx").cta).toBe("Explore now");
    expect(sampleWordsFor(null).cta).toBe("Explore now");
  });

  it("always highlights words that are in its headline", () => {
    for (const lang of ["tr", "mk", "en"]) {
      const words = sampleWordsFor(lang);
      expect(words.headline.toLowerCase()).toContain(words.highlight.toLowerCase());
    }
  });
});
