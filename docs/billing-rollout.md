# Yayına alma planı (Faz 7)

Abonelik sistemi kodca hazır ve canlıda KAPALI. Bu belge, kapalıdan "ücretli müşteriler için sınırlar uygulanıyor"a güvenli geçişin sırasıdır. Her adım geri alınabilir; hiçbir adım bir önceki doğrulanmadan atılmaz. Sahip adımları ve komutlar: `docs/billing-payments.md` (Stripe kurulumu), `docs/billing-quota.md` (modlar), `docs/billing-tasks.md` (görev bütçesi).

## Bugünkü durum

- `BILLING_MODE=off` (varsayılan): kimse sınırlanmaz, kullanım yalnız ÖLÇÜLÜR (`UsageEntry`).
- `/billing` ekranları `BILLING_UI=true` olana dek 404.
- Stripe anahtarı yok: satın alma yok, webhook ucu 503.

## Canlıya geçmeden önce (özet kontrol listesi)

- Stripe: webhook ucu + `whsec_` tam sır, portalda plan/aralık/iptal KAPALI, yeniden denemeler tükenince abonelik İPTAL, "tek abonelik" AÇIK (`docs/billing-payments.md` adım 3).
- Üretimde `BILLING_MODE=enforce` ile TEST anahtarı ödemeyi kapatır; sırayı bozmayın: önce canlı anahtar, sonra `enforce`.
- Gizlilik politikasına Stripe (ödeme işleyicisi) ve şartlara iade metni EKLENMELİ (hukuki metin, sahip kararı; kodda değiştirilmedi).
- İade/itiraz politikası sahip kararı bekliyor (`docs/billing-payments.md`): varsayılan tam iade = anında bitir, kısmi iade = dokunma, itiraz = bitir.

## Sıra

**1. Stripe TEST modu (kimseyi etkilemez).** `docs/billing-payments.md` adımları 1–5 (test anahtarı, webhook ucu, portal ayarı, ortam değişkenleri). Sonra yerelde:

```
npm run billing:stripe-smoke
```

Çıktı `FAIL` içermemeli (`WARN` portal ayarını söyleyebilir). Sonra aynı belgenin adım 6'sındaki elle test akışı (abone ol, yükselt, düşür, iptal/devam, ek paket, portal, ödeme hatası kartı, panelden iade). Test, atılabilir bir workspace ile yapılır: test modunda ödenmiş bir abonelik o workspace'in satırına yazılır.

**2. Gölge (shadow) dönemi.** `BILLING_MODE=shadow`, `BILLING_LEGACY_BEFORE=<bugünün tarihi>` (o tarihten önce açılmış, aboneliği olmayan workspace'ler mevcut müşteri sayılır). Kimse engellenmez; "enforce olsaydı engellenirdi" kararları `AuditLog`'a yazılır (workspace ve neden başına saatte en çok bir satır: sayı olay değil, workspace-saat sayısıdır):

```sql
SELECT action, count(*) FROM "AuditLog" WHERE action LIKE 'billing.shadow.%' AND "createdAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;
```

1–2 hafta sonra: (a) `npm run db:report:cost` ile gerçek birim maliyeti `src/lib/billing/economics.ts` varsayımlarıyla karşılaştırın; fiyat ve kotalar `src/lib/billing/plans.ts`'te bir BAŞLANGIÇ HİPOTEZİDİR, marj ≥ %70 değilse rakamları değiştirin (`PLANS_VERSION`'ı güncelleyin); (b) kaç workspace'in hak sınırına yaklaştığına bakın; (c) "arka plan payı" (Starter %45, diğerleri %70) gölgede "engellenirdi" olarak görünür: çok sık isabet alıyorsa payı artırın.

**3. Canlı Stripe.** ÖNCE test sürecinde bağlanmış abonelikleri emekli edin (`npm run billing:retire-test-subscriptions`, önce kuru çalışma; `docs/billing-payments.md` adım 7). Sonra test anahtarlarını canlılarıyla değiştirin: canlı mod için AYRI bir webhook ucu (yeni `whsec_…`), AYRI portal ayarı ("Settings → Billing → Customer portal" canlı modda da kaydedilmeli), `STRIPE_SECRET_KEY=sk_live_…`. Canlı anahtar yalnız production'da çalışır; yerelde reddedilir. Duman testi yalnız test anahtarıyla koşar.

**4. Kanarya.** Önce yalnız kendi workspace'inizi plana geçirin (canlı kartla ya da %100'lük bir promosyon koduyla) ve sınırların gerçekten uygulandığını görün. `enforce` küresel bir modtur ama LEGACY workspace'ler sınırsızdır: yalnız plana geçen workspace'ler sınırlanır. **Önkoşul: `BILLING_LEGACY_BEFORE` ayarlı olmalı** (adım 2); ayarlı değilse aboneliği olmayan her workspace `NO_SUBSCRIPTION` sayılır ve `enforce`'ta engellenir. Geçersiz bir tarih `enforce`'u `shadow`'a düşürür ve günlüğe yazar (kimse yanlışlıkla engellenmez).

**5. Mevcut müşterilere 7 günlük geçiş.** `BILLING_LEGACY_UNTIL=<bugün + 7 gün>` ayarlayın. Süre dolunca planı seçmemiş workspace'ler salt-okunur (READ_ONLY) olur: görüntüleme, dışa aktarma, silme, bağlantı kesme açık; yeni ücretli iş yok. Duyuruyu bu tarihten ÖNCE yapın (uygulama içi bildirim şimdilik yok: Profile → Plan & usage ve e-posta).

**6. Yeni kayıtlar.** Satırı olmayan yeni bir workspace `NO_SUBSCRIPTION` olur ve ilk markayı açamaz. Bunun çözümü AÇIK SAHİP KARARIDIR: (a) kayıtta kartsız 7 günlük deneme (`startTrial`, kodda hazır; kötüye kullanım riski), (b) kartlı deneme (Stripe Checkout'ta `trial_period_days`; kodda YOK), (c) önce plan seçtirme. Karar verilmeden yeni kayıtlar için `enforce` açmayın ya da (a)'yı bağlayın.

## İzleme (enforce açıkken)

- `BillingEvent`: `FAILED`/`IGNORED` satırlar (`docs/billing-payments.md`), `tenant-mismatch` ve `duplicate-subscription` notları ELLE bakılacak durumlardır.
- Park edilmiş görevler: `ExecutionJob` `WAITING_BUDGET` sayısı beklenenden hızlı artıyorsa kotalar dar ya da arka plan payı sıkıdır.
- Kullanım/maliyet: `npm run db:report:cost`.
- Ödeme güvenlik ağı günlükleri: `[billing] sweep ...`.

## Geri alma

`BILLING_MODE=off`: tüm kapılar açılır (kill-switch). Park edilmiş işler tick'te saatte bir boşaltılır ve devam eder. Ödemeler kapanmaz: abone olanların satırları ve Stripe'taki abonelikleri korunur, yalnız sınırlar kalkar. Stripe tarafını kapatmak için `STRIPE_SECRET_KEY`'i silmek yeter (satın alma düğmeleri kapanır, webhook ucu 503 verir ve Stripe olayları tutup yeniden dener).
