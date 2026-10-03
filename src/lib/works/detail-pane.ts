// The pane on the right that shows one long card in full (docs/works.md),
// without React so its rules can be tested: which card is open, which element
// the card is shown in, and which cards are in the chat right now (a card that
// was open and has left the chat leaves nothing to show).
//
// The card's compact twin in the chat opens it (`open`); the pane's close
// button, Escape and a tab request close it. The pane host hands over the
// element (`setContainer`) and the card is rendered into it by a portal from
// where it sits in the chat, so everything the chat provides (sending a message,
// the Work, card actions) keeps working inside the pane.

export type OpenDetail = { id: string; title: string };

export type DetailSnapshot<Container> = {
  detail: OpenDetail | null;
  container: Container | null;
  // Ids of the cards that are in the chat now.
  present: ReadonlySet<string>;
};

export type DetailStore<Container> = {
  open: (id: string, title: string) => void;
  close: () => void;
  setContainer: (container: Container | null) => void;
  // A compact card announces itself while it is in the chat; the returned
  // function takes it back.
  register: (id: string) => () => void;
  getSnapshot: () => DetailSnapshot<Container>;
  subscribe: (listener: () => void) => () => void;
};

export function createDetailStore<Container = unknown>(): DetailStore<Container> {
  let snapshot: DetailSnapshot<Container> = {
    detail: null,
    container: null,
    present: new Set(),
  };
  // Two cards may carry one id for a moment (the streamed copy and the stored
  // one): counted, so the first to leave does not hide the other.
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();

  const set = (next: Partial<DetailSnapshot<Container>>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };

  return {
    open(id, title) {
      const current = snapshot.detail;
      if (current && current.id === id && current.title === title) return;
      set({ detail: { id, title } });
    },
    close() {
      if (snapshot.detail === null) return;
      set({ detail: null });
    },
    setContainer(container) {
      if (container === snapshot.container) return;
      set({ container });
    },
    register(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (!snapshot.present.has(id)) {
        set({ present: new Set([...snapshot.present, id]) });
      }
      let taken = false;
      return () => {
        if (taken) return;
        taken = true;
        const left = (counts.get(id) ?? 1) - 1;
        if (left > 0) {
          counts.set(id, left);
          return;
        }
        counts.delete(id);
        const next = new Set(snapshot.present);
        next.delete(id);
        set({ present: next });
      };
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function isDetailOpen(
  snapshot: DetailSnapshot<unknown>,
  id: string,
): boolean {
  return snapshot.detail?.id === id;
}

// The open card is no longer in the chat (replaced by another kind of card,
// deleted, another chat was opened): the pane says so instead of staying empty.
export function detailIsGone(snapshot: DetailSnapshot<unknown>): boolean {
  return snapshot.detail !== null && !snapshot.present.has(snapshot.detail.id);
}

// The header's "hide the panel" button: with a card open it hides what is on
// screen, the card and the panel with it (the person asked for the panel to go,
// and tabs appearing in its place would look like nothing happened). Without
// one it flips the panel as it always did.
export function togglePanel(input: {
  detailOpen: boolean;
  collapsed: boolean;
}): { closeDetail: boolean; collapsed: boolean } {
  return input.detailOpen
    ? { closeDetail: true, collapsed: true }
    : { closeDetail: false, collapsed: !input.collapsed };
}
