import { createContext, useContext, useState } from "react";
import { api, type Meta } from "./api";
import { applyTheme, initialTheme, useAsync, useRoute } from "./hooks";
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

export function App() {
  const route = useRoute();
  const meta = useAsync(() => api.meta(), []);
  const [theme, setTheme] = useState(initialTheme);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  const sessionMatch = /^\/session\/([^/]+)(\/files)?$/.exec(route.path);
  const section = sessionMatch ? "/" : route.path;

  let page;
  if (sessionMatch) {
    page = <SessionPage id={decodeURIComponent(sessionMatch[1]!)} tab={sessionMatch[2] ? "files" : "timeline"} params={route.params} />;
  } else if (route.path === "/risks") page = <RisksPage />;
  else if (route.path === "/costs") page = <CostsPage />;
  else page = <SessionsPage />;

  return (
    <MetaContext.Provider value={meta.data}>
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center gap-6 border-b border-line bg-panel px-4 py-2">
          <a href="#/" className="flex items-center gap-2 font-semibold">
            <span aria-hidden>🛫</span> Flight Recorder
          </a>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <a
                key={n.path}
                href={`#${n.path}`}
                className={`rounded px-2.5 py-1 ${section === n.path ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            <span title="Nothing leaves this machine">100% local</span>
            {meta.data && <span>v{meta.data.version}</span>}
            <button type="button" onClick={toggleTheme} className="rounded border border-line px-2 py-1 hover:text-fg" title="Toggle light/dark">
              {theme === "dark" ? "☀ Light" : "☾ Dark"}
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{page}</main>
      </div>
    </MetaContext.Provider>
  );
}
