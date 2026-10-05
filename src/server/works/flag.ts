import "server-only";

import { getEnv } from "@/lib/env";

// Works on/off, read at call time (no module-level cache). A route or action
// re-checks it itself: hiding the button is not a security boundary.
//
// Works ride on the streaming agent (the legacy blocking action has no notion
// of a Work), so they are on only with CHAT_ENGINE=agent: flipping WORKS_UI
// under the legacy engine changes nothing instead of half-working.
export function isWorksEnabled(): boolean {
  const env = getEnv();
  return env.WORKS_UI && env.CHAT_ENGINE === "agent";
}

// Modules on/off (MODULES_UI, src/lib/modules), read the same way. A module is
// remembered on its Work, so modules are on only while Works is: MODULES_UI on
// its own changes nothing.
export function isModulesEnabled(): boolean {
  return getEnv().MODULES_UI && isWorksEnabled();
}
