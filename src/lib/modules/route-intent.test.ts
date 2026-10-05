import { describe, expect, it } from "vitest";

import { routeIntent, type RoutedIntent } from "./route-intent";

const CHAT: RoutedIntent = { module: null, prefill: {} };

const social = (prefill: RoutedIntent["prefill"] = {}): RoutedIntent => ({
  module: "social",
  prefill,
});

// Each row: what the person typed, and where it goes with what the Brief starts
// with.
const routes = (rows: readonly (readonly [string, RoutedIntent])[]) =>
  it.each(rows.map(([text, expected]) => ({ text, expected })))(
    "$text",
    ({ text, expected }) => {
      expect(routeIntent(text)).toEqual(expected);
    },
  );

describe("routeIntent: Social Media Planner", () => {
  describe("Turkish", () => {
    routes([
      [
        "gelecek hafta için 3 instagram postu",
        social({ channels: ["instagram"], perWeek: 3, weeks: 1 }),
      ],
      ["Bana 3 post hazırla", social({ perWeek: 3, weeks: 1 })],
      ["haftada 3 post, 2 hafta", social({ perWeek: 3, weeks: 2 })],
      ["haftada 3 gonderi", social({ perWeek: 3 })],
      [
        "x ve linkedin için haftada 2 paylaşım",
        social({ channels: ["linkedin", "x"], perWeek: 2 }),
      ],
      [
        "Instagram için 5 story hazırla",
        social({ channels: ["instagram"], story: true, perWeek: 5, weeks: 1 }),
      ],
      [
        "Yaz indirimi için 3 Instagram postu hazırla",
        social({
          channels: ["instagram"],
          perWeek: 3,
          weeks: 1,
          topic: "Yaz indirimi",
        }),
      ],
      [
        "yeni kahve menümüz hakkında 3 gönderi",
        social({ perWeek: 3, weeks: 1, topic: "yeni kahve menümüz" }),
      ],
      [
        "Sonbahar koleksiyonu hakkında haftada 2 gönderi",
        social({ perWeek: 2, topic: "Sonbahar koleksiyonu" }),
      ],
      ["Bu hafta için içerik takvimi hazırlar mısın?", social({ weeks: 1 })],
      ["Bana 3 post hazırlarmısın", social({ perWeek: 3, weeks: 1 })],
      ["post hazırlayabilir misin", social()],
      ["1 aylık içerik planı", social({ weeks: 4 })],
      ["bu ay için 12 post", social({ perWeek: 3, weeks: 4 })],
      ["ayda 12 post", social({ perWeek: 3, weeks: 4 })],
      ["her ay 8 gönderi", social({ perWeek: 2, weeks: 4 })],
      ["2 haftalık plan, haftada 4 içerik", social({ perWeek: 4, weeks: 2 })],
      [
        "Instagram'da haftada 3 kez paylaşım yap",
        social({ channels: ["instagram"], perWeek: 3 }),
      ],
      [
        "Facebook'ta yaz indirimi için post",
        social({ channels: ["facebook"], topic: "yaz indirimi" }),
      ],
      [
        "IG story 3 tane",
        social({ channels: ["instagram"], story: true, perWeek: 3, weeks: 1 }),
      ],
      ["üç post", social({ perWeek: 3, weeks: 1 })],
      ["Bir post hazırla", social({ perWeek: 1, weeks: 1 })],
      [
        "Instagram için story yapsana",
        social({ channels: ["instagram"], story: true }),
      ],
      ["TikTok videoları için fikir ver", social({ channels: ["tiktok"] })],
      ["tik tok için video", social({ channels: ["tiktok"] })],
      ["sosyal medya içerikleri", social()],
      ["takvimi göster", social()],
      ["Pazartesi'ye kadar 3 post", social({ perWeek: 3, weeks: 1 })],
      ["3 post olsun", social({ perWeek: 3, weeks: 1 })],
      ["kahve hakkında post yazar mısınız", social({ topic: "kahve" })],
    ]);
  });

  describe("English", () => {
    routes([
      [
        "Plan 3 posts a week for Instagram and Facebook",
        social({ channels: ["instagram", "facebook"], perWeek: 3 }),
      ],
      [
        "3 posts about our new coffee menu",
        social({ perWeek: 3, weeks: 1, topic: "new coffee menu" }),
      ],
      ["Can you make a content calendar for next month?", social({ weeks: 4 })],
      ["Plan 10 posts", social({ perWeek: 5, weeks: 2 })],
      [
        "2 weeks of posts, 3 per week, for linkedin",
        social({ channels: ["linkedin"], perWeek: 3, weeks: 2 }),
      ],
      [
        "make an instagram story about the summer sale",
        social({ channels: ["instagram"], story: true, topic: "summer sale" }),
      ],
      ["reels for tiktok", social({ channels: ["tiktok"] })],
      [
        "Post 3 times a week on Instagram",
        social({ channels: ["instagram"], perWeek: 3 }),
      ],
      ["Do a content plan for next week", social({ weeks: 1 })],
      ["Plan posts for Black Friday", social({ topic: "Black Friday" })],
      [
        "Make 5 posts about Mother's Day",
        social({ perWeek: 5, weeks: 1, topic: "Mother's Day" }),
      ],
      ["three posts a week", social({ perWeek: 3 })],
      ["post twice a week", social({ perWeek: 2 })],
      [
        "post once a week on LinkedIn",
        social({ channels: ["linkedin"], perWeek: 1 }),
      ],
      [
        "3/week instagram posts",
        social({ channels: ["instagram"], perWeek: 3 }),
      ],
      ["5 posts/week for 2 weeks", social({ perWeek: 5, weeks: 2 })],
      ["10 posts a month", social({ perWeek: 3, weeks: 4 })],
      [
        "12 posts per month for Instagram",
        social({ channels: ["instagram"], perWeek: 3, weeks: 4 }),
      ],
      ["Boost engagement with 3 posts a week", social({ perWeek: 3 })],
      [
        "Need 3 posts for the launch",
        social({ perWeek: 3, weeks: 1, topic: "launch" }),
      ],
      ["Coffee posts", social({ topic: "Coffee" })],
      ["New Year posts", social({ topic: "New Year" })],
      ["Create new posts", social()],
      ["Make 3 more posts", social({ perWeek: 3, weeks: 1 })],
      ["Twitter thread", social({ channels: ["x"] })],
      ["social media content", social()],
    ]);
  });

  describe("channel names", () => {
    routes([
      // Nothing but channel names: they are the Brief's channels.
      [
        "Instagram and Facebook",
        social({ channels: ["instagram", "facebook"] }),
      ],
      ["instagram", social({ channels: ["instagram"] })],
      // Aliases, in catalog order whatever order they were typed in.
      [
        "insta, fb ve twitter için 2 post",
        social({
          channels: ["instagram", "facebook", "x"],
          perWeek: 2,
          weeks: 1,
        }),
      ],
      [
        "ig + linkedin haftada 4",
        social({ channels: ["instagram", "linkedin"], perWeek: 4 }),
      ],
      // A channel name with how much: Social.
      ["tiktok 3 weeks", social({ channels: ["tiktok"], weeks: 3 })],
    ]);

    it("a bare x is X away from numbers only", () => {
      expect(routeIntent("X için 3 post").prefill.channels).toEqual(["x"]);
      expect(routeIntent("3 x 2 post").prefill.channels).toBeUndefined();
    });

    it("a channel name next to other words is not enough on its own", () => {
      expect(routeIntent("instagram şifremi unuttum")).toEqual(CHAT);
      expect(routeIntent("tweet at")).toEqual(CHAT);
    });
  });
});

