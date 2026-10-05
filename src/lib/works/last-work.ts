// The chat (Work) a project was last open on, kept in a cookie so a panel
// reached by any link (a card, the sidebar, the right panel) can send
// "Back to chat" there instead of to a new chat. Scoped to the project's path.

export function lastWorkCookieName(projectId: string): string {
  return `ae_last_work_${projectId}`;
}

// Work ids are cuids (or the "today" key form); anything else is ignored.
export function parseLastWork(value: string | undefined | null): string | null {
  const id = value?.trim();
  return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export function lastWorkCookie(projectId: string, workId: string): string {
  return [
    `${lastWorkCookieName(projectId)}=${encodeURIComponent(workId)}`,
    `path=/projects/${projectId}`,
    `max-age=${60 * 60 * 24 * 30}`,
    "samesite=lax",
  ].join("; ");
}
