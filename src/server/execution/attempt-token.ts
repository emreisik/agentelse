// Names the plan-allowance reservation of one delivery attempt of a dispatch
// event (docs/billing-tasks.md, "Anahtar disiplini"). Pure, so the worker and the
// tests share the one rule.
//
// A resumed job (billing/park.ts) arrives with a token its hold was already
// reserved under: the FIRST attempt adopts that hold; every retry gets a token of
// its own like any other event (a failed attempt releases its key, so reusing the
// token would burn through the key space and, in the end, leave the job unable to
// reserve). Stable for a redelivery of the same attempt (a lease-expiry reclaim
// finds and adopts its own reservation instead of reserving twice).
export function dispatchAttemptToken(
  event: { id: string; attemptCount: number },
  payloadToken: string | undefined,
): string {
  if (!payloadToken) return `${event.id}.${event.attemptCount + 1}`;
  return event.attemptCount === 0
    ? payloadToken
    : `${payloadToken}.${event.attemptCount + 1}`;
}
