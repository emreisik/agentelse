import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { FinalCta } from "@/components/marketing/final-cta";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { DEPARTMENTS } from "@/components/marketing/departments/department-data";

export const metadata: Metadata = {
  title: "Departments",
  description:
    "Research, Creative, SEO, Social and Analytics — the specialist departments that make up your AI growth department.",
};

export default function DepartmentsPage() {
  return (
    <>
      <header className="pt-16 pb-14 md:pt-20 md:pb-16">
        <div className="agentelse-container">
          <Reveal className="flex flex-col gap-4">
            <p className="agentelse-text-label text-muted-foreground uppercase tracking-wide">
              Departments
            </p>
            <h1 className="agentelse-text-h1 max-w-[20ch] text-balance">
              Specialists when you need them. One team all the time.
            </h1>
            <p className="agentelse-text-lead max-w-[52ch] text-muted-foreground">
              Every department runs its own workflow and reports back through
              the same Agency Director, so the work stays coordinated even
              though it&rsquo;s never sitting idle.
            </p>
          </Reveal>
        </div>
      </header>

      <Section>
        <Reveal>
          <div className="divide-y divide-border border-t border-border">
            {DEPARTMENTS.map((department) => (
              <Link
                key={department.slug}
                href={`/departments/${department.slug}`}
                className="group flex items-center justify-between gap-6 py-6 md:py-7"
              >
                <div className="flex flex-col gap-1.5">
                  <h2 className="agentelse-text-h3 text-foreground">
                    {department.name}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {department.tagline}
                  </p>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
              </Link>
            ))}
          </div>
        </Reveal>
      </Section>

      <Section tone="raised">
        <Reveal className="max-w-[65ch]">
          <h2 className="agentelse-text-h2 text-foreground">
            Part of the wider system
          </h2>
          <p className="agentelse-text-lead mt-4 text-muted-foreground">
            Agency Director, Idea Foundry and Opportunity Engine are also part
            of Agentelse. They coordinate priorities across departments and
            generate the opportunities that Research, Creative, SEO, Social and
            Analytics act on. None of them run in isolation — every specialist
            above reads from the same Brand Brain and reports back to the same
            Agency Director.
          </p>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
