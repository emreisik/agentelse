import "server-only";

// Bir operasyonun (worker işi, sohbet turu, sunucu eylemi) gerçek maliyet sayacı.
// usage-recorder.ts her ücretli sağlayıcı çağrısını UsageEntry'ye yazmadan ÖNCE
// buraya ekler; operation.ts bu toplamla settle eder. Bellek içidir ve operasyonun
// ömrü kadar yaşar: kalıcı kayıt UsageEntry'dir, sayaç yalnız "bu operasyon ne
// harcadı" sorusunun hızlı cevabıdır.
//
// UsageEntry toplamı yerine ayrı sayaç tutulmasının nedeni: aynı operationId'yi
// paylaşan yeniden denemeler (worker deneme 1 + 2) aynı satırlara karışır; sayaç
// ise yalnız bu denemenin çağrılarını görür.

export type MeterEntry = {
  // Aynı sağlayıcı yanıtı iki kez eklenmesin (recordUsage'ın callId'si).
  callId: string;
  kind: "TEXT" | "IMAGE" | "SEARCH" | "EMBED" | "VIDEO";
  costMicros: bigint;
  success: boolean;
  // IMAGE için üretilen görsel adedi.
  units?: number;
};

export class UsageMeter {
  readonly workspaceId: string;
  readonly operationId: string;
  // Operasyon başına azami maliyet (mikro-USD); verilmezse sınırsız. Aşıldığında
  // sonraki ücretli çağrılar assertRoom() ile durdurulabilir (Faz 3B).
  readonly ceilingMicros: bigint | undefined;

  // Bu sayacın operasyonu bir hak rezervasyonu tutuyor: içindeki motor çağrıları
  // (ReasoningService.run) o rezervasyona katılır, yeniden rezerve etmez. Ücretsiz,
  // rezervasyonsuz ya da kapalı moddaki bir operasyonun sayacı bunu SAĞLAMAZ; içindeki
  // çağrı kendi hakkını ayırır.
  covered = false;

  private readonly seen = new Set<string>();
  private spent = BigInt(0);
  private drawn = 0;
  private callCount = 0;
  private isClosed = false;
  private late = BigInt(0);

  constructor(input: {
    workspaceId: string;
    operationId: string;
    ceilingMicros?: bigint;
  }) {
    this.workspaceId = input.workspaceId;
    this.operationId = input.operationId;
    this.ceilingMicros = input.ceilingMicros;
  }

  // Operasyon mahsup edildi. Bundan sonra gelen çağrılar (zaman aşımı yarışını
  // kaybedip arkada sürmüş işler) mahsup edilmiş sonuca karışmaz; `lateMicros`
  // olarak ayrı sayılır ve bir kez loglanır.
  close(): void {
    this.isClosed = true;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get lateMicros(): bigint {
    return this.late;
  }

  // Asla fırlatmaz: ücretli çağrı zaten yapılmıştır.
  add(entry: MeterEntry): void {
    if (this.seen.has(entry.callId)) return;
    this.seen.add(entry.callId);
    if (this.isClosed) {
      if (entry.costMicros > BigInt(0)) {
        if (this.late === BigInt(0)) {
          console.warn(
            `[billing] a paid call finished after its operation was settled (${this.operationId})`,
          );
        }
        this.late += entry.costMicros;
      }
      return;
    }
    this.callCount += 1;
    if (entry.costMicros > BigInt(0)) this.spent += entry.costMicros;
    if (entry.kind === "IMAGE" && entry.success) {
      const units = entry.units ?? 1;
      if (Number.isFinite(units) && units > 0) this.drawn += Math.floor(units);
    }
  }

  // Başarılı VE başarısız tüm çağrıların toplam maliyeti.
  get costMicros(): bigint {
    return this.spent;
  }

  // Başarıyla üretilen görsel sayısı.
  get images(): number {
    return this.drawn;
  }

  get calls(): number {
    return this.callCount;
  }

  get exceeded(): boolean {
    return this.ceilingMicros !== undefined && this.spent > this.ceilingMicros;
  }
}
