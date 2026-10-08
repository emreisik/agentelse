import "server-only";

// Kullanım defterinin ham SQL'i. Her ifade TEK komuttur (kilit, bölüştürme,
// idempotent INSERT ve sayaç güncellemesi birlikte): ara durum yok, 25P02 tuzağı yok.
// PostgreSQL 14'te gerçek DB'ye karşı doğrulandı (eşzamanlılık kapısı, tekrarlı
// anahtar, borç dağılımı: ledger.integration.test.ts).
//
// Kurallar:
//  - Parametreler açık dökümlüdür ($n::text, ::bigint): Prisma ham sorguda tipi
//    tahmin edemez. Tarihler `timestamptz` bağlanır ve `AT TIME ZONE 'UTC'` ile UTC
//    duvar saatine çevrilir (kolonlar `timestamp`, UTC tutulur): oturum saat dilimi
//    ne olursa olsun aynı sonuç (UTC dışı oturumda `::timestamp` 3 saat kaydırıyordu).
//  - Ham INSERT'te id ve updatedAt AÇIKÇA verilir (veritabanı varsayılanı yok).
//  - COUNT(*) ::int, toplamlar ::bigint (Prisma SUM(bigint)'i Decimal döndürür).
//  - Tüketim sırası PERIOD → EXTRA. Dönem havuzu yalnız periodEnd > now iken
//    harcanır (sona ermiş pencerenin kalanı kullanılamaz).
//  - FOR UPDATE ŞARTTIR: olmazsa N paralel istek aynı bakiyeyi birlikte okuyup
//    kapasiteyi aşar (gerçek DB testinde 80 kapasiteye 134-180 ayrıldı).
//  - Kilit sırası her yerde bakiye satırı → rezervasyon satırıdır (ölü kilit yok).

// $1 workspaceId, $2 unit, $3 amount, $4 yeni rezervasyon id, $5 reservationKey,
// $6 operationId|null, $7 expiresAt, $8 now
export const RESERVE_SQL = `
WITH cur AS (
  SELECT "id", "periodEnd",
         CASE WHEN "periodEnd" > ($8::timestamptz AT TIME ZONE 'UTC')
              THEN GREATEST("periodGranted" - "periodUsed" - "periodReserved", 0)
              ELSE 0 END AS pavail,
         GREATEST("extraGranted" - "extraUsed" - "extraReserved", 0) AS eavail
    FROM "UsageBalance"
   WHERE "workspaceId" = $1::text AND "unit" = $2::text
     FOR UPDATE
), plan AS (
  SELECT LEAST($3::bigint, cur.pavail)              AS fp,
         $3::bigint - LEAST($3::bigint, cur.pavail) AS fe
    FROM cur
   WHERE cur.pavail + cur.eavail >= $3::bigint
), ins AS (
  INSERT INTO "UsageReservation"
         ("id","workspaceId","unit","reservationKey","operationId","amount","fromPeriod","fromExtra","status","overdraft","expiresAt","createdAt")
  SELECT $4::text, $1::text, $2::text, $5::text, $6::text, $3::bigint, plan.fp, plan.fe, 'RESERVED', false, ($7::timestamptz AT TIME ZONE 'UTC'), ($8::timestamptz AT TIME ZONE 'UTC')
    FROM plan
  ON CONFLICT ("workspaceId","unit","reservationKey") DO NOTHING
  RETURNING "fromPeriod", "fromExtra"
), upd AS (
  UPDATE "UsageBalance" b
     SET "periodReserved" = b."periodReserved" + ins."fromPeriod",
         "extraReserved"  = b."extraReserved"  + ins."fromExtra",
         "updatedAt"      = ($8::timestamptz AT TIME ZONE 'UTC')
    FROM ins, cur
   WHERE b."id" = cur."id"
  RETURNING 1
)
SELECT (SELECT count(*) FROM cur)::int  AS "balanceRows",
       (SELECT count(*) FROM plan)::int AS "sufficient",
       (SELECT count(*) FROM ins)::int  AS "inserted",
       (SELECT "fromPeriod" FROM ins)   AS "fromPeriod",
       (SELECT "fromExtra"  FROM ins)   AS "fromExtra",
       (SELECT "periodEnd"  FROM cur)   AS "periodEnd",
       (SELECT pavail + eavail FROM cur)::bigint AS "available"
`;

// reserve inserted=0 döndürdüğünde: aynı anahtar daha önce yazılmış mı?
// $1 workspaceId, $2 unit, $3 reservationKey
export const RESERVATION_LOOKUP_SQL = `
SELECT "status", "amount", "settledAmount", "overdraft"
  FROM "UsageReservation"
 WHERE "workspaceId" = $1::text AND "unit" = $2::text AND "reservationKey" = $3::text
`;

