import Link from "next/link";
import { Link2, Settings2 } from "lucide-react";

import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { CardTitle } from "@/components/workspace/card-title";
import type {
  ConnectedAccount,
  ConnectedAccountKey,
} from "@/lib/connected-accounts";

// The right panel's Brand tab opens with where the brand's accounts stand: one
// row of icons, one per linked account. The brand's own profile, kit and
// strategy live in Brand Brain. Labels are Turkish, as designed.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
} as const;

// Each account's own mark. Only accounts that can really be linked have one:
// the website is not an account.
const ACCOUNT_BRAND: Partial<Record<ConnectedAccountKey, BrandKey>> = {
  instagram: "instagram",
  facebook: "facebook",
  "meta-ads": "meta-ads",
  ga4: "ga4",
  "search-console": "search-console",
  tiktok: "tiktok",
  linkedin: "linkedin",
  x: "x",
};

// "Instagram · @webhealth": the hover text and the accessible name of an
// account's icon, since the row shows no words.
export function accountTitle(account: ConnectedAccount): string {
  return [
    account.label,
    account.detail,
    account.state === "reconnect" ? "yeniden bağlanmalı" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Only what is really linked: a half-set-up Google account (no property or
// site chosen yet), one not linked at all, and the website are left out. A
// lapsed connection stays, marked, so it isn't silently missing.
export function linkedAccounts(
  accounts: ConnectedAccount[],
): (ConnectedAccount & { brand: BrandKey })[] {
  return accounts.flatMap((account) => {
    const brand = ACCOUNT_BRAND[account.key];
    const shown =
      account.state === "connected" || account.state === "reconnect";
    return shown && brand ? [{ ...account, brand }] : [];
  });
}

// One row of icons, one per linked account, in the brands' own colours.
export function ConnectedAccountsCard({
  projectId,
  accounts,
}: {
  projectId: string;
  accounts: ConnectedAccount[];
}) {
  const href = `/projects/${projectId}/integrations`;
  const linked = linkedAccounts(accounts);
  return (
    <section
      aria-label="Bağlı hesaplar"
      data-card="connected-accounts"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <CardTitle
        icon={<Link2 />}
        aside={
          linked.length > 0 ? (
            <Link
              href={href}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)]"
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text-2)",
              }}
            >
              <Settings2 className="size-2.5" />
              Yönet
            </Link>
          ) : null
        }
      >
        Bağlı hesaplar
      </CardTitle>
      {accounts.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Hesap durumu şu an okunamadı.
        </p>
      ) : linked.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--ws-text-3)" }}>
          Henüz bağlı hesap yok.{" "}
          <Link
            href={href}
            className="font-medium underline underline-offset-2"
            style={{ color: "var(--ws-text)" }}
          >
            Hesap bağla
          </Link>
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {linked.map((account) => (
            <li key={account.key}>
              <Link
                href={href}
                title={accountTitle(account)}
                aria-label={accountTitle(account)}
                data-account={account.key}
                className="relative flex size-8 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--ws-hover)]"
                style={{
                  borderColor: "var(--ws-border)",
                  background: "var(--ws-surface-2)",
                  color: "var(--ws-text)",
                }}
              >
                <BrandIcon brand={account.brand} className="size-4" />
                {account.state === "reconnect" ? (
                  <span
                    aria-hidden
                    data-reconnect
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber-500"
                  />
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
