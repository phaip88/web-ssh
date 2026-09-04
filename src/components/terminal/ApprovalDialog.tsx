"use client";
import { useState } from "react";
import { Badge, Button, Dialog, Input } from "@/components/ui";
import { riskColor } from "@/lib/client/api";
import { useT } from "@/lib/client/i18n";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  runId: string;
  summary: string;
  risk: string;
  details: { tool?: string; input?: Record<string, unknown>; command?: string | null; environment?: string; findings?: { code: string; message: string; risk: string }[]; user?: string; rollback?: string };
  hostName: string;
}

export function ApprovalDialog({ approval, onDecide, busy }: { approval: PendingApproval | null; onDecide: (decision: "approved" | "rejected", note?: string) => void; busy: boolean }) {
  const t = useT();
  const [note, setNote] = useState("");
  if (!approval) return null;
  const d = approval.details;
  const prod = d.environment === "production";
  return (
    <Dialog open onClose={() => undefined} title={<span className="flex items-center gap-2">{t("approvalRequired")} <Badge className={riskColor(approval.risk)}>{approval.risk}</Badge>{prod && <Badge className="border-danger bg-danger/20 text-danger">{t("production")}</Badge>}</span>} wide>
      <div className="space-y-3 text-sm">
        <dl className="grid grid-cols-[140px_1fr] gap-y-1.5">
          <dt className="text-muted">{t("targetHost")}</dt>
          <dd className={prod ? "font-semibold text-danger" : ""}>{approval.hostName} <span className="text-muted">({d.environment})</span></dd>
          <dt className="text-muted">{t("user")}</dt>
          <dd>{d.user}</dd>
          <dt className="text-muted">Tool</dt>
          <dd className="mono">{d.tool}</dd>
          <dt className="text-muted">{t("command")}</dt>
          <dd><pre className="mono overflow-x-auto rounded border border-border bg-panel-2 p-2 text-xs">{d.command ?? JSON.stringify(d.input, null, 2)}</pre></dd>
          <dt className="text-muted">{t("workingDir")}</dt>
          <dd className="mono text-muted">login shell default (non-interactive exec channel)</dd>
          <dt className="text-muted">{t("impact")}</dt>
          <dd>
            {d.findings?.length ? (
              <ul className="space-y-1">
                {d.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs"><Badge className={riskColor(f.risk)}>{f.risk}</Badge><span><span className="mono">{f.code}</span> – {f.message}</span></li>
                ))}
              </ul>
            ) : <span className="text-muted">No policy findings – classified as {approval.risk}.</span>}
          </dd>
          <dt className="text-muted">{t("rollback")}</dt>
          <dd className="text-xs">{d.rollback}</dd>
        </dl>
        <Input placeholder="Decision note (optional, audited)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onDecide("rejected", note || undefined)}>{t("reject")}</Button>
          <Button variant={approval.risk === "R4" || prod ? "danger" : "primary"} disabled={busy} onClick={() => onDecide("approved", note || undefined)}>{busy ? "…" : t("approve")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
