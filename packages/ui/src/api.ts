import { useSyncExternalStore } from "react";
import type { LogLine, Snapshot } from "./types";

const TOKEN_KEY = "mcp-hub-token";

/** Read the per-run token from the URL once, keep it for this tab, and hide it from the address bar. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + (url.search || "") + url.hash);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export const getToken = (): string | null => sessionStorage.getItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${getToken() ?? ""}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // leave as text
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Live snapshot store fed by SSE

interface Store {
  snapshot: Snapshot | null;
  connected: boolean;
  unauthorized: boolean;
}

let store: Store = { snapshot: null, connected: false, unauthorized: false };
const listeners = new Set<() => void>();
const logListeners = new Set<(serverId: string, line: LogLine) => void>();

function set(patch: Partial<Store>): void {
  store = { ...store, ...patch };
  listeners.forEach((l) => l());
}

let es: EventSource | null = null;
let retry = 1000;

export function startEvents(): void {
  if (es) return;
  const token = getToken();
  if (!token) {
    set({ unauthorized: true });
    return;
  }
  const open = () => {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.addEventListener("state", (e) => {
      retry = 1000;
      set({ snapshot: JSON.parse((e as MessageEvent).data) as Snapshot, connected: true, unauthorized: false });
    });
    es.addEventListener("log", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { serverId: string; line: LogLine };
      logListeners.forEach((l) => l(d.serverId, d.line));
    });
    es.onerror = () => {
      es?.close();
      es = null;
      set({ connected: false });
      // A 401 closes the stream without detail; distinguish with a cheap probe.
      fetch("/api/state", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => {
          if (r.status === 401) set({ unauthorized: true });
          else setTimeout(open, retry);
        })
        .catch(() => setTimeout(open, retry));
      retry = Math.min(retry * 2, 10_000);
    };
  };
  open();
}

export function useStore(): Store {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => store,
  );
}

export function onLog(fn: (serverId: string, line: LogLine) => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}
