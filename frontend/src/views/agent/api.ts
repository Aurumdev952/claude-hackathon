/** Agent REST API (agent/README.md): conversations CRUD, truncate (edit / rewind), suggestions. Same role headers as the
 * FastAPI client; every query key carries role + facility because conversations are pinned to the role that created them. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRole } from "@/state/role";
import type { AgentMessage, AgentRole, Conversation, ConversationWithMessages } from "./types";

export const AGENT_BASE = "/agent";

export class AgentApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** X-Role / X-Facility-Id for the current role (doctor requests need the facility). */
export function agentHeaders(): Record<string, string> {
  const { role, facilityId } = useRole.getState();
  const h: Record<string, string> = { "X-Role": role };
  if (role === "doctor" && facilityId) h["X-Facility-Id"] = String(facilityId);
  return h;
}

export async function agentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(AGENT_BASE + path, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...agentHeaders(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new AgentApiError(res.status, e.code ?? "HTTP_ERROR", e.message ?? res.statusText);
  }
  return (body as { data: T }).data;
}

export function useAgentScope() {
  const role = useRole((s) => s.role) as AgentRole;
  const facilityId = useRole((s) => s.facilityId);
  const facilityName = useRole((s) => s.facilityName);
  const ready = role === "ministry" || !!facilityId;
  return { role, facilityId: role === "doctor" ? facilityId : null, facilityName: role === "doctor" ? facilityName : null, ready };
}

export const agentKeys = {
  all: ["agent"] as const,
  list: (role: AgentRole, fac: number | null) => ["agent", "conversations", role, fac] as const,
  one: (role: AgentRole, fac: number | null, id: string) => ["agent", "conversation", role, fac, id] as const,
  suggestions: (role: AgentRole, fac: number | null) => ["agent", "suggestions", role, fac] as const,
};

export function useConversations() {
  const { role, facilityId, ready } = useAgentScope();
  return useQuery({
    queryKey: agentKeys.list(role, facilityId),
    queryFn: () => agentFetch<Conversation[]>("/conversations?limit=200"),
    enabled: ready,
    staleTime: 15_000,
  });
}

export function useConversation(id: string | null, enabled = true) {
  const { role, facilityId, ready } = useAgentScope();
  return useQuery({
    queryKey: agentKeys.one(role, facilityId, id ?? ""),
    queryFn: () => agentFetch<ConversationWithMessages>(`/conversations/${encodeURIComponent(id!)}`),
    enabled: ready && !!id && enabled,
    retry: (n, e) => !(e instanceof AgentApiError && (e.status === 404 || e.status === 403)) && n < 2,
    staleTime: Infinity,
    gcTime: 0,
  });
}

export function useSuggestions() {
  const { role, facilityId, ready } = useAgentScope();
  return useQuery({
    queryKey: agentKeys.suggestions(role, facilityId),
    queryFn: () => agentFetch<{ role: AgentRole; questions: string[] }>("/suggestions"),
    enabled: ready,
    staleTime: 10 * 60_000,
  });
}

export function useRenameConversation() {
  const qc = useQueryClient();
  const { role, facilityId } = useAgentScope();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      agentFetch<Conversation>(`/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
    onMutate: async ({ id, title }) => {
      const key = agentKeys.list(role, facilityId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Conversation[]>(key);
      qc.setQueryData<Conversation[]>(key, (xs) => xs?.map((c) => (c.id === id ? { ...c, title } : c)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(agentKeys.list(role, facilityId), ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: agentKeys.list(role, facilityId) }),
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  const { role, facilityId } = useAgentScope();
  return useMutation({
    mutationFn: (id: string) => agentFetch<{ id: string; deleted: boolean }>(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onMutate: async (id) => {
      const key = agentKeys.list(role, facilityId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Conversation[]>(key);
      qc.setQueryData<Conversation[]>(key, (xs) => xs?.filter((c) => c.id !== id));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(agentKeys.list(role, facilityId), ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: agentKeys.list(role, facilityId) }),
  });
}

/** Edit (`inclusive: true`, drops the message itself) or rewind (`inclusive: false`, keeps it) on the server. */
export function truncateConversation(id: string, messageId: string, inclusive: boolean) {
  return agentFetch<{ id: string; deleted: number; messages: AgentMessage[] }>(`/conversations/${encodeURIComponent(id)}/truncate`, {
    method: "POST", body: JSON.stringify({ messageId, inclusive }),
  });
}

export function fetchConversation(id: string) {
  return agentFetch<ConversationWithMessages>(`/conversations/${encodeURIComponent(id)}`);
}
