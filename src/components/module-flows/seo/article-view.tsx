"use client";

import { useMemo, type ReactNode } from "react";

import {
  parseMarkdown,
  type MdBlock,
  type MdInline,
} from "@/lib/module-flows/seo/markdown";

// The article as a reader sees it, rendered from the same blocks as the HTML
// export (lib/module-flows/seo/markdown.ts): React elements only, never raw
// HTML. Headings step down below the card's own heading (h3).

function inline(nodes: readonly MdInline[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code
            key={key}
            className="rounded px-1 py-0.5 text-[0.85em]"
            style={{ background: "var(--ws-hover)" }}
          >
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {inline(node.children, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{inline(node.children, key)}</em>;
      case "link":
        return node.href ? (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline underline-offset-2"
          >
            {inline(node.children, key)}
          </a>
        ) : (
          <span key={key}>{inline(node.children, key)}</span>
        );
    }
  });
}

function block(item: MdBlock, index: number): ReactNode {
  const key = String(index);
  switch (item.type) {
    case "heading": {
      const content = inline(item.children, key);
      if (item.level <= 2) {
        return (
          <h4
            key={key}
            className="pt-1 text-[15px] leading-6 font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {content}
          </h4>
        );
      }
      return item.level === 3 ? (
        <h5
          key={key}
          className="text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {content}
        </h5>
      ) : (
        <h6
          key={key}
          className="text-sm font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {content}
        </h6>
      );
    }
    case "paragraph":
      return <p key={key}>{inline(item.children, key)}</p>;
    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 pl-3 italic"
          style={{ borderColor: "var(--ws-border)" }}
        >
          {inline(item.children, key)}
        </blockquote>
      );
    case "list": {
      const items = item.items.map((entry, itemIndex) => (
        <li key={`${key}.${itemIndex}`}>
          {inline(entry.children, `${key}.${itemIndex}`)}
        </li>
      ));
      return item.ordered ? (
        <ol key={key} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      );
    }
  }
}

export function ArticleView({
  title,
  markdown,
}: {
  title: string;
  markdown: string;
}) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <article
      className="space-y-3 text-sm leading-6 break-words"
      style={{ color: "var(--ws-text-body, var(--ws-text))" }}
    >
      <p
        className="text-lg leading-7 font-semibold"
        style={{ color: "var(--ws-text)" }}
      >
        {title}
      </p>
      {blocks.map(block)}
    </article>
  );
}
