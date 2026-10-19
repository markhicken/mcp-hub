import { useEffect, useState } from "react";
import { api } from "./api";
import { Badge, Button, useToast } from "./ui";

interface Target {
  id: string;
  name: string;
}
type Status = "allowed" | "denied" | "waiting" | "unavailable";
interface Result {
  status: Status;
  message: string;
}

const TONE = { allowed: "good", denied: "bad", waiting: "warn", unavailable: "warn" } as const;
const LABEL = { allowed: "Allowed", denied: "Blocked", waiting: "Waiting for you", unavailable: "Couldn't check" } as const;

/** Lets people check, and re-request, the macOS permission for MCP Hub to control other apps with AppleScript. */
export function AutomationPanel() {
  const toast = useToast();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});

  useEffect(() => {
    api<{ targets: Target[] }>("GET", "/api/automation").then((r) => setTargets(r.targets), () => setTargets([]));
  }, []);

  const check = async (t: Target, reset: boolean) => {
    setBusy(t.id);
    try {
      const r = await api<Result>("POST", "/api/automation/check", { target: t.id, reset });
      setResults((x) => ({ ...x, [t.id]: r }));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  if (!targets?.length) return <div className="px-5 py-4 text-xs text-muted">{targets ? "No apps that servers usually control were found on this Mac." : "Looking for apps…"}</div>;

  return (
    <>
      <div className="px-5 py-4 text-xs text-muted">
        Servers such as Outlook or Mail tools control those apps with AppleScript, and macOS must let MCP Hub do that. Checking may open the app and show a macOS prompt: choose Allow.
        If you chose Don't Allow earlier, use Ask again.{" "}
        <button className="cursor-pointer font-medium text-accent underline-offset-2 hover:underline" onClick={() => api("POST", "/api/automation/open-settings").catch((e) => toast((e as Error).message, "error"))}>
          Open System Settings
        </button>
      </div>
      {targets.map((t) => {
        const r = results[t.id];
        return (
          <div key={t.id} className="px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                {t.name}
                {r && <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => check(t, false)}>{busy === t.id ? "Checking…" : "Check access"}</Button>
                <Button size="sm" disabled={busy !== null} onClick={() => check(t, true)}>Ask again</Button>
              </div>
            </div>
            {r && <div className="mt-1.5 text-xs text-muted">{r.message}</div>}
          </div>
        );
      })}
    </>
  );
}
