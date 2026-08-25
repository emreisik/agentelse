"use client";

import { useState } from "react";

import type { ActionResult } from "@/components/shared/action-form";
import {
  VisualIdentityEditSheet,
  type VisualIdentityEditable,
} from "@/components/brand/visual-identity-edit-sheet";
import { InstagramImportDialog } from "@/components/brand/instagram-import-dialog";
import type { InstagramStyleSuggestion } from "@/server/reasoning/prompts/instagram-style";

// Coordinates the two Visual Identity entry points that both end up in the
// same edit Dialog: the plain pencil "Edit" button (saved values only) and
// "Import from Instagram" (saved values + an AI suggestion layered on top,
// for review before saving). VisualIdentityEditSheet only reads its
// `identity`/`suggestion` props on mount (useState initial value +
// uncontrolled defaultValue), so `instanceKey` is bumped on every close —
// whichever entry point opens it next gets a fresh mount off the current
// props instead of stale state left over from the previous session
// (otherwise a cancelled Instagram suggestion, or values from before a
// successful save, could leak into the next open).
export function VisualIdentityControls({
  projectId,
  logoUrl,
  identity,
  action,
}: {
  projectId: string;
  logoUrl: string | null;
  identity: VisualIdentityEditable;
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [suggestion, setSuggestion] =
    useState<Partial<VisualIdentityEditable> | null>(null);
  const [instanceKey, setInstanceKey] = useState(0);

  function applySuggestion(next: InstagramStyleSuggestion) {
    setSuggestion(next);
    setEditOpen(true);
  }

  function handleOpenChange(next: boolean) {
    setEditOpen(next);
    if (!next) {
      setSuggestion(null);
      setInstanceKey((v) => v + 1);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <InstagramImportDialog projectId={projectId} onApply={applySuggestion} />
      <VisualIdentityEditSheet
        key={instanceKey}
        projectId={projectId}
        logoUrl={logoUrl}
        identity={identity}
        action={action}
        suggestion={suggestion}
        open={editOpen}
        onOpenChange={handleOpenChange}
      />
    </div>
  );
}