// Gölge mod, bakiye satırı var ama yetmiyor: sayaçlara DOKUNMAYAN "olsaydı
// engellenirdi" kaydı. $1 id, $2 ws, $3 unit, $4 key, $5 operationId|null,
// $6 amount, $7 expiresAt, $8 now
export const RESERVE_OVERDRAFT_SQL = `
INSERT INTO "UsageReservation"
       ("id","workspaceId","unit","reservationKey","operationId","amount","fromPeriod","fromExtra","status","overdraft","expiresAt","createdAt")
VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::bigint, 0, 0, 'RESERVED', true, ($7::timestamptz AT TIME ZONE 'UTC'), ($8::timestamptz AT TIME ZONE 'UTC'))
ON CONFLICT ("workspaceId","unit","reservationKey") DO NOTHING
RETURNING "id"
`;

// Gerçekleşen tutarı mahsup et. RESERVED veya (süpürücü bıraktıysa) RELEASED
// rezervasyondan geçer; SETTLED satır dokunulmaz (0 satır döner). Önce rezervasyonun
// kendi havuz paylarından, fazlası dönem ve extra BOŞLUĞUNDAN, kalan borç dönem
// havuzuna (used > granted; pencere sıfırlamasında affedilir) yazılır. Gölge
// (overdraft) satırın gerçek tutarı sayaçlara yazılmaz.
// $1 workspaceId, $2 unit, $3 reservationKey, $4 actual, $5 now
export const SETTLE_SQL = `
WITH bal AS (
  SELECT "id", "periodGranted" AS pg, "periodUsed" AS pu, "periodReserved" AS pr,
         "extraGranted" AS eg, "extraUsed" AS eu, "extraReserved" AS er
    FROM "UsageBalance"
   WHERE "workspaceId" = $1::text AND "unit" = $2::text
     FOR UPDATE
), res AS (
  SELECT "id", "status", "fromPeriod" AS fp, "fromExtra" AS fe, "overdraft" AS od
    FROM "UsageReservation"
   WHERE "workspaceId" = $1::text AND "unit" = $2::text AND "reservationKey" = $3::text
     FOR UPDATE
), done AS (
  UPDATE "UsageReservation" u
     SET "status" = 'SETTLED', "settledAmount" = $4::bigint, "settledAt" = ($5::timestamptz AT TIME ZONE 'UTC'),
         "fromPeriod" = 0, "fromExtra" = 0
    FROM res, bal
   WHERE u."id" = res."id" AND res."status" IN ('RESERVED','RELEASED')
  RETURNING CASE WHEN res."status" = 'RESERVED' THEN res.fp ELSE 0::bigint END AS fp,
            CASE WHEN res."status" = 'RESERVED' THEN res.fe ELSE 0::bigint END AS fe,
            CASE WHEN res.od THEN 0::bigint ELSE $4::bigint END               AS act
), c1 AS (
  SELECT bal."id", done.fp, done.fe, done.act,
         LEAST(done.act, done.fp)                          AS cp,
         LEAST(GREATEST(done.act - done.fp, 0), done.fe)   AS ce,
         GREATEST(done.act - done.fp - done.fe, 0)         AS ex,
         bal.pg, bal.pu, bal.pr, bal.eg, bal.eu, bal.er
    FROM bal CROSS JOIN done
), c2 AS (
  SELECT c1.*, LEAST(ex, GREATEST(pg - (pu + cp) - (pr - fp), 0)) AS ep FROM c1
), c3 AS (
  SELECT c2.*, LEAST(ex - ep, GREATEST(eg - (eu + ce) - (er - fe), 0)) AS ee FROM c2
)
UPDATE "UsageBalance" t
   SET "periodReserved" = t."periodReserved" - c3.fp,
       "extraReserved"  = t."extraReserved"  - c3.fe,
       "periodUsed"     = t."periodUsed" + c3.cp + c3.ep + (c3.ex - c3.ep - c3.ee),
       "extraUsed"      = t."extraUsed"  + c3.ce + c3.ee,
       "updatedAt"      = ($5::timestamptz AT TIME ZONE 'UTC')
  FROM c3
 WHERE t."id" = c3."id"
RETURNING c3.cp + c3.ep + (c3.ex - c3.ep - c3.ee) AS "chargedPeriod",
          c3.ce + c3.ee                           AS "chargedExtra",
          c3.ex - c3.ep - c3.ee                   AS "overrun"
`;

