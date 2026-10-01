import type { Permit, PermitStatus, BlockCode } from "./types";
import { BLOCK_REASONS, batchExpiry, formatClock } from "./engine";
import type { State } from "./store";

export const STATUS_LABEL: Record<PermitStatus, { text: string; cls: string }> = {
  issued: { text: "有效", cls: "ok" },
  reconfirm: { text: "待重新确认", cls: "warn" },
  used: { text: "已进入", cls: "info" },
  exited: { text: "已离开", cls: "muted" },
  expired: { text: "已超时", cls: "danger" },
  voided: { text: "已吊销", cls: "danger" },
  conflict: { text: "冲突待裁决", cls: "danger" },
};

export function StatusPill({ status }: { status: PermitStatus }) {
  const s = STATUS_LABEL[status];
  return <span className={`pill ${s.cls}`}>{s.text}</span>;
}

export function BlockTag({ code, detail }: { code?: BlockCode; detail?: string }) {
  if (!code) return <span className="muted-text">—</span>;
  const r = BLOCK_REASONS[code];
  return (
    <div className={`block-tag ${r.kind === "wait" ? "wait" : "hard"}`}>
      <strong>{r.label}</strong>
      <span>{r.message(detail ?? "")}</span>
    </div>
  );
}

export function personName(s: State, id: string): string {
  return s.people.find((p) => p.id === id)?.name ?? id;
}

export function materialInfo(s: State, mid: string) {
  const m = s.materials.find((x) => x.id === mid);
  if (!m) return null;
  const b = s.batches[m.batchId];
  return { m, b };
}

export function fmtRange(p: Permit): string {
  return `${formatClock(p.validFrom)} – ${formatClock(p.validUntil)}`;
}

export function batchStateText(s: State, batchId: string): string {
  const b = s.batches[batchId];
  if (!b) return "未知批次";
  if (b.revoked) return `已作废（rev ${b.revision}）`;
  const expiry = batchExpiry(b);
  if (s.now > expiry) return `已过期（${formatClock(expiry)} 到期）`;
  return `有效至 ${formatClock(expiry)}（rev ${b.revision}）`;
}
