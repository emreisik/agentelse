"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import { NAV_LINKS, SIGN_IN_HREF, START_HREF } from "@/lib/site";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function SiteNav() {
  const pathname = usePathname();
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
        "sticky top-0 z-50 border-b transition-colors duration-300",
        scrolled
          ? "border-border bg-background/80 backdrop-blur-xl"
          : "border-transparent bg-background/0",
      )}
    >
      <div className="site-container-wide flex h-16 items-center justify-between gap-6">
        <Link
          href="/"
          className="flex shrink-0 items-center"
          aria-label="Agentelse home"
        >
          <img src="/logo.png" alt="Agentelse" className="h-6 w-auto" />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full px-3.5 py-2 text-sm font-medium transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Button
            variant="ghost"
            className="h-9 px-4"
            nativeButton={false}
            render={<Link href={SIGN_IN_HREF} />}
          >
            Sign in
          </Button>
          <Button
            className="h-9 px-4"
            nativeButton={false}
            render={<Link href={START_HREF} />}
          >
            Start free
          </Button>
        </div>

        <Sheet>
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open menu"
              />
            }
          >
            <Menu />
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>
                <img src="/logo.png" alt="Agentelse" className="h-6 w-auto" />
              </SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-4" aria-label="Primary">
              {[
                { href: "/", label: "Home" },
                ...NAV_LINKS,
                { href: "/contact", label: "Contact" },
              ].map((link) => (
                <SheetClose
                  key={link.href}
                  render={<Link href={link.href} />}
                  nativeButton={false}
                  className="flex items-center justify-between rounded-lg px-3 py-3 text-base font-medium text-foreground hover:bg-muted"
                >
                  {link.label}
                  <ArrowRight className="size-4 text-muted-foreground" />
                </SheetClose>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-2 border-t border-border p-4">
              <Button
                variant="secondary"
                className="h-11"
                render={<Link href={SIGN_IN_HREF} />}
                nativeButton={false}
              >
                Sign in
              </Button>
              <Button
                className="h-11"
                render={<Link href={START_HREF} />}
                nativeButton={false}
              >
                Start free
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