// Kullanılmayan rezervasyonu iade et (yalnız RESERVED). $1 workspaceId, $2 unit,
// $3 reservationKey, $4 now
export const RELEASE_SQL = `
WITH bal AS (
  SELECT "id" FROM "UsageBalance"
   WHERE "workspaceId" = $1::text AND "unit" = $2::text
     FOR UPDATE
), res AS (
  SELECT "id", "fromPeriod" AS fp, "fromExtra" AS fe
    FROM "UsageReservation"
   WHERE "workspaceId" = $1::text AND "unit" = $2::text AND "reservationKey" = $3::text AND "status" = 'RESERVED'
     FOR UPDATE
), done AS (
  UPDATE "UsageReservation" u
     SET "status" = 'RELEASED', "fromPeriod" = 0, "fromExtra" = 0
    FROM res, bal
   WHERE u."id" = res."id"
  RETURNING res.fp, res.fe
)
UPDATE "UsageBalance" t
   SET "periodReserved" = t."periodReserved" - done.fp,
       "extraReserved"  = t."extraReserved"  - done.fe,
       "updatedAt"      = ($4::timestamptz AT TIME ZONE 'UTC')
  FROM done, bal
 WHERE t."id" = bal."id"
RETURNING done.fp AS "releasedPeriod", done.fe AS "releasedExtra"
`;

// Süresi dolmuş (çökmüş işin tuttuğu) rezervasyonlar. $1 now, $2 limit
export const EXPIRED_RESERVATIONS_SQL = `
SELECT "workspaceId", "unit", "reservationKey"
  FROM "UsageReservation"
 WHERE "status" = 'RESERVED' AND "expiresAt" <= ($1::timestamptz AT TIME ZONE 'UTC')
 ORDER BY "expiresAt"
 LIMIT $2::int
`;

// Bakiye satırını tut. READ COMMITTED'da ifadenin anlık görüntüsü KİLİT BEKLEMESİNDEN
// ÖNCE alınır; bu yüzden toplam hesaplayan ifadeler (ensure, repair) bu kilidi ayrı bir
// ÖNCEKİ ifadede alır: sonraki ifade taze anlık görüntü görür ve satır kilidi eşzamanlı
// reserve/settle/release'i dışarıda tutar. $1 workspaceId, $2 unit
export const LOCK_BALANCE_SQL = `
SELECT "id" FROM "UsageBalance"
 WHERE "workspaceId" = $1::text AND "unit" = $2::text
   FOR UPDATE
`;

// Sayaçlar türev veridir: reserved = RESERVED satırların toplamı. Bakiye satırı
// FOR UPDATE ile tutulduktan SONRA (ayrı ifade: READ COMMITTED anlık görüntüsü
// kilit beklemesinden önce alınır) çalıştırılır. $1 workspaceId, $2 unit, $3 now
export const REPAIR_RESERVED_SQL = `
UPDATE "UsageBalance" b
   SET "periodReserved" = s.fp, "extraReserved" = s.fe, "updatedAt" = ($3::timestamptz AT TIME ZONE 'UTC')
  FROM (SELECT COALESCE(SUM("fromPeriod"), 0)::bigint AS fp,
               COALESCE(SUM("fromExtra"), 0)::bigint  AS fe
          FROM "UsageReservation"
         WHERE "workspaceId" = $1::text AND "unit" = $2::text AND "status" = 'RESERVED') s
 WHERE b."workspaceId" = $1::text AND b."unit" = $2::text
   AND (b."periodReserved" <> s.fp OR b."extraReserved" <> s.fe)
RETURNING b."periodReserved"::bigint AS "periodReserved", b."extraReserved"::bigint AS "extraReserved"
`;

// Yeni aylık pencereyi aç (YÖN KONTROLLÜ: yalnız ileri; bayat `now` ya da replikalar
// arası saat farkı pencereyi geri saramaz). periodReserved kayıtlardan yeniden
// hesaplanır (uçuştaki işler yeni pencerede de tutulu kalır). Aynı ifade PLAN
// hibesini deftere yazar (yalnız sıfırlama gerçekleştiyse). 1 satır = bu çağrı
// açtı; 0 = pencere zaten güncel (ya da çağıran bayat).
// $1 workspaceId, $2 unit, $3 yeni bakiye id, $4 pencere başı, $5 pencere sonu,
// $6 kota, $7 now, $8 hibe id, $9 neden (PLAN | TRIAL)
export const ENSURE_PERIOD_SQL = `
WITH w AS (
  INSERT INTO "UsageBalance" ("id","workspaceId","unit","periodStart","periodEnd","periodGranted","updatedAt")
  VALUES ($3::text, $1::text, $2::text, ($4::timestamptz AT TIME ZONE 'UTC'), ($5::timestamptz AT TIME ZONE 'UTC'), $6::bigint, ($7::timestamptz AT TIME ZONE 'UTC'))
  ON CONFLICT ("workspaceId","unit") DO UPDATE
     SET "periodStart"    = EXCLUDED."periodStart",
         "periodEnd"      = EXCLUDED."periodEnd",
         "periodGranted"  = EXCLUDED."periodGranted",
         "periodUsed"     = 0,
         "periodReserved" = COALESCE((SELECT SUM(r."fromPeriod") FROM "UsageReservation" r
                                       WHERE r."workspaceId" = EXCLUDED."workspaceId" AND r."unit" = EXCLUDED."unit"
                                         AND r."status" = 'RESERVED'), 0),
         "updatedAt"      = EXCLUDED."updatedAt"
   WHERE "UsageBalance"."periodStart" IS NULL OR "UsageBalance"."periodStart" < EXCLUDED."periodStart"
  RETURNING "id"
)
INSERT INTO "UsageGrant" ("id","workspaceId","unit","pool","amount","reason","idempotencyKey","periodStart","createdAt")
SELECT $8::text, $1::text, $2::text, 'PERIOD', $6::bigint, $9::text,
       lower($9::text) || ':' || to_char(($4::timestamptz AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ($4::timestamptz AT TIME ZONE 'UTC'), ($7::timestamptz AT TIME ZONE 'UTC')
  FROM w
ON CONFLICT ("workspaceId","idempotencyKey","unit","reason") DO NOTHING
RETURNING "id"
`;