describe("routeIntent: the other modules", () => {
  routes([
    ["reklam kampanyası başlat, bütçe 500 TL", { module: "ads", prefill: {} }],
    ["Boost my last post", { module: "ads", prefill: {} }],
    [
      "Create an ad campaign for our summer sale",
      { module: "ads", prefill: { topic: "summer sale" } },
    ],
    [
      "yaz indirimi için reklam",
      { module: "ads", prefill: { topic: "yaz indirimi" } },
    ],
    [
      "Instagram reklamı",
      { module: "ads", prefill: { channels: ["instagram"] } },
    ],
    ["sponsorlu post", { module: "ads", prefill: {} }],
    ["butce ayarla", { module: "ads", prefill: {} }],
    ["kampanya", { module: "ads", prefill: {} }],
    [
      "Show me last month's performance report",
      { module: "analytics", prefill: {} },
    ],
    [
      "geçen ayın performans raporunu çıkar",
      { module: "analytics", prefill: {} },
    ],
    ["post performance", { module: "analytics", prefill: {} }],
    ["Reklam raporu", { module: "analytics", prefill: {} }],
    ["campaign results", { module: "analytics", prefill: {} }],
    [
      "Instagram istatistikleri",
      { module: "analytics", prefill: { channels: ["instagram"] } },
    ],
    ["insights", { module: "analytics", prefill: {} }],
    ["Analiz et", { module: "analytics", prefill: {} }],
    ["SEO için blog yazısı yaz", { module: "seo", prefill: {} }],
    [
      "write a blog article about summer skincare",
      { module: "seo", prefill: { topic: "summer skincare" } },
    ],
    ["anahtar kelime araştırması yap", { module: "seo", prefill: {} }],
    [
      "keyword research for our bakery",
      { module: "seo", prefill: { topic: "bakery" } },
    ],
    ["makale yaz", { module: "seo", prefill: {} }],
    ["blog post", { module: "seo", prefill: {} }],
  ]);
});

