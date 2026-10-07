import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  indexNowDisableAction,
  indexNowEnableAction,
  indexNowVerifyAction,
} from "@/server/actions/seo-apply-actions";
import type { IndexNowView } from "@/lib/seo/apply/view-types";

// IndexNow kartı (SC-F8, SEO_INDEXNOW): Bing, Yandex gibi IndexNow'a katılan
// arama motorlarına yayına giren sayfaları bildirir (Google katılmaz).
// WordPress REST kök dizine dosya yazamaz: kullanıcı {anahtar}.txt dosyasını
// kendisi oluşturur, "Check the file" gövdenin anahtara eşit olduğunu doğrular.
// Anahtar herkese açıktır (dosya adı ve içeriği), gizli değildir. Yalnız props'tan
// çizilir; düğmeler yalnız yöneticide görünür.

export const INDEXNOW_COPY = {
  title: "IndexNow",
  intro:
    "Tell search engines that use IndexNow, such as Bing and Yandex, when a page change goes live. Google does not use it. Only the addresses of changed public pages are sent, never drafts. It is optional and you can switch it off at any time.",
  verified:
    "The key file is in place. Agentelse sends the address of a page when a change to it goes live.",
  notVerified:
    "Not checked yet. Nothing is sent until the key file is in place.",
} as const;

function Hidden({ projectId }: { projectId: string }) {
  return <input type="hidden" name="projectId" value={projectId} />;
}

export function IndexNowCard({
  projectId,
  view,
  canManage = true,
}: {
  projectId: string;
  view: IndexNowView;
  canManage?: boolean;
}): React.JSX.Element {
  return (
    <div
      id="indexnow"
      data-enabled={view.enabled ? "true" : "false"}
      className="space-y-3 rounded-xl p-4 ring-1 ring-foreground/10"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{INDEXNOW_COPY.title}</h3>
        <p className="text-xs text-muted-foreground">{INDEXNOW_COPY.intro}</p>
      </div>

      {!view.enabled || !view.key ? (
        canManage ? (
          <ActionForm
            action={indexNowEnableAction}
            successMessage="IndexNow is on. Add the key file, then check it."
          >
            <Hidden projectId={projectId} />
            <SubmitButton size="xs">Switch on IndexNow</SubmitButton>
          </ActionForm>
        ) : (
          <p className="text-xs text-muted-foreground">
            An owner or admin can switch this on.
          </p>
        )
      ) : (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-4 text-xs">
            <li>
              {"Create a plain text file named "}
              <code className="rounded bg-muted px-1 py-0.5">
                {view.keyFileName}
              </code>
              .
            </li>
            <li>
              {"The only thing in the file is this key: "}
              <code className="rounded bg-muted px-1 py-0.5 break-all">
                {view.key}
              </code>
            </li>
            <li>
              {"Upload it to the root of your site so that it opens at "}
              <code className="rounded bg-muted px-1 py-0.5 break-all">
                {view.keyUrl}
              </code>
              .
            </li>
            <li>Check the file below.</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            {view.verified ? INDEXNOW_COPY.verified : INDEXNOW_COPY.notVerified}
          </p>
          {view.lastPingAt ? (
            <p className="text-xs text-muted-foreground">
              {`Last sent ${view.lastPingAt.slice(0, 10)}`}
            </p>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <ActionForm
                action={indexNowVerifyAction}
                successMessage="The key file is in place."
              >
                <Hidden projectId={projectId} />
                <SubmitButton size="xs" variant={view.verified ? "outline" : "default"}>
                  Check the file
                </SubmitButton>
              </ActionForm>
              <ActionForm
                action={indexNowDisableAction}
                successMessage="IndexNow is off."
              >
                <Hidden projectId={projectId} />
                <SubmitButton size="xs" variant="ghost">
                  Switch off
                </SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
