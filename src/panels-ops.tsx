import { useMemo, useState } from "react";
import type { Action } from "./store";
import { channelName, groupName, roomName } from "./store";
import type { AppState } from "./types";
import { reasonText, STATUS_META } from "./domain";
import { Badge, Card, Empty, Field, KV, ReasonBanner } from "./ui";

type Dispatch = (a: Action) => void;

// ============ 操作页：互锁通道 + 许可操作 ============

function ChannelCard({
  s,
  channelId,
  dispatch,
  lastBlock,
}: {
  s: AppState;
  channelId: string;
  dispatch: Dispatch;
  lastBlock?: { code?: string; text?: string };
}) {
  const ch = s.channels.find((c) => c.id === channelId)!;
  const occ = s.occupancy[channelId];
  const rooms = s.rooms.filter((r) => r.channelId === channelId);
  const permit = occ ? s.permits.find((p) => p.permitNo === occ.permitNo) : undefined;

  return (
    <div className={`channel-card ${ch.anomalyOpen ? "is-danger" : occ ? "is-busy" : "is-free"}`}>
      <div className="channel-head">
        <div>
          <h3>{ch.name}</h3>
          <p className="dim">
            外门 {ch.outerDoorId} · 内门 {ch.innerDoorId}
          </p>
        </div>
        {ch.anomalyOpen ? <Badge kind="danger">异常未结</Badge> : occ ? <Badge kind="warn">占用中</Badge> : <Badge kind="ok">空闲</Badge>}
      </div>

      <div className="door-diagram">
        <div className={`door ${occ?.outerOpen ? "open" : "closed"}`}>
          <span>外门</span>
          <strong>{occ?.outerOpen ? "开启" : "关闭"}</strong>
        </div>
        <div className="airlock">
          <span>互锁区（同通道只允许一组）</span>
          <strong>{occ ? groupName(s, occ.groupId) : "—"}</strong>
          {occ && <em>{occ.permitNo} · {occ.stage === "airlock" ? "互锁中" : "已入房间"}</em>}
        </div>
        <div className={`door ${occ?.stage === "room" ? "open" : "closed"}`}>
          <span>内门</span>
          <strong>{occ?.stage === "room" ? "开启过" : "关闭"}</strong>
        </div>
      </div>

      {ch.anomalyOpen && (
        <div className="inline-reason">⛔ 异常未结：{ch.anomalyNote}</div>
      )}

      {occ && permit && (
        <div className="occ-meta">
          <KV k="当前许可" v={permit.permitNo} />
          <KV k="目标" v={roomName(s, permit.roomId)} />
          <div className="channel-actions">
            {occ.outerOpen && (
              <button onClick={() => dispatch({ type: "ONLINE_AIRLOCK", channelId })}>① 进入互锁（关外门）</button>
            )}
            {!occ.outerOpen && occ.stage === "airlock" && permit.status === "active" && (
              <button className="primary-action" onClick={() => dispatch({ type: "ONLINE_ROOM", channelId })}>
                ② 开内门进入房间
              </button>
            )}
            {occ.stage === "room" && (
              <button onClick={() => dispatch({ type: "EXIT", channelId })}>③ 人员离场，释放通道</button>
            )}
          </div>
        </div>
      )}

      <div className="room-mini">
        {rooms.map((r) => {
          const rule = s.rules[r.id];
          const ok = r.pressurePa >= rule.minPa && r.pressurePa <= rule.maxPa;
          return (
            <div key={r.id} className="room-line">
              <span>{r.name}（{r.className}）</span>
              <Badge kind={ok ? "ok" : "danger"}>
                压差 {r.pressurePa}Pa / 规则 v{rule.version} [{rule.minPa}~{rule.maxPa}]
              </Badge>
            </div>
          );
        })}
      </div>

      {ch.anomalyOpen ? (
        <button className="primary-action" onClick={() => dispatch({ type: "CLOSE_ANOMALY", channelId })}>
          关闭异常单
        </button>
      ) : (
        <button
          onClick={() => {
            const note = prompt("登记异常内容（如：压差报警、门锁故障）", "气闸压差报警排查中");
            if (note) dispatch({ type: "OPEN_ANOMALY", channelId, note });
          }}
        >
          登记通道异常
        </button>
      )}
      {lastBlock?.text && <div className="last-block">最近阻挡：{lastBlock.text}</div>}
    </div>
  );
}

