import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * What happened, in the user's terms. History is a plain-language record, never a log of commands, arguments,
 * secret values or payloads.
 */
export type HistoryKind =
  | "secret" // a secret was read from a credential source, or reused from memory
  | "preload" // MCP Hub announced it is loading secrets ahead of time
  | "app" // an app asked to use MCP Hub, or its access changed
  | "server" // a server started, stopped or failed
  | "config" // a server was added, changed or removed
  | "vault"; // saved secrets were locked or forgotten

export const HISTORY_KINDS: readonly HistoryKind[] = ["secret", "preload", "app", "server", "config", "vault"];

export type SecretOutcome = "read" | "memory" | "denied" | "timeout" | "not-found" | "unavailable";

export interface HistoryInput {
  kind: HistoryKind;
  /** Short event name within the kind, e.g. "started", "idle-stop", "allowed". */
  action: string;
  serverId?: string;
  serverName?: string;
  /** The app involved, when there is one. */
  app?: string;
  /** The credential source involved, e.g. "1Password". */
  source?: string;
  /** Why it happened, as a short phrase: "Claude connected", "MCP Hub started", "you pressed Retry". */
  trigger?: string;
  /** Free-form extra info that is safe to show (counts, server names). Never secrets or raw errors. */
  detail?: string;
  /** For secret events. */
  outcome?: SecretOutcome;
}

export interface HistoryEvent {
  id: number;
  t: number;
  kind: HistoryKind;
  action: string;
  serverId: string;
  serverName: string;
  app: string;
  source: string;
  trigger: string;
  detail: string;
  outcome: string;
  /** How many identical events this row stands for (a burst of reads for one server is one row). */
  count: number;
  title: string;
}

export interface HistoryQuery {
  q?: string;
  /** Only these kinds (any of them). */
  kinds?: HistoryKind[];
  serverId?: string;
  limit?: number;
  /** Return events older than this id (for "load more"). */
  before?: number;
}

export interface HistoryResult {
  events: HistoryEvent[];
  /** True when older events match too. */
  more: boolean;
}

