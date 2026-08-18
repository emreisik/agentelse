"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { appHref } from "@/lib/app-url";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { AgentelseMark } from "@/components/marketing/agentelse-mark";
import { DesktopNav, NAV_LINKS } from "@/components/marketing/nav-menu";

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition-colors duration-200",
        scrolled
          ? "border-border bg-background/85 backdrop-blur-md"
          : "border-transparent bg-transparent",
      )}
    >
      <div className="agentelse-container-wide flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <AgentelseMark className="size-8" />
          <span className="text-lg font-extrabold tracking-wide uppercase">
            Agentelse
          </span>
        </Link>

        <DesktopNav />

        <div className="hidden items-center gap-2.5 xl:flex">
          <Button
            variant="secondary"
            className="h-10 px-4"
            nativeButton={false}
            render={<Link href={appHref("/login")} />}
          >
            Sign in
          </Button>
          <Button
            className="h-10 px-4"
            nativeButton={false}
            render={<Link href={appHref("/register")} />}
          >
            Start free
            <ArrowUpRight />
          </Button>
        </div>

        <Sheet>
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="xl:hidden"
                aria-label="Open menu"
              />
            }
          >
            <Menu />
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>
                <span className="flex items-center gap-2">
                  <AgentelseMark className="size-6" />
                  <span className="text-base font-extrabold tracking-wide uppercase">
                    Agentelse
                  </span>
                </span>
              </SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-4" aria-label="Primary">
              {NAV_LINKS.map((link) => (
                <SheetClose
                  key={link.href}
                  render={<Link href={link.href} />}
                  nativeButton={false}
                  className="rounded-md px-2 py-2.5 text-base text-foreground hover:bg-muted"
                >
                  {link.label}
                </SheetClose>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-2 border-t border-border p-4">
              <Button
                variant="secondary"
                className="h-10"
                render={<Link href={appHref("/login")} />}
                nativeButton={false}
              >
                Sign in
              </Button>
              <Button
                className="h-10"
                render={<Link href={appHref("/register")} />}
                nativeButton={false}
              >
                Start free
                <ArrowUpRight />
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
