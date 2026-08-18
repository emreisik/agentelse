"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type ActionResult = { ok: true } | { ok: false; message: string };

type ServerAction = (formData: FormData) => Promise<ActionResult | void>;

// Wraps a server action with toast feedback. Actions may return
// { ok, message } (preferred) or return void/throw — both are handled.
export function ActionForm({
  action,
  successMessage = "Action completed",
  className,
  children,
}: {
  action: ServerAction;
  successMessage?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(
    async (
      _prev: (ActionResult & { seq: number }) | null,
      formData: FormData,
    ) => {
      try {
        const result = await action(formData);
        if (result && result.ok === false) {
          return { ...result, seq: Date.now() };
        }
        return { ok: true as const, seq: Date.now() };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : "Action failed",
          seq: Date.now(),
        };
      }
    },
    null,
  );

  const router = useRouter();
  const lastSeq = useRef<number>(0);
  useEffect(() => {
    if (!state || state.seq === lastSeq.current) return;
    lastSeq.current = state.seq;
    if (state.ok) {
      toast.success(successMessage);
      router.refresh();
    } else {
      toast.error(state.message || "Action failed");
    }
  }, [state, successMessage, router]);

  return (
    <form action={formAction} className={className}>
      {children}
    </form>
  );
}