describe("routeIntent: greetings, sentences and module names", () => {
  routes([
    [
      "Merhaba! 3 instagram postu hazırla.",
      social({ channels: ["instagram"], perWeek: 3, weeks: 1 }),
    ],
    [
      "Hi. Can you plan 3 posts about our new menu?",
      social({ perWeek: 3, weeks: 1, topic: "new menu" }),
    ],
    [
      "Thanks. Now make 3 posts about coffee",
      social({ perWeek: 3, weeks: 1, topic: "coffee" }),
    ],
    [
      "Plan 3 posts.\nTopic: autumn collection",
      social({ perWeek: 3, weeks: 1, topic: "autumn collection" }),
    ],
    [
      "Selam, yeni ürünümüz için reklam kampanyası başlatalım",
      { module: "ads", prefill: { topic: "yeni ürünümüz" } },
    ],
    ["Social Media Planner", social()],
    ["Ads Manager", { module: "ads", prefill: {} }],
    ["Analytics", { module: "analytics", prefill: {} }],
    ["SEO Manager", { module: "seo", prefill: {} }],
  ]);
});

describe("routeIntent: stays a chat", () => {
  describe("questions without a request", () => {
    routes([
      ["markamızın tonu ne?", CHAT],
      ["markamizin tonu ne", CHAT],
      ["what is our brand tone?", CHAT],
      ["How did our posts perform last week?", CHAT],
      ["Should we post more reels?", CHAT],
      ["Is SEO worth it?", CHAT],
      ["SEO nedir", CHAT],
      ["Reklam bütçemiz ne kadar?", CHAT],
      ["Hangi postlar iyi gitti?", CHAT],
      ["Hazırladığın postlar nasıl?", CHAT],
      ["Oluşturduğumuz reklamlar nasıl gidiyor?", CHAT],
      ["Instagram?", CHAT],
    ]);
  });

  describe("ties and no module word", () => {
    routes([
      ["post ve reklam", CHAT],
      ["SEO raporu", CHAT],
      ["hello", CHAT],
      ["merhaba, nasılsın?", CHAT],
      ["thanks!", CHAT],
      ["bir haftalık plan", CHAT],
      ["3x a week", CHAT],
      ["", CHAT],
      ["   ", CHAT],
    ]);
  });

  describe("words that only look like a module", () => {
    routes([
      // Turkish "ad" is a name, "boost" can mean more of something.
      ["ürün için ad bul", CHAT],
      ["yeni ürüne ad öner", CHAT],
      ["How can we boost engagement?", CHAT],
      // A brand story is the brand's, not an Instagram Story.
      ["brand story", CHAT],
      ["markamızın hikayesi", CHAT],
    ]);
  });

  it("a long message is a conversation, whatever words it has", () => {
    const long = `Plan 3 instagram posts ${"and tell me more ".repeat(12)}`;
    expect(routeIntent(long)).toEqual(CHAT);
  });
});

