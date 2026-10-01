import { useMemo, useState, type ReactNode } from "react";
import { BLOCK_REASONS, batchExpiry, evaluate, formatClock } from "./engine";
import { store, useStore, localOccupancy, type State } from "./store";
import type { BlockCode, Gate, Permit } from "./types";
import {
  BlockTag,
  STATUS_LABEL,
  StatusPill,
  batchStateText,
  fmtRange,
  materialInfo,
  personName,
} from "./ui";
import "./styles.css";

const GATE_EV_LABEL: Record<string, string> = {
  ENTER: "进入",
  EXIT: "离开",
  EDIT_NOTE: "改备注",
  ENQUEUE: "排队",
};

function Header({ s }: { s: State }) {
  const pendingGates = s.gates.filter((g) => g.journal.some((e) => !e.ack)).length;
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">hxwl-09 · 洁净室互锁门禁联动</p>
        <h1>人员 · 房间 · 物料 · 灭菌有效期 · 通行许可 一体化外门控制</h1>
        <p className="subtitle">
          互锁通道同时只允许一组人员进入；物料过期 / 压差不合格停在外门并写明原因；门控离线冻结快照，
          回传按许可编号合并、同字段两版待班长裁决、按批次断点重试。
        </p>
        <div className="hero-controls">
          <span className="clock">🕒 {formatClock(s.now)}</span>
          <button onClick={() => store.tick(30)}>推进 30 分钟</button>
          <button onClick={() => store.tick(70)}>推进 70 分钟（看许可/物料超时）</button>
          <button
            className={s.linkDown ? "danger-btn active" : "danger-btn"}
            onClick={() => store.toggleLink()}
            title="模拟回传链路故障，用于验证按批次重试"
          >
            回传链路：{s.linkDown ? "中断" : "正常"}
          </button>
        </div>
      </div>
      <div className="stack-card">
        <span>当前待回传门控</span>
        <strong>{pendingGates} 个门有待确认流水</strong>
        <button className="primary-action" onClick={() => store.syncAllPending()}>
          回传全部未完成的门
        </button>
        <span className="hint">已完成的门不会被重复回传</span>
      </div>
    </section>
  );
}

function Metrics({ s }: { s: State }) {
  const inside = s.permits.filter((p) => p.status === "used").length;
  const queued = s.queue.length;
  const blocked = s.permits.filter(
    (p) => p.lastBlock && p.status !== "used" && p.status !== "exited"
  ).length;
  const conflicts = s.conflicts.filter((c) => !c.resolved).length;
  const cards: { label: string; value: number; cls: string }[] = [
    { label: "通道内在内人员组", value: inside, cls: "ok" },
    { label: "待处理队列", value: queued, cls: "warn" },
    { label: "最近被阻挡许可", value: blocked, cls: "danger" },
    { label: "字段冲突待裁决", value: conflicts, cls: "danger" },
  ];
  return (
    <section className="metrics-grid">
      {cards.map((c) => (
        <article className="metric-card" key={c.label}>
          <span>{c.label}</span>
          <strong>{c.value}</strong>
          <i className={`dot ${c.cls}`} />
        </article>
      ))}
    </section>
  );
}

