import { describe, expect, it } from "vitest";

import { extractHtmlParts } from "./html-parts";

// Bu dosyanın kanıtladığı: yorumdaki script sayılmaz; script metni
// '</div>' içerse de kapanış etiketine kadar okunur; nitelikler dört
// biçimde ve varlıklar çözülerek okunur; bozuk girdi istisna atmaz;
// etiket sınırı uygulanır.

describe("extractHtmlParts", () => {
  it("skips comments, DOCTYPE and CDATA", () => {
    const parts = extractHtmlParts(
      `<!DOCTYPE html><!-- <script src="/hidden.js"></script> -->` +
        `<![CDATA[ <script src="/cdata.js"></script> ]]>` +
        `<script src="/visible.js"></script>`,
    );
    expect(parts.scripts).toEqual([{ src: "/visible.js", text: "" }]);
  });

  it("reads script text as raw text up to the closing tag", () => {
    const parts = extractHtmlParts(
      `<SCRIPT>var x = "</div><a href='/no'>"; if (a < b) {}</ScRiPt >` +
        `<style>a::before{content:"<script>"}</style><a href="/yes">`,
    );
    expect(parts.scripts).toEqual([
      { src: null, text: `var x = "</div><a href='/no'>"; if (a < b) {}` },
    ]);
    expect(parts.hrefs).toEqual(["/yes"]);
  });

  it("reads quoted, unquoted and boolean attributes and decodes entities", () => {
    const parts = extractHtmlParts(
      `<script async src='https://x.test/a.js?b=1&amp;c=2'></script>` +
        `<a href=/plain>1</a><a HREF="say &quot;hi&quot; &#39;x&#39; &lt;&gt;">2</a>` +
        `<a name="x">no href</a><form action="/f"></form><FORM></FORM>`,
    );
    expect(parts.scripts[0]).toEqual({
      src: "https://x.test/a.js?b=1&c=2",
      text: "",
    });
    expect(parts.hrefs).toEqual(["/plain", `say "hi" 'x' <>`]);
    expect(parts.forms).toBe(2);
  });

  it("keeps the first of duplicated attributes and tolerates '>' in quotes", () => {
    const parts = extractHtmlParts(`<a href="/a>b" href="/c">x</a>`);
    expect(parts.hrefs).toEqual(["/a>b"]);
  });

  it("never throws on malformed input", () => {
    const inputs = [
      "<",
      "<a",
      `<a href="unterminated`,
      "<script>never closed",
      "<!-- open comment",
      "<<<>>>< / a>",
      `<a =x href=>`,
      "a < b > c",
      "",
    ];
    for (const input of inputs) {
      expect(() => extractHtmlParts(input)).not.toThrow();
    }
    expect(extractHtmlParts("<script>never closed").scripts).toEqual([
      { src: null, text: "never closed" },
    ]);
    expect(extractHtmlParts(null as unknown as string)).toEqual({
      scripts: [],
      hrefs: [],
      forms: 0,
    });
  });

  it("stops after 20 000 tags and caps a script at 200 000 chars", () => {
    const many = extractHtmlParts(`<a href="/x">`.repeat(25_000));
    expect(many.hrefs).toHaveLength(20_000);

    const big = extractHtmlParts(`<script>${"x".repeat(250_000)}</script>`);
    expect(big.scripts[0]?.text).toHaveLength(200_000);
  });
});