describe("routeIntent: what the Brief starts with", () => {
  it("a Story is Instagram's when no channel is named, and keeps the named ones", () => {
    expect(routeIntent("3 story hazırla").prefill).toEqual({
      channels: ["instagram"],
      story: true,
      perWeek: 3,
      weeks: 1,
    });
    expect(routeIntent("Facebook story").prefill).toEqual({
      channels: ["facebook"],
      story: true,
    });
    expect(routeIntent("hikaye paylaş").prefill).toMatchObject({ story: true });
  });

  it("keeps the counts within the Brief's limits", () => {
    expect(routeIntent("20 posts a week").prefill).toEqual({ perWeek: 7 });
    expect(routeIntent("posts for 6 weeks").prefill).toEqual({ weeks: 4 });
    expect(routeIntent("3 aylık içerik takvimi").prefill).toEqual({ weeks: 4 });
    expect(routeIntent("100 posts").prefill).toEqual({ perWeek: 7, weeks: 4 });
  });

  it("a named day stays in the topic; a plain day is a time", () => {
    expect(routeIntent("Sevgililer Günü için 3 post").prefill.topic).toBe(
      "Sevgililer Günü",
    );
    expect(routeIntent("Kara Cuma için 3 post").prefill.topic).toBe(
      "Kara Cuma",
    );
    expect(routeIntent("Moda Haftası için story").prefill.topic).toBe(
      "Moda Haftası",
    );
    for (const text of [
      "posts on Friday",
      "post on Fridays",
      "every Friday post",
      "cuma günü 2 post",
      "next week posts",
    ]) {
      expect(routeIntent(text).prefill.topic).toBeUndefined();
    }
  });

  it.each([
    "Instagram için 5 story hazırla",
    "Facebook sayfası için 3 post",
    "Reel çekimi için fikir",
    "TikTok videoları için fikir ver",
    "anahtar kelime araştırması yap",
    "Instagram'da haftada 3 kez paylaşım yap",
    "Bana 3 post hazırlar mısın?",
  ])("leaves the topic out when nothing is a subject: %s", (text) => {
    expect(routeIntent(text).prefill.topic).toBeUndefined();
  });

  it("the topic is the phrase around the other words, as typed", () => {
    expect(routeIntent("Starbucks gibi postlar").prefill.topic).toBe(
      "Starbucks",
    );
    expect(routeIntent("kuruluş hikayemiz hakkında post").prefill).toEqual({
      topic: "kuruluş hikayemiz",
    });
    expect(routeIntent("post about our brand story").prefill).toEqual({
      topic: "brand story",
    });
  });

  it("a long phrase is no topic, and a told story is no Instagram Story", () => {
    expect(
      routeIntent(
        "posts about the very long story of how our small family bakery grew into a chain",
      ),
    ).toEqual(social());
  });
});

describe("routeIntent: Turkish letters or not", () => {
  it.each([
    ["gönderi", "gonderi"],
    ["paylaşım planı", "paylasim plani"],
    ["İçerik Takvimi", "ICERIK TAKVIMI"],
    ["bütçe", "butce"],
    ["hikâye", "hikaye"],
    ["haftada 3 gönderi, İnstagram", "haftada 3 gonderi, instagram"],
    ["performans raporunu çıkar", "performans raporunu cikar"],
    ["anahtar kelime araştırması", "anahtar kelime arastirmasi"],
    ["markamızın tonu ne?", "markamizin tonu ne?"],
  ])("%s routes like %s", (withLetters, ascii) => {
    const a = routeIntent(withLetters);
    const b = routeIntent(ascii);
    expect(a.module).toBe(b.module);
    expect({ ...a.prefill, topic: undefined }).toEqual({
      ...b.prefill,
      topic: undefined,
    });
  });
});
