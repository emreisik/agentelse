# Yayına alma planı (Faz 7)

Abonelik sistemi kodca hazır ve canlıda KAPALI. Bu belge, kapalıdan "ücretli müşteriler için sınırlar uygulanıyor"a güvenli geçişin sırasıdır. Her adım geri alınabilir; hiçbir adım bir önceki doğrulanmadan atılmaz. Sahip adımları ve komutlar: `docs/billing-payments.md` (Stripe kurulumu), `docs/billing-quota.md` (modlar), `docs/billing-tasks.md` (görev bütçesi).

## Bugünkü durum

- `BILLING_MODE=off` (varsayılan): kimse sınırlanmaz, kullanım yalnız ÖLÇÜLÜR (`UsageEntry`).
- `/billing` ekranları `BILLING_UI=true` olana dek 404.
- Stripe anahtarı yok: satın alma yok, webhook ucu 503.

## Canlıya geçmeden önce (özet kontrol listesi)

- Stripe: webhook ucu + `whsec_` tam sır, portalda plan/aralık/iptal KAPALI, yeniden denemeler tükenince abonelik İPTAL, **başarısız ödeme e-postaları AÇIK** (uygulama müşteriye ödeme sorununu kendisi bildirmez), "tek abonelik" ayarı bir ek önlemdir (`docs/billing-payments.md` adım 3).
- Üretimde `BILLING_MODE=enforce` ile TEST anahtarı ödemeyi kapatır; sırayı bozmayın: önce canlı anahtar, sonra `enforce`.
- **`BILLING_UI=true` ekranı HERKESE açar.** Plan seçimi ve ödeme düğmeleri, açtığınız anda tüm çalışma alanı sahiplerine/yöneticilerine görünür ve çalışır; çalışma alanı başına bir kapı YOK. `off`/`shadow` iken kimse sınırlanmadığı için bu aşamada satış, müşteriye hiçbir şeyi değiştirmeyen bir plan sattırır (ve iade politikası sahip kararı bekliyor). Bu yüzden ekranı enforce ile AYNI dağıtımda açın (adım 4); kendi kanaryanızı o anda yaparsınız.
- Gizlilik politikasına Stripe (ödeme işleyicisi) ve şartlara iade metni EKLENMELİ (hukuki metin, sahip kararı; kodda değiştirilmedi).
- İade/itiraz politikası sahip kararı bekliyor (`docs/billing-payments.md`): varsayılan tam iade = anında bitir, kısmi iade = dokunma, itiraz = bitir (soruşturma aşaması ve kazanılan itiraz hariç).
- Herkese açık metinler ürünle aynı anda güncellenir (kodda DEĞİŞTİRİLMEDİ, sahip işi): pazarlama sitesindeki `/pricing` (`apps/marketing`) bugün yalnız "Early access $0 / Agencies" gösterir; gerçek planlar `src/lib/billing/plans.ts`'ten yazılmalı. `src/app/terms/page.tsx` (ücretli planlardan ve /pricing'den söz eden bölüm) ve gizlilik politikası (Stripe ödeme işleyicisi, müşteri e-postası/çalışma alanı adı/ödeme verisi) ile Meta App Review "Data handling" işlemci listesi de güncellenir.
- Kenar çubuğunda "Plan & usage" girişi yok (menü dosyaları sahibin commit'siz çalışmasında); giriş şimdilik Profile kartı ve doğrudan `/billing` adresidir. Sahibin menü çalışması commit'lenince hesap menüsüne eklenir.

## Sıra

**1. Stripe TEST modu — yerelde.** `docs/billing-payments.md` adımları 1–5 (test anahtarı, webhook ucu, portal ayarı, ortam değişkenleri). Test anahtarını ÜRETİM servisine koyup `BILLING_UI=true` yapmak ekranı herkese açar ve herkes test kartıyla abone olabilir: "kimseyi etkilemez" yalnız yerelde (ya da `BILLING_UI` kapalıyken) doğrudur. Yerelde:

```
npm run billing:stripe-smoke
```

Çıktı `FAIL` içermemeli (`WARN` portal ayarını söyleyebilir). Sonra aynı belgenin adım 6'sındaki elle test akışı (abone ol, yükselt, düşür, iptal/devam, ek paket, portal, panelden iade). Test, atılabilir bir workspace ile yapılır: test modunda ödenmiş bir abonelik o workspace'in satırına yazılır. Ödeme hatası (PAST_DUE) akışı gerçek Stripe'ta bu adımda denenemez (adım 6'daki not); otomatik testlerle kanıtlıdır.

