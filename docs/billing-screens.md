# Plan & usage ekranları (Faz 6, ilk sürüm)

Şartname §10: Pricing, My Subscription, Usage, Tasks. Tek sayfa, dört sekme: `/billing?tab=plans|subscription|usage|tasks` (sekme adresin parçasıdır; yenileme ve paylaşılan bağlantı aynı sekmeye iner). Profile sayfasında "Plan & usage" kartı bağlantı verir.

## Açma/kapama

`BILLING_UI` (`src/server/billing/ui-flag.ts`): geliştirmede AÇIK, canlıda yalnız `BILLING_UI=true` iken açık (`false` her yerde kapatır). Kapalıyken `/billing` 404 verir ve Profile kartı görünmez. Menüde ayrı bir giriş YOK (kenar çubuğu başka bir çalışmada); giriş Profile kartıdır.

## Veri

`getBillingOverview(workspaceId)` (`src/server/billing/overview.ts`) yalnız OKUR ve `BILLING_MODE`'dan bağımsızdır (kapıların kendisi kapalıyken görünmezdir, ama ekran ölçülen kullanımı ve çalışma alanının sahip olduklarını yine gösterir):

- **Abonelik**: `Subscription` satırı (plan, aralık, durum, yenileme tarihi, iptal/zamanlı değişiklik). Satır yoksa "No plan yet".
- **Haklar**: `UsageBalance` satırları (görsel ve AI), dönem + ek paket; kalan, kullanılan, yenilenme tarihi. Satır yoksa "Usage is measured, not limited yet".
- **Ölçülen kullanım**: bu ayın başarılı `UsageEntry` satırları: oluşturulan görsel ve AI isteği sayısı, modül dökümü, son 14 gün. Müşteriye token ya da maliyet GÖSTERİLMEZ, yalnız sayı ve yüzde.
- **Görevler**: çalışanlar, `WAITING_BUDGET` (neden: hak bitti / plan yok), onay bekleyenler.

Plan fiyatları ve kotalar `src/lib/billing/plans.ts`'ten (`catalog.ts` türetir, kopya yok). Yıllık fiyat ve ilk ay fiyatı aynı sabitlerdendir; "Apply first-month discount" yalnız aylık faturalamada geçerlidir, yıllık fiyata yığılmaz.

## Ödeme bağlıyken (Faz 4) ve bağlı değilken

Ödeme `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` ile açılır (`docs/billing-payments.md`). **Kapalıyken** plan düğmeleri, ek paket satın alma, iptal ve ödeme yöntemi pasiftir ve sayfa bunu açıkça söyler. **Açıkken** (`pickerModeFor`, `src/lib/billing/picker-mode.ts`):

- Ödeme yapmamış workspace: her kartta *Subscribe to X* (Stripe Checkout'a gider), ilk ay indirimi düğmesi yalnız ilk abonelikte çalışır.
- Ödeme yapan workspace: *Upgrade to X* (hemen, farkı öder) / *Switch to X* (yenilemede), bekleyen düşürme için *Keep this plan*; aralık değişmez. Ödeme sorunu ya da iptali planlanmış aboneliğte düğmeler kapalı ve nedeni yazılı.
- Yalnız sahip/yönetici eylem yapar; diğerleri nedenini görür.
- *My subscription*: iptal (dönem sonunda) / devam, ödeme yöntemi (Stripe portalı), Stripe faturaları (tarih, no, tutar, durum, görüntüle/PDF).
- *Usage*: ek paket *Buy* (planı olan yöneticide).
- Stripe'tan dönüşte (`?checkout=success&session_id=…`) sayfa durumu webhook'u beklemeden eşitler ve sabit metinli bir bilgi şeridi gösterir. Test anahtarıyla çalışırken başlıkta "Test mode · no real charges" rozeti görünür.

## Testler

`src/lib/billing/catalog.test.ts`, `src/lib/billing/picker-mode.test.ts` (düğme modları, bilgi şeridi), `src/components/billing/billing-screens.test.ts` (sunucuda render: fiyatlar, uyarılar, durumlar, canlı düğmeler), `src/server/billing/overview.integration.test.ts` (gerçek veritabanı), `src/app/billing/page.test.ts` (bayrak, çalışma alanı, sekme, Stripe dönüşü).
