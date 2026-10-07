import "server-only";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import type { ModuleFlowStep } from "@/lib/module-flows/card";
import {
  seoRunActive,
  withoutRun,
  type SeoRunKind,
  type SeoRunPhase,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import {
  releaseSeoRun,
  writeSeoCard,
  type SeoCardNext,
} from "@/server/modules/seo/card";
import { SeoActionVerifier } from "@/server/seo/actions/verify";
import { GUARD_MESSAGE } from "@/server/works/guard";

// SEO Manager'ın model çağrıları arka planda (docs/search-actions.md "SEO
// Manager"): eylem kartı sahiplenir (run), işi next/server after() ile
// zamanlar ve hemen döner; iş evrelerini karta yazar, istemci bunları DB
// yoklamalı SSE ucundan canlı izler. after() bir deploy yeniden başlatmasında
// ölebilir: kartın 5 dakikalık run TTL'i kartı açar. Cevaptan SONRA
// revalidatePath çağrılmaz; istemci SSE'nin `end` olayında kendini yeniler.

export type SeoJobCurrent = { step: ModuleFlowStep; state: SeoState };

export type SeoJob<T> = {
  projectId: string;
  commandId: string;
  runId: string;
  kind: SeoRunKind;
  fallbackStep: ModuleFlowStep;
  // Model çağrısı; evre değişince setPhase karta yazar (sahiplik düştüyse
  // sessizce bir şey yapmaz).
  call: (
    setPhase: (phase: SeoRunPhase) => Promise<void>,
  ) => Promise<{ ok: true; value: T } | { ok: false; message: string }>;
  // Cevabın karta yazılışı; kart yazılırken run hâlâ bu işinse çağrılır.
  finish: (current: SeoJobCurrent, value: T) => SeoJobCurrent;
  // Kart yazıldıktan sonraki yan işler (Work özeti gibi); hatası işi bozmaz.
  after?: (value: T) => Promise<void>;
};

const STALE = "This card changed. Refreshing.";

function logFailure(label: string, error: unknown): void {
  console.error(
    `[works] seo ${label} failed:`,
    error instanceof Error ? error.message : error,
  );
}

// Başarısız işin sahipliğini bırakır ve nedenini karta yazar (lastError): SSE
// ucu `?run=` ile eşleşen hatayı istemciye bildirir. Tek yazma: sahiplik
// düşmüşse hata da yazılmaz.
async function failRun<T>(job: SeoJob<T>, message: string): Promise<void> {
  const written = await writeSeoCard({
    projectId: job.projectId,
    commandId: job.commandId,
    update: ({ state }) =>
      state.run?.id === job.runId
        ? {
            step: job.fallbackStep,
            state: {
              ...withoutRun(state),
              lastError: {
                runId: job.runId,
                kind: job.kind,
                message,
                at: new Date().toISOString(),
              },
            },
          }
        : { reject: STALE },
  }).catch((error: unknown) => {
    logFailure("failure write", error);
    return null;
  });
  // Kart yazılamadıysa (Work tamamlandı gibi) en azından sahiplik düşürülmeyi dener.
  if (written && !written.ok && written.message !== STALE) {
    await releaseSeoRun({
      projectId: job.projectId,
      commandId: job.commandId,
      runId: job.runId,
      step: job.fallbackStep,
    });
  }
}

// Hiçbir koşulda fırlatmaz: after() içinde yakalanmamış hata sürecin sorunu olur.
export async function runSeoJob<T>(job: SeoJob<T>): Promise<void> {
  const { projectId, commandId, runId } = job;
  try {
    const setPhase = async (phase: SeoRunPhase): Promise<void> => {
      await writeSeoCard({
        projectId,
        commandId,
        update: ({ step, state }) =>
          state.run?.id === runId
            ? { step, state: { ...state, run: { ...state.run, phase } } }
            : { reject: STALE },
      }).catch((error: unknown) => logFailure("phase write", error));
    };

    let outcome: { ok: true; value: T } | { ok: false; message: string };
    try {
      outcome = await job.call(setPhase);
    } catch (error) {
      logFailure(job.kind, error);
      outcome = { ok: false, message: GUARD_MESSAGE.failed };
    }
    if (!outcome.ok) {
      await failRun(job, outcome.message);
      return;
    }

    const value = outcome.value;
    const done = await writeSeoCard({
      projectId,
      commandId,
      update: ({ step, state }) =>
        state.run?.id === runId
          ? job.finish({ step, state: withoutRun(state) }, value)
          : { reject: STALE },
    });
    if (!done.ok) {
      // Sahiplik başkasına geçtiyse (TTL) bu cevap atılır; sebebi loga yazılır.
      logFailure(`${job.kind} write`, done.message);
      return;
    }
    if (job.after)
      await job.after(value).catch((e: unknown) => logFailure("after", e));
  } catch (error) {
    logFailure(`${job.kind} job`, error);
  }
}

// Cevap dönünce çalışır; istek bağlamı dışında (after kullanılamıyorsa) işi
// ayrık başlatır.
export function scheduleSeoJob<T>(job: SeoJob<T>): void {
  try {
    after(() => runSeoJob(job));
  } catch (error) {
    logFailure("schedule", error);
    void runSeoJob(job);
  }
}

// Kullanıcı "uygulandı" dediğinde doğrulayıcı cevaptan sonra hemen bir kez bakar
// (günlük tick'i beklemeden); hatası kullanıcıya yansımaz.
export function verifyActionSoon(actionId: string): void {
  const run = async (): Promise<void> => {
    await SeoActionVerifier.runAction(actionId).catch((error: unknown) =>
      logFailure("verify", error),
    );
  };
  try {
    after(run);
  } catch (error) {
    logFailure("schedule verify", error);
    void run();
  }
}

// ---- sahiplen + çağır sürücüsü ------------------------------------------------------

export type SeoClaimedRun<T> = {
  projectId: string;
  commandId: string;
  kind: SeoRunKind;
  fallbackStep: ModuleFlowStep;
  // Canlı kipte kartın ilk evresi.
  phase?: SeoRunPhase;
  claim: (current: SeoJobCurrent) => SeoCardNext;
  call: (
    claimed: SeoJobCurrent,
    setPhase: (phase: SeoRunPhase) => Promise<void>,
  ) => Promise<{ ok: true; value: T } | { ok: false; message: string }>;
  finish: (current: SeoJobCurrent, value: T) => SeoJobCurrent;
  // Kart yazıldıktan sonra (yan işler); hatası sonucu bozmaz.
  afterDone?: (value: T) => Promise<void>;
  message: string;
  copy: { busy: string; stale: string };
};

export type SeoClaimedResult =
  | { ok: true; message: string; runId?: string }
  | { ok: false; message: string; code?: "STALE" };

export const SEO_LIVE_MESSAGE = "Working on it. This card updates live.";

// Bir model çağrısı: sahiplen (kart çalışıyor görünür, ikinci dokunuş ya da
// sekme reddedilir), çağır, cevabı yalnız sahiplik hâlâ bu çalıştırmanınsa yaz.
// Başarısız çağrı sahipliği bırakır ve kartı `fallbackStep`e döndürür.
// Kart canlı damgalıysa (features.live) ve SEO_ACTIONS açıksa çağrı arka planda
// koşar ve `runId` ile hemen dönülür; aksi hâlde bugünkü eşzamanlı yol.
export async function runSeoClaimed<T>(
  input: SeoClaimedRun<T>,
): Promise<SeoClaimedResult> {
  const { projectId, commandId } = input;
  const runId = randomUUID();
  const startedAt = new Date();
  const mode = { live: false };

  const failed = (message: string): SeoClaimedResult =>
    message === input.copy.stale
      ? { ok: false, message, code: "STALE" }
      : { ok: false, message };

  const claimed = await writeSeoCard({
    projectId,
    commandId,
    update: (current) => {
      if (seoRunActive(current.state.run, startedAt.getTime())) {
        return { reject: input.copy.busy };
      }
      const next = input.claim(current);
      if ("reject" in next) return next;
      mode.live =
        SeoActionFlags.manager() && next.state.features?.live === true;
      // Yeni çalıştırma önceki hatayı siler.
      const state = { ...next.state };
      delete state.lastError;
      return {
        step: next.step,
        state: {
          ...state,
          run: {
            id: runId,
            kind: input.kind,
            startedAt: startedAt.toISOString(),
            ...(mode.live && input.phase ? { phase: input.phase } : {}),
          },
        },
      };
    },
  });
  if (!claimed.ok) return failed(claimed.message);

  if (mode.live) {
    scheduleSeoJob<T>({
      projectId,
      commandId,
      runId,
      kind: input.kind,
      fallbackStep: input.fallbackStep,
      call: (setPhase) => input.call(claimed, setPhase),
      finish: input.finish,
      ...(input.afterDone ? { after: input.afterDone } : {}),
    });
    return { ok: true, message: SEO_LIVE_MESSAGE, runId };
  }

  const refresh = () => revalidatePath(`/projects/${projectId}`);
  let outcome: { ok: true; value: T } | { ok: false; message: string };
  try {
    outcome = await input.call(claimed, async () => undefined);
  } catch (error) {
    logFailure(input.kind, error);
    outcome = { ok: false, message: GUARD_MESSAGE.failed };
  }
  if (!outcome.ok) {
    await releaseSeoRun({
      projectId,
      commandId,
      runId,
      step: input.fallbackStep,
    });
    refresh();
    return { ok: false, message: outcome.message };
  }

  const value = outcome.value;
  const done = await writeSeoCard({
    projectId,
    commandId,
    update: (current) =>
      current.state.run?.id === runId
        ? input.finish(
            { step: current.step, state: withoutRun(current.state) },
            value,
          )
        : { reject: input.copy.stale },
  });
  refresh();
  if (!done.ok) return failed(done.message);
  if (input.afterDone) {
    await input.afterDone(value).catch((e: unknown) => logFailure("after", e));
  }
  return { ok: true, message: input.message };
}
