import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";

import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";

type TrustPoint = {
  id: string;
  label: string;
};

const TRUST_POINTS: TrustPoint[] = [
  { id: "encrypted-connections", label: "Encrypted connections" },
  { id: "separated-data", label: "Separated company data" },
  { id: "permissions", label: "Permissions on every action" },
  { id: "approvals", label: "Human approvals for risky work" },
  { id: "audit-history", label: "Full audit history" },
  { id: "data-retention", label: "Configurable data retention" },
];

// Condensed homepage version — a plain checklist, not a card grid. The full
// explanation (and any compliance detail) belongs on the dedicated
// /security page; this section only needs to reassure, briefly.
export function TrustSecurity() {
  return (
    <Section tone="raised">
      <Reveal>
        <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
          Your company data stays your company data.
        </h2>
      </Reveal>

      <Reveal delayMs={80} className="mt-10 md:mt-12">
        <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {TRUST_POINTS.map((point) => (
            <li key={point.id} className="flex items-center gap-2.5">
              <Check className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm text-foreground">{point.label}</span>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal
        delayMs={140}
        className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3"
      >
        <p className="text-sm text-muted-foreground">
          Built with enterprise-grade security principles.
        </p>
        <Button
          variant="link"
          className="px-0"
          render={<Link href="/security" />}
          nativeButton={false}
        >
          Read our security overview
          <ArrowRight className="size-3.5" />
        </Button>
      </Reveal>
    </Section>
  );
}
