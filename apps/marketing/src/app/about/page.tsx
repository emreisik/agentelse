import type { Metadata } from "next";

import { FinalCta } from "@/components/marketing/final-cta";
import { Section } from "@/components/marketing/section";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "About",
  description:
    "Agentelse is not another AI tool you manage. It's an autonomous growth department a company adds to itself.",
};

export default function AboutPage() {
  return (
    <>
      <Section className="pb-0">
        <Reveal className="flex flex-col gap-4">
          <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
            About
          </p>
          <h1 className="agentelse-text-h1 max-w-[20ch] text-balance">
            We think AI should do the work, not wait for instructions.
          </h1>
          <p className="agentelse-text-lead max-w-[56ch] text-muted-foreground">
            Most AI tools take a prompt and hand back an output. That&rsquo;s
            not how a growth department works. A real one researches, decides,
            and acts continuously, on its own schedule, not yours. So
            that&rsquo;s what we built.
          </p>
        </Reveal>
      </Section>

      <Section tone="raised">
        <Reveal className="flex max-w-[65ch] flex-col gap-6">
          <h2 className="agentelse-text-h2 text-balance">
            How we think about it
          </h2>
          <div className="flex flex-col gap-5 text-base text-foreground/90">
            <p>
              Companies shouldn&rsquo;t have to manage AI the way they manage
              software: configuring it, prompting it, checking on it every few
              hours. They should be able to give it a job, the way they&rsquo;d
              hand a role to a new team member, and trust it to show up and do
              that job.
            </p>
            <p>
              But autonomy without control isn&rsquo;t trustworthy, it&rsquo;s
              just risk with better marketing. That&rsquo;s why approvals and
              permissions are core to Agentelse, not a setting you find later.
              You decide what it can do on its own and what it brings back to
              you first.
            </p>
            <p>
              We&rsquo;re not building a novelty. We&rsquo;re building
              infrastructure a company can still be running on in five years,
              something that gets more useful the longer it works for you, not
              something you churn out of after the demo wears off.
            </p>
          </div>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