export function OpsPanel({ s, dispatch }: { s: AppState; dispatch: Dispatch }) {
  const [selected, setSelected] = useState(s.permits[0]?.permitNo ?? "");
  const activePermits = s.permits;

  const lastBlock = useMemo(() => {
    const a = s.audit.find((x) => x.reasonText);
    return a ? { code: a.reasonCode, text: a.reasonText } : undefined;
  }, [s.audit]);

  return (
    <div className="panel-grid">
      <Card title="通行许可刷卡（外门统一判定）">
        <Field label="选择许可编号">
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {activePermits.map((p) => (
              <option key={p.permitNo} value={p.permitNo}>
                {p.permitNo} · {groupName(s, p.groupId)} → {roomName(s, p.roomId)} · {STATUS_META[p.status].label}
              </option>
            ))}
          </select>
        </Field>

        {(() => {
          const p = s.permits.find((x) => x.permitNo === selected);
          if (!p) return <Empty text="无许可" />;
          const room = s.rooms.find((r) => r.id === p.roomId)!;
          return (
            <div className="permit-preview">
              <KV k="人员组" v={groupName(s, p.groupId)} />
              <KV k="房间" v={`${room.name}（${room.className}）`} />
              <KV
                k="物料"
                v={p.materialIds
                  .map((id) => {
                    const m = s.materials.find((x) => x.id === id)!;
                    const b = s.batches.find((x) => x.id === m.batchId)!;
                    const expired = new Date(b.validUntil + "T23:59:59").getTime() < Date.now();
                    return (
                      <span key={id} className={expired ? "txt-danger" : "txt-ok"}>
                        {m.name} · {b.id} · 效期 {b.validUntil}
                        {expired ? "（已过期）" : ""}
                      </span>
                    );
                  })}
              />
              <div className="preview-actions">
                <button
                  className="primary-action"
                  disabled={!s.online}
                  onClick={() => dispatch({ type: "ONLINE_OUTER", permitNo: p.permitNo })}
                >
                  {s.online ? "刷卡开外门" : "离线中：请用门控面板操作"}
                </button>
              </div>
            </div>
          );
        })()}
      </Card>

      {s.channels.map((c) => (
        <ChannelCard key={c.id} s={s} channelId={c.id} dispatch={dispatch} lastBlock={lastBlock} />
      ))}
    </div>
  );
}

// ============ 许可与规则 ============

