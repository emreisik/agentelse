import { copyText, type CopyKey } from "@/lib/works/copy";

const TEXT: Record<"plan" | "ideas" | "generic", CopyKey> = {
  plan: "kit.pending.plan",
  ideas: "kit.pending.ideas",
  generic: "kit.pending.generic",
};

// A skeleton in the card shell while a Work turn runs without a card or text
// yet; the real card replaces it in place.
export function PendingCard({ hint }: { hint: "plan" | "ideas" | "generic" }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mt-1 w-full max-w-md space-y-2 rounded-2xl border p-3.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      <p
        className="text-sm font-semibold"
        style={{ color: "var(--ws-text)" }}
      >
        {copyText(TEXT[hint])}
      </p>
      <div
        aria-hidden="true"
        className="h-3 w-3/4 animate-pulse rounded-full motion-reduce:animate-none"
        style={{ background: "var(--ws-hover)" }}
      />
      <div
        aria-hidden="true"
        className="h-3 w-1/2 animate-pulse rounded-full motion-reduce:animate-none"
        style={{ background: "var(--ws-hover)" }}
      />
    </div>
  );
}
