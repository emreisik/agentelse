# Plan & usage ekranları (Faz 6, ilk sürüm)

Şartname §10: Pricing, My Subscription, Usage, Tasks. Tek sayfa, dört sekme: `/billing?tab=plans|subscription|usage|tasks` (sekme adresin parçasıdır; yenileme ve paylaşılan bağlantı aynı sekmeye iner). Profile sayfasında "Plan & usage" kartı bağlantı verir.

## Açma/kapama

`BILLING_UI` (`src/server/billing/ui-flag.ts`): geliştirmede AÇIK, canlıda yalnız `BILLING_UI=true` iken açık (`false` her yerde kapatır). Kapalıyken `/billing` 404 verir ve Profile kartı görünmez. Menüde ayrı bir giriş YOK (kenar çubuğu başka bir çalışmada); giriş Profile kartıdır.

## Veri

`getBillingOverview(workspaceId)` (`src/server/billing/overview.ts`) yalnız OKUR ve `BILLING_MODE`'dan bağımsızdır (kapıların kendisi kapalıyken görünmezdir, ama ekran ölçülen kullanımı ve çalışma alanının sahip olduklarını yine gösterir):

- **Abonelik**: `Subscription` satırı (plan, aralık, durum, tarih, iptal/zamanlı değişiklik). Tarih satırının adı duruma göre: Renews on / Ends on / Paid through (ödeme sorunu) / Access until (iptal, süre sürüyor) / Ended on; iade ve itirazla biten abonelikte neden satırı ("Refunded", "Payment disputed", "Payment failed"). "Stripe'a bağlı" ve "ödenmiş erişim" ÇALIŞAN anahtarın moduna göre hesaplanır (test modunda bağlanmış abonelik canlı anahtarla bağlı sayılmaz). Satır yoksa "No plan yet" (ödeme açıkken "Choose a plan in Plans"; deneme vaadi YOK: `startTrial` henüz bağlı değil).
- **Haklar**: `UsageBalance` satırları (görsel ve AI), dönem + ek paket; kalan, kullanılan, yenilenme tarihi. Çubuk bu pencerenin hakkı + ek paketten KALAN üzerinden hesaplanır (paketlerin ömür boyu sayaçları şişirmez). Satır yoksa metin duruma göre: ödeme kapalı → "Usage is measured, not limited yet"; ödeme açık, plan yok → "No plan yet"; planı olan ama pencere açılmamış (limitler kapalı) → "Your plan is active".
- **Ölçülen kullanım**: bu ayın başarılı `UsageEntry` satırları: oluşturulan görsel ve AI isteği sayısı, modül dökümü, son 14 gün. Müşteriye token ya da maliyet GÖSTERİLMEZ, yalnız sayı ve yüzde.
- **Görevler**: çalışanlar, `WAITING_BUDGET` (neden: hak bitti / plan yok), onay bekleyenler.

Plan fiyatları ve kotalar `src/lib/billing/plans.ts`'ten (`catalog.ts` türetir, kopya yok). Yıllık fiyat ve ilk ay fiyatı aynı sabitlerdendir; "Apply first-month discount" yalnız aylık faturalamada geçerlidir, yıllık fiyata yığılmaz.

## Ödeme bağlıyken (Faz 4) ve bağlı değilken

Ödeme `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` ile açılır (`docs/billing-payments.md`). **Kapalıyken** plan düğmeleri, ek paket satın alma, iptal ve ödeme yöntemi pasiftir ve sayfa bunu açıkça söyler. **Açıkken** (`pickerModeFor`, `src/lib/billing/picker-mode.ts`):

- Ödeme yapmamış workspace: her kartta *Subscribe to X* (Stripe Checkout'a gider), ilk ay indirimi düğmesi yalnız ilk abonelikte çalışır; "Promo code" alanı kodu sunucuda denetler ve ne verdiğini gösterir (kod ilk ay indiriminin yerine geçer).
- Ödeme yapan workspace: *Upgrade to X* (hemen, farkı öder) / *Switch to X* (yenilemede), bekleyen düşürme için *Keep this plan*; aralık değişmez. Ödeme sorunu ya da iptali planlanmış aboneliğte düğmeler kapalı ve nedeni yazılı.
- Yalnız sahip/yönetici eylem yapar; diğerleri nedenini görür.
- *My subscription*: iptal (dönem sonunda) / devam, ödeme yöntemi (Stripe portalı), Stripe faturaları (tarih, no, tutar, durum, görüntüle/PDF).
- *Usage*: ek paket *Buy* (planı olan yöneticide).
- Stripe'tan dönüşte (`?checkout=success&session_id=…`) sayfa durumu webhook'u beklemeden eşitler (yalnız yönetici için, workspace başına 10 dakikada 10) ve sabit metinli bir bilgi şeridi gösterir: ödeme uygulandı / henüz işlenmedi ("reload this page in a minute") / iade edildi / bu workspace ile eşleştirilemedi. Şerit gösterildikten sonra tek seferlik adres parametreleri (`notice`, `checkout`, `purchase`, `session_id`) adresten silinir. Test anahtarıyla çalışırken başlıkta "Test mode · no real charges" rozeti görünür.
- Muaf (kalıcı tam erişimli) workspace'te Subscribe/ek paket yok ("This workspace has full access, so there is nothing to buy."). Ödeme kapalıyken mevcut abone, "Plan changes, cancellation and invoices are temporarily unavailable" notunu görür. Faturalar: ödenmemiş fatura ödenecek tutarla ve "Unpaid" ile görünür, taslak/iptal edilmiş faturalar gizlenir, Stripe okunamazsa "could not load your invoices" yazar (boş liste ile karışmaz).
- Başarısız ya da belirsiz sonuçlu plan değişikliği/iptal sonrasında sayfa yenilenir; düğme Stripe'a giderken kapalı kalır ve beklenmeyen hatada "değişmedi" denmez ("We could not confirm this. Check My subscription before trying again.").

## Testler

`src/lib/billing/catalog.test.ts`, `src/lib/billing/picker-mode.test.ts` (düğme modları, bilgi şeridi), `src/lib/billing/one-shot-params.test.ts`, `src/components/billing/billing-screens.test.ts` (sunucuda render: fiyatlar, uyarılar, durumlar, canlı düğmeler), `src/server/billing/overview.integration.test.ts` (gerçek veritabanı), `src/app/billing/page.test.ts` (bayrak, çalışma alanı, sekme, Stripe dönüşü).
