import { AlertTriangle } from "lucide-react";

/** Inline error box for a failed query (role="alert"). */
export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className="flex items-start gap-2 text-xs text-tone-danger p-3 rounded-tile border border-danger/30 bg-danger/10">
      <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden />{msg}
    </div>
  );
}
