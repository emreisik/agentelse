# Work'ler: kanal odaklı, kart öncelikli çalışma alanı

Bayrak: `WORKS_UI` (varsayılan **kapalı**) ve `CHAT_ENGINE=agent`. İkisi de değilse eski tek-sohbet ekranı birebir çalışır.

## Fikir

Bir proje artık tek sonsuz sohbet değil. Her konuşma bir **Work**: başlık, alt başlık, durum (aktif / tamamlandı / arşiv) ve **hedef kanallar**. Solda "Recent works" listesi, sohbetin üstünde Work çubuğu (başlık, Complete / Reopen, "…" menüsü) vardır. Her Work bağımsız açılır; yeni Work boş bir ekrana değil, ne yapılacağını soran kartlara açılır.

İçerik rastgele üretilmez: her şey bir kanal için planlanır ve üretilir. Bu yüzden her Work önce bir kanal seçtirir.

## Veri

- `Work` tablosu (`prisma/migrations/20261001000000_add_work`, yalnızca CREATE): `title`, `summary`, `status`, `channels` (kanal anahtarları), `acknowledgedUnconnected`, `lastActivityAt`.
- `Command.workId` (nullable, `ON DELETE SET NULL`). `workId` boş satırlar eski tek sohbettir.
- Bağlantı durumu Work'te **saklanmaz**, her seferinde canlı okunur (`getChannelConnections`). Saklanan yalnızca seçilen kanallardır.

## Kapsam (hangi satır hangi Work'te)

- Sohbet okuma: `page.tsx` ve `chat/context.ts`, `workId` verilince yalnız o Work'ün satırları. Verilmezse eski sorgu.
- Yazma: sohbet rotası `workId` alır, **Work'ün bu projeye ait ve aktif olduğunu sunucuda doğrular** (Works açıkken `workId` yoksa 400).
- SYSTEM kartları (görev sonucu, creative, onay): `IdeaChatRepository.postSystemMessage` `taskId` üzerinden görevi başlatan Command'ın Work'ünü çözer. Kaynağı olmayan arka plan olayları hiçbir Work'te görünmez (paneller gösterir).
- Bekleyen kararlar: bir Work'te yalnız kendi Work'ünün ya da hiçbir Work'e ait olmayan kararlar görünür (`works/scope.ts`).

## Kanal kapısı (sunucuda zorunlu)

Bir Work'te kanal seçilmeden `start_plan_brief`, `propose_content_plan`, `propose_content_package`, `generate_image` ve kanala bağlı `create_task` çalışmaz; turu bitiren bir **kanal seçim kartı** döner (`works/channel-gate.ts`). Araştırma/analiz kanal gerektirmez.

- Kanal bağlı değilse de seçilebilir ("sonra bağlarım"): plan ve üretim çalışır, **yayın bağlanana kadar kilitli** (mevcut yayın çekirdekleri zaten reddeder; kartta "Connect" görünür).
- Platform, modelin tahmininden değil Work'ün kanallarından çözülür (`generate_image`'in boş platform açığı kapandı). Work dışı bir platform istenirse model reddedilir.
- Plan sihirbazı yalnız Work'ün kanallarını sunar; plan öğeleri Work dışı kanal içeremez.
- Model bağlamına Work'ün kanalları ve bağlantı durumu girer (`prompt.ts`), ama asıl zorlama araçlardadır.

## Arayüz

- `components/layout/work-list.tsx`: sidebar listesi, durum noktası (yeşil aktif, mor tamamlandı), "New Work".
- `components/works/work-header.tsx`: başlık, durum satırı (kanallar ve bağlı olmayanlar), Complete/Reopen, yeniden adlandır / arşivle / sil.
- Boş Work: önce `ChannelPicker` (kanal seçimi, bağlı/bağlı değil durumuyla), kanal seçilince `starter-cards` (`lib/works/starter-cards.ts`, saf): haftayı planla, bekleyen kararlar, fikir bul, bağlı değilse "Connect X" ya da performans.
- Hiç Work yoksa ilk Work otomatik açılır (`NewWorkOpener`).
- Tamamlanan Work'e yazılmaz; "Reopen" gerekir.

## Geçmişi sıfırlama

Kod hiçbir şey silmez; `WORKS_UI` açılınca `workId` boş eski satırlar hiçbir Work'te görünmez. Kalıcı silmek için **sizin** çalıştıracağınız SQL: `docs/architecture/works-reset.sql` (önce sayım, sonra silme). Creative/Task/Library varlıkları silinmez.

## Açma sırası

1. Migration'ı uygula (`prisma migrate deploy`).
2. `CHAT_ENGINE=agent` ve `WORKS_UI=true`.
3. Yeni Work → kanal kartı → plan → Complete.

## İkinci dilim (dalga 1 ve 2 yayınlandı)

Ayrıntı: `docs/works-slice2.md` (ve bayrağı geri alma sorgusu orada).

Dalga 1'de gelenler: alternatifli plan (2-3 yön, slot başına alternatif fikir), fikir -> takvim -> üretim -> yayın hızlı akışı (`scheduleSlotsAction`), slot-first üretim (bağımsız görsel/metin üretimi plana bağlandı), planın marka kurallarına doğrulanması, yayın güvenliği (hold, story, çift yayın kilidi), Work kapsamlı yolculuk.

Dalga 2'de (yayınlandı): ana mesaj + kanal uyarlaması, üç görsel varyant, Today Work ve günlük özet, Meta Ads kartı, yeni kanal bağlanınca "bu kanal için Work aç" teklifi.
