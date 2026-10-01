/** Chat UI types (plan §B7). Widget and metadata contracts come from the agent backend via the `@agent/widgets` alias. */
import type { UIMessage } from "ai";
import type { MessageMetadata, ToolName } from "@agent/widgets";
import { TOOL_LABELS } from "@agent/widgets";

export type AgentRole = "ministry" | "doctor";
export type AgentMessage = UIMessage<MessageMetadata>;
export type AgentPart = AgentMessage["parts"][number];

export type Conversation = {
  id: string;
  role: AgentRole;
  facility_id: number | null;
  title: string;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  message_count?: number;
  last_message_preview?: string | null;
};
export type ConversationWithMessages = Conversation & { messages: AgentMessage[] };

export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error" | "approval-requested" | "approval-responded" | "output-denied";
/** The tool UI part shape we rely on (static `tool-<name>` and `dynamic-tool` parts both fit). */
export type ToolPartLike = { type: string; toolCallId: string; state: ToolState; input?: unknown; output?: unknown; errorText?: string; toolName?: string };

export const isToolPart = (p: { type: string }): p is ToolPartLike => p.type.startsWith("tool-") || p.type === "dynamic-tool";
export const toolNameOf = (p: ToolPartLike) => (p.type === "dynamic-tool" ? p.toolName ?? "tool" : p.type.slice(5));
export const toolLabel = (name: string) => (TOOL_LABELS as Record<string, string>)[name] ?? name.replace(/_/g, " ");
export const WIDGET_TOOLS = new Set<ToolName | string>(["make_chart", "make_patient_widget", "run_python"]);

/** Who answers: one agent per target user (the role switch in the top nav decides). */
export const PERSONA: Record<AgentRole, { name: string; blurb: string }> = {
  ministry: { name: "Ministry analyst", blurb: "Rates, trends, hotspots and care quality across Rwanda" },
  doctor: { name: "Clinical assistant", blurb: "Your facility's patients, risk and alerts" },
};
