import {
  PLATFORMS,
  PlatformIcon,
  type Platform,
} from "@/components/site/mock/parts";

const LOGOS: Platform[] = [
  "instagram",
  "facebook",
  "meta-ads",
  "analytics",
  "search-console",
  "telegram",
  "tiktok",
  "linkedin",
  "x",
];

// One quiet, endless row of the accounts Agentelse connects to.
export function IntegrationsStrip() {
  return (
    <section aria-label="Integrations" className="border-y border-border py-10">
      <p className="text-center text-sm text-muted-foreground">
        Works with the accounts you already use
      </p>
      <div className="site-fade-x mt-7 overflow-hidden">
        <ul className="site-marquee flex w-max items-center gap-12 pr-12">
          {[...LOGOS, ...LOGOS].map((platform, index) => (
            <li
              key={`${platform}-${index}`}
              aria-hidden={index >= LOGOS.length ? true : undefined}
              className="flex items-center gap-2.5 text-foreground/70"
            >
              <PlatformIcon platform={platform} className="size-5" />
              <span className="text-[15px] font-medium whitespace-nowrap">
                {PLATFORMS[platform].name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
