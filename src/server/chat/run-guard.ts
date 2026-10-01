// What one chat message may do before the agent must stop and hand back to the
// client. Ordinary messages get the small allowance the engine always had: a few
// model rounds and ONE work action, so a message can never fan out into
// duplicate work. A message that belongs to a work session gets a larger, still
// bounded, allowance so it can carry several steps in one go.
//
// Pure (no IO, no clock of its own) so the agent loop's limits can be tested
// without a model.

export type StopReason =
  "rounds" | "time" | "cost" | "budget" | "context" | "daily";

export type RunLimits = {
  maxRounds: number;
  maxWorkActions: number;
  // null: no ceiling.
  maxCostUsd: number | null;
  // What reaching maxCostUsd is reported as: this message's own ceiling, or the
  // session's remaining budget when that is the tighter of the two.
  costStop: "cost" | "budget";
  maxMs: number | null;
  // Size of the last model request. The conversation is resent every round, so
  // once it is this big the next round only gets bigger.
  maxInputTokens: number | null;
};

// Rounds are model <-> tool round trips. A normal turn is one round (a plain
// answer) or two (a tool call, then the wrap-up); read tools spend rounds too.
export const TURN_LIMITS: RunLimits = {
  maxRounds: 6,
  maxWorkActions: 1,
  maxCostUsd: null,
  costStop: "cost",
  maxMs: null,
  maxInputTokens: null,
};

export const SESSION_TURN_LIMITS = {
  maxRounds: 24,
  maxWorkActions: 6,
  maxCostUsd: 1.5,
  // Proxies in front of the app close a request that lives much longer.
  maxMs: 10 * 60_000,
  maxInputTokens: 150_000,
} as const;

export function limitsForSession(remainingBudgetUsd: number): RunLimits {
  const remaining = Math.max(0, remainingBudgetUsd);
  return {
    maxRounds: SESSION_TURN_LIMITS.maxRounds,
    maxWorkActions: SESSION_TURN_LIMITS.maxWorkActions,
    maxCostUsd: Math.min(SESSION_TURN_LIMITS.maxCostUsd, remaining),
    costStop: remaining < SESSION_TURN_LIMITS.maxCostUsd ? "budget" : "cost",
    maxMs: SESSION_TURN_LIMITS.maxMs,
    maxInputTokens: SESSION_TURN_LIMITS.maxInputTokens,
  };
}

// Added to the reply when a work session's message is cut short, so the client
// reads why it stopped and what to do.
export const STOP_NOTICES: Record<StopReason, string> = {
  rounds:
    'I stopped here because this message reached its step limit. Say "continue" and I will pick up where I left off.',
  time: 'I stopped here because this message reached its time limit. Say "continue" and I will pick up where I left off.',
  cost: 'I stopped here because this message reached its cost limit. Say "continue" and I will pick up where I left off.',
  budget:
    "I stopped here because this work session's budget is used up, so the session is closed. Tell me if you want to carry on and I will start a new one.",
  context:
    'I stopped here because the conversation has grown too long to keep going in one message. Say "continue" and I will pick up from the saved progress.',
  daily:
    "I stopped here because today's AI limit for this project is used up. The saved progress will still be here when it resets.",
};

export type GuardedTool = {
  name: string;
  kind: "work" | "terminal" | "note" | "read";
  // A decision or a long paid job: only ever the first action of a message.
  decisive?: boolean;
};

const ONE_ACTION =
  "Only one action per message is allowed and it already ran. Explain the outcome to the client; they can ask for the rest in a follow-up.";

const actionsUsedUp = (max: number) =>
  `The limit of ${max} actions for this message is used up. Say what is done and what is left; the client can ask you to continue in a follow-up.`;

const DECISIVE_FIRST =
  "Not done: a decision on the client's behalf, or a long paid job, is only started when the client asks for it in their message, and only as the first action of the reply, before any other work. Say what is pending and ask them to confirm it in their next message.";

