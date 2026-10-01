import "server-only";

import {
  fetchPageAccessToken,
  type InstagramApi,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";

// Which Instagram account a connected "instagram" credential publishes to, and
// how to call Instagram for it. The row holds one of two routes (see
// MetaInstagramMetadata): Instagram Login (the account itself, the token is its
// own) or Facebook Login (the account linked to the selected Page, a Page token
// is derived). Everything that publishes, tests, or lists targets reads it
// through here so the two routes never drift apart.
export type InstagramTarget = {
  login: "instagram" | "facebook";
  // The Instagram professional account every API call is addressed to.
  igUserId: string;
  username?: string;
  // Facebook route only.
  pageId?: string;
  pageName?: string;
};

export function resolveInstagramTarget(
  metadata: Partial<MetaInstagramMetadata> | null | undefined,
): InstagramTarget | null {
  if (!metadata) return null;

  if (metadata.login === "instagram") {
    const account = metadata.instagramAccount;
    return account?.id
      ? { login: "instagram", igUserId: account.id, username: account.username }
      : null;
  }

  const page = metadata.pages?.find(
    (candidate) => candidate.pageId === metadata.selectedPageId,
  );
  if (!page?.instagramBusinessAccountId) return null;
  return {
    login: "facebook",
    igUserId: page.instagramBusinessAccountId,
    username: page.instagramUsername,
    pageId: page.pageId,
    pageName: page.pageName,
  };
}

// The token to call Instagram with, and the Graph host it belongs to. The
// Facebook route never stores a Page token: it is derived from the user token
// right before use. The Instagram route uses the stored token as it is.
export async function instagramAccessFor(
  target: InstagramTarget,
  storedToken: string,
): Promise<{ accessToken: string; api: InstagramApi }> {
  if (target.login === "instagram") {
    return { accessToken: storedToken, api: "instagram" };
  }
  return {
    accessToken: await fetchPageAccessToken(target.pageId!, storedToken),
    api: "facebook",
  };
}
