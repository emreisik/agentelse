// SC-F8: SEO Manager makalesinin markdown'ını Gutenberg blok serileştirmesine
// çevirir (yeni WordPress taslağının içeriği). parseMarkdown ile aynı ayrıştırıcı
// kullanılır; metnin her karakteri kaçışlanır, yalnız aşağıdaki etiketler yazılır.
// Çıktı belirleyicidir (aynı girdi, aynı bayt). Blok işaretleri WordPress 6.x
// biçimindedir (doğrulanmalı: wp-block-heading / wp-block-list sınıfları ve
// wp:list-item iç blokları sürüme göre değişir). Saf modül.

import {
  countWords,
  escapeHtml,
  parseMarkdown,
  type MdInline,
} from "@/lib/module-flows/seo/markdown";

function inlineHtml(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.text);
        case "code":
          return `<code>${escapeHtml(node.text)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(node.children)}</strong>`;
        case "em":
          return `<em>${inlineHtml(node.children)}</em>`;
        case "link":
          // Güvenli olmayan hedef: etiket düz metin olarak kalır.
          return node.href
            ? `<a href="${escapeHtml(node.href)}">${inlineHtml(node.children)}</a>`
            : inlineHtml(node.children);
      }
    })
    .join("");
}

function sameText(a: string, b: string): boolean {
  const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

export function markdownToBlocks(
  markdown: string,
  options: { title: string },
): { content: string; words: number; headings: number } {
  const out: string[] = [];
  let words = 0;
  let headings = 0;
  let h1Handled = false;

  for (const block of parseMarkdown(markdown)) {
    if (block.type === "heading") {
      // Başlık WordPress'te yazı başlığıdır: ilk H1 aynıysa gövdeden düşer,
      // diğer H1'ler H2 olur; H5/H6 H4'e iner.
      if (block.level === 1 && !h1Handled) {
        h1Handled = true;
        if (sameText(block.text, options.title)) continue;
      }
      const level = Math.min(Math.max(block.level, 2), 4);
      const attrs = level === 2 ? "" : ` {"level":${level}}`;
      out.push(
        `<!-- wp:heading${attrs} -->\n<h${level} class="wp-block-heading">${inlineHtml(block.children)}</h${level}>\n<!-- /wp:heading -->`,
      );
      words += countWords(block.text);
      headings++;
      continue;
    }

    if (block.type === "paragraph") {
      out.push(
        `<!-- wp:paragraph -->\n<p>${inlineHtml(block.children)}</p>\n<!-- /wp:paragraph -->`,
      );
      words += countWords(block.text);
      continue;
    }

    if (block.type === "quote") {
      out.push(
        `<!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>${inlineHtml(block.children)}</p>\n<!-- /wp:paragraph --></blockquote>\n<!-- /wp:quote -->`,
      );
      words += countWords(block.text);
      continue;
    }

    const tag = block.ordered ? "ol" : "ul";
    const attrs = block.ordered ? ' {"ordered":true}' : "";
    const items = block.items
      .map(
        (item) =>
          `<!-- wp:list-item -->\n<li>${inlineHtml(item.children)}</li>\n<!-- /wp:list-item -->`,
      )
      .join("\n");
    out.push(
      `<!-- wp:list${attrs} -->\n<${tag} class="wp-block-list">${items}</${tag}>\n<!-- /wp:list -->`,
    );
    for (const item of block.items) words += countWords(item.text);
  }

  return { content: out.join("\n\n"), words, headings };
}
