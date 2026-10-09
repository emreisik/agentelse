"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// The result every billing server action returns: either the next step (a Stripe
// page to go to) / done, or a message that is already safe to show.
export type BillingActionResponse =
  | { ok: true; url?: string; kind?: string }
  | { ok: false; error: string; message: string };

export type ConfirmCopy = {
  title: string;
  description: string;
  confirmLabel: string;
};

// One button for every billing action: optional confirmation, a busy state, the
// error shown right under the button, and the right next step on success (leave to
// Stripe, go to a page with a banner, or just refresh).
//
// It takes the SERVER ACTION itself plus a serializable input, never a closure: server
// components (the subscription and usage panels) render this button, and only server
// action references and plain data can cross from a server component to a client one.
export function BillingActionButton<Input = undefined>({
  action,
  input,
  children,
  busyLabel = "Working…",
  variant = "default",
  disabled = false,
  confirm,
  className,
  doneHref,
}: {
  action: (input: Input) => Promise<BillingActionResponse>;
  input?: Input;
  children: React.ReactNode;
  busyLabel?: string;
  variant?: "default" | "outline" | "secondary" | "destructive";
  disabled?: boolean;
  confirm?: ConfirmCopy;
  className?: string;
  // Where to go after a successful action that has no Stripe page (a banner there
  // says what happened); a function may pick the page from the result, but only from
  // a client component. Without it the page is refreshed.
  doneHref?:
    | string
    | ((response: Extract<BillingActionResponse, { ok: true }>) => string);
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function execute() {
    setError(null);
    startTransition(async () => {
      try {
        const response = await action(input as Input);
        if (!response.ok) {
          setError(response.message);
          setOpen(false);
          return;
        }
        if (response.url) {
          // Leaving for Stripe: keep the button busy until the page unloads.
          window.location.assign(response.url);
          return;
        }
        setOpen(false);
        if (doneHref) {
          router.push(
            typeof doneHref === "function" ? doneHref(response) : doneHref,
          );
        } else {
          router.refresh();
        }
      } catch {
        setError("That did not work. Nothing was changed. Try again.");
        setOpen(false);
      }
    });
  }

  return (
    <div className={className}>
      <Button
        type="button"
        size="lg"
        variant={variant}
        disabled={disabled || pending}
        className="w-full"
        onClick={() => (confirm ? setOpen(true) : execute())}
      >
        {pending && !open ? busyLabel : children}
      </Button>
      {error ? (
        <p
          role="alert"
          className="mt-1.5 text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {error}
        </p>
      ) : null}
      {confirm ? (
        <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{confirm.title}</DialogTitle>
              <DialogDescription>{confirm.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Not now
              </Button>
              <Button type="button" disabled={pending} onClick={execute}>
                {pending ? busyLabel : confirm.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
