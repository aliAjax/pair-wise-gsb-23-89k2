import { useState } from "react";
import type { Action } from "./store";
import { channelName, groupName, roomName } from "./store";
import type { AppState, GateEvent } from "./types";
import { Badge, Card, Empty, Field } from "./ui";

type Dispatch = (a: Action) => void;

const EVENT_META: Record<string, { label: string; kind: string }> = {
  outer: { label: "外门刷卡", kind: "warn" },
  airlock: { label: "进入互锁", kind: "muted" },
  room: { label: "内门进入房间", kind: "ok" },
};

const STATE_META: Record<GateEvent["state"], { label: string; cls: string }> = {
  queued: { label: "待回传", cls: "warn" },
  held: { label: "冲突暂扣", cls: "danger" },
  acked: { label: "中心已确认", cls: "ok" },
  rejected: { label: "中心驳回", cls: "danger" },
};

function GateDoorControls({ s, dispatch }: { s: AppState; dispatch: Dispatch }) {
  const cache = s.gateCache;
  if (!cache) return <Empty text="门控未进入离线模式" />;
  return (
    <div className="gate-grid">
      {s.channels.map((ch) => {
        const occ = cache.occupancy[ch.id];
        const permit = occ ? cache.permits.find((p) => p.permitNo === occ.permitNo) : undefined;
        return (
          <div key={ch.id} className="gate-channel">
            <h4>{ch.name}</h4>
            <p className="dim">
              门控缓存状态：{occ ? `${groupName(cache, occ.groupId)}（${occ.stage === "airlock" ? "互锁中" : "已入房间"}）` : "空闲"}
            </p>
            <div className="row-actions">
              {occ?.outerOpen && (
                <button onClick={() => dispatch({ type: "GATE_AIRLOCK", channelId: ch.id })}>
                  门控：进入互锁（关外门）
                </button>
              )}
              {occ && !occ.outerOpen && occ.stage === "airlock" && permit?.status === "active" && (
                <button onClick={() => dispatch({ type: "GATE_ROOM", channelId: ch.id })}>
                  门控：开内门进入房间
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OfflinePanel({ s, dispatch }: { s: AppState; dispatch: Dispatch }) {
  const [permitNo, setPermitNo] = useState(s.permits[0].permitNo);
  const [gateNote, setGateNote] = useState("门控离线补登记");
  const [serverNote, setServerNote] = useState("中心调度改派");

  const queuedCount = s.gateEvents.filter((e) => e.state === "queued" || e.state === "held").length;
  const hasFailed = s.syncBatches.some((b) => b.state === "failed");

  return (
    <div className="panel-grid">
      <Card
        title="网络与门控缓存"
        extra={
          s.online ? (
            <button className="primary-action" onClick={() => dispatch({ type: "GO_OFFLINE" })}>
              模拟断网
            </button>
          ) : (
            <button className="primary-action" onClick={() => dispatch({ type: "GO_ONLINE" })}>
              网络恢复
            </button>
          )
        }
      >
        <div className="net-row">
          <Badge kind={s.online ? "ok" : "danger"}>{s.online ? "在线：门控直连中心" : "离线：门控按本地缓存判定"}</Badge>
          {s.gateCacheAt && <span className="dim">门控缓存快照时间：{s.gateCacheAt}</span>}
        </div>
        <p className="dim">
          离线期间门控按断网瞬间的快照判定物料有效期/压差/通道占用；所有门动作带许可编号入回传队列，按批次合并，中心复核后才真正核销。
        </p>
      </Card>

      <Card title="门控本地面板（断网时操作）">
        <Field label="许可编号">
          <select value={permitNo} onChange={(e) => setPermitNo(e.target.value)}>
            {s.permits.map((p) => (
              <option key={p.permitNo} value={p.permitNo}>
                {p.permitNo} · {groupName(s, p.groupId)} → {roomName(s, p.roomId)}
              </option>
            ))}
          </select>
        </Field>
        <div className="row-actions">
          <button className="primary-action" disabled={s.online} onClick={() => dispatch({ type: "GATE_OUTER", permitNo })}>
            门控刷卡开外门
          </button>
          <button disabled={s.online} onClick={() => dispatch({ type: "GATE_OUTER", permitNo, dup: true })}>
            模拟重复刷卡（验证不重复放行）
          </button>
        </div>
        <GateDoorControls s={s} dispatch={dispatch} />
      </Card>

      <Card title="断网期间双方改同一许可字段（按许可编号合并/冲突）">
        <Field label="许可编号">
          <select value={permitNo} onChange={(e) => setPermitNo(e.target.value)}>
            {s.permits.map((p) => (
              <option key={p.permitNo} value={p.permitNo}>
                {p.permitNo}
              </option>
            ))}
          </select>
        </Field>
        <div className="edit-grid">
          <div>
            <Field label="门控侧改「随行备注」">
              <input value={gateNote} onChange={(e) => setGateNote(e.target.value)} />
            </Field>
            <button disabled={s.online} onClick={() => dispatch({ type: "GATE_EDIT_PERMIT", permitNo, note: gateNote })}>
              门控侧保存
            </button>
          </div>
          <div>
            <Field label="中心侧改「随行备注」">
              <input value={serverNote} onChange={(e) => setServerNote(e.target.value)} />
            </Field>
            <button disabled={s.online} onClick={() => dispatch({ type: "SERVER_EDIT_PERMIT", permitNo, note: serverNote })}>
              中心侧保存
            </button>
          </div>
        </div>
        <p className="dim">双方各改且取值不同 → 回传时保留两版、许可挂“冲突待裁决”，整组门事件暂扣，等班长在下方裁决。</p>
      </Card>

      <Card
        title={`批次回传（待处理 ${queuedCount} 个门事件，每批 3 条）`}
        extra={
          <div className="row-actions">
            <button
              className={s.failNext ? "danger-btn" : ""}
              onClick={() => dispatch({ type: "TOGGLE_FAIL_NEXT" })}
            >
              {s.failNext ? "下一批：回传失败（已勾选）" : "勾选：模拟下批回传失败"}
            </button>
            <button
              className="primary-action"
              disabled={!s.online || queuedCount === 0}
              onClick={() => dispatch({ type: "SYNC_BATCH" })}
            >
              {hasFailed ? "重试失败批次（只补未完成门）" : "回传下一批（按许可编号合并）"}
            </button>
          </div>
        }
      >
        {s.syncBatches.length === 0 ? (
          <Empty text="还没有回传批次" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>批次</th>
                <th>状态</th>
                <th>尝试</th>
                <th>事件</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {s.syncBatches.map((b) => (
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td>
                    <Badge kind={b.state === "acked" ? "ok" : "danger"}>
                      {b.state === "acked" ? "已合并" : "失败待重试"}
                    </Badge>
                  </td>
                  <td>{b.attempts}</td>
                  <td>{b.eventIds.join("、")}</td>
                  <td className="dim">{b.error ?? "已按许可编号合并，已进入的通行未重复开门"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="冲突裁决（班长）">
        {s.permits.filter((p) => p.status === "conflict").length === 0 ? (
          <Empty text="暂无字段冲突" />
        ) : (
          s.permits
            .filter((p) => p.status === "conflict")
            .map((p) => (
              <article key={p.permitNo} className="conflict-card">
                <div className="permit-head">
                  <strong>{p.permitNo}</strong>
                  <Badge kind="danger">两版保留待裁决</Badge>
                </div>
                <div className="two-version">
                  <div className="version-box">
                    <span>中心版</span>
                    <strong>{p.conflict!.serverValue}</strong>
                  </div>
                  <div className="version-box gate">
                    <span>门控版</span>
                    <strong>{p.conflict!.gateValue}</strong>
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    onClick={() => dispatch({ type: "RESOLVE_CONFLICT", permitNo: p.permitNo, winner: "server" })}
                  >
                    采用中心版（离线门动作驳回，需重新确认）
                  </button>
                  <button
                    className="primary-action"
                    onClick={() => dispatch({ type: "RESOLVE_CONFLICT", permitNo: p.permitNo, winner: "gate" })}
                  >
                    采用门控版（承认离线通行，补并入中心）
                  </button>
                </div>
              </article>
            ))
        )}
      </Card>

      <Card title="门控事件流（回传/合并/幂等明细）">
        {s.gateEvents.length === 0 ? (
          <Empty text="离线期间暂无门动作" />
        ) : (
          <div className="event-list">
            {s.gateEvents.map((e) => {
              const meta = EVENT_META[e.kind];
              const st = STATE_META[e.state];
              return (
                <article key={e.id} className={`event-card state-${e.state}`}>
                  <div className="permit-head">
                    <strong>
                      {e.id} · {meta.label}
                    </strong>
                    <div className="row-actions">
                      {e.dup && <Badge kind="danger">重复刷卡</Badge>}
                      <Badge kind={e.gateDecision === "pass" ? "ok" : "danger"}>
                        门控{e.gateDecision === "pass" ? "放行" : "阻挡"}
                      </Badge>
                      <Badge kind={st.cls}>{st.label}</Badge>
                    </div>
                  </div>
                  <p className="dim">
                    {e.permitNo} · {channelName(s, e.channelId)} · {e.at}
                    {e.batchId ? ` · 批次 ${e.batchId}` : ""}
                  </p>
                  {e.gateReasonText && <p className="txt-danger">门控侧：{e.gateReasonText}</p>}
                  {e.state === "rejected" && <p className="txt-danger">中心侧：{e.resultText}</p>}
                  {e.state === "acked" && <p className="txt-ok">中心已执行，未重复开门</p>}
                  {e.state === "held" && <p className="txt-danger">暂扣：同字段两版冲突，等班长裁决</p>}
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

const LEVEL_CLS: Record<string, string> = {
  info: "ok",
  success: "ok",
  warn: "warn",
  danger: "danger",
};

export function AuditPanel({ s }: { s: AppState; dispatch: Dispatch }) {
  return (
    <Card title="追溯记录（所有阻挡原因与操作页、队列同源）">
      <div className="audit-list">
        {s.audit.map((a) => (
          <article key={a.id} className={`audit-item ${a.level}`}>
            <div className="audit-time">{a.at}</div>
            <div className="audit-body">
              <div className="permit-head">
                <Badge kind={LEVEL_CLS[a.level] ?? "muted"}>{a.typeLabel}</Badge>
                <span className="dim">{a.id}</span>
              </div>
              <p>{a.message}</p>
              {a.reasonText && (
                <div className="audit-reason">
                  <code>{a.reasonCode}</code> {a.reasonText}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </Card>
  );
}
