import { describe, expect, it } from "vitest";

import { changeIdsOf, cmsUntreatedPageIds, markCmsFailed } from "./cms-items";

// Bu dosyanın kanıtladığı: CMS öğe kaydından değişiklik kimlikleri okunur,
// değişikliği yapılmamış sayfalar bulunur ve başarısız değişiklikler işaretlenir.

const RAW = {
  v: 1,
  items: [
    { pageId: "p1", changeId: "c1", skipped: null },
    { pageId: "p2", changeId: null, skipped: "NO_TITLE" },
    { pageId: "p3", changeId: "c3", skipped: null },
  ],
};

describe("cms items", () => {
  it("lists change ids and tolerates malformed input", () => {
    expect(changeIdsOf(RAW)).toEqual(["c1", "c3"]);
    expect(changeIdsOf(null)).toEqual([]);
    expect(changeIdsOf({ items: "x" })).toEqual([]);
  });

  it("finds the pages that never got a change", () => {
    expect([...cmsUntreatedPageIds(RAW)]).toEqual(["p2"]);
    expect(cmsUntreatedPageIds(undefined).size).toBe(0);
  });

  it("marks failed changes as FAILED and keeps the rest", () => {
    const marked = markCmsFailed(RAW, ["c3"]);
    expect(marked.items[2]).toEqual({ pageId: "p3", changeId: null, skipped: "FAILED" });
    expect([...cmsUntreatedPageIds(marked)].sort()).toEqual(["p2", "p3"]);
    expect(changeIdsOf(marked)).toEqual(["c1"]);
  });
});
