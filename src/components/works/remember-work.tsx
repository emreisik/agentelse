"use client";

import { useEffect } from "react";

import { lastWorkCookie } from "@/lib/works/last-work";

// Notes the chat on screen as the project's last open chat (see last-work.ts).
export function RememberWork({
  projectId,
  workId,
}: {
  projectId: string;
  workId: string;
}) {
  useEffect(() => {
    document.cookie = lastWorkCookie(projectId, workId);
  }, [projectId, workId]);
  return null;
}
