# Marka medya kütüphanesi

Marka sahibinin gerçek fotoğrafları yüklenir, otomatik anlaşılır ve bir postun görseli olarak **olduğu gibi** kullanılır; üstüne markanın tasarımı (logo, başlık, CTA) basılır. Görsel maliyeti $0, kırpma deterministik. Veri modeli videoya hazır (`BrandMedia.kind`, `durationMs`, `posterAssetId`); video üretimi henüz yok.

## Akış

1. **Alım** (`server/brand/media/normalize.ts`, `store.ts`): EXIF'e göre döndür, GPS temizle, uzun kenar ≤ 2400 px, `Asset.hash` ile aynı fotoğrafı tekrar ekleme. Yükleme onayı zorunlu.
2. **Anlama** (`analyze.ts`, `tick.ts`, `prompts/brand-media.ts`): `brand.media.analyze` (lite). Etiket, açıklama, odak noktası, kalite. Günlük 60 tavan, 3 deneme, bütçe aşımında 1 saat ertele. Kişinin etiketi (`tagsEdited`) korunur.
3. **Media sekmesi** (Brand Brain → Media): yükle, süz, etiket düzenle, arşivle/sil (kullanılmışsa silinmez), **Make a post from this photo**.
4. **Fotoğraf modu** (`openai-creative.provider.ts`, `payload.photoAssetIds`): görsel model ve sanat yönetmeni çağrılmaz, görsel anahtarı gerekmez. `media/photo-fit.ts` + `lib/photo-crop.ts`: odak noktası etrafında kırp, başlık bölgesinden uzak tut; kırpma alanın yarısından fazlasını atacaksa (yatay foto → Story) tüm foto bulanık kopyasının üstünde gösterilir (kenarlar yumuşatılır). Orijinal asla ezilmez: `putAsset` ile kopya, sonra mevcut `brandTemplated`.
5. **Aynı postun diğer formatları**: `photoSource {assetId, fit}` `generationMetadata`'ya yazılır; `readPictureForAdapting` onu okur ve sağlayıcı aynı fotoğrafı yeni formata yeniden kırpar (model yok). Fotoğraf silinmişse eski "adapt" yoluna düşer.

## Ray (planlanan gönderi)

`SlotTarget.photoAssetIds` → plan kartı öğesi → `Post.photoAssetIds` (`save-plan-core.ts`) → `ClaimedSlot.photoAssetIds` (`plan-run.ts`, yalnız kendi görselini çizen parça) → `specOf` payload. Fotoğraf Post'ta durur: yeniden deneme preset'i kaybetse de fotoğraf kaybolmaz. Fotoğraflı parçanın görsel maliyeti $0 (`lib/works/cost.ts`, `PlanViewItem.photo`).

Proje kapsamı: `loadBrandPhoto(assetId, projectId)` her zaman projeyle birlikte arar.

## Fikir bağlantısı (P3)

- `SocialDraft.assetIds` (≤3, fiilen 1): fikrin gerçek fotoğrafı. Motor (`idea-engine.ts`) modele `catalogOf` ile seçilmiş 15 hazır fotoğrafı (kimlik, şekil, ne gösterdiği) verir; model `photoId` yazar, `normalize.ts` yalnız listelenen id'leri tutar ve bir fotoğrafı bir toplu işte tek fikre verir. Havuzda başka fikre bağlı fotoğraf kataloga girmez.
- `lib/media-match.ts` (saf): kelime örtüşmesi (etiket 2, açıklama 1; Türkçe katlama), kalite süzgeci (<40 dışarıda), kırpma kaybı ve kullanım cezası.
- Pano: kartta fotoğraf postun arka planıdır (`LayoutPreview photoSrc`); detayda **Picture** alanı: "Made for this post" / "My photo" + önerilen fotoğraflar (noktalı) ve tümü. `updateIdeaDraftAction` `assetIds`'i proje kapsamında doğrular.
- Üretim: `makeIdeaPost` canlı fotoğrafı hedefe koyar (Post'a yazılır, planlı kartta maliyet $0); sohbet planı ve haftalık taslak yolunda `plan-run.ts` `ideaPhotosOf` fikrin fotoğrafını üretim anında okur (silinmişse görsel olağan yolla yapılır).

## Sohbet ve dok (P4)

- `search_brand_photos` (yalnız Works, okuma aracı): fotoğrafları sorguya göre sıralar. `generate_image` ve `propose_content_plan` öğeleri `photoAssetIds: [id]` alır (Works değişkenleri; varsayılan araç tanımları değişmedi). Kimlikler `liveBrandPhotoIds` ile proje kapsamında doğrulanır, bir plan içinde aynı fotoğraf iki posta verilmez (`keepLivePhotoIds`).
- `loadReferenceImage`/`loadStyleReferences` artık `projectId` ile arar (başka projenin varlığı referans olamaz).
- Sağ dok Files: bu projenin `BrandMedia` fotoğrafları "Photos" grubunda.
- Sohbette fotoğraf sonuç **kartı** yok (araç metin sonucu döndürür; seçilen fotoğraf postun kartında görünür).

## Studio

Studio'da "new" (yeniden üret) bir fotoğraf postunda fotoğrafı yeniden kırpar (format değiştiyse yeni formata), AI resmi ile değiştirmez. "Edit" kişinin isteğiyle modele gider ve fotoğraf kaynağını bırakır.

## Kalan işler

- **P5 video**: ffmpeg (`RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg`), poster/kareler ve analiz, Range akışı, presigned yükleme, HEIC. Yeni bağımlılık/altyapı: sahibin kararı.
- Eski doğrudan haftalık planlayıcı (`instagram-week-planner.ts`) fotoğraf eşlemesi yapmıyor (aktif yol `plan-run` üzerinden yapıyor).
- Sohbette `photo-results` kartı.

## Sahip adımları

`npx prisma migrate deploy` (`20261007100000_add_brand_design_profile`, `20261007120000_add_brand_media`), sonra dev sunucuyu yeniden başlat. Works arayüzü açık olmalı (Make a post düğmesi Works sohbetini açar).
