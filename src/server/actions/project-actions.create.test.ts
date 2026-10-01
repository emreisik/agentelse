import { beforeEach, describe, expect, it, vi } from "vitest";

// A real redirect() throws; the mock does the same so a redirect placed inside
// a try/catch would be swallowed exactly as it would in production.
class RedirectSignal extends Error {}
const redirect = vi.fn((...args: [string, string?]): never => {
  void args;
  throw new RedirectSignal("NEXT_REDIRECT");
});
vi.mock("next/navigation", () => ({
  redirect,
  RedirectType: { push: "push", replace: "replace" },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getEnv = vi.fn();
vi.mock("@/lib/env", () => ({ getEnv }));

const requireUser = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess: vi.fn(),
}));

const findFirstOrThrow = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { workspaceMember: { findFirstOrThrow } },
}));

const projectCreate = vi.fn();
vi.mock("@/server/repositories/project.repository", () => ({
  ProjectRepository: { create: projectCreate },
}));

const auditRecord = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const ensureProjectActive = vi.fn();
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));
const startIntakeAtCreate = vi.fn();
vi.mock("@/server/brand/intake-start", () => ({ startIntakeAtCreate }));
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => ({ putAsset: vi.fn() }));

const { createGuidedProjectAction, createProjectAction } = await import(
  "./project-actions"
);

function form(fields: Record<string, string | string[]>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      formData.append(key, item);
    }
  }
  return formData;
}

const valid = () =>
  form({
    name: "Qr Hub",
    domain: "https://www.Qrhub.com.tr/menu",
    language: "tr",
    country: ["TR", "MK"],
    localeSource: "tld",
  });

beforeEach(() => {
  vi.clearAllMocks();
  getEnv.mockReturnValue({ GUIDED_SETUP: true });
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  findFirstOrThrow.mockResolvedValue({ workspaceId: "ws-1" });
  projectCreate.mockResolvedValue({ id: "proj-1", brands: [{ id: "brand-1" }] });
  auditRecord.mockResolvedValue(undefined);
  ensureProjectActive.mockResolvedValue(undefined);
  startIntakeAtCreate.mockResolvedValue(undefined);
});

describe("createGuidedProjectAction", () => {
  it("refuses with the flag off and touches nothing (G48)", async () => {
    getEnv.mockReturnValue({ GUIDED_SETUP: false });
    const result = await createGuidedProjectAction(valid());
    expect(result.ok).toBe(false);
    expect(requireUser).not.toHaveBeenCalled();
    expect(projectCreate).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["name", { name: "  ", language: "tr", country: "TR" }],
    ["domain", { name: "A", domain: "not a domain", language: "tr", country: "TR" }],
    ["country", { name: "A", language: "tr" }],
    ["country", { name: "A", language: "tr", country: ["TR", "ZZ"] }],
    ["language", { name: "A", language: "xx", country: "TR" }],
  ])("returns a typed failure naming the %s field", async (field, fields) => {
    const result = await createGuidedProjectAction(form(fields));
    expect(result).toMatchObject({ ok: false, field });
    expect(projectCreate).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("creates the project with country === countries[0] and a normalized domain (G48)", async () => {
    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(projectCreate).toHaveBeenCalledTimes(1);
    expect(projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        name: "Qr Hub",
        slug: "qr-hub",
        domain: "qrhub.com.tr",
        language: "tr",
        country: "TR",
        countries: ["TR", "MK"],
      }),
    );
  });

  it("redirects to ?guide=setup with RedirectType.replace, outside the try/catch (G48)", async () => {
    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/projects/proj-1?guide=setup", "replace");
    // Had the redirect sat inside the slug loop's try/catch, its throw would
    // have been swallowed as a slug clash and the project created again.
    expect(projectCreate).toHaveBeenCalledTimes(1);
  });

  it("starts the intake once, after the project exists and before the redirect, with ids it derived itself", async () => {
    const order: string[] = [];
    startIntakeAtCreate.mockImplementation(async () => {
      order.push("intake");
    });
    redirect.mockImplementation((): never => {
      order.push("redirect");
      throw new RedirectSignal("NEXT_REDIRECT");
    });

    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(startIntakeAtCreate).toHaveBeenCalledTimes(1);
    expect(startIntakeAtCreate).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      domain: "qrhub.com.tr",
    });
    expect(order).toEqual(["intake", "redirect"]);
  });

  it("passes no website when none was typed, so nothing can start", async () => {
    await expect(
      createGuidedProjectAction(
        form({ name: "Qr Hub", language: "tr", country: "TR" }),
      ),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(startIntakeAtCreate.mock.calls[0]![0].domain).toBeUndefined();
  });

  it("still redirects, once, when the intake cannot even be started", async () => {
    startIntakeAtCreate.mockRejectedValue(new Error("scheduler exploded"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(projectCreate).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when the flag is off or the form is invalid", async () => {
    getEnv.mockReturnValue({ GUIDED_SETUP: false });
    await createGuidedProjectAction(valid());
    getEnv.mockReturnValue({ GUIDED_SETUP: true });
    await createGuidedProjectAction(form({ name: "  ", language: "tr", country: "TR" }));

    expect(startIntakeAtCreate).not.toHaveBeenCalled();
  });

  it("records project.created with the locale provenance", async () => {
    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-1",
        actorId: "user-1",
        action: "project.created",
        metadata: { localeSource: "tld" },
      }),
    );
  });

  it("drops an unknown provenance instead of storing it", async () => {
    await expect(
      createGuidedProjectAction(
        form({ name: "A", language: "tr", country: "TR", localeSource: "x" }),
      ),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(auditRecord.mock.calls[0]?.[0].metadata).toBeUndefined();
  });

  it("does not block on a failed activation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    ensureProjectActive.mockRejectedValue(new Error("boom"));
    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirect).toHaveBeenCalledWith("/projects/proj-1?guide=setup", "replace");
    log.mockRestore();
  });

  it("retries a slug clash with a suffix", async () => {
    projectCreate
      .mockRejectedValueOnce(new Error("unique"))
      .mockResolvedValueOnce({ id: "proj-2", brands: [{ id: "brand-2" }] });
    await expect(createGuidedProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(projectCreate).toHaveBeenCalledTimes(2);
    expect(projectCreate.mock.calls[1]?.[0].slug).toBe("qr-hub-1");
    expect(redirect).toHaveBeenCalledWith("/projects/proj-2?guide=setup", "replace");
  });

  it("gives up after too many slug clashes", async () => {
    projectCreate.mockRejectedValue(new Error("unique"));
    await expect(createGuidedProjectAction(valid())).rejects.toThrow("unique");
    expect(redirect).not.toHaveBeenCalled();
  });
});

// The kill switch: with the flag off the wizard posts to this untouched action.
describe("createProjectAction (legacy, characterization) (G71)", () => {
  it("still returns undefined on invalid input", async () => {
    await expect(
      createProjectAction(form({ name: "", language: "tr", country: "TR" })),
    ).resolves.toBeUndefined();
    await expect(
      createProjectAction(form({ name: "A", language: "xx", country: "TR" })),
    ).resolves.toBeUndefined();
    await expect(
      createProjectAction(form({ name: "A", language: "tr" })),
    ).resolves.toBeUndefined();
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("still redirects with exactly ONE argument, without the guide param", async () => {
    await expect(createProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect.mock.calls[0]).toEqual(["/projects/proj-1"]);
  });

  it("does not consult the flag", async () => {
    getEnv.mockReturnValue({ GUIDED_SETUP: false });
    await expect(createProjectAction(valid())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirect.mock.calls[0]).toEqual(["/projects/proj-1"]);
  });
});