function ChannelPanel({ s }: { s: State }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>房间 / 门控</p>
          <h2>互锁通道状态</h2>
        </div>
      </div>
      <div className="channel-list">
        {s.channels.map((c) => {
          const gate = s.gates.find((g) => g.id === c.gateId)!;
          const rule = s.rules.find((r) => r.channelId === c.id)!;
          const pressureOk = c.pressurePa >= rule.minPa;
          const occ = gate.online
            ? c.occupiedByPermitId
            : localOccupancy(gate);
          return (
            <article className="channel-card" key={c.id}>
              <header>
                <h3>{c.id} · {c.name}</h3>
                <span className={`pill ${gate.online ? "ok" : "danger"}`}>
                  {gate.id} {gate.online ? "在线" : "离线"}
                </span>
              </header>
              <div className="kv-grid">
                <div>
                  <span>实时压差</span>
                  <strong className={pressureOk ? "ok-text" : "danger-text"}>
                    {c.pressurePa}Pa
                  </strong>
                  <em>规则 {rule.id}（v{rule.version}）≥ {rule.minPa}Pa</em>
                </div>
                <div>
                  <span>互锁占用</span>
                  <strong>{occ ? occ : "空闲"}</strong>
                  <em>{occ ? "外门互锁锁定，他组排队" : "可进入一组"}</em>
                </div>
                <div className="span2">
                  <span>未结异常</span>
                  {c.openAnomaly ? (
                    <strong className="danger-text">{c.openAnomaly.reason}</strong>
                  ) : (
                    <strong className="ok-text">无</strong>
                  )}
                </div>
              </div>
              <div className="row-actions">
                <label className="inline">
                  压差模拟
                  <input
                    type="number"
                    defaultValue={c.pressurePa}
                    style={{ width: 80 }}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v)) store.setPressure(c.id, v);
                    }}
                  />Pa
                </label>
                <button onClick={() => store.adjustRule(c.id, rule.minPa + 2)}>
                  规则上调 +2Pa（已签发许可失效）
                </button>
                {c.openAnomaly && (
                  <button onClick={() => store.resolveAnomaly(c.id)}>
                    关闭未结异常并复检队列
                  </button>
                )}
                <button
                  className={gate.online ? "" : "primary-action"}
                  onClick={() => store.setGateOnline(gate.id, !gate.online)}
                >
                  {gate.online ? "断开门控（模拟离线）" : "恢复门控链路"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function BatchPanel({ s }: { s: State }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>灭菌有效期 / 压差规则</p>
          <h2>批次与规则调整（调整即令已签发许可失效）</h2>
        </div>
      </div>
      <div className="batch-grid">
        {Object.values(s.batches).map((b) => {
          const expired = s.now > batchExpiry(b) && !b.revoked;
          return (
            <article key={b.id} className="batch-card">
              <h3>{b.id}</h3>
              <p className={b.revoked || expired ? "danger-text" : "ok-text"}>
                {b.revoked ? "批次已作废" : expired ? "已超过灭菌有效期" : "灭菌有效期内"}
              </p>
              <p className="muted-text">{batchStateText(s, b.id)}</p>
              <p className="muted-text">灭菌 {formatClock(b.sterilizedAt)} · 有效期 {b.validHours}h</p>
              <div className="row-actions">
                <button onClick={() => store.adjustBatch(b.id, { validHours: Math.max(6, b.validHours - 12) })}>
                  缩短有效期 12h
                </button>
                {!b.revoked && (
                  <button className="danger-btn" onClick={() => store.adjustBatch(b.id, { revoked: true })}>
                    作废旧批次
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function IssueBox({ s }: { s: State }) {
  const [channelId, setChannelId] = useState(s.channels[0].id);
  const [picks, setPicks] = useState<string[]>([]);
  const [mats, setMats] = useState<string[]>([]);
  const toggle = (id: string, list: string[], setter: (v: string[]) => void) =>
    setter(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <section className="panel issue-box">
      <div className="section-heading">
        <div>
          <p>签发通行许可</p>
          <h2>新建许可（绑定当前规则版本与批次修订号）</h2>
        </div>
      </div>
      <div className="issue-grid">
        <label>
          <span>互锁通道</span>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {s.channels.map((c) => (
              <option key={c.id} value={c.id}>{c.id} {c.name}</option>
            ))}
          </select>
        </label>
        <div>
          <span>人员（一组）</span>
          <div className="pick-row">
            {s.people.map((p) => (
              <button
                key={p.id}
                className={picks.includes(p.id) ? "picked" : p.certified ? "" : "disabled-person"}
                onClick={() => toggle(p.id, picks, setPicks)}
                title={p.certified ? p.team : `${p.name} 洁净资质失效`}
              >
                {p.name}{!p.certified && "（资质失效）"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span>携带物料</span>
          <div className="pick-row">
            {s.materials.map((m) => (
              <button
                key={m.id}
                className={mats.includes(m.id) ? "picked" : ""}
                onClick={() => toggle(m.id, mats, setMats)}
              >
                {m.name} · {m.batchId}
              </button>
            ))}
          </div>
        </div>
        <button
          className="primary-action"
          disabled={picks.length === 0}
          onClick={() => {
            store.issuePermit(channelId, picks, mats);
            setPicks([]);
            setMats([]);
          }}
        >
          签发
        </button>
      </div>
    </section>
  );
}

function PermitRow({ s, p }: { s: State; p: Permit }) {
  const gate = s.gates.find((g) => g.channelId === p.channelId)!;
  const channel = s.channels.find((c) => c.id === p.channelId)!;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(p.note);
  const snap = gate.snapshot[p.id];
  // 操作页实时复检：阻挡原因与追溯记录同源（BLOCK_REASONS）
  const live = useMemo(() => {
    if (!gate.online) return null;
    return evaluate({
      now: s.now,
      permit: p,
      channel,
      gate,
      people: s.people,
      materials: s.materials,
      batches: s.batches,
      pressureRule: s.rules.find((r) => r.channelId === p.channelId)!,
      queue: s.queue,
    });
  }, [gate, channel, p, s]);

  const queued = s.queue.some((q) => q.permitId === p.id);

  return (
    <article className="permit-card">
      <header>
        <div>
          <h3>{p.id}</h3>
          <span className="muted-text">{p.channelId} · {fmtRange(p)}</span>
        </div>
        <StatusPill status={p.status} />
      </header>
      <div className="permit-body">
        <div>
          <span>人员</span>
          <p>
            {p.personIds.map((id) => {
              const pe = s.people.find((x) => x.id === id)!;
              return (
                <span key={id} className={pe.certified ? "" : "danger-text"} title={pe.certified ? "" : "资质失效"}>
                  {pe.name}
                </span>
              );
            }).reduce<ReactNode[]>((acc, el, i) => {
              if (i) acc.push("、");
              acc.push(el);
              return acc;
            }, [])}
          </p>
        </div>
        <div>
          <span>物料 / 灭菌有效期</span>
          {p.materialIds.length === 0 ? (
            <p className="muted-text">未携带</p>
          ) : (
            <ul className="mat-list">
              {p.materialIds.map((mid) => {
                const info = materialInfo(s, mid);
                if (!info) return null;
                const bad = info.b.revoked || s.now > batchExpiry(info.b);
                return (
                  <li key={mid} className={bad ? "danger-text" : ""}>
                    {info.m.name}（{info.b.id}，{batchStateText(s, info.b.id)}）
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <span>备注（离线时双方可改 → 回传比对）</span>
          {editing ? (
            <div className="note-edit">
              <input value={note} onChange={(e) => setNote(e.target.value)} />
              <button onClick={() => { store.editNote(p.id, note); setEditing(false); }}>保存{gate.online ? "" : "到门控本地"}</button>
            </div>
          ) : (
            <p onClick={() => { setNote(p.note); setEditing(true); }} className="note">
              {p.note || <em className="muted-text">点击添加备注</em>} ✎
            </p>
          )}
          {!gate.online && snap && (
            <p className="muted-text">离线快照状态：{STATUS_LABEL[snap.status].text}
              {p.note !== snap.note && p.note !== "" && "（与中央版本不同）"}
            </p>
          )}
        </div>
        <div className="decision-cell">
          <span>外门判定</span>
          {gate.online ? (
            live?.outcome === "allow" ? (
              <span className="pill ok">允许开外门</span>
            ) : live ? (
              <BlockTag code={live.code} detail={live.detail} />
            ) : (
              <StatusPill status={p.status} />
            )
          ) : (
            <span className="muted-text">
              门控离线中，刷卡由本地冻结快照判定
              {snap ? `（快照：${STATUS_LABEL[snap.status].text}）` : "（无此许可快照）"}
            </span>
          )}
          {queued && <span className="pill warn">在待处理队列</span>}
          {p.enteredOffline && <span className="pill info">离线进入·已标记</span>}
        </div>
      </div>
      <div className="row-actions">
        <button className="primary-action" onClick={() => store.swipe(p.id)}>
          {p.status === "issued" || p.status === "reconfirm" ? "外门刷卡进入" : "再次刷卡（验证不可重复开门）"}
        </button>
        {(p.status === "used") && (
          <button onClick={() => store.exit(p.id)}>登记离开（释放互锁）</button>
        )}
        {p.status === "reconfirm" && (
          <button onClick={() => store.reconfirm(p.id)}>按新规则重新确认</button>
        )}
      </div>
      {p.status === "reconfirm" && p.reconfirmFailReason && (
        <p className="inline-warn">{p.reconfirmFailReason}，未通过前不能进入</p>
      )}
    </article>
  );
}

function PermitList({ s }: { s: State }) {
  const byChannel = s.channels.map((c) => ({
    channel: c,
    permits: s.permits.filter((p) => p.channelId === c.id),
  }));
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>操作页</p>
          <h2>通行许可与外门操作</h2>
        </div>
      </div>
      {byChannel.map(({ channel, permits }) => (
        <div key={channel.id} className="permit-group">
          <h3 className="group-title">{channel.id} {channel.name}</h3>
          {permits.map((p) => (
            <PermitRow key={p.id} s={s} p={p} />
          ))}
        </div>
      ))}
    </section>
  );
}

function QueuePanel({ s }: { s: State }) {
  return (
    <section className="panel queue-panel">
      <div className="section-heading">
        <div>
          <p>通道满载 / 异常未结</p>
          <h2>待处理队列（操作页与追溯同一阻挡原因）</h2>
        </div>
      </div>
      {s.queue.length === 0 ? (
        <p className="muted-text">队列为空</p>
      ) : (
        s.queue.map((q) => {
          const p = s.permits.find((x) => x.id === q.permitId)!;
          const channel = s.channels.find((c) => c.id === q.channelId)!;
          const gate = s.gates.find((g) => g.channelId === q.channelId)!;
          const d = evaluate({
            now: s.now,
            permit: p,
            channel,
            gate,
            people: s.people,
            materials: s.materials,
            batches: s.batches,
            pressureRule: s.rules.find((r) => r.channelId === q.channelId)!,
            queue: s.queue,
            alreadyQueued: true,
          });
          return (
            <article key={q.permitId} className="queue-card">
              <div>
                <strong>{q.permitId}</strong>
                <span className="muted-text"> {q.channelId} · 排队于 {formatClock(q.queuedAt)}</span>
              </div>
              {d.outcome === "allow" ? (
                <span className="pill ok">条件已解除，等待互锁释放自动放行</span>
              ) : (
                <BlockTag code={d.code} detail={d.detail} />
              )}
            </article>
          );
        })
      )}
    </section>
  );
}

function GateJournal({ gate }: { gate: Gate }) {
  const unacked = gate.journal.filter((e) => !e.ack);
  return (
    <article className="journal-card">
      <header>
        <h3>{gate.id} · {gate.channelId}</h3>
        <span className={`pill ${gate.online ? "ok" : "danger"}`}>
          {gate.online ? "在线" : `离线 · ${unacked.length} 条待回传`}
        </span>
      </header>
      {unacked.length === 0 ? (
        <p className="muted-text">无待确认流水{gate.lastSyncAt ? `（最后同步 ${formatClock(gate.lastSyncAt)}）` : ""}</p>
      ) : (
        <ul className="journal-list">
          {unacked.map((e) => (
            <li key={e.seq}>
              <code>#{e.seq}</code>
              <span>{formatClock(e.at)}</span>
              <span>{GATE_EV_LABEL[e.type]} {e.permitId}</span>
              {"localBlock" in e && e.localBlock && (
                <BlockTag code={e.localBlock} detail={e.detail} />
              )}
              {"code" in e && e.type === "ENQUEUE" && (
                <BlockTag code={e.code} detail={e.detail} />
              )}
              {e.type === "EDIT_NOTE" && <span className="muted-text">「{e.value}」</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="row-actions">
        <button onClick={() => store.syncGate(gate.id)} disabled={unacked.length === 0}>
          回传该门（按批次断点重试）
        </button>
      </div>
    </article>
  );
}

function SyncPanel({ s }: { s: State }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>断网门控回传</p>
          <h2>门控流水与回传批次</h2>
        </div>
      </div>
      <div className="journal-grid">
        {s.gates.map((g) => (
          <GateJournal key={g.id} gate={g} />
        ))}
      </div>
      <h3 className="group-title">回传批次</h3>
      {s.syncBatches.length === 0 ? (
        <p className="muted-text">尚无回传批次。可先断开某门控、刷卡操作，再制造回传失败。</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>批次</th><th>门</th><th>尝试</th><th>进度</th><th>状态</th><th>说明</th></tr>
          </thead>
          <tbody>
            {s.syncBatches.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{b.gateId}</td>
                <td>{b.attempts}</td>
                <td>{b.doneSeqs.length}/{b.total}</td>
                <td>
                  <span className={`pill ${b.status === "done" ? "ok" : b.status === "partial" ? "warn" : "danger"}`}>
                    {b.status === "done" ? "完成" : b.status === "partial" ? "部分完成" : b.status === "failed" ? "失败待重试" : b.status}
                  </span>
                </td>
                <td className="muted-text">{b.lastError || "仅补未确认流水，已进入的通行不会再次开门"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ConflictPanel({ s }: { s: State }) {
  const open = s.conflicts.filter((c) => !c.resolved);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>同字段双方都改过</p>
          <h2>冲突裁决（两版保留，班长裁定）</h2>
        </div>
      </div>
      {open.length === 0 ? (
        <p className="muted-text">无待裁决冲突</p>
      ) : (
        open.map((c) => (
          <article key={c.id} className="conflict-card">
            <h3>{c.id} · 许可 {c.permitId} · 字段「备注」</h3>
            <div className="conflict-versions">
              <div>
                <span>中央版</span>
                <p>{c.centerValue || <em className="muted-text">空</em>}</p>
                <button onClick={() => store.resolveConflict(c.id, "center")}>保留中央版</button>
              </div>
              <div>
                <span>{c.gateId} 门控版（离线编辑）</span>
                <p>{c.gateValue || <em className="muted-text">空</em>}</p>
                <button onClick={() => store.resolveConflict(c.id, "gate")}>保留门控版</button>
              </div>
            </div>
          </article>
        ))
      )}
      {s.conflicts.some((c) => c.resolved) && (
        <>
          <h3 className="group-title">已裁决</h3>
          <ul className="resolved-list">
            {s.conflicts.filter((c) => c.resolved).map((c) => (
              <li key={c.id}>{c.id} · {c.permitId} → 采用{c.resolved === "center" ? "中央版" : "门控版"}（{formatClock(c.resolvedAt!)}）</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AuditTrail({ s }: { s: State }) {
  const [onlyBlock, setOnlyBlock] = useState(false);
  const rows = onlyBlock
    ? s.audit.filter((a) => a.level === "block" || a.level === "queue")
    : s.audit;
  return (
    <section className="panel audit-panel">
      <div className="section-heading">
        <div>
          <p>追溯记录</p>
          <h2>操作与阻挡审计（与操作页同源文案）</h2>
        </div>
        <button onClick={() => setOnlyBlock(!onlyBlock)}>
          {onlyBlock ? "显示全部" : "只看阻挡/排队"}
        </button>
      </div>
      <ul className="audit-list">
        {rows.map((a) => (
          <li key={a.id} className={`lvl-${a.level}`}>
            <code>{formatClock(a.at)}</code>
            <span className={`audit-dot lvl-${a.level}`} />
            <span>{a.text}</span>
            {a.code && (
              <span className="audit-code">{BLOCK_REASONS[a.code as BlockCode].label}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function App() {
  const s = useStore((x) => x);
  return (
    <main className="app-shell">
      <Header s={s} />
      <Metrics s={s} />
      <ChannelPanel s={s} />
      <BatchPanel s={s} />
      <IssueBox s={s} />
      <PermitList s={s} />
      <QueuePanel s={s} />
      <SyncPanel s={s} />
      <ConflictPanel s={s} />
      <AuditTrail s={s} />
      <footer className="foot">
        规则引擎：{Object.keys(BLOCK_REASONS).length} 类阻挡原因统一字典 · 外门判定 evaluate() ·
        回传合并 mergeEvent() · 指纹版本：压差规则 version + 灭菌批次 revision
      </footer>
    </main>
  );
}

export default App;
