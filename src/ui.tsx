import type { ReactNode } from "react";

export function Card({
  title,
  extra,
  children,
  className = "",
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="section-heading">
          <h2>{title}</h2>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

const BADGE_CLS: Record<string, string> = {
  ok: "badge ok",
  warn: "badge warn",
  danger: "badge danger",
  muted: "badge muted",
};

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={BADGE_CLS[kind] ?? BADGE_CLS.muted}>{children}</span>;
}

export function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ReasonBanner({ code, text }: { code?: string; text?: string }) {
  if (!text) return null;
  return (
    <div className="reason-banner">
      <span className="reason-icon">⛔</span>
      <div>
        <strong>阻挡原因（操作页 · 队列 · 追溯同源）</strong>
        <p>{text}</p>
        <code>{code}</code>
      </div>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="empty-hint">{text}</p>;
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}
