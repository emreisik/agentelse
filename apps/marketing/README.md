# Agentelse marketing site

The public marketing site — deploys to **agentelse.com**. Independent Next.js app inside this npm workspace; the product itself (agentelse.ai) lives at the repo root and is unaffected by anything here.

## Local setup

```bash
npm install          # from the repo root — this is an npm workspace
npm run dev -w apps/marketing
```

## Environment

Create a `.env.local` in this directory with:

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Used to build absolute links from this site into the product ("Start free", "Sign in", the legal pages) — the two apps are on different domains, so a plain relative `<Link>` won't reach the app. In production this should point at `https://agentelse.ai` (or wherever the app is actually deployed).

The contact form notifies the team over Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set; without them it still succeeds silently.

## Structure

| Path | What it is |
| --- | --- |
| `src/app/page.tsx` | Home: animated hero demo, integrations, three steps, feature grid, control, agencies, FAQ |
| `src/app/{product,agencies,pricing,security,about,contact}` | The other pages |
| `src/components/site/hero/` | The hero demo: the product playing a ~30 s loop. `timeline.ts` is the script (scenes, key moments, cursor targets); every frame is derived from one clock position, so the panes in `demo-chat.tsx` / `demo-panes.tsx` are pure and are also reused as still pictures on /product and /agencies |
| `src/components/site/home/` | Home sections; `step-visuals.tsx` and `bento-visuals.tsx` are the small looping pictures (`use-loop.ts`) |
| `src/components/site/mock/` | Shared mock-up parts (platform icons, pills, the CSS post picture, the fictional brand) and the agency brand switcher |
| `src/components/site/` | Nav, footer, sections, CTA, FAQ (with FAQPage JSON-LD), page hero, feature split |
| `src/lib/site.ts` | Site URL, nav and footer links, product links |
| `next.config.ts` | Redirects: old `/departments` and `/solutions` → `/product`; `/privacy`, `/terms`, `/data-deletion` → the product's pages (one legal text) |

The demo copies the product's real screens and words (sidebar, right dock with Brand / Files / Outputs / Calendar, plan pane, post card, next-step strip). Update it when those screens change. Animations stop when the demo is off screen or the tab is hidden, and under `prefers-reduced-motion` it shows still frames.

## Copy rules

Keep headlines to a few words and body lines to one sentence. Say only what the product does today. In particular: only Instagram publishes on its own schedule; Facebook Page posts take one tap; TikTok, LinkedIn and X posts are prepared for the user to post; Ads, Analytics and SEO modules are "Coming soon"; there is no video generation and no team invites. Pricing is "free during early access" — there is no billing in the product.
