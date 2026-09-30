import { describe, expect, it } from "vitest";

import {
  RunGuard,
  SESSION_TURN_LIMITS,
  STOP_NOTICES,
  TURN_LIMITS,
  canonicalJson,
  limitsForSession,
  type GuardedTool,
} from "./run-guard";

// The allowance of one chat message: how many model rounds and work actions it
// may use, that the same action never runs twice, that a decision on the
// client's behalf comes first or not at all, and where a long message must
// stop (cost, time, size, rounds).

const work: GuardedTool = { name: "create_task", kind: "work" };
const image: GuardedTool = { name: "generate_image", kind: "work" };
const terminal: GuardedTool = { name: "ask_user", kind: "terminal" };
const note: GuardedTool = { name: "update_work_session", kind: "note" };
const read: GuardedTool = { name: "get_findings", kind: "read" };
const decision: GuardedTool = {
  name: "decide_approval",
  kind: "work",
  decisive: true,
};

// Admits an action the way the loop does: the slot check, then the parsed
// arguments.
function run(guard: RunGuard, tool: GuardedTool, args: unknown = {}) {
  return guard.slotBlock(tool) ?? guard.admit(tool, canonicalJson(args));
}

describe("an ordinary message", () => {
  it("gets one work action", () => {
    const guard = new RunGuard();

    expect(run(guard, work, { a: 1 })).toBeNull();
    expect(guard.workActions).toBe(1);
  });

  it("is told, in the wording the engine always used, when it asks for a second", () => {
    const guard = new RunGuard();
    run(guard, work, { a: 1 });

    expect(guard.slotBlock(work)).toBe(
      "Only one action per message is allowed and it already ran. Explain the outcome to the client; they can ask for the rest in a follow-up.",
    );
    expect(guard.slotBlock(image)).not.toBeNull();
  });

  it("counts a question to the client as its action", () => {
    const guard = new RunGuard();
    run(guard, terminal);

    expect(guard.slotBlock(work)).not.toBeNull();
  });

  it("looks things up and saves notes as often as it likes", () => {
    const guard = new RunGuard();
    run(guard, work, { a: 1 });

    for (let i = 0; i < 20; i += 1) {
      expect(run(guard, read, { i })).toBeNull();
      expect(run(guard, note, { i })).toBeNull();
    }
    expect(guard.workActions).toBe(1);
  });

  it("stops after six model rounds", () => {
    const guard = new RunGuard();

    expect(guard.beforeRound(5)).toBeNull();
    expect(guard.beforeRound(TURN_LIMITS.maxRounds)).toBe("rounds");
  });

  it("has no cost, time or size ceiling of its own", () => {
    let now = 0;
    const guard = new RunGuard(() => now);
    now = 60 * 60_000;

    expect(guard.beforeRound(0)).toBeNull();
    expect(
      guard.afterRound({ roundInputTokens: 10_000_000, turnCostUsd: 1_000 }),
    ).toBeNull();
    expect(guard.inSession).toBe(false);
  });
});

describe("a message under a work session", () => {
  const session = () => {
    const guard = new RunGuard();
    guard.enterSession(5);
    return guard;
  };

  it("gets several work actions", () => {
    const guard = session();

    for (let i = 0; i < SESSION_TURN_LIMITS.maxWorkActions; i += 1) {
      expect(run(guard, work, { step: i })).toBeNull();
    }
    expect(guard.workActions).toBe(SESSION_TURN_LIMITS.maxWorkActions);
  });

  it("is told how many it had when they are used up", () => {
    const guard = session();
    for (let i = 0; i < SESSION_TURN_LIMITS.maxWorkActions; i += 1) {
      run(guard, work, { step: i });
    }

    expect(guard.slotBlock(work)).toContain(
      String(SESSION_TURN_LIMITS.maxWorkActions),
    );
    expect(guard.slotBlock(read)).toBeNull();
  });

  it("gets far more model rounds", () => {
    const guard = session();

    expect(guard.beforeRound(6)).toBeNull();
    expect(guard.beforeRound(SESSION_TURN_LIMITS.maxRounds - 1)).toBeNull();
    expect(guard.beforeRound(SESSION_TURN_LIMITS.maxRounds)).toBe("rounds");
  });

  it("can join a message that was already under way", () => {
    const guard = new RunGuard();
    run(guard, work, { a: 1 });
    expect(guard.slotBlock(work)).not.toBeNull();

    guard.enterSession(5);

    expect(guard.inSession).toBe(true);
    expect(guard.slotBlock(work)).toBeNull();
    // What already ran still counts.
    expect(guard.workActions).toBe(1);
  });

  it("stops when the message has run out of time", () => {
    let now = 1_000;
    const guard = new RunGuard(() => now);
    guard.enterSession(5);

    now += SESSION_TURN_LIMITS.maxMs - 1;
    expect(guard.beforeRound(3)).toBeNull();
    now += 1;
    expect(guard.beforeRound(3)).toBe("time");
  });

  it("stops when the message has cost its ceiling", () => {
    const guard = session();

    expect(
      guard.afterRound({ roundInputTokens: 1_000, turnCostUsd: 1.49 }),
    ).toBeNull();
    expect(
      guard.afterRound({ roundInputTokens: 1_000, turnCostUsd: 1.5 }),
    ).toBe("cost");
  });

  it("reports the session's budget instead when that is what ran out", () => {
    const guard = new RunGuard();
    guard.enterSession(0.4);

    expect(
      guard.afterRound({ roundInputTokens: 1_000, turnCostUsd: 0.39 }),
    ).toBeNull();
    expect(
      guard.afterRound({ roundInputTokens: 1_000, turnCostUsd: 0.4 }),
    ).toBe("budget");
  });

  it("stops when the conversation has grown too large to resend", () => {
    const guard = session();

    expect(
      guard.afterRound({
        roundInputTokens: SESSION_TURN_LIMITS.maxInputTokens - 1,
        turnCostUsd: 0.1,
      }),
    ).toBeNull();
    expect(
      guard.afterRound({
        roundInputTokens: SESSION_TURN_LIMITS.maxInputTokens,
        turnCostUsd: 0.1,
      }),
    ).toBe("context");
  });
});