export function PermitsPanel({ s, dispatch }: { s: AppState; dispatch: Dispatch }) {
  const [groupId, setGroupId] = useState(s.groups[0].id);
  const [roomId, setRoomId] = useState(s.rooms[0].id);
  const [mids, setMids] = useState<string[]>([s.materials[0].id]);
  const [noteDraft, setNoteDraft] = useState("");

  const toggleMat = (id: string) =>
    setMids((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="panel-grid">
      <Card title="签发通行许可（冻结当前规则/批次版本）">
        <div className="form-stack">
          <Field label="人员组">
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {s.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}（{g.memberIds.map((id) => s.people.find((p) => p.id === id)?.name).join("、")}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="目标房间">
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {s.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.className} · 经{channelName(s, r.channelId)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="随带物料（按灭菌批次核有效期）">
            <div className="check-list">
              {s.materials.map((m) => {
                const b = s.batches.find((x) => x.id === m.batchId)!;
                const expired = new Date(b.validUntil + "T23:59:59").getTime() < Date.now();
                return (
                  <label key={m.id} className="check-item">
                    <input type="checkbox" checked={mids.includes(m.id)} onChange={() => toggleMat(m.id)} />
                    <span className={expired ? "txt-danger" : ""}>
                      {m.name} · {b.id} · 效期 {b.validUntil}
                      {expired ? "（已过期，开外门将被拦）" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>
          <button
            className="primary-action"
            disabled={mids.length === 0}
            onClick={() =>
              dispatch({ type: "ISSUE_PERMIT", groupId, roomId, materialIds: mids })
            }
          >
            签发许可
          </button>
        </div>
      </Card>

      <Card title="已签发许可">
        <div className="permit-list">
          {s.permits.map((p) => {
            const meta = STATUS_META[p.status];
            const room = s.rooms.find((r) => r.id === p.roomId)!;
            const rule = s.rules[p.roomId];
            const ruleBehind = rule.version !== p.ruleVersion;
            return (
              <article key={p.permitNo} className="permit-card">
                <div className="permit-head">
                  <strong>{p.permitNo}</strong>
                  <Badge kind={meta.cls}>{meta.label}</Badge>
                </div>
                <p className="dim">
                  {groupName(s, p.groupId)} → {room.name} · 签发 {p.issuedAt}
                </p>
                <p className="dim">
                  物料：
                  {p.materialIds
                    .map((id) => {
                      const m = s.materials.find((x) => x.id === id);
                      const b = m && s.batches.find((x) => x.id === m.batchId);
                      return m ? `${m.name}(${b!.id} v${p.batchVersions[b!.id] ?? "?"})` : id;
                    })
                    .join("、")}
                </p>
                {ruleBehind && <p className="txt-danger">⚠ 签发时规则 v{p.ruleVersion}，现行 v{rule.version}</p>}
                {p.staleText && <div className="inline-reason">⛔ {p.staleText}</div>}
                {p.conflict && (
                  <div className="inline-reason warn">
                    ⚖ 字段「{p.conflict.fieldLabel}」两版并存：中心={p.conflict.serverValue} / 门控=
                    {p.conflict.gateValue}
                    {p.conflict.resolved ? `（已裁决采用${p.conflict.resolved === "gate" ? "门控版" : "中心版"}）` : "（待班长裁决）"}
                  </div>
                )}
                <div className="row-actions">
                  {p.status === "stale" && (
                    <button className="primary-action" onClick={() => dispatch({ type: "RECONFIRM", permitNo: p.permitNo })}>
                      按最新规则重新确认
                    </button>
                  )}
                  {p.status === "active" && !s.online && (
                    <span className="dim">断网中：可在门控/中心分别改备注制造同字段冲突</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </Card>

      <Card title="压差规则（调整即作废旧许可）">
        <table className="data-table">
          <thead>
            <tr>
              <th>房间</th>
              <th>实时压差</th>
              <th>下限</th>
              <th>上限</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {s.rooms.map((r) => {
              const rule = s.rules[r.id];
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    <input
                      type="number"
                      value={r.pressurePa}
                      style={{ width: 80 }}
                      onChange={(e) =>
                        dispatch({ type: "SET_PRESSURE", roomId: r.id, pressurePa: Number(e.target.value) })
                      }
                    />{" "}
                    Pa
                  </td>
                  <td>{rule.minPa}</td>
                  <td>{rule.maxPa}</td>
                  <td>v{rule.version}</td>
                  <td>
                    <button
                      onClick={() =>
                        dispatch({ type: "ADJUST_RULE", roomId: r.id, minPa: Math.max(0, rule.minPa + 5), maxPa: rule.maxPa })
                      }
                    >
                      下限 +5Pa（调严）
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="灭菌批次有效期（调整即作废旧许可）">
        <table className="data-table">
          <thead>
            <tr>
              <th>批次号</th>
              <th>名称</th>
              <th>灭菌日期</th>
              <th>有效期至</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {s.batches.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{b.name}</td>
                <td>{b.sterilizedAt}</td>
                <td className={new Date(b.validUntil + "T23:59:59").getTime() < Date.now() ? "txt-danger" : ""}>
                  {b.validUntil}
                </td>
                <td>v{b.version}</td>
                <td>
                  <button
                    onClick={() =>
                      dispatch({
                        type: "ADJUST_BATCH",
                        batchId: b.id,
                        validUntil: b.validUntil === "2026-09-28" ? "2026-10-08" : "2026-09-28",
                      })
                    }
                  >
                    {b.validUntil === "2026-09-28" ? "延期到 10-08" : "提前到 09-28（触发过期）"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function QueuePanel({ s, dispatch }: { s: AppState; dispatch: Dispatch }) {
  return (
    <Card
      title="待处理队列（通道满载 / 异常未结进入，按 FIFO 放行）"
      extra={
        <button className="primary-action" onClick={() => dispatch({ type: "QUEUE_TICK" })}>
          处理队首一项
        </button>
      }
    >
      {s.queue.length === 0 ? (
        <Empty text="队列暂无待处理项" />
      ) : (
        <div className="queue-list">
          {s.queue.map((q) => (
            <article key={q.id} className={`queue-item ${q.status}`}>
              <div className="permit-head">
                <strong>{q.id} · {q.permitNo}</strong>
                <Badge kind={q.status === "waiting" ? "warn" : q.status === "released" ? "ok" : "muted"}>
                  {q.status === "waiting" ? "等待中" : q.status === "released" ? "已放行" : "已作废"}
                </Badge>
              </div>
              <p className="dim">{channelName(s, q.channelId)} · 入队 {q.at}</p>
              <ReasonBanner code={q.reasonCode} text={q.reasonText} />
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
