import Link from "next/link";
import { Check } from "lucide-react";

import { FinalCta } from "@/components/marketing/final-cta";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { StatusPill } from "@/components/marketing/status-pill";
import {
  DEPARTMENTS,
  type DepartmentData,
} from "@/components/marketing/departments/department-data";

// Name -> slug, but only for departments that actually have a page. Anything
// else in worksWith (Opportunity Engine, Agency Director) renders as plain
// text instead of a dead link.
const SLUG_BY_NAME = new Map(DEPARTMENTS.map((d) => [d.name, d.slug]));

export function DepartmentDetail({
  department,
}: {
  department: DepartmentData;
}) {
  return (
    <>
      <header className="pt-16 pb-14 md:pt-20 md:pb-16">
        <div className="agentelse-container">
          <Reveal className="flex flex-col gap-4">
            <p className="agentelse-text-label text-muted-foreground uppercase tracking-wide">
              Department
            </p>
            <h1 className="agentelse-text-h1 max-w-[20ch] text-balance">
              {department.name}
            </h1>
            <p className="agentelse-text-lead max-w-[52ch] text-muted-foreground">
              {department.tagline}
            </p>
          </Reveal>
        </div>
      </header>

      <Section>
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
            What it does
          </h2>
          <p className="agentelse-text-lead mt-4 max-w-[56ch] text-muted-foreground">
            {department.description}
          </p>
        </Reveal>

        <Reveal delayMs={80} className="mt-10 md:mt-12">
          <div className="divide-y divide-border border-t border-border">
            {department.capabilities.map((capability) => (
              <div key={capability} className="flex items-start gap-3 py-4">
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm text-foreground">{capability}</span>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      <Section tone="raised">
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
            Example output
          </h2>
        </Reveal>

        <Reveal delayMs={80} className="mt-10 md:mt-12">
          <div className="rounded-xl border border-border bg-background p-6">
            <StatusPill tone="neutral">{department.name}</StatusPill>
            <h3 className="agentelse-text-h3 mt-4 text-foreground">
              {department.exampleOutput.label}
            </h3>
            <p className="mt-2 max-w-[56ch] text-sm text-muted-foreground">
              {department.exampleOutput.description}
            </p>
          </div>
        </Reveal>
      </Section>

      <Section>
        <Reveal className="max-w-[65ch]">
          <h2 className="agentelse-text-h2 text-foreground">Works with</h2>
          <p className="agentelse-text-lead mt-4 text-muted-foreground">
            {department.name} regularly coordinates with{" "}
            {department.worksWith.map((name, i) => {
              const slug = SLUG_BY_NAME.get(name);
              const isLast = i === department.worksWith.length - 1;
              const isBeforeLast = i === department.worksWith.length - 2;
              return (
                <span key={name}>
                  {slug ? (
                    <Link
                      href={`/departments/${slug}`}
                      className="text-foreground underline underline-offset-4 hover:no-underline"
                    >
                      {name}
                    </Link>
                  ) : (
                    <span className="text-foreground">{name}</span>
                  )}
                  {!isLast && (isBeforeLast ? " and " : ", ")}
                </span>
              );
            })}
            .
          </p>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
