"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Type as FontIcon } from "lucide-react";
import { toast } from "sonner";

import { loadGoogleFont } from "@/components/brand/font-specimen";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CURATED_FONTS,
  FONT_MOODS,
  googleFontsStylesheetUrl,
  isFamilyName,
  withHeadlineFont,
} from "@/lib/google-fonts";
import { cn } from "@/lib/utils";
import { updateApprovedFontsAction } from "@/server/actions/project-actions";

// One stylesheet for the whole gallery, added once per page.
let galleryLoaded = false;
function loadGallery() {
  if (galleryLoaded || typeof document === "undefined") return;
  galleryLoaded = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = googleFontsStylesheetUrl(CURATED_FONTS.map((font) => font.family));
  document.head.appendChild(link);
}

const SAMPLE = "Şöleni başlıyor, İstanbul";

// The font the post words are set in. A short list of Google Fonts that work on
// social feeds, shown in their own letters (Turkish ones included), plus any
// other Google Font by name. The choice goes first in the brand's font list.
export function FontPicker({
  projectId,
  fonts,
}: {
  projectId: string;
  // The brand's fonts now (first = the one the posts use).
  fonts: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(fonts[0] ?? "");
  const [custom, setCustom] = useState("");
  const [checking, setChecking] = useState(false);
  const [pending, startTransition] = useTransition();

  // Opened fresh each time: the current font selected, the gallery loading.
  function openPicker() {
    loadGallery();
    setSelected(fonts[0] ?? "");
    setCustom("");
    setOpen(true);
  }

  const groups = useMemo(
    () =>
      FONT_MOODS.map((mood) => ({
        mood,
        fonts: CURATED_FONTS.filter((font) => font.mood === mood),
      })),
    [],
  );

  async function tryCustomFont() {
    const name = custom.trim();
    if (!isFamilyName(name)) {
      toast.error("Use the exact name of a Google Font");
      return;
    }
    setChecking(true);
    const found = await loadGoogleFont(name);
    setChecking(false);
    if (!found) {
      toast.error(`"${name}" is not on Google Fonts`);
      return;
    }
    setSelected(name);
    setCustom("");
  }

  function save() {
    if (!selected) return;
    startTransition(async () => {
      const result = await updateApprovedFontsAction(
        projectId,
        withHeadlineFont(fonts, selected),
      );
      if (result.ok) {
        toast.success(`Posts now use ${selected}`);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  const inList = CURATED_FONTS.some(
    (font) => font.family.toLowerCase() === selected.toLowerCase(),
  );

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={openPicker}>
        <FontIcon className="size-3.5" />
        Choose font
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b border-foreground/10 p-4">
            <DialogTitle>Brand font</DialogTitle>
            <DialogDescription>
              The font the words on your posts are set in. All are free Google
              Fonts picked for social feeds; each one is shown in its own
              letters, Turkish ones included.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            {groups.map((group) => (
              <section key={group.mood} className="space-y-2">
                <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {group.mood}
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.fonts.map((font) => {
                    const active =
                      font.family.toLowerCase() === selected.toLowerCase();
                    return (
                      <button
                        key={font.family}
                        type="button"
                        onClick={() => setSelected(font.family)}
                        aria-pressed={active}
                        className={cn(
                          "flex items-start gap-3 rounded-xl p-3 text-left ring-1 transition-colors",
                          active
                            ? "bg-accent ring-foreground/40"
                            : "bg-card ring-foreground/10 hover:bg-accent/50",
                        )}
                      >
                        <span
                          className="w-12 shrink-0 text-4xl leading-none"
                          style={{ fontFamily: `"${font.family}", sans-serif` }}
                          aria-hidden
                        >
                          Aa
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            {font.family}
                            {active ? <Check className="size-3.5" /> : null}
                          </span>
                          <span
                            className="block truncate text-[15px]"
                            style={{
                              fontFamily: `"${font.family}", sans-serif`,
                              fontWeight: 700,
                            }}
                          >
                            {SAMPLE}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {font.note}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}

            <section className="space-y-2 border-t border-border pt-4">
              <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Any other Google Font
              </h3>
              <div className="flex items-center gap-2">
                <Input
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                  placeholder="Exact name, e.g. Josefin Sans"
                  className="max-w-xs"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void tryCustomFont();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void tryCustomFont()}
                  disabled={checking || !custom.trim()}
                >
                  {checking ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Use
                </Button>
              </div>
              {selected && !inList ? (
                <p className="text-xs text-muted-foreground">
                  Selected: <span className="font-medium text-foreground">{selected}</span>
                </p>
              ) : null}
            </section>
          </div>

          <DialogFooter className="shrink-0 border-t border-foreground/10 p-4">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={pending || !selected}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Use {selected || "font"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
