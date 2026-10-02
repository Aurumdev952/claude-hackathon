/** useChat transport (agent/README.md "/agent/chat"): the server rebuilds the history from its DB, so only the last
 * message travels, plus the trigger and (for regenerate) the assistant message id to replace. */
import { DefaultChatTransport } from "ai";
import { AGENT_BASE, agentHeaders } from "./api";
import type { AgentMessage } from "./types";

export function createAgentTransport() {
  return new DefaultChatTransport<AgentMessage>({
    api: `${AGENT_BASE}/chat`,
    headers: () => agentHeaders(),
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
      body: { id, message: messages[messages.length - 1], trigger, messageId },
    }),
  });
}

export const newConversationId = () =>
  `c_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 20)}`;
