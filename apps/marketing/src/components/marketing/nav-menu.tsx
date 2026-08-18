"use client";

import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { NavigationMenu } from "@base-ui/react/navigation-menu";

import { cn } from "@/lib/utils";
import {
  DEPARTMENTS,
  OTHER_DEPARTMENTS,
} from "@/components/marketing/departments/department-data";

export const NAV_LINKS = [
  { href: "/product", label: "Product" },
  { href: "/departments", label: "Departments" },
  { href: "/solutions", label: "Solutions" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

const DEPARTMENT_MENU_ITEMS = [
  ...DEPARTMENTS.map((department) => ({
    name: department.name,
    tagline: department.tagline,
    href: `/departments/${department.slug}`,
  })),
  ...OTHER_DEPARTMENTS.map((department) => ({
    name: department.name,
    tagline: department.tagline,
    href: "/departments",
  })),
];

const popupTransition =
  "transition-[opacity,transform] duration-[var(--agentelse-duration-base)] ease-[var(--agentelse-ease)] " +
  "data-starting-style:opacity-0 data-ending-style:opacity-0 " +
  "data-starting-style:scale-[0.98] data-ending-style:scale-[0.98]";

function DepartmentsMenuItem() {
  return (
    <NavigationMenu.Item>
      <NavigationMenu.Trigger className="flex items-center gap-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground data-popup-open:text-foreground">
        Departments
        <NavigationMenu.Icon className="transition-transform duration-200 ease-out data-popup-open:rotate-180">
          <ChevronDown className="size-3.5" />
        </NavigationMenu.Icon>
      </NavigationMenu.Trigger>

      <NavigationMenu.Content
        keepMounted
        className="w-[42rem] max-w-[calc(100vw-2rem)]"
      >
        <div className="grid grid-cols-[1fr_14rem] gap-1 p-3">
          <div className="p-3">
            <p className="agentelse-text-caption font-medium tracking-wide text-muted-foreground uppercase">
              Explore departments
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-x-2 gap-y-0.5">
              {DEPARTMENT_MENU_ITEMS.map((item) => (
                <li key={item.name}>
                  <NavigationMenu.Link
                    render={<Link href={item.href} />}
                    closeOnClick
                    className="block rounded-lg p-2.5 no-underline transition-colors hover:bg-muted"
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {item.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {item.tagline}
                    </span>
                  </NavigationMenu.Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col justify-between rounded-xl bg-muted p-4">
            <div>
              <p className="agentelse-text-caption font-medium tracking-wide text-muted-foreground uppercase">
                How they fit together
              </p>
              <p className="mt-3 text-sm text-foreground/80">
                Every department reports to the same Agency Director and reads
                from one Brand Brain, so the work stays coordinated even though
                it never sits idle.
              </p>
            </div>
            <NavigationMenu.Link
              render={<Link href="/departments" />}
              closeOnClick
              className="group mt-4 flex items-center gap-1.5 text-sm font-medium text-foreground no-underline"
            >
              View all departments
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
            </NavigationMenu.Link>
          </div>
        </div>
      </NavigationMenu.Content>
    </NavigationMenu.Item>
  );
}

export function DesktopNav() {
  return (
    <NavigationMenu.Root aria-label="Primary" className="hidden xl:block">
      <NavigationMenu.List className="relative flex items-center gap-6">
        {NAV_LINKS.map((link) =>
          link.href === "/departments" ? (
            <DepartmentsMenuItem key={link.href} />
          ) : (
            <NavigationMenu.Item key={link.href}>
              <NavigationMenu.Link
                render={<Link href={link.href} />}
                className="text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
              >
                {link.label}
              </NavigationMenu.Link>
            </NavigationMenu.Item>
          ),
        )}
      </NavigationMenu.List>

      <NavigationMenu.Portal>
        <NavigationMenu.Positioner
          sideOffset={16}
          align="start"
          collisionPadding={{ top: 8, bottom: 8, left: 16, right: 16 }}
          className={cn(
            "z-50 transition-[top,left,right,bottom] duration-[var(--agentelse-duration-base)] ease-[var(--agentelse-ease)] data-instant:transition-none",
          )}
        >
          <NavigationMenu.Popup
            className={cn(
              "relative w-[var(--popup-width)] h-[var(--popup-height)] origin-[var(--transform-origin)] overflow-hidden rounded-2xl border border-border bg-background shadow-[0_24px_60px_-24px_rgba(0,0,0,0.18)] transition-[width,height] duration-[var(--agentelse-duration-base)] ease-[var(--agentelse-ease)]",
              popupTransition,
            )}
          >
            <NavigationMenu.Viewport className="relative h-full w-full overflow-hidden" />
          </NavigationMenu.Popup>
        </NavigationMenu.Positioner>
      </NavigationMenu.Portal>
    </NavigationMenu.Root>
  );
}
