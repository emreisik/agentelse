import type { WorkActivity } from "@/lib/works/work-activity";
import type { WorkStatusValue } from "@/lib/works/work";

// A chat joins the sidebar's Recents the moment something is sent in it
// (docs/works.md), not when the reply ends: a turn that makes an image can take
// a minute. This is that row's life, without React so it can be tested:
//
//   announce  the chat screen sent a message: the row shows at once
//   settle    the turn is over (reply, failure, stop): the row stays only until
//             the server list the page is showing is replaced
//   sync      the page has a new server list: it is the truth now; announced
//             rows it has are shown from it, settled ones it lacks are dropped
//
// Between announce and settle the row survives every server list that does not
// have the chat yet (a channel save, a calendar refresh and the like re-render
// the page long before the first message is stored): only the end of the turn
// decides that the send failed and the row was a phantom.

export type RecentRow = {
  id: string;
  title: string;
  summary: string | null;
  status: WorkStatusValue;
};

export type AnnouncedRow = {
  row: RecentRow;
  // The server list that was showing when the turn ended; null while the turn
  // is still running. Once the page shows another list, the row is gone.
  settledAgainst: readonly RecentRow[] | null;
};

export type RecentsAnnouncer = {
  // The page's current server list (call after every render).
  sync: (works: readonly RecentRow[]) => void;
  announce: (activity: WorkActivity) => void;
  settle: (workId: string) => void;
  getSnapshot: () => readonly AnnouncedRow[];
  subscribe: (listener: () => void) => () => void;
};

export function createRecentsAnnouncer(): RecentsAnnouncer {
  let current: readonly RecentRow[] = [];
  let announced: readonly AnnouncedRow[] = [];
  const listeners = new Set<() => void>();

  const set = (next: readonly AnnouncedRow[]) => {
    announced = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    sync(works) {
      if (works === current) return;
      current = works;
      // A new server list is the truth: rows it lists are shown from it, and a
      // row whose turn already ended without being listed was a phantom.
      const kept = announced.filter(
        (entry) =>
          entry.settledAgainst === null &&
          !works.some((work) => work.id === entry.row.id),
      );
      if (kept.length !== announced.length) set(kept);
    },
    announce(activity) {
      if (current.some((work) => work.id === activity.workId)) return;
      const existing = announced.find(
        (entry) => entry.row.id === activity.workId,
      );
      if (existing) {
        // A second message while the row is still shown: the turn is running again.
        if (existing.settledAgainst !== null) {
          set(
            announced.map((entry) =>
              entry === existing ? { ...entry, settledAgainst: null } : entry,
            ),
          );
        }
        return;
      }
      set([
        {
          row: {
            id: activity.workId,
            title: activity.title,
            summary: null,
            status: "ACTIVE",
          },
          settledAgainst: null,
        },
        ...announced,
      ]);
    },
    settle(workId) {
      const target = announced.find(
        (entry) => entry.row.id === workId && entry.settledAgainst === null,
      );
      if (!target) return;
      set(
        announced.map((entry) =>
          entry === target ? { ...entry, settledAgainst: current } : entry,
        ),
      );
    },
    getSnapshot: () => announced,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// What the list shows: the announced chats the server list does not have (while
// their turn runs, or until the page shows another list), then the server list.
export function visibleRecents(
  works: readonly RecentRow[],
  announced: readonly AnnouncedRow[],
): RecentRow[] {
  const listed = new Set(works.map((work) => work.id));
  const extra = announced
    .filter(
      (entry) =>
        !listed.has(entry.row.id) &&
        (entry.settledAgainst === null || entry.settledAgainst === works),
    )
    .map((entry) => entry.row);
  return [...extra, ...works];
}
