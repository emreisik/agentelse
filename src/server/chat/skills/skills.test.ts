import { CapabilityKey } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Skills replace the departments the chat agent used to be organised around.
// This suite keeps the registry honest against the things it must agree with:
// the department table (who owns which capability), the chat capability list
// (nothing added without a home), the deliverable catalog, and the real tool
// names its instructions refer to.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin: vi.fn() }));
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision: vi.fn(),
}));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));

const { DEPARTMENTS } =
  await import("@/server/agency/departments/department-registry");
const { CHAT_CAPABILITIES } = await import("../constants");
const { DELIVERABLE_KEYS } = await import("../deliverables");
const { CHAT_INSTRUCTIONS } = await import("../prompt");
const { toolsForPhase } = await import("../tools");
const { SKILL_KEYS, SKILLS, skillCatalog, skillForCapability } =
  await import("./registry");

beforeEach(() => {
  // The default: the legacy loop fully on, so every tool is offered.
  delete process.env.LEGACY_AGENCY_LOOP;
});

// Every capability some department owns.
const ownedByADepartment = new Set(
  Object.values(DEPARTMENTS).flatMap(
    (department) => department.ownedCapabilities,
  ),
);

describe("the skill registry", () => {
  it("has one entry per key, each carrying its own key", () => {
    expect(Object.keys(SKILLS).sort()).toEqual([...SKILL_KEYS].sort());
    for (const key of SKILL_KEYS) {
      expect(SKILLS[key].key).toBe(key);
    }
  });

  it("gives every skill a label, a short summary and real numbered steps", () => {
    for (const key of SKILL_KEYS) {
      const skill = SKILLS[key];
      expect(skill.label.length, key).toBeGreaterThan(0);
      expect(skill.summary.length, key).toBeGreaterThan(10);
      expect(skill.summary.length, key).toBeLessThan(90);
      expect(skill.instructions.length, key).toBeGreaterThan(300);
      expect(skill.instructions.startsWith("1. "), key).toBe(true);
    }
  });

  it("only names real capabilities, each owned by a department in the registry", () => {
    const real = new Set<string>(Object.values(CapabilityKey));
    for (const key of SKILL_KEYS) {
      for (const capability of SKILLS[key].capabilities) {
        expect(real.has(capability), `${key}: ${capability}`).toBe(true);
        expect(
          ownedByADepartment.has(capability),
          `${key}: ${capability} is owned by no department`,
        ).toBe(true);
      }
    }
  });

  it("gives every capability to at most one skill", () => {
    const seen = new Map<string, string>();
    for (const key of SKILL_KEYS) {
      for (const capability of SKILLS[key].capabilities) {
        expect(
          seen.has(capability),
          `${capability} is in both ${seen.get(capability)} and ${key}`,
        ).toBe(false);
        seen.set(capability, key);
      }
    }
  });

  it("leaves only publishing and account setup without a skill, so a new capability cannot be added without a home", () => {
    const unassigned = CHAT_CAPABILITIES.filter(
      (capability) => skillForCapability(capability) === undefined,
    );

    // These act through approvals and the channel connections, not through a
    // way of working. Anything else showing up here needs a decision.
    expect([...unassigned].sort()).toEqual(
      [
        "INSTAGRAM_PUBLISH",
        "LINKEDIN_PUBLISH",
        "SOCIAL_ACCOUNT_SETUP",
        "TIKTOK_PUBLISH",
        "X_PUBLISH",
      ].sort(),
    );
  });

  it("gives every content-package deliverable to exactly one skill", () => {
    for (const deliverable of DELIVERABLE_KEYS) {
      const owners = SKILL_KEYS.filter((key) =>
        SKILLS[key].deliverables.includes(deliverable),
      );
      expect(owners, deliverable).toHaveLength(1);
    }
  });

  it("finds the skill that owns a capability", () => {
    expect(skillForCapability("CREATE_COPY")).toBe("content");
    expect(skillForCapability("COMPETITOR_RESEARCH")).toBe("research");
    expect(skillForCapability("META_CAMPAIGN_CREATE")).toBe("ads");
    expect(skillForCapability("SEO_ANALYSIS")).toBe("seo");
    expect(skillForCapability("CREATE_SOCIAL_CREATIVE")).toBe("creative");
    expect(skillForCapability("INSTAGRAM_PUBLISH")).toBeUndefined();
  });

  it("lists every skill with its summary in the catalog", () => {
    const catalog = skillCatalog();
    for (const key of SKILL_KEYS) {
      expect(catalog).toContain(`${key} (${SKILLS[key].summary})`);
    }
  });
});

