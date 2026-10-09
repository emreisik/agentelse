import { describe, expect, it } from "vitest";

import { REVISION_POLICY } from "./plans";
import {
  isImageRevision,
  pictureWasDrawn,
  quoteRevision,
  wasPaidRevision,
  type RevisionVersion,
} from "./revision-policy";

// The post's history as the revision action reads it: job-drawn picture first,
// then whatever the person did to it. One helper per kind of version, named after
// what really writes it.
let counter = 0;
function version(overrides: Partial<RevisionVersion> = {}): RevisionVersion {
  counter += 1;
  return {
    version: counter,
    assetId: `asset-${counter}`,
    generationProvider: "openai-creative",
    generationMetadata: { prompt: "p" },
    revisionReason: null,
    ...overrides,
  };
}

function history(...versions: Partial<RevisionVersion>[]): RevisionVersion[] {
  counter = 0;
  return versions.map((overrides) => version(overrides));
}

const drawnByJob: Partial<RevisionVersion> = {};
const freeRevision: Partial<RevisionVersion> = {
  generationProvider: "openai",
  revisionReason: "Image regenerated per instruction: warmer",
};
const editedRevision: Partial<RevisionVersion> = {
  generationProvider: "openai",
  revisionReason: "Image edited per instruction: remove the logo",
};
const paidRevision: Partial<RevisionVersion> = {
  ...freeRevision,
  generationMetadata: { prompt: "p", paid: true },
};
const captionEdit: Partial<RevisionVersion> = {
  revisionReason: "Edited by you",
};
const variantPick: Partial<RevisionVersion> = {
  revisionReason: "Picked another picture",
};

describe("isImageRevision", () => {
  it("recognises exactly the reasons performCreativeRevision writes", () => {
    expect(isImageRevision(version(freeRevision))).toBe(true);
    expect(isImageRevision(version(editedRevision))).toBe(true);
    expect(
      isImageRevision(version({ revisionReason: "Image regenerated" })),
    ).toBe(true);
    expect(isImageRevision(version(captionEdit))).toBe(false);
    expect(isImageRevision(version(variantPick))).toBe(false);
    expect(isImageRevision(version({ revisionReason: null }))).toBe(false);
  });
});

