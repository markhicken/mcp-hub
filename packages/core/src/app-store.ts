import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renameWithRetry } from "./atomic-write.js";

/** What the user decided about one app, kept so the app isn't asked about again. */
export interface SavedApp {
  /** Which app it is: its .app bundle, or its program (and script) for command-line tools. Not a process id. */
  identity: string;
  name: string;
  path: string;
  status: "allowed" | "denied";
  /** Servers it may use; null means every one, including servers added later. */
  allowed: string[] | null;
  /** The app's code-signing identity when it had one. A different signature at the same path is treated as a different app. */
  signer: string;
  savedAt: number;
  lastSeen: number;
}

const valid = (a: unknown): a is SavedApp => {
  const x = a as Partial<SavedApp> | null;
  return (
    !!x &&
    typeof x.identity === "string" &&
    !!x.identity &&
    typeof x.name === "string" &&
    typeof x.path === "string" &&
    (x.status === "allowed" || x.status === "denied") &&
    (x.allowed === null || (Array.isArray(x.allowed) && x.allowed.every((s) => typeof s === "string"))) &&
    typeof x.signer === "string" &&
    typeof x.savedAt === "number" &&
    typeof x.lastSeen === "number"
  );
};

/**
 * The remembered apps, in `apps.json` (mode 0600, written atomically). It holds decisions, never secrets. An
 * unreadable file is moved aside and treated as empty: the worst outcome is being asked again.
 */
export class AppStore {
  private readonly apps = new Map<string, SavedApp>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { apps?: unknown };
      for (const a of Array.isArray(parsed.apps) ? parsed.apps : []) if (valid(a)) this.apps.set(a.identity, a);
    } catch {
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        // nothing more to do
      }
    }
  }

  get(identity: string): SavedApp | undefined {
    const a = this.apps.get(identity);
    return a && { ...a, allowed: a.allowed ? [...a.allowed] : null };
  }

  list(): SavedApp[] {
    return [...this.apps.keys()].map((k) => this.get(k)!);
  }

  upsert(app: SavedApp): void {
    this.apps.set(app.identity, { ...app, allowed: app.allowed ? [...app.allowed] : null });
    this.save();
  }

  /** Remember that the app was seen now (and under which name and path), without changing the decision. */
  touch(identity: string, seen: { name: string; path: string; lastSeen: number }): void {
    const a = this.apps.get(identity);
    if (!a) return;
    Object.assign(a, seen);
    this.save();
  }

  delete(identity: string): boolean {
    const had = this.apps.delete(identity);
    if (had) this.save();
    return had;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, apps: [...this.apps.values()] }, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameWithRetry(tmp, this.path);
    } catch {
      // The choice still applies until the app quits; it just won't survive a restart.
    }
  }
}
