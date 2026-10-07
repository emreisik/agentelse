import { describe, expect, it } from "vitest";

import {
  approvalRowsFor,
  buildSeoApplyPayload,
  isSeoApplyPayload,
  seoApplyApprovalDetails,
  seoApplyChangeIdOf,
} from "./approval-details";
import { SEO_CHANGE_KINDS } from "./types";

const base = {
  host: "example.com",
  path: "/pricing",
  before: {},
  after: {},
  titleVia: null,
  undoText: "You can undo this for 90 days.",
} as const;

function value(rows: { label: string; value: string }[], label: string): string | undefined {
  return rows.find((row) => row.label === label)?.value;
}

describe("payload", () => {
  it("builds and guards a roundtrip", () => {
    const payload = buildSeoApplyPayload({
      changeId: "chg_1",
      kind: "TITLE_META",
      details: [{ label: "Where", value: "example.com" }],
    });
    expect(isSeoApplyPayload(payload)).toBe(true);
    expect(seoApplyChangeIdOf(payload)).toBe("chg_1");
    expect(seoApplyApprovalDetails(payload)).toEqual([{ label: "Where", value: "example.com" }]);
    // JSON'dan geçince de aynı
    expect(isSeoApplyPayload(JSON.parse(JSON.stringify(payload)))).toBe(true);
  });

  it("accepts every known kind", () => {
    for (const kind of SEO_CHANGE_KINDS) {
      expect(isSeoApplyPayload(buildSeoApplyPayload({ changeId: "c", kind, details: [] }))).toBe(true);
    }
  });

  it("is strict about the marker", () => {
    expect(isSeoApplyPayload(null)).toBe(false);
    expect(isSeoApplyPayload("x")).toBe(false);
    expect(isSeoApplyPayload({})).toBe(false);
    expect(isSeoApplyPayload({ seoApply: null })).toBe(false);
    expect(isSeoApplyPayload({ seoApply: { v: 2, changeId: "c", kind: "TITLE_META" } })).toBe(false);
    expect(isSeoApplyPayload({ seoApply: { v: 1, changeId: 5, kind: "TITLE_META" } })).toBe(false);
    expect(isSeoApplyPayload({ seoApply: { v: 1, changeId: "", kind: "TITLE_META" } })).toBe(false);
    expect(isSeoApplyPayload({ seoApply: { v: 1, changeId: "c", kind: "DELETE_SITE" } })).toBe(false);
    expect(seoApplyChangeIdOf({ details: [] })).toBeNull();
  });

  it("returns undefined for unmarked or malformed details", () => {
    expect(seoApplyApprovalDetails({ details: [{ label: "a", value: "b" }] })).toBeUndefined();
    expect(seoApplyApprovalDetails(undefined)).toBeUndefined();
    const mark = { seoApply: { v: 1, changeId: "c", kind: "TITLE_META" } };
    expect(seoApplyApprovalDetails(mark)).toBeUndefined();
    expect(seoApplyApprovalDetails({ ...mark, details: "nope" })).toBeUndefined();
    expect(seoApplyApprovalDetails({ ...mark, details: [null, 3, { label: 1, value: "x" }] })).toBeUndefined();
  });

  it("clips rows to 12 and values to 240 characters", () => {
    const payload = {
      seoApply: { v: 1, changeId: "c", kind: "TITLE_META" },
      details: Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, value: "x".repeat(500) })),
    };
    const rows = seoApplyApprovalDetails(payload);
    expect(rows).toHaveLength(12);
    expect(rows?.every((row) => row.value.length === 240)).toBe(true);
  });
});

