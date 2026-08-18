import { CheckIcon } from "lucide-react";

import { RegisterForm } from "@/components/auth/register-form";
import { LogoBadge } from "@/components/shared/logo-badge";

const HIGHLIGHTS = [
  "Gerçek zamanlı kampanya görünürlüğü",
  "Onay ve insan-inceleme akışları",
  "Otomatikleştirilmiş raporlama",
];

export default async function RegisterPage({
  searchParams,
}: PageProps<"/register">) {
  const params = await searchParams;
  const callbackUrl =
    typeof params.callbackUrl === "string" ? params.callbackUrl : "/dashboard";

  return (
    <div className="flex min-h-screen w-full flex-col bg-background lg:flex-row">
      {/* Sol panel — marka ve değer önerisi (yalnızca masaüstü) */}
      <div className="hidden flex-col justify-between bg-primary p-10 text-primary-foreground lg:flex lg:w-1/2 xl:p-16">
        <div className="flex items-center gap-2">
          <LogoBadge />
          <div className="leading-tight">
            <div className="font-heading text-lg font-semibold tracking-tight">
              Agentelse
            </div>
            <div className="text-xs text-primary-foreground/60">
              Your AI Growth Team
            </div>
          </div>
        </div>

        <div className="max-w-md space-y-6">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance xl:text-4xl">
            Ajansınızı büyüten yapay zeka ekibi.
          </h1>
          <p className="text-base text-pretty text-primary-foreground/70">
            Kampanyalar, ekipler ve raporlama Agentelse&apos;de tek çatı altında
            birleşir.
          </p>
          <ul className="space-y-3 pt-2">
            {HIGHLIGHTS.map((item) => (
              <li
                key={item}
                className="flex items-center gap-2.5 text-sm text-primary-foreground/80"
              >
                <CheckIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-primary-foreground/50"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-primary-foreground/40">
          © {new Date().getFullYear()} Agentelse
        </p>
      </div>

      {/* Sağ panel — kayıt formu */}
      <div className="flex flex-1 flex-col items-center justify-center gap-10 p-6 sm:p-10">
        <div className="flex flex-col items-center gap-1.5 lg:hidden">
          <div className="flex items-center gap-2">
            <LogoBadge />
            <span className="font-heading text-lg font-semibold tracking-tight">
              Agentelse
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            Your AI Growth Team
          </span>
        </div>
        <RegisterForm callbackUrl={callbackUrl} />
      </div>
    </div>
  );
}
