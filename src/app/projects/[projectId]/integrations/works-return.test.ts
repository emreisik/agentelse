import { describe, expect, it } from "vitest";

import { singleReturnTarget } from "./works-return";

const work = { id: "w1", title: "Launch", status: "ACTIVE" };

describe("singleReturnTarget", () => {
  it("keeps the ?from link when no channel row leads to that Work", () => {
    expect(singleReturnTarget(work, [{ workId: "w2" }])).toEqual({
      id: "w1",
      title: "Launch",
    });
  });

  it("drops it when a channel row already points at the same Work", () => {
    expect(singleReturnTarget(work, [{ workId: "w1" }])).toBeNull();
  });

  it("drops it for a missing or non-active Work", () => {
    expect(singleReturnTarget(null, [])).toBeNull();
    expect(singleReturnTarget({ ...work, status: "DONE" }, [])).toBeNull();
  });
});
