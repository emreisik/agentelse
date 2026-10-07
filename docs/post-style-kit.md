# Post style kit: örnek postlar, daima geçerli talimatlar, beğeniyle öğrenme

Marka, "postlarım şu tasarımda olsun" demek için örnek post görselleri verir. Üretilen her yeni post bu örneklerin **aynı düzeninde** çıkar; yalnız içerik (ürün, yazılar) değişir. Kit, marka kimliğinin (`BrandVisualIdentity`) yanında yaşar ama ayrı bir tablosu yoktur.

## 1. Veri

`BrandFact` satırları, kategori `post_style` (şema değişikliği ve migration **yok**):

| Anahtar             | İçerik                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directives`        | `{ text, fidelity }`. `text`: her postta geçerli talimatlar (en çok 2000 karakter). `fidelity`: `match` (örneği olabildiğince birebir kur) ya da `inspired` (yalnız yön). |
| `example:<assetId>` | `{ assetId, label, source, url?, enabled, analysis, addedAt }`. Marka başına en çok 12 örnek. `source`: `upload` / `link` / `chat` / `liked`.                             |

- Saf yardımcılar ve şemalar: `src/lib/post-style.ts` (istemci güvenli). Depo: `src/server/brand/post-style-store.ts` (BrandFact'te benzersiz kısıt yok, bu yüzden `findFirst` + `update/create`). Servis: `post-style-service.ts`.
- Bu kategori `context-builder.ts` ve Brand Brain'in "Facts" listesinden **hariç tutulur**; kit ajana başka yoldan gider (aşağıda).
- Kit verisi kaydedilirken marka kimliği satırı yoksa `ensureVisualIdentityRow` varsayılan bir satır açar.

## 2. Örneğin eklenmesi

Üç yol, hepsi aynı servise çıkar (`addExampleFromBytes` / `addExampleFromAsset`):

1. **Brand Brain → Visual Identity sekmesi → "Post style" kartı** (`post-style-card.tsx`): dosya seç (toplu) ve/veya satır başına bir link; tek istekte en çok 6; 10 dakikada 8 ekleme. Sunucu eylemleri `post-style-actions.ts`.
2. **Sohbet:** görseli ekleyip "bunu tasarım örneği olarak kullan / marka beynine aktar" demek; ajan `save_style_reference` aracını çağırır (yalnız o mesajın ekleri; ACTIVE faz; hassas). `instruction` verilirse talimat `directives`e eklenir ve `MemoryService.remember` (USER_EXPLICIT) ile hafızaya da yazılır.
3. **Beğenilen post:** Works'teki bitmiş post kartında beğeni sonrası "Use as a style example" (`addLikedCreativeToPostStyleAction`); görselin kopyası çıkarılmaz, aynı Asset örnek olur.

Görsel her yerde `sharp` ile doğrulanıp yeniden kodlanır: png/jpeg/webp, kısa kenar ≥ 240 px, en çok 1600 px, 8 MB yükleme tavanı; metadata saklanmaz. **Her örnek bir kez analiz edilir** (`brand.postStyle.analyzeExample`, vision `ReasoningDef`): özet, yerleşim, tipografi, renkler, ürün, grafikler, arka plan, mood ve ~120-170 kelimelik bir **tarif** (ürün ve yazılar yer tutucu). Analiz başarısız olursa örnek yine kaydedilir ("Yeniden oku" düğmesi `reanalyzePostStyleExampleAction`).

### Link ile alma ve sınırı

Linkler `safeFetch` (SSRF korumalı) ile çekilir; doğrudan görsel linki ya da sayfanın `og:image` / `twitter:image` değeri alınır (`post-style-links.ts`). **Instagram ve diğer ağlar başkasının görselini uygulamalara vermez**; bu linklerden çoğunlukla görsel gelmez, kullanıcıya dürüstçe "dosya ya da ekran görüntüsü ekle" denir.

## 3. Üretimde kullanım

`resolveBrandStyleContext` (`brand-style-context.ts`) kit boş değilse `visualIdentity.postStyle` ekler (okuma hatası yutulur: kit yüzünden marka görünümü yüklenemez olmaz). Böylece **her üretim yolu** (sohbet `generate_image`, Studio yeniden üret, haftalık planlayıcı, plan-run) aynı kiti görür.

`loadStyleReferences` (`src/server/media/style-references.ts`) görsel modeline giden resimleri ve metni kurar:

- **Sıra:** örnek postlar (ajanın seçtikleri, yoksa en yeni; en çok 3) → (örnek yoksa eski tek "style board") → gerçek ürün fotoğrafları (en çok 3).
- gpt-image-2 `/v1/images/edits` çoklu `image[]` alır; fal resim almaz. Mevcut görseli **düzenleyen** çağrılar tek girdi olduğu için referans eklemez.
- **Prompt:** `creative-prompt-builder.ts` konu cümlesinden hemen sonra `POST STYLE KIT:` bölümünü koyar (referans postlar, ürün paragrafı, örnek tarifleri, daima geçerli talimatlar). `fidelity=match` iken layout kompozisyon notları ve başlık yerleşimi geri çekilir; tipografi referans postları izler. Metin adımı başlık/vurgu/ek satırı, layout'un başlık bölgesi varsa ya da kit `match` ise ister; yazıyı model çizmez, `creative-text.ts` layout'un bölgesine (bölge yoksa üst üçte birin ortasına) dizer (`docs/brand-kit.md`). `match` postlarda yazı artık örnek postların konumunda ve tipografisinde değil, layout bölgesinde ve bizim dizgimizle çıkar: yazım garanti, örneklere benzerlik biraz daha gevşek.
- **Logo:** modele "logo çizme" denir; gerçek logo/şerit hâlâ üretimden sonra `applyBrandTemplate` ile piksel-hassas eklenir.

Sohbet aracı (yalnız Works varyantı; varsayılan `generate_image` tanımı baytı baytına aynı kalmalı, `tools.works.test.ts` parity testi): `styleExampleIds`, `usePhotosFromThisMessage` (aynı mesaja eklenen gerçek ürün fotoğrafı), `onImageText` (görsel üstünde ek yazılar; en çok 6 satır). `get_visual_identity` kit özetini (`postStyle`) döndürür.

## 4. Beğeniyle öğrenme

Works'teki bitmiş (IN_REVIEW / APPROVED / PUBLISHED) her post kartının altında iki sessiz simge: **Like this post** ve **Not quite** (`components/works/creative-rating.tsx`; yalnız Works sarmalayıcısında, ortak `CreativeCard`'a dokunulmaz).

- Like → `MemoryService.rememberCreativeRating`: WORKS, `OUTPUT_ACCEPTED`; cümleye postun görsel özeti (brief'teki `Visual:` satırı ve kullanılan layout adı) girer. Ardından "Use as a style example".
- Not quite → neyin yanlış olduğu birkaç dokunuşta seçilir (Layout / Product / Colors / Text / Too generic / Mood) + isteğe bağlı not → AVOID, `USER_CORRECTION`. Aynı şikâyet aynı cümle olur, yani yeni anı yerine "tekrar görüldü" sayılır.
- Bir post için **tek hüküm** tutulur (`sourceRef = creative:<id>:rating`): yenisi eskisini siler.
- Hafıza zaten her sohbet turunda `recall` ile ajana gider; yani bu hükümler sonraki üretimleri etkiler. Hata bu dokunuşu asla bozmaz (`rememberCreativeRating` fırlatmaz).
- Eylemler `creative-rating-actions.ts`: erişim, postun **kendi** projesine karşı kontrol edilir; dakikada sınırlı (10 dk'da 60 puan, 12 örnek ekleme); denetim kaydı `creative.rated`.

## 5. Sınırlar ve bilinenler

- Doğruluk görsel modelin elindedir: referans verilse de birebir kopya garanti değildir (`input_fidelity` kullanılmıyor). Başka bir markanın logosu/yazısı taşınmasın diye prompt açıkça yasaklar.
- `save_style_reference` yalnız **o mesajın** eklerini kullanır; üretimde gerçek ürün fotoğrafı da aynı mesaja eklenmelidir.
- Başka hesapların Instagram linkleri çoğunlukla görsel vermez (bkz. §2).
- Tarayıcıda görülmedi: yalnız SSR testleri ve kaynak izleme ile doğrulandı.
- Migration gerekmez; eski markalar kitsiz çalışmaya devam eder (tek "style board" ve eski metin).

## 6. Dosya haritası

| Konu                       | Dosya                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Şema, bağlam, prompt metni | `src/lib/post-style.ts`, `post-style-links.ts`                                                                                                                                                            |
| Depo, servis, analiz       | `src/server/brand/post-style-{store,service,analyzer}.ts`, `src/server/reasoning/prompts/post-style.ts`                                                                                                   |
| Eylemler                   | `src/server/actions/post-style-actions.ts`, `creative-rating-actions.ts`                                                                                                                                  |
| Üretim                     | `src/server/media/style-references.ts`, `creative-prompt-builder.ts`, `openai-image-client.ts`, `creative-image.ts`, `openai-creative.provider.ts`, `instagram-week-planner.ts` |
| Sohbet                     | `src/server/chat/tools.ts` (`save_style_reference`, `get_visual_identity`, Works `generate_image`), `slot-first.ts`                                                                                       |
| Arayüz                     | `src/components/brand/post-style-{card,section,copy}`, `src/components/works/creative-rating.tsx`                                                                                                         |
| Hafıza                     | `src/lib/creative-rating.ts`, `src/server/memory/memory-service.ts` (`rememberCreativeRating`)                                                                                                            |