**2. Gölge (shadow) dönemi ve kayıtta deneme.** `BILLING_MODE=shadow`, `BILLING_LEGACY_BEFORE=<tam zaman damgası>` (ör. `2026-10-12T09:00:00Z`: o ana dek açılmış, aboneliği olmayan workspace'ler mevcut müşteri sayılır; yalnız tarih yazarsanız UTC gece yarısı sayılır ve o gün kayıt olanlar da mevcut müşteri çıkar). Kimse engellenmez; "enforce olsaydı engellenirdi" kararları `AuditLog`'a yazılır (workspace ve neden başına saatte en çok bir satır: sayı olay değil, workspace-saat sayısıdır):

```sql
SELECT action, count(*) FROM "AuditLog" WHERE action LIKE 'billing.shadow.%' AND "createdAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;
```

**Yeni kayıtlar bu dönemde başlar:** `shadow`/`enforce` iken ve `BILLING_LEGACY_BEFORE` geçildiyse her yeni kayıt **kartsız 7 günlük deneme** alır (5 görsel + AI payı; `registerAction` → `startSignupTrial`, `docs/billing-quota.md` "Kayıtta deneme"); `off` iken hiçbir şey yazılmaz. Kötüye kullanım devre kesicisi `TRIAL_MAX_PER_DAY` (varsayılan 100/gün, `0` = deneme yok) Railway'de ayarlanır; kayıtta e-posta doğrulaması YOK, sınır bu yüzden vardır. Deneme bitince `enforce`'ta workspace salt-okunur olur ve plan seçmesi gerekir. Kartlı deneme, ilk aboneliğe bonus kullanım ve referans ödülü yapılmıyor.

1–2 hafta sonra: (a) `npm run db:report:cost` ile gerçek birim maliyeti `src/lib/billing/economics.ts` varsayımlarıyla karşılaştırın; fiyat ve kotalar `src/lib/billing/plans.ts`'te bir BAŞLANGIÇ HİPOTEZİDİR, marj ≥ %70 değilse rakamları değiştirin (`PLANS_VERSION`'ı güncelleyin); (b) kaç workspace'in hak sınırına yaklaştığına bakın; (c) "arka plan payı" (Starter %45, diğerleri %70) gölgede "engellenirdi" olarak görünür: çok sık isabet alıyorsa payı artırın.

**3. Canlı Stripe (ekran hâlâ KAPALI).** Önce test anahtarlarını canlılarıyla değiştirin: canlı mod için AYRI bir webhook ucu (yeni `whsec_…`), AYRI portal ayarı ("Settings → Billing → Customer portal" canlı modda da kaydedilmeli), `STRIPE_SECRET_KEY=sk_live_…`; test webhook ucunu silin. Canlı anahtar yalnız production'da çalışır; yerelde reddedilir. `BILLING_UI` bu adımda AÇILMAZ. **SONRA** test sürecinde bağlanmış abonelikleri emekli edin (`npm run billing:retire-test-subscriptions`, önce kuru çalışma; `docs/billing-payments.md` adım 7): test anahtarı hâlâ çalışırken emekli edilen satır yeniden gönderilen bir olayla canlanabilir, bu yüzden sıra anahtar değişimi → emekli etme → enforce'tur. Kuru çalışma hangi veritabanına yazacağını, eski müşteri (LEGACY) olup iptal edilmiş olacak workspace'leri ve test kartıyla alınmış ek paket haklarını ayrıca gösterir. Duman testi yalnız test anahtarıyla koşar.

**4. Açılış anı: enforce + ekran, aynı dağıtımda.** Sakin bir saatte, önce müşterilere duyurun (uygulama içi bildirim yok: e-posta). Öncesinde, gölge döneminde `BILLING_LEGACY_BEFORE`'dan sonra açılmış ama satırı olmayan (yani deneme almamış) workspace kalmadığını kontrol edin; kalanlar `enforce`'ta `NO_SUBSCRIPTION` (salt-okunur) olur:

