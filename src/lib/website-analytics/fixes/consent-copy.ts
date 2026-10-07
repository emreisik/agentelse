// İsteğe bağlı ikinci onay (analytics.edit) için hata metinleri. Integrations
// sayfası bunları kendi GOOGLE_ERROR_MESSAGES tablosuna yayar.

export const GA_EDIT_ERROR_MESSAGES: Record<
  | "edit_not_available"
  | "edit_manager_only"
  | "edit_connect_first"
  | "edit_scope_missing"
  | "edit_account_mismatch",
  string
> = {
  edit_not_available: "Editing isn't available right now.",
  edit_manager_only: "Only workspace owners and admins can allow editing.",
  edit_connect_first:
    "Connect Google Analytics and choose a property first.",
  edit_scope_missing:
    "Editing wasn't allowed. Try again and tick the box that lets Agentelse edit Google Analytics. Nothing was changed.",
  edit_account_mismatch:
    "Use the same Google account that is connected. Nothing was changed.",
};

export function gaEditStartHref(projectId: string): string {
  return `/api/integrations/google/start?projectId=${projectId}&service=analytics&upgrade=edit`;
}