describe("approvalRowsFor", () => {
  it("describes a draft creation", () => {
    const rows = approvalRowsFor({
      ...base,
      kind: "PUBLISH_ARTICLE",
      path: null,
      after: { title: "How to pick a plan", words: 820 },
    });
    expect(value(rows, "What happens")).toBe("Creates a draft on your WordPress site. It is not visible to visitors.");
    expect(value(rows, "Where")).toBe("example.com");
    expect(value(rows, "Page")).toBeUndefined();
    expect(value(rows, "Title")).toBe("How to pick a plan");
    expect(value(rows, "Length")).toBe("820 words");
    expect(value(rows, "Expires")).toBe("In 7 days if nobody decides");
    expect(value(rows, "Undo")).toBe(base.undoText);
  });

  it("describes making a draft live and warns when it was edited", () => {
    const plain = approvalRowsFor({ ...base, kind: "PUBLISH_LIVE" });
    expect(value(plain, "What happens")).toBe("Makes the draft visible to everyone on your site.");
    expect(value(plain, "Warning")).toBeUndefined();
    const edited = approvalRowsFor({ ...base, kind: "PUBLISH_LIVE", draftEditedSince: true });
    expect(value(edited, "Warning")).toBe("The draft was edited in WordPress after Agentelse created it.");
  });

  it("shows before and after for a title change", () => {
    const rows = approvalRowsFor({
      ...base,
      kind: "TITLE_META",
      before: { title: "Old title" },
      after: { title: "New title" },
      titleVia: "SEO_PLUGIN",
    });
    expect(value(rows, "Before")).toBe("Old title");
    expect(value(rows, "After")).toBe("New title");
    expect(value(rows, "Note")).toBeUndefined();
  });

  it("shows (default title) for an empty SEO title", () => {
    const rows = approvalRowsFor({
      ...base,
      kind: "TITLE_META",
      before: { title: "" },
      after: { title: "New title" },
      titleVia: "SEO_PLUGIN",
    });
    expect(value(rows, "Before")).toBe("(default title)");
  });

  it("adds the heading note when the title is the post title", () => {
    const rows = approvalRowsFor({
      ...base,
      kind: "TITLE_META",
      before: { title: "Old" },
      after: { title: "New" },
      titleVia: "POST_TITLE",
    });
    expect(value(rows, "Note")).toBe("This also changes the page heading on most themes.");
  });

  it("separates title and description rows when both change", () => {
    const rows = approvalRowsFor({
      ...base,
      kind: "TITLE_META",
      before: { title: "Old", description: "" },
      after: { title: "New", description: "A fresh description" },
      titleVia: "SEO_PLUGIN",
    });
    expect(value(rows, "Title before")).toBe("Old");
    expect(value(rows, "Title after")).toBe("New");
    expect(value(rows, "Description before")).toBe("(empty)");
    expect(value(rows, "Description after")).toBe("A fresh description");
    expect(rows.length).toBeLessThanOrEqual(12);
  });

  it("lists the links of an internal link change", () => {
    const rows = approvalRowsFor({
      ...base,
      kind: "INTERNAL_LINKS",
      after: {
        links: [
          { anchor: "pricing", toPath: "/pricing" },
          { anchor: "contact us", toPath: "/contact" },
        ],
      },
    });
    expect(value(rows, "Link 1")).toBe('"pricing" to /pricing');
    expect(value(rows, "Link 2")).toBe('"contact us" to /contact');
  });

  it("truncates every value to 240 characters and stays within 12 rows", () => {
    for (const kind of SEO_CHANGE_KINDS) {
      const rows = approvalRowsFor({
        ...base,
        kind,
        host: "h".repeat(400),
        path: "/" + "p".repeat(400),
        before: { title: "b".repeat(400), description: "d".repeat(400) },
        after: {
          title: "t".repeat(400),
          description: "m".repeat(400),
          links: Array.from({ length: 3 }, () => ({ anchor: "a".repeat(60), toPath: "/" + "x".repeat(400) })),
          words: 100,
        },
        titleVia: "POST_TITLE",
        draftEditedSince: true,
        undoText: "u".repeat(400),
      });
      expect(rows.length).toBeLessThanOrEqual(12);
      for (const row of rows) expect(Array.from(row.value).length).toBeLessThanOrEqual(240);
    }
  });
});
