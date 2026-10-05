"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ClipboardListIcon, PaperclipIcon, PlusIcon } from "lucide-react";
import { ComposerPrimitive } from "@assistant-ui/react";
import type {
  CapabilityKey,
  CreativeContentFormat,
  SocialPlatform,
} from "@prisma/client";

import { useGuidedSetup } from "@/components/guide/guided-setup-context";
import { useDiscovery } from "@/components/discovery/discovery-context";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  CAPABILITY_SHORTCUTS,
  INTEGRATION_SHORTCUTS,
  shortcutsForWork,
  type ComposerShortcut,
} from "@/lib/composer-shortcuts";
import type { PublishTarget } from "@/server/integrations/meta-connection-status";

const INTEGRATIONS_HREF = (projectId: string) =>
  `/projects/${projectId}/integrations`;

// The composer "+" menu: departments, integrations, and every other
// system-speeding capability shortcut, all searchable in one place (see
// src/lib/composer-shortcuts.ts for the full catalog and command-service.ts's
// SubmitCommandInput.intent comment for why this bypasses the LLM). Absorbs
// what used to be the always-visible ChatQuickActions pill row — "Add
// photos & files" is item #1 here instead of being the "+" button's only
// behavior.
export function ComposerPlusMenu({
  projectId,
  publishTargets,
  disabled,
  onShortcut,
  works = false,
}: {
  projectId: string;
  publishTargets: PublishTarget[];
  disabled?: boolean;
  // Inside a Work: no Reel / ad-creative items and no jump to integrations.
  works?: boolean;
  onShortcut: (
    capability: CapabilityKey,
    request: string,
    targetPlatform?: SocialPlatform,
    contentFormat?: CreativeContentFormat,
  ) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  // Null outside the root chat or with GUIDED_SETUP off: no Setup group.
  const guidedSetup = useGuidedSetup();
  // The discovery flow replaces the old wizard when present: same menu item,
  // its own label and open().
  const discovery = useDiscovery();
  const guided = discovery
    ? {
        entry: discovery.entry,
        open: (source: "menu") => discovery.open(source),
      }
    : guidedSetup;
  // ComposerPrimitive.AddAttachment owns its own click handler (opens the
  // native file picker) and can't take an onClick of its own — so the real
  // control stays mounted (hidden) and the menu item just clicks it via
  // ref, rather than trying to nest it inside a cmdk CommandItem (two
  // different libraries' "render prop" slot mechanics don't compose
  // reliably).
  const attachButtonRef = React.useRef<HTMLButtonElement>(null);

  const isConnected = React.useCallback(
    (platform: "instagram" | "linkedin" | "x") =>
      publishTargets.some((target) => target.platform === platform),
    [publishTargets],
  );

  function runShortcut(shortcut: ComposerShortcut) {
    setOpen(false);
    if (shortcut.kind === "navigate") {
      router.push(shortcut.href(projectId));
      return;
    }
    if (
      !works &&
      shortcut.requiresConnectedPlatform &&
      !isConnected(shortcut.requiresConnectedPlatform)
    ) {
      router.push(INTEGRATIONS_HREF(projectId));
      return;
    }
    onShortcut(
      shortcut.capability,
      shortcut.request,
      shortcut.targetPlatform,
      shortcut.contentFormat,
    );
  }

  return (
    <>
      <div className="hidden">
        <ComposerPrimitive.AddAttachment
          render={<button ref={attachButtonRef} type="button" tabIndex={-1} />}
        />
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <TooltipIconButton
              tooltip="Add files and more"
              side="bottom"
              variant="ghost"
              size="icon"
              disabled={disabled}
              className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold active:scale-[0.96] motion-reduce:transition-none"
              aria-label="Add files and more"
            />
          }
        >
          <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-80 max-w-[90vw] p-0"
        >
          <Command>
            <CommandInput placeholder="Search shortcuts…" />
            <CommandList className="max-h-96">
              <CommandEmpty>No shortcuts found.</CommandEmpty>
              {guided ? (
                <>
                  <CommandGroup heading="Setup">
                    <CommandItem
                      value={guided.entry.label}
                      onSelect={() => {
                        // Close first; the sheet opens a frame later so the
                        // popover's own focus return cannot race it.
                        setOpen(false);
                        requestAnimationFrame(() => guided.open("menu"));
                      }}
                    >
                      <ClipboardListIcon className="size-4" />
                      {guided.entry.label}
                    </CommandItem>
                  </CommandGroup>
                  <CommandSeparator />
                </>
              ) : null}
              <CommandGroup heading="Add">
                <CommandItem
                  value="Add photos and files"
                  onSelect={() => {
                    setOpen(false);
                    attachButtonRef.current?.click();
                  }}
                >
                  <PaperclipIcon className="size-4" />
                  Add photos &amp; files
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Integrations">
                {shortcutsForWork(INTEGRATION_SHORTCUTS, works).map((shortcut) => (
                  <CommandItem
                    key={shortcut.id}
                    value={shortcut.label}
                    onSelect={() => runShortcut(shortcut)}
                  >
                    <shortcut.icon className="size-4" />
                    {shortcut.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Shortcuts">
                {shortcutsForWork(CAPABILITY_SHORTCUTS, works).map((shortcut) => (
                  <CommandItem
                    key={shortcut.id}
                    value={shortcut.label}
                    onSelect={() => runShortcut(shortcut)}
                  >
                    <shortcut.icon className="size-4" />
                    {shortcut.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
