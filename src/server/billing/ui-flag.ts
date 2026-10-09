import "server-only";

// The Plan & usage screens (/billing): on in development so the owner can see them
// while billing is being built, and in production only when BILLING_UI=true is set.
// Read at call time. A route re-checks it itself: hiding a link is not a boundary.
export function isBillingUiEnabled(): boolean {
  if (process.env.BILLING_UI === "true") return true;
  if (process.env.BILLING_UI === "false") return false;
  return process.env.NODE_ENV !== "production";
}