// EXTRA hibe: tek ifadede idempotent hibe + bakiye upsert. Bakiye satırı yoksa
// oluşturur (ödenen hak kaybolmaz). 0 satır = aynı (anahtar, birim, neden).
// $1 hibe id, $2 workspaceId, $3 unit, $4 amount, $5 reason, $6 idempotencyKey,
// $7 now, $8 yeni bakiye id
export const GRANT_EXTRA_SQL = `
WITH g AS (
  INSERT INTO "UsageGrant" ("id","workspaceId","unit","pool","amount","reason","idempotencyKey","createdAt")
  VALUES ($1::text, $2::text, $3::text, 'EXTRA', $4::bigint, $5::text, $6::text, ($7::timestamptz AT TIME ZONE 'UTC'))
  ON CONFLICT ("workspaceId","idempotencyKey","unit","reason") DO NOTHING
  RETURNING "amount"
)
INSERT INTO "UsageBalance" ("id","workspaceId","unit","extraGranted","updatedAt")
SELECT $8::text, $2::text, $3::text, g."amount", ($7::timestamptz AT TIME ZONE 'UTC') FROM g
ON CONFLICT ("workspaceId","unit") DO UPDATE
   SET "extraGranted" = "UsageBalance"."extraGranted" + EXCLUDED."extraGranted",
       "updatedAt"    = EXCLUDED."updatedAt"
RETURNING "id"
`;

// PERIOD hibe (süreli promosyon, plan yükseltme farkı): yalnız çağıranın açık
// saydığı pencere hâlâ açıksa yazılır. 0 satır = tekrarlı anahtar YA DA pencere
// kapanmış (çağıran yeniden okuyup karar verir).
// $1 hibe id, $2 workspaceId, $3 unit, $4 amount, $5 reason, $6 idempotencyKey,
// $7 now, $8 çağıranın bildiği pencere başı
export const GRANT_PERIOD_SQL = `
WITH bal AS (
  SELECT "id", "periodStart" FROM "UsageBalance"
   WHERE "workspaceId" = $2::text AND "unit" = $3::text
     FOR UPDATE
), g AS (
  INSERT INTO "UsageGrant" ("id","workspaceId","unit","pool","amount","reason","idempotencyKey","periodStart","createdAt")
  SELECT $1::text, $2::text, $3::text, 'PERIOD', $4::bigint, $5::text, $6::text, bal."periodStart", ($7::timestamptz AT TIME ZONE 'UTC')
    FROM bal
   WHERE bal."periodStart" = ($8::timestamptz AT TIME ZONE 'UTC')
  ON CONFLICT ("workspaceId","idempotencyKey","unit","reason") DO NOTHING
  RETURNING "amount"
)
UPDATE "UsageBalance" t
   SET "periodGranted" = t."periodGranted" + g."amount", "updatedAt" = ($7::timestamptz AT TIME ZONE 'UTC')
  FROM g, bal
 WHERE t."id" = bal."id"
RETURNING t."id", t."periodGranted"
`;

// Tekrarlı hibe anahtarında mevcut satırı oku (aynı mı, çelişiyor mu?).
// $1 workspaceId, $2 unit, $3 idempotencyKey, $4 reason
export const GRANT_LOOKUP_SQL = `
SELECT "pool", "amount"
  FROM "UsageGrant"
 WHERE "workspaceId" = $1::text AND "unit" = $2::text
   AND "idempotencyKey" = $3::text AND "reason" = $4::text
`;
