import { describe, expect, it } from "vitest";

import {
  CLUSTER_MAX_QUERIES,
  buildClusters,
  matchClusters,
  type BuiltCluster,
  type ClusterQueryInput,
} from "./clusters";
import { mockEmbedding } from "./vector";

function query(
  queryId: string,
  impressions: number,
  extra: Partial<ClusterQueryInput> = {},
): ClusterQueryInput {
  return {
    queryId,
    impressions,
    clicks: 1,
    topPageId: null,
    topPageShare: 0,
    vector: null,
    ...extra,
  };
}

describe("buildClusters", () => {
  it("joins queries whose shared top page carries ≥30% of each", () => {
    const clusters = buildClusters([
      query("q3", 50, { topPageId: "p1", topPageShare: 0.3 }),
      query("q1", 100, { topPageId: "p1", topPageShare: 0.9 }),
      query("q2", 80, { topPageId: "p1", topPageShare: 0.5 }),
      query("q4", 70, { topPageId: "p1", topPageShare: 0.29 }),
    ]);
    expect(clusters).toEqual([
      {
        key: "q1",
        queryIds: ["q1", "q2", "q3"],
        impressions: 230,
        clicks: 3,
        pillarPageId: "p1",
      },
    ]);
  });

  it("joins by cosine and picks the pillar by summed impressions", () => {
    const clusters = buildClusters([
      query("b", 100, {
        vector: mockEmbedding("running shoes"),
        topPageId: "p2",
        topPageShare: 0.1,
      }),
      query("a", 90, {
        vector: mockEmbedding("running shoe"),
        topPageId: "p1",
        topPageShare: 0.1,
      }),
      query("c", 80, {
        vector: mockEmbedding("running shoes "),
        topPageId: "p1",
        topPageShare: 0.1,
      }),
      query("d", 500, { vector: mockEmbedding("tax lawyer") }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      key: "a",
      queryIds: ["b", "a", "c"],
      pillarPageId: "p1",
      impressions: 270,
    });
  });

  it("drops groups under three and sorts by impressions", () => {
    const clusters = buildClusters([
      query("x1", 10, { topPageId: "px", topPageShare: 1 }),
      query("x2", 10, { topPageId: "px", topPageShare: 1 }),
      query("y1", 5, { topPageId: "py", topPageShare: 1 }),
      query("y2", 5, { topPageId: "py", topPageShare: 1 }),
      query("y3", 5, { topPageId: "py", topPageShare: 1 }),
      query("z1", 50, { topPageId: "pz", topPageShare: 1 }),
      query("z2", 50, { topPageId: "pz", topPageShare: 1 }),
      query("z3", 50, { topPageId: "pz", topPageShare: 1 }),
    ]);
    expect(clusters.map((cluster) => cluster.key)).toEqual(["z1", "y1"]);
  });

  it("caps the input at the top 2000 queries by impressions", () => {
    const inputs = Array.from({ length: CLUSTER_MAX_QUERIES }, (_, index) =>
      query(`top-${String(index).padStart(4, "0")}`, 10_000 - index),
    );
    inputs.push(
      query("low-1", 1, { topPageId: "p", topPageShare: 1 }),
      query("low-2", 1, { topPageId: "p", topPageShare: 1 }),
      query("low-3", 1, { topPageId: "p", topPageShare: 1 }),
    );
    expect(buildClusters(inputs)).toEqual([]);
  });

  it("is deterministic whatever the input order", () => {
    const inputs = [
      query("m", 10, { topPageId: "p", topPageShare: 0.5 }),
      query("k", 10, { topPageId: "p", topPageShare: 0.5 }),
      query("n", 10, { topPageId: "p", topPageShare: 0.5 }),
    ];
    const forward = buildClusters(inputs);
    const backward = buildClusters([...inputs].reverse());
    expect(forward).toEqual(backward);
    expect(forward[0]?.key).toBe("k");
  });
});

describe("matchClusters", () => {
  const built = (key: string, queryIds: string[]): BuiltCluster => ({
    key,
    queryIds,
    impressions: 0,
    clicks: 0,
    pillarPageId: null,
  });

  it("carries ids over at Jaccard ≥ 0.5 only", () => {
    const map = matchClusters(
      [
        { id: "old-1", queryIds: ["a", "b", "c"] },
        { id: "old-2", queryIds: ["x", "y", "z", "w"] },
      ],
      [built("a", ["a", "b", "d"]), built("x", ["x", "y", "q", "r", "s"])],
    );
    // {a,b,c} ∩ {a,b,d} = 2 / 4 = 0.5; {x,y,z,w} ∩ {x,y,q,r,s} = 2 / 7.
    expect([...map]).toEqual([["a", "old-1"]]);
  });

  it("matches one-to-one, best overlap first", () => {
    const map = matchClusters(
      [{ id: "old", queryIds: ["a", "b", "c", "d"] }],
      [built("a", ["a", "b", "c"]), built("b", ["a", "b", "c", "d"])],
    );
    expect([...map]).toEqual([["b", "old"]]);
  });
});
