"use client";

import * as React from "react";

import { AgentelseMark } from "@/components/brand/agentelse-mark";

// Same heading as the project chat's welcome (project-chat.tsx) — the SSR
// pass and the first client paint see "Welcome back", then
// useSyncExternalStore re-syncs to the visitor's local time with no
// hydration mismatch.
export function DashboardGreeting({
  firstName,
  subtitle,
}: {
  firstName: string | null;
  subtitle: string;
}) {
  const timeGreeting = React.useSyncExternalStore(
    () => () => {},
    () => {
      const hour = new Date().getHours();
      return hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
    },
    () => "Welcome back",
  );

  return (
    <div className="relative px-1">
      <h1
        className="max-w-[calc(100%-80px)] text-[29px] leading-[1.15] font-medium sm:text-[35px]"
        style={{ color: "var(--ws-text)", letterSpacing: "-1.4px" }}
      >
        {firstName ? `${timeGreeting}, ${firstName}` : timeGreeting}
        <span style={{ color: "var(--ws-olive)" }}>.</span>
      </h1>
      <AgentelseMark
        aria-hidden
        className="pointer-events-none absolute top-0 right-0 hidden size-14 rotate-12 sm:block"
        style={{ color: "var(--ws-olive)", opacity: 0.5 }}
      />
      <p
        className="mt-3 max-w-lg text-sm leading-6"
        style={{ color: "var(--ws-text-2)" }}
      >
        {subtitle}
      </p>
    </div>
  );
}
