"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { connectTelegramAction } from "@/server/actions/telegram-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";

type State = { ok: true } | { ok: false; message: string } | null;
type Draft = { botToken: string; chatId: string; allowedApproverIds: string };

const EMPTY_DRAFT: Draft = { botToken: "", chatId: "", allowedApproverIds: "" };

// This form's draft is written to sessionStorage (a separate key per
// project) — during setup in this session the dev server restarted and
// the page reloaded multiple times, requiring the long bot token to be
// retyped each time. sessionStorage clears itself when the tab closes
// (unlike localStorage), and it is also cleared immediately once the
// connection succeeds — so the token doesn't sit in the browser longer
// than necessary.
function draftKey(projectId: string): string {
  return `telegram-connect-draft:${projectId}`;
}

function readDraft(projectId: string): Draft {
  try {
    const raw = window.sessionStorage.getItem(draftKey(projectId));
    if (!raw) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "botToken" in parsed &&
      "chatId" in parsed &&
      typeof (parsed as Draft).botToken === "string" &&
      typeof (parsed as Draft).chatId === "string"
    ) {
      const draft = parsed as Partial<Draft>;
      return {
        botToken: draft.botToken ?? "",
        chatId: draft.chatId ?? "",
        allowedApproverIds:
          typeof draft.allowedApproverIds === "string"
            ? draft.allowedApproverIds
            : "",
      };
    }
  } catch {
    // sessionStorage may be inaccessible (private mode, etc.) — ignore silently.
  }
  return EMPTY_DRAFT;
}

function writeDraft(projectId: string, draft: Draft) {
  try {
    window.sessionStorage.setItem(draftKey(projectId), JSON.stringify(draft));
  } catch {
    // if it can't be written, continue without saving a draft — not critical.
  }
}

function clearDraft(projectId: string) {
  try {
    window.sessionStorage.removeItem(draftKey(projectId));
  } catch {
    // ignore
  }
}

// We keep the bot token, chat ID, and allowed approver list as controlled
// inputs — so that after a failed attempt (e.g. wrong chat id) or a page
// reload, the user doesn't have to retype the long token, only fix the
// bad field and retry.
export function TelegramConnectForm({
  projectId,
  hasExistingConnection,
}: {
  projectId: string;
  hasExistingConnection: boolean;
}) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [allowedApproverIds, setAllowedApproverIds] = useState("");
  const router = useRouter();

  // To avoid a server-render mismatch (hydration) issue, reading from
  // sessionStorage is deferred to an effect after mount — accessing
  // window in a lazy useState initializer would create a mismatch
  // between SSR/client renders. This is a legitimate "sync with an
  // external system (browser storage) on mount" effect, as React's own
  // docs illustrate — it doesn't risk cascading renders since it runs at
  // most once, only on mount (or when projectId changes).
  useEffect(() => {
    const draft = readDraft(projectId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (draft.botToken) setBotToken(draft.botToken);
    if (draft.chatId) setChatId(draft.chatId);
    if (draft.allowedApproverIds)
      setAllowedApproverIds(draft.allowedApproverIds);
  }, [projectId]);

  const updateBotToken = (value: string) => {
    setBotToken(value);
    writeDraft(projectId, { botToken: value, chatId, allowedApproverIds });
  };
  const updateChatId = (value: string) => {
    setChatId(value);
    writeDraft(projectId, { botToken, chatId: value, allowedApproverIds });
  };
  const updateAllowedApproverIds = (value: string) => {
    setAllowedApproverIds(value);
    writeDraft(projectId, { botToken, chatId, allowedApproverIds: value });
  };

  const [state, formAction] = useActionState(
    async (_prev: State, formData: FormData): Promise<State> => {
      const result = await connectTelegramAction(formData);
      if (result.ok) {
        toast.success("Telegram connected");
        setBotToken("");
        setChatId("");
        setAllowedApproverIds("");
        clearDraft(projectId);
        router.refresh();
      } else {
        toast.error(result.message);
      }
      return result;
    },
    null,
  );

  const failed = state !== null && !state.ok;

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Bot Token</label>
        <Input
          name="botToken"
          type="password"
          placeholder="123456:ABC-DEF..."
          className="h-8 text-xs"
          value={botToken}
          onChange={(e) => updateBotToken(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Chat ID or @username</label>
        <Input
          name="chatId"
          placeholder="@channelname or -1001234567890"
          className="h-8 text-xs"
          value={chatId}
          onChange={(e) => updateChatId(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">
          Telegram user IDs with approval rights (optional)
        </label>
        <Input
          name="allowedApproverIds"
          placeholder="123456789, 987654321"
          className="h-8 text-xs"
          value={allowedApproverIds}
          onChange={(e) => updateAllowedApproverIds(e.target.value)}
        />
      </div>
      {failed ? (
        <p className="text-[11px] text-destructive">{state.message}</p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Create the bot with @BotFather and enter the token here. You can use
        @username for a public channel; for a private group/channel you can find
        the numeric chat ID with a helper bot like @userinfobot. Don&apos;t
        forget to add the bot as an admin to the target channel/group.
      </p>
      <p className="text-[10px] text-muted-foreground/70">
        Restricts who can use the &quot;Approve&quot;/&quot;Reject&quot; buttons
        on approval requests — you can find your own ID with @userinfobot. If
        left empty, approval messages are sent for information only, with no
        buttons.
      </p>
      <p className="text-[10px] text-muted-foreground/70">
        Your entries are kept in your browser while this tab is open (they
        survive a page reload) — cleared automatically once the connection
        succeeds.
      </p>
      <SubmitButton size="xs">
        {failed ? (
          <RefreshCw className="size-3" />
        ) : (
          <Plug className="size-3" />
        )}
        {failed ? "Try Again" : hasExistingConnection ? "Reconnect" : "Connect"}
      </SubmitButton>
    </form>
  );
}
