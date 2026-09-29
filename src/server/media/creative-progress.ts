import "server-only";

// In-process progress channel for a creative generation, keyed by the
// ExecutionJob id. The inline chat tool (generate_image) subscribes BEFORE it
// drives the job itself, and the OpenAI creative provider — running in the
// same process — publishes streamed partial previews here. Process-local on
// purpose: if a worker in another process happens to run the job instead,
// there are simply no listeners and the provider takes the non-streaming
// path, so nothing depends on this channel being reachable.

export type CreativeProgressEvent = {
  type: "partial";
  index: number;
  dataUrl: string;
};

type Listener = (event: CreativeProgressEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeCreativeProgress(
  executionJobId: string,
  listener: Listener,
): () => void {
  let set = listeners.get(executionJobId);
  if (!set) {
    set = new Set();
    listeners.set(executionJobId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(executionJobId);
  };
}

export function hasCreativeProgressListener(executionJobId: string): boolean {
  return (listeners.get(executionJobId)?.size ?? 0) > 0;
}

export function emitCreativeProgress(
  executionJobId: string,
  event: CreativeProgressEvent,
): void {
  for (const listener of listeners.get(executionJobId) ?? []) {
    try {
      listener(event);
    } catch {
      // A broken listener (e.g. a closed stream) must never break the
      // generation that is publishing to it.
    }
  }
}
