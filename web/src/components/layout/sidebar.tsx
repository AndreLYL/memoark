import { useState } from "react";
import { NavLink } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Clock, Download, Share2, Layers, Search } from "lucide-react";
import { api } from "../../api/client";

export const SIDEBAR_NAV_ITEMS = [
  { to: "/", label: "Dashboard", Icon: LayoutDashboard },
  { to: "/timeline", label: "Timeline", Icon: Clock },
  { to: "/fetch", label: "Fetch", Icon: Download },
  { to: "/graph", label: "Graph", Icon: Share2 },
  { to: "/entities", label: "All Entities", Icon: Layers },
  { to: "/search", label: "Search", Icon: Search },
];

export const SIDEBAR_FOOTER_ITEMS = [{ to: "/config", label: "Settings", icon: "⚙" }] as const;

const CATEGORIES = [
  { label: "People", type: "person", color: "var(--color-person)" },
  { label: "Projects", type: "project", color: "var(--color-project)" },
  { label: "Decisions", type: "decision", color: "var(--color-decision)" },
  { label: "Knowledge", type: "knowledge", color: "var(--color-knowledge)" },
  { label: "Tasks", type: "task", color: "var(--color-task)" },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
    isActive
      ? "bg-accent-muted/20 text-accent"
      : "text-fg-muted hover:text-fg-default hover:bg-bg-overlay"
  }`;
}

function footerNavLinkClass({ isActive }: { isActive: boolean }) {
  return `flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
    isActive
      ? "bg-accent-muted/20 text-accent"
      : "text-fg-subtle hover:text-fg-default hover:bg-bg-overlay"
  }`;
}

export function Sidebar() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.dataset.theme === "dark",
  );
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 30000,
  });

  const typeCount = (type: string) => {
    if (!stats?.pages_by_type) return 0;
    if (type === "knowledge") {
      return Object.entries(stats.pages_by_type)
        .filter(([t]) => t === "knowledge" || t === "concept" || t.startsWith("discovery-"))
        .reduce((sum, [, count]) => sum + count, 0);
    }
    return stats.pages_by_type[type] ?? 0;
  };

  return (
    <nav className="w-[200px] shrink-0 bg-bg-inset border-r border-border-default flex flex-col min-h-screen">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold text-fg-default bg-accent-muted">
          M
        </div>
        <span className="text-sm font-semibold text-fg-default">Memkin</span>
      </div>

      <div className="px-2 space-y-0.5">
        {SIDEBAR_NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navLinkClass}>
            <item.Icon size={16} strokeWidth={1.75} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div className="px-4 mt-6">
        <div className="text-[10px] uppercase tracking-widest text-fg-subtle mb-2">Categories</div>
        <div className="space-y-1">
          {CATEGORIES.map((cat) => (
            <NavLink
              key={cat.type}
              to={`/search?type=${cat.type}`}
              className="flex items-center justify-between px-2 py-1 rounded text-sm text-fg-muted hover:text-fg-default hover:bg-bg-overlay transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                <span>{cat.label}</span>
              </div>
              <span className="text-xs text-fg-subtle">{typeCount(cat.type)}</span>
            </NavLink>
          ))}
        </div>
      </div>

      <div className="px-4 mt-6">
        <div className="text-[10px] uppercase tracking-widest text-fg-subtle mb-2">Sources</div>
        <div className="space-y-1">
          {health?.sources.map((src) => (
            <div key={src.name} className="flex items-center justify-between px-2 py-1 text-sm text-fg-muted">
              <span>{src.name}</span>
              <span className={src.status === "healthy" ? "text-decision" : src.status === "error" ? "text-task" : "text-fg-subtle"}>
                {src.status === "healthy" ? "✓" : src.status === "error" ? "✗" : "—"}
              </span>
            </div>
          ))}
          {(!health?.sources || health.sources.length === 0) && (
            <div className="text-xs text-fg-subtle px-2">No sources configured</div>
          )}
        </div>
      </div>

      <div className="flex-1" />

      <div className="px-2 pb-4 space-y-0.5">
        <button
          type="button"
          onClick={() => {
            const next =
              document.documentElement.dataset.theme === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = next;
            localStorage.setItem("memkin-theme", next);
            setIsDark(next === "dark");
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-fg-subtle hover:text-fg-default rounded-md hover:bg-bg-overlay transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span>{isDark ? "☀" : "☾"}</span>
          <span>{isDark ? "Light mode" : "Dark mode"}</span>
        </button>
        {SIDEBAR_FOOTER_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} end className={footerNavLinkClass}>
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
