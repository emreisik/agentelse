"use client";

import { Component, type ReactNode } from "react";
import { toast } from "sonner";

// copy.md error.render
export const BOUNDARY_TOAST =
  "Setup couldn't open. Reload the page, or continue in chat.";

type Props = {
  children: ReactNode;
  // Lets the host reset its "open" state: without it the entry points would
  // call open() on a sheet that no longer exists and nothing would happen.
  onError?: () => void;
};

type State = { failed: boolean };

// A render bug in the sheet must never reach projects/[projectId]/error.tsx
// (the whole page would blank). It is swallowed here: the sheet disappears,
// one toast explains, the chat keeps working. Never rethrows.
export class GuidedSetupBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  private reported = false;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(): void {
    if (this.reported) return;
    this.reported = true;
    try {
      toast.error(BOUNDARY_TOAST);
      this.props.onError?.();
    } catch {
      // Reporting is best effort; the boundary itself must not throw.
    }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
