import { BigQueryError } from "./errors";

// SQL'e giren tek tanımlayıcı kapısı (bqTable) ve salt-okunur SQL koruması.
// Parametre değerleri her zaman adlandırılmış parametredir; tanımlayıcılar
// ancak burada doğrulanıp ters tırnakla sarılır.

export function isValidGcpProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

export function isValidDatasetId(value: string): boolean {
  return /^[A-Za-z0-9_]{1,1024}$/.test(value);
}

export function isValidTableId(value: string): boolean {
  return /^[A-Za-z0-9_]{1,1024}$/.test(value);
}

export function bqTable(ids: {
  projectId: string;
  dataset: string;
  table: string;
}): string {
  if (
    !isValidGcpProjectId(ids.projectId) ||
    !isValidDatasetId(ids.dataset) ||
    !isValidTableId(ids.table)
  ) {
    throw new BigQueryError("INVALID_REQUEST");
  }
  return `\`${ids.projectId}.${ids.dataset}.${ids.table}\``;
}

// Yorumları ve tırnaklı bölümleri (dize, ters tırnaklı ad) boşlukla değiştirir;
// kalan metin yalnız gerçek SQL belirteçlerini içerir. Kapanmayan tırnak
// geçersizdir.
function maskQuoted(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;
    const rest3 = sql.slice(i, i + 3);
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "#") {
      while (i < n && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new BigQueryError("INVALID_REQUEST");
      i = end + 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const triple = ch !== "`" && rest3 === ch.repeat(3);
      const closer = triple ? ch.repeat(3) : ch;
      i += closer.length;
      let closed = false;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql.startsWith(closer, i)) {
          i += closer.length;
          closed = true;
          break;
        }
        // Tek tırnaklı dize satır sonunda biter (üçlü ve ters tırnak hariç)
        if (!triple && ch !== "`" && sql[i] === "\n") break;
        i += 1;
      }
      if (!closed) throw new BigQueryError("INVALID_REQUEST");
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const FORBIDDEN_WORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "EXPORT",
  "CALL",
  "EXECUTE",
  "GRANT",
  "REVOKE",
];
const FORBIDDEN_RE = new RegExp(`\\b(?:${FORBIDDEN_WORDS.join("|")})\\b`, "i");

// BigQuery erişimi salt okunurdur: sorgu SELECT ya da WITH ile başlar, tek
// ifadedir ve yazan komut kelimesi içermez (dize ve ters tırnak içindekiler
// sayılmaz).
export function assertReadOnlySql(sql: string): void {
  const code = maskQuoted(sql).trim();
  const body = code.endsWith(";") ? code.slice(0, -1).trim() : code;
  if (!body || body.includes(";")) throw new BigQueryError("INVALID_REQUEST");
  if (!/^(?:SELECT|WITH)\b/i.test(body)) {
    throw new BigQueryError("INVALID_REQUEST");
  }
  if (FORBIDDEN_RE.test(body)) throw new BigQueryError("INVALID_REQUEST");
}
