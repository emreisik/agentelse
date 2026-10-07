// BigQuery istemcisinin ortak tipleri (GA ve Search Console dışa aktarımları
// paylaşır; bu klasörde ikisine de ait ad geçmez).

export type BqParam = {
  name: string;
  type: "STRING" | "INT64" | "FLOAT64" | "DATE" | "BOOL";
  // DATE için "YYYY-MM-DD"
  value: string | number | boolean;
};

export type BqColumn = {
  name: string;
  type:
    | "STRING"
    | "INTEGER"
    | "FLOAT"
    | "BOOLEAN"
    | "DATE"
    | "TIMESTAMP"
    | "OTHER";
};

// INTEGER/FLOAT -> number, BOOLEAN -> boolean, kalanı string
export type BqCell = string | number | boolean | null;

export type BqQueryRequest = {
  // "gsc.*" | "ga.*": sahte arka ucu yönlendirir ve işi etiketler
  purpose: string;
  projectId: string;
  location: string | null;
  sql: string;
  params: BqParam[];
  maxBytesBilled: number;
  maxRows: number;
  // Toplam bekleme (varsayılan 90000); çağıran, tur süresinden kalanı verir.
  timeoutMs?: number;
  // Tekrar güvenliği anahtarı; yoksa istemci rastgele UUID doldurur.
  requestId?: string;
};

export type BqQueryResult = {
  columns: BqColumn[];
  rows: BqCell[][];
  totalRows: number;
  // Sunucu okunandan fazla satır bildirdi
  truncated: boolean;
  bytesProcessed: number;
  bytesBilled: number | null;
  cacheHit: boolean;
};

export type BqDryRunResult = { bytesProcessed: number };

export type BqTableInfo = {
  numRows: number | null;
  sizeBytes: number | null;
  location: string | null;
  partitionField: string | null;
};

export type BqDatasetInfo = { location: string | null };

export interface BigQueryBackend {
  query(request: BqQueryRequest, token: string): Promise<BqQueryResult>;
  dryRun(request: BqQueryRequest, token: string): Promise<BqDryRunResult>;
  getTable(
    input: { projectId: string; dataset: string; table: string },
    token: string,
  ): Promise<BqTableInfo>;
  getDataset(
    input: { projectId: string; dataset: string },
    token: string,
  ): Promise<BqDatasetInfo>;
}
