import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renameWithRetry } from "./atomic-write.js";
import { SecretBox } from "./credentials/box.js";

export interface LogLine {
  t: number;
  level: "info" | "warn" | "error" | "stderr";
  text: string;
}

const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Per-server log lines: a ring buffer in memory, optionally mirrored to a file so history survives a restart.
 * Registered secret values are masked before anything is stored. The file is readable only by you, and is
 * rolled over at 1 MB (the previous one is kept as `<file>.1`).
 */
export class LogBuffer extends EventEmitter {
  private lines: LogLine[] = [];
  /** Secret values to mask, kept sealed and opened only while a line is being masked. */
  private secrets: string[] = [];
  private fileOk = true;
  private readonly box: SecretBox;

  constructor(
    private readonly max = 500,
    private readonly file?: string,
    box?: SecretBox,
  ) {
    super();
    this.box = box ?? SecretBox.ephemeral();
    if (file) this.load(file);
  }

  /** Recent lines from an earlier run, oldest first. */
  private load(file: string): void {
    try {
      const old = existsSync(`${file}.1`) ? readFileSync(`${file}.1`, "utf-8") : "";
      const cur = existsSync(file) ? readFileSync(file, "utf-8") : "";
      for (const raw of (old + cur).split("\n").slice(-this.max * 2)) {
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as LogLine;
          if (typeof l.t === "number" && typeof l.text === "string") this.lines.push(l);
        } catch {
          // a torn last line after a crash
        }
      }
      this.lines = this.lines.slice(-this.max);
    } catch {
      // history is a convenience
    }
  }

  setSecrets(values: Iterable<string>): void {
    this.secrets = [...new Set([...values].filter((v) => v.length >= 4))].map((v) => this.box.seal(v));
  }

  private mask(text: string): string {
    let out = text;
    for (const sealed of this.secrets) {
      const s = this.box.open(sealed);
      if (out.includes(s)) out = out.split(s).join("•••");
    }
    return out;
  }

  private persist(line: LogLine): void {
    if (!this.file || !this.fileOk) return;
    try {
      if (!existsSync(this.file)) {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        writeFileSync(this.file, "", { mode: 0o600 });
      } else if (statSync(this.file).size > MAX_FILE_BYTES) {
        renameWithRetry(this.file, `${this.file}.1`);
        writeFileSync(this.file, "", { mode: 0o600 });
      }
      appendFileSync(this.file, JSON.stringify(line) + "\n");
    } catch {
      this.fileOk = false; // never let logging break the server
    }
  }

  add(level: LogLine["level"], text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line: LogLine = { t: Date.now(), level, text: this.mask(raw).slice(0, 2000) };
      this.lines.push(line);
      if (this.lines.length > this.max) this.lines.shift();
      this.persist(line);
      this.emit("line", line);
    }
  }

  tail(n = 200): LogLine[] {
    return this.lines.slice(-n);
  }

  clear(): void {
    this.lines = [];
    this.removeFiles(true);
  }

  /** Delete the files (the server was removed). */
  destroy(): void {
    this.lines = [];
    this.removeFiles(false);
  }

  private removeFiles(keepEmptyCurrent: boolean): void {
    if (!this.file) return;
    try {
      rmSync(`${this.file}.1`, { force: true });
      if (keepEmptyCurrent && existsSync(this.file)) {
        writeFileSync(this.file, "");
        chmodSync(this.file, 0o600);
      } else rmSync(this.file, { force: true });
    } catch {
      // nothing to clean up
    }
  }
}
