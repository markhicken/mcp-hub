import { Check, ChevronDown, Copy, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { api } from "./api";
import { fileManager } from "./lib";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------- Button

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-solid text-accent-fg hover:brightness-110 shadow-sm",
  secondary: "bg-surface border border-border text-fg hover:bg-surface-2",
  ghost: "text-muted hover:text-fg hover:bg-surface-2",
  danger: "bg-bad/10 text-bad hover:bg-bad/20 border border-bad/30",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------- Surfaces

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx("rounded-xl border border-border bg-surface shadow-card", className)}>
      {children}
    </div>
  );
}

export function Badge({ tone = "neutral", children, pulse }: { tone?: "good" | "warn" | "bad" | "accent" | "neutral"; children: ReactNode; pulse?: boolean }) {
  const tones = {
    good: "bg-good/12 text-good",
    warn: "bg-warn/15 text-warn",
    bad: "bg-bad/12 text-bad",
    accent: "bg-accent/14 text-accent",
    neutral: "bg-surface-2 text-muted",
  };
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone])}>
      <span className={cx("size-1.5 rounded-full bg-current", pulse && "pulse-dot")} aria-hidden />
      {children}
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{children}</span>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors cursor-pointer disabled:opacity-50",
        checked ? "bg-accent" : "bg-border",
      )}
    >
      <span className={cx("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-lg bg-surface-2", className)} />;
}

/** An indeterminate spinner: something is in progress and there is no way to say how far along it is. */
export function Spinner({ label, className }: { label: string; className?: string }) {
  return <span role="status" aria-label={label} title={label} className={cx("inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent", className)} />;
}

/** The current time, refreshed every `everyMs`, so "5m ago" labels stay true while nothing else changes. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

// ---------------------------------------------------------------------------- Form controls

export const inputCls =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, "h-auto min-h-20 py-2 font-mono text-xs", props.className)} />;
}

/** A native select with its own chevron, inset from the edge (the browser's is flush against the border). */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx("relative", className)}>
      <select {...props} className={cx(inputCls, "cursor-pointer appearance-none pr-9")} />
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold text-fg">
        {label}
      </label>
      <div id={id}>{children}</div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }> }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer",
            value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- Overlays

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

/** Keep Tab focus inside a container while it is mounted. */
function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusables()[0] ?? el).focus();
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = [...focusables()].filter((n) => !n.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", h);
    return () => {
      el.removeEventListener("keydown", h);
      prev?.focus?.();
    };
  }, [ref]);
}

export function Dialog({ title, subtitle, onClose, children, footer, wide }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useFocusTrap(ref);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm fade-in" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={cx("relative flex max-h-[90vh] w-full flex-col rounded-2xl border border-border bg-surface shadow-2xl fade-in", wide ? "max-w-3xl" : "max-w-xl")}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer">
            <X className="size-4" />
          </button>
        </header>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useFocusTrap(ref);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/35 fade-in" onClick={onClose} />
      <aside ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="absolute right-0 top-0 flex h-full w-full max-w-[560px] flex-col border-l border-border bg-surface shadow-2xl slide-in">
        {children}
      </aside>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{body}</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Toasts

interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "error";
}
const ToastCtx = createContext<(text: string, tone?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), tone === "error" ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx("fade-in pointer-events-auto max-w-sm rounded-lg border px-4 py-2.5 text-sm shadow-card", t.tone === "error" ? "border-bad/40 bg-surface text-bad" : "border-border bg-surface text-fg")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------------------- Misc

export function CopyButton({ text, label = "Copy", size = "sm" }: { text: string; label?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
      {done ? "Copied" : label}
    </Button>
  );
}

/** `shown` is what's displayed when it differs from what's copied (a masked secret). */
export function CodeBlock({ code, shown }: { code: string; shown?: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 pr-20 font-mono text-xs leading-relaxed">{shown ?? code}</pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="fade-in mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-accent/12 text-accent">{icon}</div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted">{body}</p>
      {children && <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * A file path that opens in the file manager (Finder, Explorer…) when clicked. Every path the UI shows should be one of
 * these. The hub looks the file up itself, so no arbitrary path is ever sent back to it: say what the path belongs to.
 *   app      an app's config file (by the app's name), or with `backup`, a backup copy of it
 *   running  a connected app's program (by its id)
 *   exported the configuration file that was just exported
 */
export function PathLink({ path, app, backup, running, exported, wrap, className }: { path: string; app?: string; backup?: boolean; running?: string; exported?: boolean; /** Break a long path over lines instead of cutting it off. */ wrap?: boolean; className?: string }) {
  const toast = useToast();
  const open = async () => {
    try {
      if (exported) await api("POST", "/api/config/export/reveal");
      else if (running) await api("POST", `/api/clients/${encodeURIComponent(running)}/reveal`);
      else await api("POST", "/api/apps/reveal", { client: app, ...(backup ? { backup: path } : {}) });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <button type="button" onClick={open} title={`Show in ${fileManager}: ${path}`} className={cx("max-w-full cursor-pointer text-left hover:text-accent hover:underline", wrap ? "break-all" : "block truncate", className)}>
      {path}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}
