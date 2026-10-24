import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

/** Run an async loader whenever `deps` change; ignores results from stale runs. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, error: undefined, loading: false }),
      (error: unknown) => live && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Current location hash route, e.g. "#/session/abc?e=12" → { path: "/session/abc", params }. */
export function useRoute(): { path: string; params: URLSearchParams } {
  const read = () => {
    const h = window.location.hash.replace(/^#/, "") || "/";
    const [path, query = ""] = h.split("?");
    return { path: path || "/", params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(path: string, replace = false): void {
  const url = `#${path}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.location.hash = path;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const THEME_KEY = "afteraction-theme";

export type ThemePref = "system" | "light" | "dark";

export function initialTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

/** Apply a theme preference; "system" follows the OS and keeps following it. */
export function applyTheme(pref: ThemePref): void {
  document.documentElement.classList.toggle("dark", pref === "dark" || (pref === "system" && systemDark()));
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // storage unavailable: theme just won't persist
  }
}

export function useSystemThemeSync(pref: ThemePref): void {
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, [pref]);
}
