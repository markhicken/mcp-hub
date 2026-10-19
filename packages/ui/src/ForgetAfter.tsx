import { Select } from "./ui";

const OPTIONS: Array<[number, string]> = [
  [60, "1 minute"],
  [300, "5 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [14400, "4 hours"],
  [28800, "8 hours"],
  [86400, "24 hours"],
  [0, "Until I forget them"],
];

const label = (s: number): string => {
  if (s % 3600 === 0) return `${s / 3600} hours`;
  if (s % 60 === 0) return `${s / 60} minutes`;
  return `${s} seconds`;
};

/** How long a remembered sign-in is kept after it was last signed in or renewed. */
const SIGNIN_OPTIONS: Array<[number, string]> = [
  [86400, "1 day"],
  [7 * 86400, "7 days"],
  [30 * 86400, "30 days"],
  [90 * 86400, "90 days"],
  [0, "Until I forget them"],
];

export function SignInTtlSelect({ value, onChange, className }: { value: number; onChange: (seconds: number) => void; className?: string }) {
  const known = SIGNIN_OPTIONS.some(([s]) => s === value);
  return (
    <Select aria-label="Forget remembered sign-ins after" className={className ?? "w-44"} value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
      {!known && <option value={String(value)}>{Math.round(value / 86400)} days</option>}
      {SIGNIN_OPTIONS.map(([s, text]) => <option key={s} value={String(s)}>{text}</option>)}
    </Select>
  );
}

/** How long MCP Hub keeps a secret it fetched before forgetting it. Used on the Credentials and Settings pages. */
export function ForgetAfterSelect({ value, onChange, className }: { value: number; onChange: (seconds: number) => void; className?: string }) {
  const known = OPTIONS.some(([s]) => s === value);
  return (
    <Select aria-label="Forget secrets after" className={className ?? "w-44"} value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
      {!known && <option value={String(value)}>{label(value)}</option>}
      {OPTIONS.map(([s, text]) => <option key={s} value={String(s)}>{text}</option>)}
    </Select>
  );
}
