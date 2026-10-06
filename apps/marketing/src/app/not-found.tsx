import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/site/section";

export default function NotFound() {
  return (
    <section className="site-section">
      <div className="site-container flex flex-col items-center gap-5 text-center">
        <Eyebrow>404</Eyebrow>
        <h1 className="text-h1 max-w-[16ch] text-balance">
          This page isn&apos;t here.
        </h1>
        <p className="max-w-[44ch] text-muted-foreground">
          It may have moved when we rebuilt the site. The home page is a good
          place to start.
        </p>
        <Button
          className="mt-2 h-11 px-6"
          nativeButton={false}
          render={<Link href="/" />}
        >
          <ArrowLeft />
          Back home
        </Button>
      </div>
    </section>
  );
}