describe("the same action twice", () => {
  it("does not run twice, however the arguments are ordered", () => {
    const guard = new RunGuard();
    guard.enterSession(5);

    expect(
      run(guard, image, { imagePrompt: "a", nested: { x: 1, y: 2 } }),
    ).toBeNull();
    const again = run(guard, image, {
      nested: { y: 2, x: 1 },
      imagePrompt: "a",
    });

    expect(again).toContain("already ran in this message");
    expect(guard.workActions).toBe(1);
  });

  it("runs a different action of the same tool", () => {
    const guard = new RunGuard();
    guard.enterSession(5);

    expect(run(guard, image, { imagePrompt: "a" })).toBeNull();
    expect(run(guard, image, { imagePrompt: "b" })).toBeNull();
    expect(guard.workActions).toBe(2);
  });

  it("does not treat the same arguments to another tool as a repeat", () => {
    const guard = new RunGuard();
    guard.enterSession(5);

    expect(run(guard, work, { brief: "x" })).toBeNull();
    expect(run(guard, image, { brief: "x" })).toBeNull();
  });

  it("lets a lookup or a progress note repeat", () => {
    const guard = new RunGuard();
    guard.enterSession(5);

    expect(run(guard, read, { q: "x" })).toBeNull();
    expect(run(guard, read, { q: "x" })).toBeNull();
    expect(run(guard, note, { s: "s1" })).toBeNull();
    expect(run(guard, note, { s: "s1" })).toBeNull();
  });

  it("does not use up an action when the arguments were the problem", () => {
    // The loop parses before admit(); an unparsable call never reaches it.
    const guard = new RunGuard();

    expect(guard.workActions).toBe(0);
    expect(run(guard, work, { a: 1 })).toBeNull();
  });
});

describe("a decision on the client's behalf", () => {
  it("may be the first action of a message, and work follows", () => {
    const guard = new RunGuard();
    guard.enterSession(5);

    expect(run(guard, decision, { decision: "APPROVE" })).toBeNull();
    expect(run(guard, work, { a: 1 })).toBeNull();
  });

  it("is refused once other work has run in the same message", () => {
    const guard = new RunGuard();
    guard.enterSession(5);
    run(guard, work, { a: 1 });

    const refused = run(guard, decision, { decision: "APPROVE" });

    expect(refused).toContain("first action");
    expect(guard.workActions).toBe(1);
  });

  it("is refused after a question to the client too", () => {
    const guard = new RunGuard();
    guard.enterSession(5);
    run(guard, terminal);

    expect(run(guard, decision, { decision: "APPROVE" })).not.toBeNull();
  });

  it("is not refused by a lookup or a note that came before it", () => {
    const guard = new RunGuard();
    guard.enterSession(5);
    run(guard, read, { q: "x" });
    run(guard, note, { s: "s1" });

    expect(run(guard, decision, { decision: "REJECT" })).toBeNull();
  });

  it("is only allowed once: a second decision is not the first action", () => {
    const guard = new RunGuard();
    guard.enterSession(5);
    run(guard, decision, { decision: "APPROVE" });

    expect(run(guard, decision, { decision: "REJECT" })).not.toBeNull();
  });
});

describe("limitsForSession", () => {
  it("caps a message at its own ceiling when the budget is ample", () => {
    expect(limitsForSession(5)).toMatchObject({
      maxCostUsd: SESSION_TURN_LIMITS.maxCostUsd,
      costStop: "cost",
    });
  });

  it("caps it at what the session has left when that is less", () => {
    expect(limitsForSession(0.3)).toMatchObject({
      maxCostUsd: 0.3,
      costStop: "budget",
    });
  });

  it("never goes below zero", () => {
    expect(limitsForSession(-2).maxCostUsd).toBe(0);
  });
});

describe("STOP_NOTICES", () => {
  it("has a plain sentence for every way a message can be cut short", () => {
    for (const reason of [
      "rounds",
      "time",
      "cost",
      "budget",
      "context",
      "daily",
    ] as const) {
      expect(STOP_NOTICES[reason].length).toBeGreaterThan(20);
    }
  });

  it("tells the client how to go on when going on is possible", () => {
    expect(STOP_NOTICES.rounds).toContain("continue");
    expect(STOP_NOTICES.cost).toContain("continue");
    expect(STOP_NOTICES.budget).toContain("new one");
  });
});

describe("canonicalJson", () => {
  it("is the same for the same content in any key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it("tells different content apart", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
