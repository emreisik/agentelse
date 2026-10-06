import { beforeEach, describe, expect, it, vi } from "vitest";

const graph = vi.hoisted(() => ({ metaFetch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./graph", () => graph);

import { metaBatchGet } from "./batch";

describe("metaBatchGet (F8)", () => {
  beforeEach(() => {
    graph.metaFetch.mockReset();
  });

  it("sends up to 50 GETs per call and keeps each answer apart", async () => {
    graph.metaFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const batch = JSON.parse(new URLSearchParams(init.body).get("batch")!) as {
        relative_url: string;
      }[];
      return batch.map((item, index) =>
        index === 1
          ? { code: 400, body: JSON.stringify({ error: { message: "Unsupported get request" } }) }
          : { code: 200, body: JSON.stringify({ id: item.relative_url.split("/")[1]!.split("?")[0] }) },
      );
    });
    const paths = Array.from({ length: 52 }, (_, index) => `${100 + index}?fields=id`);
    const results = await metaBatchGet<{ id: string }>(paths, "token");
    expect(graph.metaFetch).toHaveBeenCalledTimes(2);
    const firstBody = new URLSearchParams(graph.metaFetch.mock.calls[0]![1].body);
    expect(JSON.parse(firstBody.get("batch")!)).toHaveLength(50);
    expect(JSON.parse(firstBody.get("batch")!)[0].relative_url).toBe("v26.0/100?fields=id");
    expect(results).toHaveLength(52);
    expect(results[0]).toEqual({ ok: true, body: { id: "100" } });
    expect(results[1]).toEqual({ ok: false, status: 400, message: "Unsupported get request" });
  });

  it("treats a missing sub-response as a failure", async () => {
    graph.metaFetch.mockResolvedValue([null]);
    expect(await metaBatchGet(["1?fields=id"], "token")).toEqual([
      { ok: false, status: 0, message: "No response (timed out in the batch)" },
    ]);
  });
});
