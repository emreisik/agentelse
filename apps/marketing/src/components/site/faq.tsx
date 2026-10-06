import { Plus } from "lucide-react";

import { Section, SectionHeader } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";

export type FaqItem = { question: string; answer: string };

// Native <details>, so it works without JavaScript, plus FAQPage structured
// data so answer engines can quote it.
export function Faq({
  items,
  title = "Questions, answered.",
}: {
  items: FaqItem[];
  title?: string;
}) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <Section>
      <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeader eyebrow="FAQ" title={title} />
        <Reveal>
          <ul className="divide-y divide-border border-y border-border">
            {items.map((item) => (
              <li key={item.question}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[16px] font-medium [&::-webkit-details-marker]:hidden">
                    {item.question}
                    <Plus className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-45" />
                  </summary>
                  <p className="max-w-[62ch] pb-6 text-[15px] leading-relaxed text-muted-foreground">
                    {item.answer}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
    </Section>
  );
}