describe("the tools the skills point at", () => {
  // Every tool the agent has in any phase (the hosted web search is OpenAI's,
  // present only when switched on).
  const realTools = new Set([
    ...toolsForPhase("ACTIVE").map((tool) => tool.name),
    ...toolsForPhase("ON_HOLD").map((tool) => tool.name),
    "web_search",
  ]);

  it("lists only tools that exist", () => {
    for (const key of SKILL_KEYS) {
      for (const tool of SKILLS[key].tools) {
        expect(realTools.has(tool), `${key}: ${tool}`).toBe(true);
      }
    }
  });

  it("refers to tools by their real names in the instructions, and to none that were removed", () => {
    const toolLike =
      /\b(?:get|create|generate|propose|start|save|load|ask|remember|suggest|decide)_[a-z_]+\b/g;
    for (const key of SKILL_KEYS) {
      const mentioned = SKILLS[key].instructions.match(toolLike) ?? [];
      for (const name of mentioned) {
        expect(realTools.has(name), `${key} mentions ${name}`).toBe(true);
      }
      expect(SKILLS[key].instructions).not.toContain("start_brand_setup");
    }
  });
});

describe("the agent's standing instructions", () => {
  it("tell the agent to load a skill before substantial work, and list them all", () => {
    expect(CHAT_INSTRUCTIONS).toContain("load_skill");
    for (const key of SKILL_KEYS) {
      expect(CHAT_INSTRUCTIONS).toContain(`${key} (${SKILLS[key].summary})`);
    }
  });

  it("keep the hard rules above whatever a skill says", () => {
    expect(CHAT_INSTRUCTIONS).toContain("never overrides these rules");
  });
});

describe("load_skill", () => {
  const tool = (phase: "ACTIVE" | "ON_HOLD" = "ACTIVE") =>
    toolsForPhase(phase).find((candidate) => candidate.name === "load_skill");
  const ctx = {
    workspaceId: "w",
    projectId: "p",
    brandId: "b",
    userId: "u",
    commandId: "c",
    message: "hi",
    phase: "ACTIVE" as const,
    emit: vi.fn(),
  };

  it("is a read tool, offered while the project can work and not while it is on hold", () => {
    expect(tool("ACTIVE")?.kind).toBe("read");
    expect(tool("ON_HOLD")).toBeUndefined();
  });

  it("describes every skill so the agent can choose without loading them all", () => {
    for (const key of SKILL_KEYS) {
      expect(tool()!.description).toContain(`${key} (${SKILLS[key].summary})`);
    }
  });

  it("hands back the steps, capabilities, deliverables and tools of the skill asked for", async () => {
    const outcome = await tool()!.execute({ skill: "creative" }, ctx);

    expect(outcome.result).toEqual({
      skill: "creative",
      name: "Creative",
      instructions: SKILLS.creative.instructions,
      capabilities: SKILLS.creative.capabilities,
      deliverables: ["instagram_post"],
      tools: SKILLS.creative.tools,
    });
  });

  it("accepts each skill key and rejects anything else", () => {
    const schema = tool()!.schema;
    for (const key of SKILL_KEYS) {
      expect(schema.safeParse({ skill: key }).success, key).toBe(true);
    }
    expect(schema.safeParse({ skill: "finance" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
