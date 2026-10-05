import { isModuleKey, type ModuleKey } from "@/lib/modules/catalog";

// The sidebar's Recents learn about a chat the moment something is sent in it
// (docs/works.md), not when the reply ends: a turn that makes an image can take
// a minute. The chat screen announces the send and, when the turn is over, that
// it settled; the list's row follows that life (recents-announcer.ts). Browser
// events, so neither component imports the other.

export const WORK_ACTIVITY_EVENT = "agentelse:work-activity";
export const WORK_SETTLED_EVENT = "agentelse:work-settled";

export type WorkActivity = {
  projectId: string;
  workId: string;
  // What the list shows until the stored title arrives.
  title: string;
  // The module the chat is for (src/lib/modules), so its row shows the
  // module's icon at once; null or absent: a general chat.
  module?: ModuleKey | null;
};

export type WorkSettled = { projectId: string; workId: string };

export function isWorkActivity(value: unknown): value is WorkActivity {
  if (!value || typeof value !== "object") return false;
  const { projectId, workId, title, module } = value as Record<string, unknown>;
  return (
    typeof projectId === "string" &&
    typeof workId === "string" &&
    workId.length > 0 &&
    typeof title === "string" &&
    (module === undefined || module === null || isModuleKey(module))
  );
}

export function isWorkSettled(value: unknown): value is WorkSettled {
  if (!value || typeof value !== "object") return false;
  const { projectId, workId } = value as Record<string, unknown>;
  return (
    typeof projectId === "string" &&
    typeof workId === "string" &&
    workId.length > 0
  );
}

// What one project's sidebar takes from an event's detail: only its own
// project's, and only well-formed ones.
export function activityOf(
  projectId: string,
  detail: unknown,
): WorkActivity | null {
  return isWorkActivity(detail) && detail.projectId === projectId
    ? detail
    : null;
}

export function settledOf(
  projectId: string,
  detail: unknown,
): WorkSettled | null {
  return isWorkSettled(detail) && detail.projectId === projectId
    ? detail
    : null;
}

export function announceWorkActivity(activity: WorkActivity): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkActivity>(WORK_ACTIVITY_EVENT, { detail: activity }),
  );
}

export function announceWorkSettled(settled: WorkSettled): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkSettled>(WORK_SETTLED_EVENT, { detail: settled }),
  );
}
