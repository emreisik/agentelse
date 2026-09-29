"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LayoutTemplate as LayoutIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { LayoutGallery } from "@/components/brand/layout-gallery";
import type { PreviewLogos } from "@/components/brand/layout-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { KitTemplate } from "@/lib/brand-kit";
import {
  buildPresetLayouts,
  normalizeLayoutNames,
  type LayoutPalette,
  type LayoutTemplates,
} from "@/lib/layout-templates";
import { updateLayoutTemplatesAction } from "@/server/actions/brand-layout-actions";

// The Brand tab's "Edit layouts" button + dialog. The editor body is mounted
// only while the dialog is open, so closing it discards unsaved edits.
export function LayoutEditorButton({
  projectId,
  saved,
  baseTemplate,
  colors,
  logoIds,
  label = "Edit layouts",
  className,
}: {
  projectId: string;
  // The brand's saved layouts, or null when it has none yet.
  saved: LayoutTemplates | null;
  baseTemplate: KitTemplate;
  colors: LayoutPalette;
  logoIds: { light: string | null; dark: string | null };
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => setOpen(true)}
        className={className ?? "gap-1"}
      >
        <LayoutIcon className="size-3" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-3xl">
          {open ? (
            <EditorBody
              projectId={projectId}
              saved={saved}
              baseTemplate={baseTemplate}
              colors={colors}
              logoIds={logoIds}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditorBody({
  projectId,
  saved,
  baseTemplate,
  colors,
  logoIds,
  onClose,
}: {
  projectId: string;
  saved: LayoutTemplates | null;
  baseTemplate: KitTemplate;
  colors: LayoutPalette;
  logoIds: { light: string | null; dark: string | null };
  onClose: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState<LayoutTemplates>(
    () => saved ?? buildPresetLayouts(baseTemplate),
  );
  const [saving, startSaving] = useTransition();

  const logos: PreviewLogos = {
    light: logoIds.light ? `/api/assets/${logoIds.light}` : null,
    dark: logoIds.dark ? `/api/assets/${logoIds.dark}` : null,
  };

  function save() {
    startSaving(async () => {
      const result = await updateLayoutTemplatesAction(
        projectId,
        normalizeLayoutNames(value),
      );
      if (result.ok) {
        toast.success("Layouts saved.");
        router.refresh();
        onClose();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-foreground/10 p-4">
        <DialogTitle>Post layouts</DialogTitle>
        <DialogDescription>
          Each layout sets where the logo, the color bar or band and the
          headline go. New posts use the default one (or the one you pick in
          chat). The logo and bar are added after the image is made, so they are
          identical every time.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {saved ? null : (
          <p className="mb-3 rounded-lg border border-border/60 bg-muted/40 p-2.5 text-xs">
            These are suggested layouts built from your brand. Save to start
            using them; until then posts use your logo and color bar template.
          </p>
        )}
        <LayoutGallery
          value={value}
          onChange={setValue}
          colors={colors}
          logos={logos}
          baseTemplate={baseTemplate}
          disabled={saving}
        />
      </div>
      <DialogFooter className="shrink-0 border-t border-foreground/10 p-4">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save layouts"
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
