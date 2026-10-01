import { describe, expect, it, vi } from "vitest";

// The old standalone routes keep working for bookmarks and old links. What this
// suite proves: each one sends its visitor to a screen that exists today (the
// Brand Brain tabs for what used to be Signals / Insights / Goals) and carries
// the record it pointed at, instead of a panel name that is no longer valid
// (which dropped the visitor into the chat).

class Redirected extends Error {
  constructor(readonly url: string) {
    super(url);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

const { parseHubParams } = await import("@/components/hub-core/hub-core-params");

async function follow(
  page: () => Promise<{
    default: (props: {
      params: Promise<{ projectId: string }>;
      searchParams: Promise<Record<string, string | string[] | undefined>>;
    }) => Promise<unknown>;
  }>,
  search: Record<string, string> = {},
): Promise<string> {
  const { default: Route } = await page();
  try {
    await Route({
      params: Promise.resolve({ projectId: "proj-1" }),
      searchParams: Promise.resolve(search),
    });
  } catch (error) {
    if (error instanceof Redirected) return error.url;
    throw error;
  }
  throw new Error("did not redirect");
}

const parse = (url: string) =>
  parseHubParams(Object.fromEntries(new URL(url, "http://x").searchParams));

describe("old standalone routes", () => {
  it("/istihbarat: signals and insights live in Brand Brain's Intelligence tab", async () => {
    const url = await follow(() => import("./istihbarat/page"));
    expect(url).toBe("/projects/proj-1?panel=brand-brain&sub=intelligence");
    const withSignal = await follow(() => import("./istihbarat/page"), { sinyal: "s1" });
    expect(parse(withSignal)).toMatchObject({
      panel: "brand-brain",
      sub: "intelligence",
      entity: { kind: "signal", id: "s1" },
    });
  });

  it("/firsatlar: opportunities go to Intelligence, goals to the Goals tab", async () => {
    expect(await follow(() => import("./firsatlar/page"))).toBe(
      "/projects/proj-1?panel=brand-brain&sub=intelligence",
    );
    expect(await follow(() => import("./firsatlar/page"), { tab: "hedefler" })).toBe(
      "/projects/proj-1?panel=brand-brain&sub=goals",
    );
    expect(
      parse(await follow(() => import("./firsatlar/page"), { firsat: "o1" })).entity,
    ).toEqual({ kind: "opportunity", id: "o1" });
  });

  it("/zeka: each of its old tabs maps, a record wins", async () => {
    const zeka = () => import("./zeka/page");
    expect(await follow(zeka, { tab: "sinyaller" })).toContain("sub=intelligence");
    expect(await follow(zeka, { tab: "icgoru-firsat" })).toContain("sub=intelligence");
    expect(await follow(zeka, { tab: "hedefler" })).toContain("sub=goals");
    expect(parse(await follow(zeka, { tab: "marka-beyni" }))).toMatchObject({
      panel: "brand-brain",
      sub: null,
    });
    // No tab: the goals tab (what it always opened), or the record asked for.
    expect(await follow(zeka)).toContain("sub=goals");
    expect(parse(await follow(zeka, { sinyal: "s9" })).entity).toEqual({
      kind: "signal",
      id: "s9",
    });
  });

  it("/beyin: Brand Brain, its old findings tab to Intelligence", async () => {
    expect(await follow(() => import("./beyin/page"))).toBe(
      "/projects/proj-1?panel=brand-brain",
    );
    expect(await follow(() => import("./beyin/page"), { tab: "bulgular" })).toContain(
      "sub=intelligence",
    );
  });

  it("/fikirler, /departmanlar, /isler, /ayarlar use today's panel names", async () => {
    expect(await follow(() => import("./fikirler/page"))).toBe("/projects/proj-1?panel=ideas");
    expect(parse(await follow(() => import("./fikirler/page"), { fikir: "i1" })).entity).toEqual({
      kind: "idea",
      id: "i1",
    });
    expect(await follow(() => import("./departmanlar/page"))).toBe(
      "/projects/proj-1?panel=departments",
    );
    expect(await follow(() => import("./isler/page"))).toBe(
      "/projects/proj-1?panel=work&sub=plans",
    );
    expect(await follow(() => import("./isler/page"), { tab: "gorevler" })).toBe(
      "/projects/proj-1?panel=work&sub=tasks",
    );
    expect(parse(await follow(() => import("./isler/page"), { plan: "w1" })).entity).toEqual({
      kind: "workPlan",
      id: "w1",
    });
    expect(await follow(() => import("./ayarlar/page"))).toBe(
      "/projects/proj-1?panel=settings&sub=autonomy",
    );
    expect(await follow(() => import("./ayarlar/page"), { tab: "tehlike" })).toBe(
      "/projects/proj-1?panel=settings&sub=risk",
    );
  });

  it("every redirect opens a panel that exists", async () => {
    const pages = [
      () => import("./istihbarat/page"),
      () => import("./firsatlar/page"),
      () => import("./zeka/page"),
      () => import("./beyin/page"),
      () => import("./fikirler/page"),
      () => import("./departmanlar/page"),
      () => import("./isler/page"),
      () => import("./ayarlar/page"),
    ];
    for (const page of pages) {
      expect(parse(await follow(page)).panel).not.toBeNull();
    }
  });
});