describe("pictureWasDrawn", () => {
  it("is true for a picture a model drew", () => {
    expect(pictureWasDrawn(version(drawnByJob))).toBe(true);
    expect(pictureWasDrawn(version(freeRevision))).toBe(true);
  });

  it("is false without a picture or without a generation provider (a library upload)", () => {
    expect(pictureWasDrawn(version({ assetId: null }))).toBe(false);
    expect(pictureWasDrawn(version({ generationProvider: null }))).toBe(false);
  });

  it("is false for the plan draft and SEO calendar placeholders", () => {
    expect(pictureWasDrawn(version({ generationProvider: "plan-run" }))).toBe(
      false,
    );
    expect(
      pictureWasDrawn(version({ generationProvider: "seo-manager" })),
    ).toBe(false);
  });

  it("is false for a picture cut from the brand's own photo", () => {
    expect(
      pictureWasDrawn(
        version({
          generationMetadata: {
            photoSource: { assetId: "photo-1", fit: "cover" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("is false for a picture adapted from the post's main picture", () => {
    expect(
      pictureWasDrawn(
        version({ generationMetadata: { adaptedFrom: "asset-main" } }),
      ),
    ).toBe(false);
  });

  it("tolerates metadata that is not an object", () => {
    expect(pictureWasDrawn(version({ generationMetadata: null }))).toBe(true);
    expect(pictureWasDrawn(version({ generationMetadata: "x" }))).toBe(true);
    expect(pictureWasDrawn(version({ generationMetadata: [1] }))).toBe(true);
  });
});

describe("wasPaidRevision", () => {
  it("reads only the explicit paid marker", () => {
    expect(wasPaidRevision(version(paidRevision))).toBe(true);
    expect(wasPaidRevision(version(freeRevision))).toBe(false);
    expect(
      wasPaidRevision(version({ generationMetadata: { paid: "yes" } })),
    ).toBe(false);
    expect(wasPaidRevision(version({ generationMetadata: null }))).toBe(false);
  });
});

describe("quoteRevision", () => {
  it("re-cutting the brand's photo draws nothing and costs nothing", () => {
    expect(
      quoteRevision({ versions: history(drawnByJob), cutsPhoto: true }),
    ).toEqual({ spendsRight: false, why: "photo-cut" });
    expect(quoteRevision({ versions: [], cutsPhoto: true }).spendsRight).toBe(
      false,
    );
  });

  it("the first picture of a post is its main image and costs a right", () => {
    expect(quoteRevision({ versions: [], cutsPhoto: false })).toEqual({
      spendsRight: true,
      why: "first-picture",
    });
    expect(
      quoteRevision({
        versions: history({ assetId: null, generationProvider: "plan-run" }),
        cutsPhoto: false,
      }).why,
    ).toBe("first-picture");
  });

  it("the first AI picture over a picture nobody paid for costs a right (upload, photo, adaptation)", () => {
    const upload = history({
      generationProvider: null,
      generationMetadata: null,
    });
    const photo = history({
      generationMetadata: { photoSource: { assetId: "p", fit: "cover" } },
    });
    const adapted = history({ generationMetadata: { adaptedFrom: "a" } });
    for (const versions of [upload, photo, adapted]) {
      expect(quoteRevision({ versions, cutsPhoto: false })).toEqual({
        spendsRight: true,
        why: "undrawn-picture",
      });
    }
  });

  it("an AI picture gets the free revisions, then each further one costs a right", () => {
    expect(REVISION_POLICY.freePerPost).toBe(2);
    const quote = (n: number) =>
      quoteRevision({
        versions: history(drawnByJob, ...Array(n).fill(freeRevision)),
        cutsPhoto: false,
      });
    expect(quote(0)).toEqual({ spendsRight: false, why: "free" });
    expect(quote(1)).toEqual({ spendsRight: false, why: "free" });
    expect(quote(2)).toEqual({ spendsRight: true, why: "beyond-free" });
    expect(quote(7)).toEqual({ spendsRight: true, why: "beyond-free" });
  });

  it("an edit uses the same free allowance as a regenerate", () => {
    expect(
      quoteRevision({
        versions: history(drawnByJob, freeRevision, editedRevision),
        cutsPhoto: false,
      }).why,
    ).toBe("beyond-free");
  });

  // The reason this works from the history and not from the version number:
  // editing the words or picking another picture also adds a version, but draws
  // nothing and must not use up the free revisions.
  it("caption edits and picture picks do not count as revisions", () => {
    const churn = [
      captionEdit,
      captionEdit,
      variantPick,
      captionEdit,
      variantPick,
    ];
    expect(
      quoteRevision({
        versions: history(drawnByJob, ...churn),
        cutsPhoto: false,
      }),
    ).toEqual({ spendsRight: false, why: "free" });
    expect(
      quoteRevision({
        versions: history(drawnByJob, freeRevision, ...churn),
        cutsPhoto: false,
      }),
    ).toEqual({ spendsRight: false, why: "free" });
    expect(
      quoteRevision({
        versions: history(drawnByJob, freeRevision, freeRevision, ...churn),
        cutsPhoto: false,
      }).why,
    ).toBe("beyond-free");
  });

  it("a revision that cost a right does not use up a free one", () => {
    expect(
      quoteRevision({
        versions: history(drawnByJob, paidRevision, freeRevision),
        cutsPhoto: false,
      }),
    ).toEqual({ spendsRight: false, why: "free" });
  });

  it("the first AI draw over an upload is paid; after it the two free revisions apply", () => {
    // upload -> paid AI picture (marked paid) -> still two free revisions.
    const afterPaidDraw = history(
      { generationProvider: null, generationMetadata: null },
      paidRevision,
    );
    expect(
      quoteRevision({ versions: afterPaidDraw, cutsPhoto: false }).why,
    ).toBe("free");
    const used = history(
      { generationProvider: null, generationMetadata: null },
      paidRevision,
      freeRevision,
      freeRevision,
    );
    expect(quoteRevision({ versions: used, cutsPhoto: false }).why).toBe(
      "beyond-free",
    );
  });

  it("does not depend on the order the versions arrive in", () => {
    const ordered = history(drawnByJob, freeRevision, freeRevision);
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    expect(quoteRevision({ versions: shuffled, cutsPhoto: false })).toEqual(
      quoteRevision({ versions: ordered, cutsPhoto: false }),
    );
  });

  it("judges the NEWEST picture: a photo-cut after AI drawings is judged as undrawn", () => {
    const versions = history(drawnByJob, freeRevision, {
      generationMetadata: { photoSource: { assetId: "p", fit: "cover" } },
    });
    expect(quoteRevision({ versions, cutsPhoto: false }).why).toBe(
      "undrawn-picture",
    );
  });
});
