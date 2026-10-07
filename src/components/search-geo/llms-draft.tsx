"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

// llms.txt taslağı ve kopyala düğmesi (SC-F8). Yalnız bir metin gösterir;
// siteye hiçbir şey yazılmaz. Pano erişimi reddedilirse düğme sessizce
// kalır, metin yine seçilip kopyalanabilir.

export function LlmsDraft({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-2" data-card="llms-draft">
      <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs break-words whitespace-pre-wrap">
        {text}
      </pre>
      <Button type="button" variant="outline" size="xs" onClick={copy}>
        {copied ? "Copied" : "Copy the text"}
      </Button>
    </div>
  );
}