```sql
SELECT w.id, w."createdAt" FROM "Workspace" w LEFT JOIN "Subscription" s ON s."workspaceId" = w.id WHERE s.id IS NULL AND w."createdAt" >= '<BILLING_LEGACY_BEFORE>';
```

Sonra tek dağıtımda `BILLING_MODE=enforce` ve `BILLING_UI=true`. Hemen **kendi workspace'inizi kanarya** yapın: canlı kartla plan alın ya da Stripe'ta yalnız sizin müşterinize bağlı, `max_redemptions = 1` ve kısa `expires_at` taşıyan %100'lük bir promosyon kodu yaratın (kodu işiniz bitince arşivleyin; herkese açık, süresiz bir %100 kod tahmin edilirse bedava plan demektir) ve sınırların gerçekten uygulandığını görün. `enforce` küresel bir modtur ama LEGACY workspace'ler sınırsızdır: yalnız plana geçen ve deneme/ödeme satırı olan workspace'ler sınırlanır. **Önkoşul: `BILLING_LEGACY_BEFORE` ayarlı olmalı** (adım 2); ayarlı değilse aboneliği olmayan her workspace `NO_SUBSCRIPTION` sayılır ve `enforce`'ta engellenir. Geçersiz bir tarih `enforce`'u `shadow`'a düşürür ve günlüğe yazar (kimse yanlışlıkla engellenmez).

**5. Mevcut müşterilere 7 günlük geçiş.** `BILLING_LEGACY_UNTIL=<bugün + 7 gün>` ayarlayın. Süre dolunca planı seçmemiş workspace'ler salt-okunur (READ_ONLY) olur: görüntüleme, dışa aktarma, silme, bağlantı kesme açık; yeni ücretli iş yok. Duyuruyu bu tarihten ÖNCE yapın (uygulama içi bildirim şimdilik yok: Profile → Plan & usage ve e-posta).

## İzleme (enforce açıkken)

- `BillingEvent`: `FAILED`/`IGNORED` satırlar (`docs/billing-payments.md`), `tenant-mismatch` ve `duplicate-subscription` notları ELLE bakılacak durumlardır.
- Park edilmiş görevler: `ExecutionJob` `WAITING_BUDGET` sayısı beklenenden hızlı artıyorsa kotalar dar ya da arka plan payı sıkıdır.
- Kullanım/maliyet: `npm run db:report:cost`.
- Ödeme güvenlik ağı günlükleri: `[billing] sweep ...` (hangi workspace/abonelik ve Stripe durumu yazılır; "EVERY read failed" anahtar ya da Stripe sorunudur).
- Müşteriye "Billing is temporarily unavailable" gösterildiğinde tek iz `[billing][operator-action]` günlük satırıdır; hiçbir uyarı sistemine bağlı değil.
- Ödeme hatası (PAST_DUE) akışının ilk GERÇEK denemesi: ilk başarısız yenilemede `BillingEvent` ve `Subscription.status/graceUntil` satırlarını izleyin.

## Geri alma

1. **Sınırları kaldırmak:** `BILLING_MODE=off`. Tüm kapılar açılır (kill-switch). Park edilmiş işler tick'te saatte bir boşaltılır ve devam eder. Ödemeler kapanmaz: abone olanların satırları ve Stripe'taki abonelikleri korunur, yalnız sınırlar kalkar. Webhook ucu ve güvenlik ağı çalışmaya devam eder, yenilemeler kaydedilir.
2. **Yeni satışı durdurmak:** `BILLING_UI=false`. Ekran 404 verir ve tüm ödeme eylemleri kapanır; webhook ve güvenlik ağı sürer (yenileme ve bitişler kaydedilmeye devam eder).
3. **`STRIPE_SECRET_KEY`'i SİLMEYİN** (yalnız ödemeyi tümüyle durdurmanız gerekiyorsa): webhook ucu 503 verir, güvenlik ağı da durur, Stripe aboneleri faturalamaya devam ederken yenilemeler kaydedilmez (müşteriler ~6 saat sonra salt-okunur olur) ve iptal yolu kapanır. Anahtar 3 günden uzun yoksa Stripe olayları yeniden denemeyi de bırakır; geri koyduktan sonra güvenlik ağı kaçan yenilemeleri onarır, kaçan iade/itirazları ise elle gönderin (Stripe panelinden olay → Resend).
