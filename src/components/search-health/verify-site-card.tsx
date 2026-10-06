import { CopyButton } from "@/components/calendar/copy-button";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { checkSiteVerificationAction } from "@/server/actions/search-health-actions";
import type { SearchHealthPanel } from "@/server/seo/health/panel";

// Search Console'suz projede alan adı doğrulaması (SC-F3): ana sayfaya meta
// etiketi ya da DNS TXT kaydı. Jeton yoksa (açılış listesi dışı) yalnız
// açıklama görünür, hiçbir şey yazılmaz.

type Verify = NonNullable<SearchHealthPanel["scope"]["verify"]>;

function CodeBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted px-2.5 py-2 text-[11px] leading-relaxed">
        <code>{value}</code>
      </pre>
      <CopyButton text={value} label={label} />
    </div>
  );
}

export function VerifySiteCard({
  projectId,
  verify,
}: {
  projectId: string;
  verify: Verify | null;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          Verify your website to run the technical audit
        </p>
        <p className="text-xs text-muted-foreground">
          {verify
            ? `Use one of these two ways to show that you own ${verify.domain}. Connecting Search Console works too.`
            : "Connect Search Console, or add a tag or DNS record we give you, to show that you own the website."}
        </p>
      </div>
      {verify ? (
        <>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">
              Option 1: add this tag to the &lt;head&gt; of your homepage
            </p>
            <CodeBlock value={verify.metaTag} label="Tag" />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">
              Option 2: add a TXT record to the DNS of {verify.dnsName}
            </p>
            <CodeBlock value={verify.dnsValue} label="Record" />
          </div>
          <ActionForm
            action={checkSiteVerificationAction}
            successMessage="Your website is verified"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <SubmitButton variant="outline" size="xs">
              Check now
            </SubmitButton>
          </ActionForm>
        </>
      ) : null}
    </div>
  );
}
