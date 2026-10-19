import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "mcp-hub-theme";

function apply(t: Theme): void {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function initTheme(): Theme {
  const t = (localStorage.getItem(KEY) as Theme | null) ?? "system";
  apply(t);
  return t;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme | null) ?? "system");
  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => apply("system");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [theme]);
  return [
    theme,
    (t) => {
      localStorage.setItem(KEY, t);
      setThemeState(t);
    },
  ];
}
