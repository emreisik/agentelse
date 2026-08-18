import type { Metadata } from "next";

import { Section } from "@/components/marketing/section";
import { Reveal } from "@/components/marketing/reveal";
import { ContactForm } from "@/components/marketing/contact-form";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Tell us about your brands and what you'd want your first AI department to take on.",
};

export default function ContactPage() {
  return (
    <Section>
      <div className="grid items-start gap-12 md:grid-cols-2">
        <Reveal className="flex flex-col gap-6">
          <h1 className="agentelse-text-h1 max-w-[16ch] text-balance">
            Talk to us.
          </h1>
          <p className="agentelse-text-lead max-w-[42ch] text-muted-foreground">
            Tell us about your brands and what you&apos;d want your first AI
            department to take on. We&apos;ll follow up within a business day.
          </p>
          <div className="flex flex-col gap-1 pt-2">
            <p className="text-sm text-muted-foreground">Prefer email?</p>
            <a
              href="mailto:hello@agentelse.com"
              className="text-sm text-foreground underline underline-offset-4"
            >
              hello@agentelse.com
            </a>
          </div>
        </Reveal>
        <ContactForm />
      </div>
    </Section>
  );
}
