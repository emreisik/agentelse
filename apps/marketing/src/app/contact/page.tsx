import type { Metadata } from "next";

import { CONTACT_EMAIL } from "@/lib/site";
import { ContactForm } from "@/components/site/contact-form";
import { Reveal } from "@/components/site/reveal";
import { Eyebrow } from "@/components/site/section";

export const metadata: Metadata = {
  title: "Contact",
  description: "Talk to the Agentelse team. We reply within one business day.",
};

export default function ContactPage() {
  return (
    <section className="site-section">
      <div className="site-container grid items-start gap-12 md:grid-cols-[0.9fr_1.1fr] md:gap-16">
        <Reveal className="flex flex-col gap-6">
          <Eyebrow>Contact</Eyebrow>
          <h1 className="text-h1 max-w-[14ch] text-balance">
            Let&apos;s talk.
          </h1>
          <p className="text-lead max-w-[42ch] text-muted-foreground">
            Tell us about your brand. We reply within one business day.
          </p>
          <div className="flex flex-col gap-1 pt-2">
            <p className="text-sm text-muted-foreground">Prefer email?</p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-sm text-foreground underline underline-offset-4"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </Reveal>
        <Reveal delayMs={100}>
          <ContactForm />
        </Reveal>
      </div>
    </section>
  );
}
