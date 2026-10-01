import { useMemo, useReducer, useState } from "react";
import "./styles.css";
import { initialState } from "./seed";
import { reducer } from "./store";
import { OpsPanel, PermitsPanel, QueuePanel } from "./panels-ops";
import { AuditPanel, OfflinePanel } from "./panels-offline";
import type { ReasonCode } from "./types";
import { reasonText } from "./domain";
import { Badge } from "./ui";

const TABS = [
  { id: "ops", label: "门禁操作页" },
  { id: "permits", label: "许可 / 物料 / 规则" },
  { id: "offline", label: "离线门控与回传" },
  { id: "queue", label: "待处理队列" },
  { id: "audit", label: "追溯记录" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function Metric({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={`tone-${tone}`} />
    </article>
  );
}

function App() {
  const [s, dispatch] = useReducer(reducer, undefined, initialState);
  const [tab, setTab] = useState<TabId>("ops");

  const waiting = s.queue.filter((q) => q.status === "waiting").length;
  const heldEvents = s.gateEvents.filter((e) => e.state === "held").length;
  const pendingEvents = s.gateEvents.filter((e) => e.state === "queued" || e.state === "held").length;
  const occupied = Object.values(s.occupancy).filter(Boolean).length;

  const lastBlock = useMemo(() => {
    const a = s.audit.find((x) => x.reasonCode);
    if (!a) return undefined;
    return { code: a.reasonCode as ReasonCode, text: a.reasonText ?? reasonText(a.reasonCode as ReasonCode) };
  }, [s.audit]);

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · port 5109</p>
          <h1>半导体洁净室门禁联动</h1>
          <p className="subtitle">
            人员组 · 房间 · 物料 · 灭菌有效期 · 通行许可 全链路联动；互锁通道同刻只进一组，
            物料过期 / 压差不合格停在外门；断网门控按许可编号合并、同字段两版留档等班长裁决。
          </p>
        </div>
        <div className="stack-card">
          <span>系统状态</span>
          <strong>
            <Badge kind={s.online ? "ok" : "danger"}>{s.online ? "在线" : "断网离线"}</Badge>
          </strong>
          <span className="dim">门控缓存：{s.gateCacheAt ?? "—"}</span>
          <button onClick={() => dispatch({ type: "RESET" })}>重置演示数据</button>
        </div>
      </section>

      <section className="metrics-grid">
        <Metric label="互锁通道占用" value={`${occupied}/${s.channels.length}`} tone={occupied ? "warn" : "ok"} />
        <Metric label="有效许可" value={s.permits.filter((p) => p.status === "active").length} tone="ok" />
        <Metric label="失效/冲突待处理" value={s.permits.filter((p) => p.status === "stale" || p.status === "conflict").length} tone="danger" />
        <Metric label="队列等待" value={waiting} tone={waiting ? "warn" : "ok"} />
        <Metric label="离线门事件待回传" value={pendingEvents} tone={pendingEvents ? "warn" : "ok"} />
      </section>

      {lastBlock && (
        <div className="global-banner">
          <span>⛔</span>
          <div>
            <strong>最近阻挡原因（操作页与追溯记录同源）</strong>
            <p>
              <code>{lastBlock.code}</code> {lastBlock.text}
            </p>
          </div>
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "queue" && waiting > 0 && <em className="tab-dot">{waiting}</em>}
            {t.id === "offline" && (heldEvents > 0 || pendingEvents > 0) && (
              <em className="tab-dot">{heldEvents || pendingEvents}</em>
            )}
          </button>
        ))}
      </nav>

      {tab === "ops" && <OpsPanel s={s} dispatch={dispatch} />}
      {tab === "permits" && <PermitsPanel s={s} dispatch={dispatch} />}
      {tab === "offline" && <OfflinePanel s={s} dispatch={dispatch} />}
      {tab === "queue" && <QueuePanel s={s} dispatch={dispatch} />}
      {tab === "audit" && <AuditPanel s={s} dispatch={dispatch} />}
    </main>
  );
}

export default App;
