import { createContext, useContext, useState } from "react";
import { api, type Meta } from "./api";
import { Icon, Logo } from "./components/icons";
import { applyTheme, initialTheme, useAsync, useRoute, useSystemThemeSync, type ThemePref } from "./hooks";
import { CostsPage } from "./pages/CostsPage";
import { RisksPage } from "./pages/RisksPage";
import { SessionPage } from "./pages/SessionPage";
import { SessionsPage } from "./pages/SessionsPage";

const MetaContext = createContext<Meta | undefined>(undefined);
export const useMeta = () => useContext(MetaContext);

const NAV = [
  { path: "/", label: "Sessions" },
  { path: "/risks", label: "Risks" },
  { path: "/costs", label: "Costs" },
];

/** A malformed escape (#/session/%E0%A4%A) must not throw during render and blank the app. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function App() {
  const route = useRoute();
  const meta = useAsync(() => api.meta(), []);
  const [theme, setTheme] = useState<ThemePref>(initialTheme);
  useSystemThemeSync(theme);
  const changeTheme = (t: ThemePref) => {
    applyTheme(t);
    setTheme(t);
  };

  const sessionMatch = /^\/session\/([^/]+)(?:\/(files|claims))?$/.exec(route.path);
  const section = sessionMatch ? "/" : route.path;

  let page;
  if (sessionMatch) {
    page = <SessionPage id={safeDecode(sessionMatch[1]!)} tab={sessionMatch[2] === "files" ? "files" : sessionMatch[2] === "claims" ? "claims" : "timeline"} params={route.params} />;
  } else if (route.path === "/risks") page = <RisksPage />;
  else if (route.path === "/costs") page = <CostsPage />;
  else page = <SessionsPage />;

  return (
    <MetaContext.Provider value={meta.data}>
      <div className="flex h-full flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-surface focus:px-3 focus:py-1.5">
          Skip to content
        </a>
        <header className="flex h-12 shrink-0 items-center gap-6 border-b border-line bg-surface px-5">
          <a href="#/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
            <Logo />
            <span>Afteraction</span>
          </a>
          <nav aria-label="Main" className="flex h-full items-stretch gap-1">
            {NAV.map((n) => {
              const active = section === n.path;
              return (
                <a
                  key={n.path}
                  href={`#${n.path}`}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center px-2.5 text-sm transition-colors duration-150 ${
                    active ? "text-fg" : "text-muted hover:text-fg"
                  }`}
                >
                  {n.label}
                  {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
                </a>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5" title="Nothing leaves this machine: no telemetry, no network calls">
              <Icon.Lock className="size-3.5 text-ok" />
              Local only
            </span>
            {meta.data && <span className="num font-mono">v{meta.data.version}</span>}
            <label className="relative inline-flex items-center">
              <span className="sr-only">Theme</span>
              <select
                value={theme}
                onChange={(e) => changeTheme(e.target.value as ThemePref)}
                className="h-7 cursor-pointer appearance-none rounded-control bg-transparent pr-6 pl-2 text-xs text-fg-2 outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="system">System theme</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
              <Icon.ChevronDown className="pointer-events-none absolute right-1.5 size-3.5" />
            </label>
          </div>
        </header>
        <main id="main" className="min-h-0 flex-1 overflow-hidden">{page}</main>
      </div>
    </MetaContext.Provider>
  );
}
