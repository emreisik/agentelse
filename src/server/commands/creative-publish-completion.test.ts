import { beforeEach, describe, expect, it, vi } from "vitest";

// A Facebook delivery of a post (channel "facebook") is marked PUBLISHED when
// its share completes; a cross-post of another channel's piece never is (it
// would drop that piece from its own channel's schedule).

const taskFindUnique = vi.fn();
const creativeFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: taskFindUnique },
    creative: { findUnique: creativeFindUnique },
  },
}));
const transition = vi.fn();
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { transition },
}));
vi.mock("@/server/agency/learning/post-results", () => ({
  recordPublishedIdeaLink: vi.fn(),
}));

const { CreativePublishCompletion } = await import(
  "./creative-publish-completion"
);

function facebookShareOf(creativeId: string) {
  taskFindUnique.mockResolvedValue({
    id: "t1",
    status: "COMPLETED",
    capability: "FACEBOOK_PUBLISH",
    workspaceId: "ws",
    projectId: "p1",
    payload: { sharedCreativeId: creativeId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreativePublishCompletion and Facebook", () => {
  it("marks a post's Facebook delivery published", async () => {
    facebookShareOf("fb");
    creativeFindUnique.mockResolvedValue({ status: "APPROVED", channel: "facebook" });
    await CreativePublishCompletion.onTaskCompleted("t1");
    expect(transition).toHaveBeenCalledWith("fb", "p1", "PUBLISHED");
  });

  it("leaves an Instagram piece shared to the Page as it is", async () => {
    facebookShareOf("ig");
    creativeFindUnique.mockResolvedValue({ status: "APPROVED", channel: "instagram" });
    await CreativePublishCompletion.onTaskCompleted("t1");
    expect(transition).not.toHaveBeenCalled();
  });
});
