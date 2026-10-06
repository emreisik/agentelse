import { CtaBand } from "@/components/site/cta-band";
import { Faq, type FaqItem } from "@/components/site/faq";
import { AgenciesTeaser } from "@/components/site/home/agencies-teaser";
import { Bento } from "@/components/site/home/bento";
import { Control } from "@/components/site/home/control";
import { Hero } from "@/components/site/home/hero";
import { IntegrationsStrip } from "@/components/site/home/integrations-strip";
import { Steps } from "@/components/site/home/steps";
import { SITE_URL } from "@/lib/site";

const FAQ: FaqItem[] = [
  {
    question: "What is Agentelse?",
    answer:
      "An AI social media team. It learns your brand, plans your posts, designs them and publishes them after you approve.",
  },
  {
    question: "Where does it post?",
    answer:
      "Instagram posts and Stories go out on schedule. Facebook Page posts take one tap. For TikTok, LinkedIn and X it makes the post and you share it.",
  },
  {
    question: "Will it post without asking?",
    answer: "Never. Nothing goes live until you approve it.",
  },
  {
    question: "Will it sound like my brand?",
    answer:
      "Yes. It reads your website, follows your style kit and learns from every post you like or turn down.",
  },
  {
    question: "Which languages?",
    answer:
      "14, including English, Turkish, German, French, Spanish, Arabic, Greek and Macedonian.",
  },
  {
    question: "How much is it?",
    answer: "Free during early access. No credit card.",
  },
];

const APP_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Agentelse",
  url: SITE_URL,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description:
    "An AI social media team for brands and agencies: it plans, designs and publishes your posts after you approve.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free during early access",
  },
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <IntegrationsStrip />
      <Steps />
      <Bento />
      <Control />
      <AgenciesTeaser />
      <Faq items={FAQ} />
      <CtaBand />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(APP_LD) }}
      />
    </>
  );
}
