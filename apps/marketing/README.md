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

Used to build absolute links from this site into the product (e.g. the "Start free" button) — the two apps are on different domains, so a plain relative `<Link>` won't reach the app. In production this should point at `https://app.agentelse.ai` (or wherever the app is actually deployed).
