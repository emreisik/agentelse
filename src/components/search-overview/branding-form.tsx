"use client";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { assetUrl } from "@/lib/asset-url";
import {
  ACCENT_HEX,
  ACCENT_KEYS,
  ACCENT_LABEL,
  BRANDING_FOOTER_MAX,
  BRANDING_NAME_MAX,
  DEFAULT_SHARE_FOOTER,
  LOGO_EMPTY_HINT,
  type BrandingSnapshot,
} from "@/lib/report-share/types";
import { saveReportBrandingAction } from "@/server/actions/report-share-actions";

// Müşteri raporları markası (SC-F9; GA-F8'in /websites sayfası da kullanır):
// ajans adı, vurgu rengi, alt not ve logo. Marka workspace'e aittir; yeni
// oluşturulan bağlantılara ve yazdırma görünümüne uygulanır, gönderilmiş
// bağlantıları değiştirmez. Yalnız workspace OWNER/ADMIN düzenler.

export function BrandingForm({
  branding,
  logos,
  canEdit,
}: {
  branding: BrandingSnapshot;
  logos: { id: string; filename: string }[];
  canEdit: boolean;
}) {
  return (
    <ActionForm
      action={saveReportBrandingAction}
      successMessage="Branding saved"
      className="space-y-4"
    >
      <fieldset disabled={!canEdit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="branding-name" className="text-sm font-medium">
            Name shown to clients
          </label>
          <Input
            id="branding-name"
            name="displayName"
            defaultValue={branding.displayName}
            maxLength={BRANDING_NAME_MAX}
            required
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Accent color</p>
          <div className="flex flex-wrap gap-2">
            {ACCENT_KEYS.map((key) => (
              <label
                key={key}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-xs has-[:checked]:border-foreground has-[:disabled]:cursor-not-allowed"
              >
                <input
                  type="radio"
                  name="accent"
                  value={key}
                  defaultChecked={branding.accent === key}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className="size-3 rounded-full"
                  style={{ backgroundColor: ACCENT_HEX[key] }}
                />
                {ACCENT_LABEL[key]}
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="branding-footer" className="text-sm font-medium">
            Footer note
          </label>
          <Input
            id="branding-footer"
            name="footer"
            defaultValue={branding.footer ?? ""}
            maxLength={BRANDING_FOOTER_MAX}
            placeholder={DEFAULT_SHARE_FOOTER}
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Logo</p>
          {logos.length === 0 ? (
            <>
              <input type="hidden" name="logoAssetId" value="" />
              <p className="text-xs text-muted-foreground">{LOGO_EMPTY_HINT}</p>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-xs has-[:checked]:border-foreground has-[:disabled]:cursor-not-allowed">
                <input
                  type="radio"
                  name="logoAssetId"
                  value=""
                  defaultChecked={branding.logoAssetId === null}
                  className="sr-only"
                />
                No logo
              </label>
              {logos.map((logo) => (
                <label
                  key={logo.id}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1 text-xs has-[:checked]:border-foreground has-[:disabled]:cursor-not-allowed"
                >
                  <input
                    type="radio"
                    name="logoAssetId"
                    value={logo.id}
                    defaultChecked={branding.logoAssetId === logo.id}
                    className="sr-only"
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={assetUrl(logo.id, "thumb")}
                    alt={logo.filename}
                    className="h-8 w-auto max-w-24 object-contain"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      {canEdit ? (
        <SubmitButton size="sm">Save branding</SubmitButton>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only workspace owners and admins can change this.
        </p>
      )}
    </ActionForm>
  );
}
