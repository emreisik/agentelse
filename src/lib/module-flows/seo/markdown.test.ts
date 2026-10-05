import { describe, expect, it } from "vitest";

import {
  articleStats,
  countWords,
  markdownToHtml,
  parseInline,
  parseMarkdown,
  safeHref,
} from "./markdown";

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, lists and quotes as blocks", () => {
    const blocks = parseMarkdown(
      [
        "Intro line one",
        "continues here.",
        "",
        "## First section ##",
        "- one",
        "- two",
        "  still two",
        "1. first",
        "2) second",
        "> quoted",
        "---",
        "```",
        "Plain text inside a fence",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "heading",
      "list",
      "list",
      "quote",
      "paragraph",
    ]);
    expect(blocks[0]).toMatchObject({ text: "Intro line one continues here." });
    expect(blocks[1]).toMatchObject({ level: 2, text: "First section" });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [{ text: "one" }, { text: "two still two" }],
    });
    expect(blocks[3]).toMatchObject({
      ordered: true,
      items: [{ text: "first" }, { text: "second" }],
    });
    expect(blocks[5]).toMatchObject({ text: "Plain text inside a fence" });
  });

  it("does not read emphasis at the start of a line as a list", () => {
    const [block] = parseMarkdown("**Bold** start of a paragraph");
    expect(block?.type).toBe("paragraph");
  });
});

describe("parseInline", () => {
  it("reads bold, italic, code and links", () => {
    expect(parseInline("a **b** _c_ *d* `e` [f](https://x.com/f)")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "code", text: "e" },
      { type: "text", text: " " },
      {
        type: "link",
        href: "https://x.com/f",
        children: [{ type: "text", text: "f" }],
      },
    ]);
  });

  it("leaves snake_case, lone stars and escapes as text", () => {
    expect(parseInline("snake_case_name and 2 * 3 = 6 and \\*x\\*")).toEqual([
      { type: "text", text: "snake_case_name and 2 * 3 = 6 and *x*" },
    ]);
  });

  it("keeps an unsafe link target out", () => {
    const [link] = parseInline("[click](javascript:alert(1))");
    expect(link).toMatchObject({ type: "link", href: null });
  });
});

describe("safeHref", () => {
  it("allows the web, mail and same-site paths only", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(safeHref("/blog/post")).toBe("/blog/post");
    expect(safeHref("#top")).toBe("#top");
    expect(safeHref("//evil.com")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://a.com/x y")).toBeNull();
  });
});

describe("markdownToHtml", () => {
  it("writes headings, paragraphs, lists, bold, italic and links", () => {
    expect(
      markdownToHtml(
        "Intro with **bold** and *italic*.\n\n## Section\n\n- one\n- [two](https://x.com)\n\n1. first",
      ),
    ).toBe(
      [
        "<p>Intro with <strong>bold</strong> and <em>italic</em>.</p>",
        "<h2>Section</h2>",
        "<ul>",
        "  <li>one</li>",
        '  <li><a href="https://x.com">two</a></li>',
        "</ul>",
        "<ol>",
        "  <li>first</li>",
        "</ol>",
      ].join("\n"),
    );
  });

  it("escapes every character of the source", () => {
    const html = markdownToHtml(
      '<script>alert("x")</script> & \'quotes\'\n\n[a](https://x.com/?q="1"&b=2)\n\n`<b>`',
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;</p>",
    );
    expect(html).toContain(
      '<a href="https://x.com/?q=&quot;1&quot;&amp;b=2">a</a>',
    );
    expect(html).toContain("<code>&lt;b&gt;</code>");
  });

  it("writes an unsafe link as its text only", () => {
    expect(markdownToHtml("[click me](javascript:alert(1))")).toBe(
      "<p>click me</p>",
    );
  });
});

describe("articleStats", () => {
  it("counts words, sections, H1s and paragraph lengths", () => {
    const stats = articleStats(
      "# Title\n\nFirst para has five words.\n\n## One\n\nSecond.\n\n- a list item\n\n## Two",
    );
    expect(stats.h1Count).toBe(1);
    expect(stats.h2).toEqual(["One", "Two"]);
    expect(stats.firstParagraph).toBe("First para has five words.");
    expect(stats.paragraphWords).toEqual([5, 1]);
    expect(stats.words).toBe(1 + 5 + 1 + 1 + 3 + 1);
  });

  it("counts words in any script", () => {
    expect(countWords("Koşu ayakkabısı nasıl seçilir? Как выбрать")).toBe(6);
    expect(countWords("it's well-known")).toBe(2);
  });
});