/** Events that repeat within this window with the same details are merged into one row with a count. */
const COALESCE_MS = 10_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describe(e: Pick<HistoryEvent, "kind" | "action" | "serverName" | "app" | "source" | "detail" | "outcome" | "count">): string {
  const server = e.serverName || "a server";
  const secrets = plural(e.count, "secret");
  switch (e.kind) {
    case "secret":
      switch (e.outcome) {
        case "read": return `Read ${secrets} from ${e.source || "a credential source"} for ${server}`;
        case "memory": return `Used ${plural(e.count, "saved secret")} for ${server}`;
        case "denied": return `${e.source || "The credential source"} refused ${secrets} for ${server}`;
        case "timeout": return `Gave up waiting for ${e.source || "the credential source"} to provide ${secrets} for ${server}`;
        case "not-found": return `Couldn't find ${secrets} in ${e.source || "the credential source"} for ${server}`;
        default: return `Couldn't read ${secrets} from ${e.source || "the credential source"} for ${server}`;
      }
    case "preload":
      return e.detail || "Loading secrets ahead of time";
    case "app":
      switch (e.action) {
        case "asked": return `${e.app} asked to use MCP Hub`;
        case "allowed": return `You allowed ${e.app} to use ${e.detail || "every server"}`;
        case "changed": return `You changed what ${e.app} can use: ${e.detail}`;
        case "denied": return `You denied ${e.app}`;
        case "revoked": return `You revoked ${e.app}'s access`;
        case "returned": return `${e.app} came back and used the access you saved (${e.detail})`;
        case "returned-denied": return `${e.app} came back and was turned away, as you chose`;
        case "signature-changed": return `${e.app} isn't signed the same way as the app you allowed, so MCP Hub is asking again`;
        case "removed": return `You removed ${e.app}; it has to be allowed again`;
        case "left": return `${e.app} quit`;
        default: return `${e.app}: ${e.action}`;
      }
    case "server":
      switch (e.action) {
        case "started": return `${server} started`;
        case "stopped": return `${server} stopped`;
        case "idle-stop": return `${server} stopped after sitting idle${e.detail ? ` for ${e.detail}` : ""}`;
        case "failed": return `${server} couldn't start or lost its connection`;
        case "needs-sign-in": return `${server} needs you to sign in`;
        default: return `${server}: ${e.action}`;
      }
    case "config":
      switch (e.action) {
        case "added": return `Added ${server}`;
        case "changed": return `Changed ${server}`;
        case "removed": return `Removed ${server}`;
        default: return `${server}: ${e.action}`;
      }
    case "vault":
      switch (e.action) {
        case "locked": return "Forgot every saved secret held in memory";
        case "forgot-one": return `Forgot one saved secret${e.source ? ` from ${e.source}` : ""}`;
        case "wiped": return "Deleted every locally saved secret";
        default: return e.action;
      }
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Plain-language activity history in SQLite. Pruned to the user's "keep history for" setting. */
export class History {
  private readonly db: DatabaseSync;
  private onWrite?: () => void;
  private closed = false;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        server_id TEXT NOT NULL DEFAULT '',
        server_name TEXT NOT NULL DEFAULT '',
        app TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        why TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_t ON events (t);
    `);
  }

  /** Called after every write, so the UI can refresh. */
  onChange(fn: () => void): void {
    this.onWrite = fn;
  }

  record(input: HistoryInput): void {
    if (this.closed) return;
    try {
      this.write(input);
    } catch {
      // The history is a convenience; a full disk or a locked file must never take the hub down.
    }
  }

  private write(input: HistoryInput): void {
    const row = {
      kind: input.kind,
      action: input.action,
      serverId: input.serverId ?? "",
      serverName: input.serverName ?? "",
      app: input.app ?? "",
      source: input.source ?? "",
      trigger: input.trigger ?? "",
      detail: input.detail ?? "",
      outcome: input.outcome ?? "",
    };
    const t = this.now();
    // Only secret events merge: reading five secrets for one server is one event, not five.
    if (row.kind === "secret") {
      const prev = this.db
        .prepare("SELECT id, count FROM events WHERE kind = 'secret' AND server_id = ? AND source = ? AND why = ? AND outcome = ? AND t >= ? ORDER BY id DESC LIMIT 1")
        .get(row.serverId, row.source, row.trigger, row.outcome, t - COALESCE_MS) as { id: number; count: number } | undefined;
      if (prev) {
        const count = prev.count + 1;
        this.db.prepare("UPDATE events SET count = ?, t = ?, title = ? WHERE id = ?").run(count, t, describe({ ...row, count }), prev.id);
        this.onWrite?.();
        return;
      }
    }
    this.db
      .prepare("INSERT INTO events (t, kind, action, server_id, server_name, app, source, why, detail, outcome, count, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .run(t, row.kind, row.action, row.serverId, row.serverName, row.app, row.source, row.trigger, row.detail, row.outcome, describe({ ...row, count: 1 }));
    this.onWrite?.();
  }

  query(q: HistoryQuery = {}): HistoryResult {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.kinds?.length) {
      where.push(`kind IN (${q.kinds.map(() => "?").join(", ")})`);
      args.push(...q.kinds);
    }
    if (q.serverId) {
      where.push("server_id = ?");
      args.push(q.serverId);
    }
    if (q.before) {
      where.push("id < ?");
      args.push(q.before);
    }
    // Every word must match somewhere in the event's visible text.
    for (const word of (q.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${escapeLike(word.toLowerCase())}%`;
      where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(why) LIKE ? ESCAPE '\\' OR lower(app) LIKE ? ESCAPE '\\' OR lower(server_name) LIKE ? ESCAPE '\\' OR lower(source) LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like, like);
    }
    const rows = this.db
      .prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit + 1) as Array<Record<string, string | number>>;
    const events = rows.slice(0, limit).map(
      (r): HistoryEvent => ({
        id: r.id as number,
        t: r.t as number,
        kind: r.kind as HistoryKind,
        action: r.action as string,
        serverId: r.server_id as string,
        serverName: r.server_name as string,
        app: r.app as string,
        source: r.source as string,
        trigger: r.why as string,
        detail: r.detail as string,
        outcome: r.outcome as string,
        count: r.count as number,
        title: r.title as string,
      }),
    );
    return { events, more: rows.length > limit };
  }

  /** Drop events older than the retention period. Returns how many went. */
  prune(retentionDays: number): number {
    const cutoff = this.now() - retentionDays * 86_400_000;
    const r = this.db.prepare("DELETE FROM events WHERE t < ?").run(cutoff);
    if (r.changes) this.onWrite?.();
    return Number(r.changes);
  }

  clear(): void {
    this.db.exec("DELETE FROM events");
    this.onWrite?.();
  }

  close(): void {
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
