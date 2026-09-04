"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client/api";
import { Button, ErrorText, Input, Label } from "@/components/ui";
import { useT } from "@/lib/client/i18n";

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-panel p-6 shadow-xl">
      <div className="flex items-center gap-2">
        <span className="mono rounded bg-accent px-1.5 py-0.5 text-xs font-bold text-white">&gt;_</span>
        <h1 className="text-lg font-semibold">WebSSH Agent Console</h1>
      </div>
      <div>
        <Label>{t("email")}</Label>
        <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div>
        <Label>{t("password")}</Label>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "…" : t("login")}
      </Button>
      <p className="text-center text-[11px] text-muted">Sessions use HttpOnly SameSite cookies. MFA/SSO are enforced by your organisation policy.</p>
      {process.env.NEXT_PUBLIC_SHOW_DEMO_HINT !== "false" && (
        <p className="rounded border border-border bg-panel-2 p-2 text-[11px] text-muted">
          Dev seed accounts: <span className="mono">admin@example.com / ChangeMe-Admin-2026</span>, <span className="mono">dev@example.com / ChangeMe-Dev-2026</span>
        </p>
      )}
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
