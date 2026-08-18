import { Section } from "@/components/marketing/section";
import { Reveal } from "@/components/marketing/reveal";
import { LogosRow } from "@/components/marketing/logos-row";

const INTEGRATION_NAMES = [
  "Google Analytics",
  "Google Search Console",
  "Google Ads",
  "Meta",
  "Shopify",
  "WordPress",
  "HubSpot",
  "Kommo",
  "Slack",
  "Gmail",
  "Telegram",
  "CRM systems",
];

export function Integrations() {
  return (
    <Section>
      <Reveal>
        <h2 className="agentelse-text-h2 text-balance">
          Works where your business already works.
        </h2>
        <LogosRow names={INTEGRATION_NAMES} className="mt-8" />
        <p className="agentelse-text-lead mt-8 max-w-[55ch] text-muted-foreground">
          Connect your tools. Agentelse turns them into context.
        </p>
      </Reveal>
    </Section>
  );
}