// A tool that refused before writing anything gives its action back, so the
// model's corrected retry can run. Capped so a model that keeps getting refused
// cannot loop on free retries (rounds still bound it too).
export const MAX_ACTION_REFUNDS = 2;

const DUPLICATE =
  "That exact action already ran in this message and was not repeated. Use its result.";

// Work and terminal tools count against the action allowance; notes and reads
// (lookups, saving a preference, updating a session) never do.
const consumesAction = (tool: GuardedTool) =>
  tool.kind === "work" || tool.kind === "terminal";

// JSON with object keys sorted at every level, so the same arguments in a
// different order are the same action.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}

export class RunGuard {
  private limits: RunLimits = TURN_LIMITS;
  private inSessionRun = false;
  private actions = 0;
  private readonly ran = new Set<string>();
  private refunds = 0;
  private readonly startedAt: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.startedAt = clock();
  }

  // Whether this message runs under a work session's allowance.
  get inSession(): boolean {
    return this.inSessionRun;
  }

  // Work actions admitted so far this message.
  get workActions(): number {
    return this.actions;
  }

  // The message belongs to a session (one was already live, or the agent just
  // opened one): from here on the larger allowance applies. `remainingBudgetUsd`
  // is what the session may still spend.
  enterSession(remainingBudgetUsd: number): void {
    this.inSessionRun = true;
    this.limits = limitsForSession(remainingBudgetUsd);
  }

  // Before running model round `round` (0-based): why the message must stop
  // now, or null.
  beforeRound(round: number): StopReason | null {
    if (round >= this.limits.maxRounds) return "rounds";
    if (
      this.limits.maxMs !== null &&
      this.clock() - this.startedAt >= this.limits.maxMs
    ) {
      return "time";
    }
    return null;
  }

  // After a model round has come back and before its tool calls run.
  afterRound(usage: {
    roundInputTokens: number;
    turnCostUsd: number;
  }): StopReason | null {
    const { maxCostUsd, maxInputTokens, costStop } = this.limits;
    if (maxCostUsd !== null && usage.turnCostUsd >= maxCostUsd) {
      return costStop;
    }
    if (maxInputTokens !== null && usage.roundInputTokens >= maxInputTokens) {
      return "context";
    }
    return null;
  }

  // Checked before the arguments are even parsed: is there any action left?
  // Returns the text to hand the model, or null.
  slotBlock(tool: GuardedTool): string | null {
    if (!consumesAction(tool)) return null;
    if (this.actions < this.limits.maxWorkActions) return null;
    return this.limits.maxWorkActions === 1
      ? ONE_ACTION
      : actionsUsedUp(this.limits.maxWorkActions);
  }

  // Checked with the parsed arguments. On success the action is reserved (it
  // counts even if the tool then fails halfway: the work may already exist);
  // otherwise the text to hand the model.
  admit(tool: GuardedTool, argsKey: string): string | null {
    if (!consumesAction(tool)) return null;
    if (tool.decisive && this.actions > 0) return DECISIVE_FIRST;
    const key = `${tool.name}:${argsKey}`;
    if (this.ran.has(key)) return DUPLICATE;
    this.ran.add(key);
    this.actions += 1;
    return null;
  }

  // The tool admitted for `argsKey` refused without doing anything (nothing was
  // written, started or spent): hands its action back and forgets the call, so
  // a corrected retry is not answered with "one action per message". Returns
  // false (and keeps the action) once the per-message refund cap is used up or
  // when the call was never admitted.
  release(tool: GuardedTool, argsKey: string): boolean {
    if (!consumesAction(tool)) return false;
    const key = `${tool.name}:${argsKey}`;
    if (!this.ran.has(key) || this.actions === 0) return false;
    if (this.refunds >= MAX_ACTION_REFUNDS) return false;
    this.ran.delete(key);
    this.actions -= 1;
    this.refunds += 1;
    return true;
  }
}
