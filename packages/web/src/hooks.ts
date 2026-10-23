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

const THEME_KEY = "flightrec-theme";

export function initialTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage unavailable: theme just won't persist
  }
}
