"use client";

import * as React from "react";

import { useWorkspaceDetail } from "@/components/workspace/workspace-panel-toggle";

// The pane shows a card of THIS chat: when the chat goes (another chat is
// opened, the person moves to a panel or another page), so does the pane.
export function useCloseDetailOnLeave(): void {
  const closeDetail = useWorkspaceDetail()?.closeDetail;
  React.useEffect(() => () => closeDetail?.(), [closeDetail]);
}
