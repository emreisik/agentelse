import type { ZodType } from "zod";

// A ReasoningDef packages one engine-internal LLM purpose: its output schema,
// how to build the real prompt from caller-frozen context, and how to build a
// deterministic mock output from that same context. Mock builders MUST derive
// everything from the input (never hardcode brand content) so tests exercise
// real data flow, and every mock output is marked isMock by the service.
export type ReasoningContext = Record<string, unknown>;

export type ReasoningDef<TOut> = {
  purpose: string;
  schema: ZodType<TOut>;
  buildPrompt(context: ReasoningContext): { system: string; user: string };
  buildMock(context: ReasoningContext): TOut;
  // Maliyet/kalite kademesi. "lite" yüksek hacimli mekanik adımlar için
  // (fikir üretimi, sinyal skorlama), "pro" nadir ama kritik sentezler için.
  // Belirtilmezse proje geneli varsayılan model kullanılır.
  tier?: "lite" | "default" | "pro";
  // Kademeyi atlayıp belirli bir modeli sabitlemek için kaçış kapısı.
  model?: string;
  maxTokens?: number;
};

export type ReasoningInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  context: ReasoningContext;
  // Çok modlu girdi (kullanıcının sohbete eklediği görsel/PDF/metin).
  // Yalnızca gerçek çağrıda kullanılır; mock yolu bunları görmez, bu yüzden
  // buildMock her zaman yalnız context'ten türetmeye devam eder.
  attachments?: { mimeType: string; data: string }[];
};

export type ReasoningResult<TOut> = {
  output: TOut;
  isMock: boolean;
  reasoningCallId: string;
};
