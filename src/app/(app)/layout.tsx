"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client/api";
import { useI18n, useT, type Key } from "@/lib/client/i18n";
import { Badge } from "@/components/ui";

export interface Me {
  user: { id: string; email: string; displayName: string; isPlatformAdmin: boolean };
  env: string;
  organizations: { id: string; name: string; slug: string }[];
  workspaces: { id: string; name: string; slug: string; orgId: string; role: string | null; permissions: string[] }[];
}

const NAV: { href: string; key: Key; icon: string }[] = [
  { href: "/dashboard", key: "dashboard", icon: "▦" },
  { href: "/terminal", key: "terminal", icon: ">_" },
  { href: "/hosts", key: "hosts", icon: "🖧" },
  { href: "/credentials", key: "credentials", icon: "🔑" },
  { href: "/sessions", key: "sessions", icon: "⏺" },
  { href: "/providers", key: "providers", icon: "◈" },
  { href: "/audit", key: "audit", icon: "☰" },
  { href: "/settings", key: "settings", icon: "⚙" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(() => (typeof document === "undefined" ? true : document.documentElement.classList.contains("dark")));

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => router.replace("/login"));
  }, [router]);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };
  const isTerminal = pathname.startsWith("/terminal");

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={`${open ? "flex" : "hidden"} md:flex ${isTerminal ? "md:w-14" : "md:w-56"} absolute z-40 h-full w-56 flex-col border-r border-border bg-panel md:static`}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-3">
          <span className="mono rounded bg-accent px-1.5 py-0.5 text-xs font-bold text-white">&gt;_</span>
          {!isTerminal && <span className="truncate text-sm font-semibold">WebSSH Agent</span>}
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)} title={t(n.key)} className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${pathname.startsWith(n.href) ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel-2 hover:text-fg"}`}>
              <span className="mono w-5 text-center text-xs">{n.icon}</span>
              {(!isTerminal || open) && <span>{t(n.key)}</span>}
            </Link>
          ))}
        </nav>
        <div className="space-y-2 border-t border-border p-2 text-xs">
          {(!isTerminal || open) && me && (
            <div className="px-1">
              <div className="truncate font-medium">{me.user.displayName}</div>
              <div className="truncate text-muted">{me.user.email}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {me.workspaces.slice(0, 1).map((w) => (
                  <Badge key={w.id}>{w.role ?? "member"}</Badge>
                ))}
                {me.user.isPlatformAdmin && <Badge className="border-accent/40 text-accent">admin</Badge>}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-1 px-1">
            <button onClick={toggleTheme} className="rounded px-1.5 py-1 text-muted hover:bg-panel-2" title={t("theme")}>
              {dark ? "☾" : "☀"}
            </button>
            <button onClick={() => setLocale(locale === "en" ? "zh" : "en")} className="rounded px-1.5 py-1 text-muted hover:bg-panel-2" title={t("language")}>
              {locale === "en" ? "中" : "EN"}
            </button>
            <button onClick={logout} className="rounded px-1.5 py-1 text-muted hover:bg-panel-2" title={t("logout")}>
              ⎋
            </button>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2 md:hidden">
          <button onClick={() => setOpen((o) => !o)} className="rounded border border-border px-2 py-1 text-sm">
            ☰
          </button>
          <span className="text-sm font-semibold">WebSSH Agent</span>
        </header>
        <main className={`min-h-0 flex-1 ${isTerminal ? "overflow-hidden" : "overflow-auto p-4 md:p-6"}`}>{children}</main>
      </div>
    </div>
  );
}
