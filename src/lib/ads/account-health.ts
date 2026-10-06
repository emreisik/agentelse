// Reklam hesabı sağlığı (docs/meta-ads-plan.md §3.6 Hesap / ödeme, G6, G9).
// Saf: senkron yazar, bekçiler ve yazma kapısı okur.

export type AccountHealthStatus =
  "OK" | "WARN" | "BLOCKED" | "AUTH" | "UNKNOWN";

export type AccountHealthIssue = {
  kind:
    | "ACCOUNT_BLOCKED"
    | "PAYMENT_ISSUE"
    | "SPEND_CAP_NEAR"
    | "SPEND_CAP_REACHED";
  severity: "WARN" | "CRITICAL";
  title: string;
  detail: string;
};

// Meta account_status.
const STATUS_TEXT: Readonly<Record<number, AccountHealthIssue>> = {
  2: {
    kind: "ACCOUNT_BLOCKED",
    severity: "CRITICAL",
    title: "Meta disabled this ad account",
    detail:
      "Ads can't run until Meta restores the account. Check Account Quality in Meta.",
  },
  3: {
    kind: "PAYMENT_ISSUE",
    severity: "CRITICAL",
    title: "Your ad account has an unpaid balance",
    detail: "Pay in Meta Billing to resume your ads.",
  },
  7: {
    kind: "ACCOUNT_BLOCKED",
    severity: "CRITICAL",
    title: "Meta is reviewing this ad account",
    detail: "Ads are on hold while Meta reviews the account.",
  },
  8: {
    kind: "PAYMENT_ISSUE",
    severity: "CRITICAL",
    title: "Your ad account has a payment to settle",
    detail: "Pay in Meta Billing to resume your ads.",
  },
  9: {
    kind: "PAYMENT_ISSUE",
    severity: "WARN",
    title: "Your ad account is in a payment grace period",
    detail: "Ads still run for now. Pay in Meta Billing so they don't stop.",
  },
  100: {
    kind: "ACCOUNT_BLOCKED",
    severity: "CRITICAL",
    title: "This ad account is closing",
    detail: "Meta is closing this ad account. Choose another account.",
  },
  101: {
    kind: "ACCOUNT_BLOCKED",
    severity: "CRITICAL",
    title: "This ad account is closed",
    detail: "Choose another ad account in Integrations.",
  },
};

export const SPEND_CAP_WARN_SHARE = 0.9;

export function accountHealthIssues(input: {
  accountStatus: number | null;
  disableReason: number | null;
  // null: ödeme bilgisi okunamadı (MANAGE görevi yok); yok sayılır.
  hasFunding: boolean | null;
  spendCapMinor: number | null;
  amountSpentMinor: number | null;
}): AccountHealthIssue[] {
  const issues: AccountHealthIssue[] = [];
  const status = input.accountStatus;
  if (status !== null && status !== 1 && status !== 201) {
    issues.push(
      STATUS_TEXT[status] ?? {
        kind: "ACCOUNT_BLOCKED",
        severity: "CRITICAL",
        title: "This ad account can't run ads right now",
        detail: `Meta reports account status ${status}.`,
      },
    );
  } else if (input.disableReason && input.disableReason !== 0) {
    issues.push({
      kind: "ACCOUNT_BLOCKED",
      severity: "CRITICAL",
      title: "Meta restricted this ad account",
      detail: "Check Account Quality in Meta to see why.",
    });
  }
  // Okunan ama boş ödeme bilgisi: Meta alanı başka nedenlerle de boş
  // döndürebildiği için WARN; teslimat gerçekten durursa PENDING_BILLING_INFO
  // reklam düzeyinde ayrıca yakalanır (G5).
  if (input.hasFunding === false) {
    issues.push({
      kind: "PAYMENT_ISSUE",
      severity: "WARN",
      title: "No payment method found on this ad account",
      detail: "Add a payment method in Meta Billing so ads can run.",
    });
  }
  const cap = input.spendCapMinor;
  const spent = input.amountSpentMinor;
  if (cap && cap > 0 && spent !== null) {
    if (spent >= cap) {
      issues.push({
        kind: "SPEND_CAP_REACHED",
        severity: "CRITICAL",
        title: "The ad account reached its spending limit",
        detail:
          "Ads stopped. Raise or reset the account spending limit in Meta.",
      });
    } else if (spent >= cap * SPEND_CAP_WARN_SHARE) {
      issues.push({
        kind: "SPEND_CAP_NEAR",
        severity: "WARN",
        title: "The ad account is close to its spending limit",
        detail: "Ads stop when the limit is reached.",
      });
    }
  }
  return issues;
}

export function healthStatusOf(issues: AccountHealthIssue[]): {
  status: AccountHealthStatus;
  reason: string | null;
} {
  const critical = issues.find((issue) => issue.severity === "CRITICAL");
  if (critical) {
    return {
      status: critical.kind === "SPEND_CAP_REACHED" ? "WARN" : "BLOCKED",
      reason: critical.title,
    };
  }
  const warn = issues[0];
  return warn
    ? { status: "WARN", reason: warn.title }
    : { status: "OK", reason: null };
}

// G6 yazma kapısı: 3/8/9'da (ödeme) yalnız artış ve yeni kampanya durur;
// diğer engellerde P1-P2 yazmalarının hepsi. PAUSE (P0) her durumda denenir.
export type AccountWriteGate = "OPEN" | "NO_INCREASE" | "CLOSED";

export function accountWriteGate(
  accountStatus: number | null,
): AccountWriteGate {
  if (accountStatus === null || accountStatus === 1 || accountStatus === 201) {
    return "OPEN";
  }
  if (accountStatus === 3 || accountStatus === 8 || accountStatus === 9) {
    return "NO_INCREASE";
  }
  return "CLOSED";
}

// funding_source_details okunabildiyse: bir ödeme yöntemi var mı?
export function hasFundingSource(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const record = details as Record<string, unknown>;
  return Boolean(record.id || record.type || record.display_string);
}
