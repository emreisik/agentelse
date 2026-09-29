"use client";

import { createContext, useContext } from "react";

// Lets a chat card send a message the same way the composer does (the
// streaming agent turn when CHAT_ENGINE=agent, the blocking action otherwise),
// so an answer typed into a card lands in the exact engine that asked for it.
// Null outside the project chat: cards then fall back to the plain server
// action.
type SendMessage = (text: string) => Promise<void>;

const ChatSendContext = createContext<SendMessage | null>(null);

export const ChatSendProvider = ChatSendContext.Provider;

export function useChatSend(): SendMessage | null {
  return useContext(ChatSendContext);
}
