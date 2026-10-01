import type {
  AppState,
  AuditEvent,
  GateEvent,
  GateSnapshot,
  Permit,
  QueueEntry,
  ReasonCode,
  ReasonContext,
} from "./types";
import { initialState } from "./seed";
import { checkOuter, QUEUEABLE, reasonText, revalidate } from "./domain";

export type Action =
  | { type: "RESET" }
  | { type: "ONLINE_OUTER"; permitNo: string }
  | { type: "ONLINE_AIRLOCK"; channelId: string }
  | { type: "ONLINE_ROOM"; channelId: string }
  | { type: "EXIT"; channelId: string }
  | { type: "QUEUE_TICK" }
  | { type: "ISSUE_PERMIT"; groupId: string; roomId: string; materialIds: string[] }
  | { type: "RECONFIRM"; permitNo: string }
  | { type: "SET_PRESSURE"; roomId: string; pressurePa: number }
  | { type: "ADJUST_RULE"; roomId: string; minPa: number; maxPa: number }
  | { type: "ADJUST_BATCH"; batchId: string; validUntil: string }
  | { type: "OPEN_ANOMALY"; channelId: string; note: string }
  | { type: "CLOSE_ANOMALY"; channelId: string }
  | { type: "GO_OFFLINE" }
  | { type: "GO_ONLINE" }
  | { type: "GATE_OUTER"; permitNo: string; dup?: boolean }
  | { type: "GATE_AIRLOCK"; channelId: string }
  | { type: "GATE_ROOM"; channelId: string }
  | { type: "GATE_EDIT_PERMIT"; permitNo: string; note: string }
  | { type: "SERVER_EDIT_PERMIT"; permitNo: string; note: string }
  | { type: "TOGGLE_FAIL_NEXT" }
  | { type: "SYNC_BATCH" }
  | { type: "RESOLVE_CONFLICT"; permitNo: string; winner: "server" | "gate" };

// ---------- 工具 ----------

const pad = (n: number) => String(n).padStart(2, "0");
export const ts = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;

const NOTE_FIELD = "note";
const NOTE_LABEL = "随行备注";

export function groupName(s: { groups: AppState["groups"] }, id: string): string {
  return s.groups.find((g) => g.id === id)?.name ?? id;
}
export function roomName(s: { rooms: AppState["rooms"] }, id: string): string {
  return s.rooms.find((r) => r.id === id)?.name ?? id;
}
export function channelName(s: { channels: AppState["channels"] }, id: string): string {
  return s.channels.find((c) => c.id === id)?.name ?? id;
}

function audit(
  s: AppState,
  level: AuditEvent["level"],
  typeLabel: string,
  message: string,
  extra?: Partial<AuditEvent>,
): AppState {
  const ev: AuditEvent = {
    id: `AU-${s.seq.audit}`,
    at: ts(),
    level,
    typeLabel,
    message,
    ...extra,
  };
  return { ...s, audit: [ev, ...s.audit], seq: { ...s.seq, audit: s.seq.audit + 1 } };
}

function addAudit(
  s: AppState,
  level: AuditEvent["level"],
  typeLabel: string,
  message: string,
  extra?: Partial<AuditEvent>,
) {
  s.audit.unshift({ id: `AU-${s.seq.audit}`, at: ts(), level, typeLabel, message, ...extra });
  s.seq.audit += 1;
}

function reasonAudit(
  s: AppState,
  level: AuditEvent["level"],
  typeLabel: string,
  code: ReasonCode,
  ctx: ReasonContext,
  extra?: Partial<AuditEvent>,
) {
  addAudit(s, level, typeLabel, reasonText(code, ctx), { reasonCode: code, reasonText: reasonText(code, ctx), ...extra });
}

function snapshotOf(s: AppState): GateSnapshot {
  return {
    groups: structuredClone(s.groups),
    permits: structuredClone(s.permits),
    rooms: structuredClone(s.rooms),
    channels: structuredClone(s.channels),
    materials: structuredClone(s.materials),
    batches: structuredClone(s.batches),
    rules: structuredClone(s.rules),
    occupancy: structuredClone(s.occupancy),
  };
}

function materialNames(s: AppState, p: Permit): string {
  return p.materialIds
    .map((id) => {
      const m = s.materials.find((x) => x.id === id);
      if (!m) return id;
      const b = s.batches.find((x) => x.id === m.batchId);
      return `${m.name}(${m.batchId}${b ? "/" + b.validUntil : ""})`;
    })
    .join("、");
}

// ---------- 门控离线事件：构造 ----------

function newGateEvent(
  s: AppState,
  kind: GateEvent["kind"],
  permit: Permit,
  channelId: string,
  opts: { dup?: boolean; check?: ReturnType<typeof checkOuter> } = {},
): GateEvent {
  const check = opts.check;
  return {
    id: `GE-${s.seq.event}`,
    permitNo: permit.permitNo,
    channelId,
    kind,
    dup: opts.dup,
    at: ts(),
    gateDecision: opts.dup ? "block" : check && !check.ok ? "block" : "pass",
    gateReasonCode: opts.dup ? "PERMIT_CONSUMED" : check && !check.ok ? check.code : undefined,
    gateReasonText: opts.dup
      ? reasonText("PERMIT_CONSUMED", { detail: permit.permitNo })
      : check && !check.ok && check.code
        ? reasonText(check.code, check.ctx)
        : undefined,
    state: "queued",
  };
}

// ---------- 离线门禁物理动作推进（作用在门控本地缓存上） ----------

function gateApplyOuter(cache: GateSnapshot, permit: Permit, channelId: string) {
  cache.occupancy[channelId] = {
    permitNo: permit.permitNo,
    groupId: permit.groupId,
    stage: "airlock",
    outerOpen: true,
    since: ts(),
  };
  permit.status = "active";
}

function gateApplyAirlock(cache: GateSnapshot, permitNo: string, channelId: string) {
  const occ = cache.occupancy[channelId];
  if (occ && occ.permitNo === permitNo) {
    occ.outerOpen = false;
  }
}

function gateApplyRoom(cache: GateSnapshot, permitNo: string, channelId: string) {
  const occ = cache.occupancy[channelId];
  if (occ && occ.permitNo === permitNo) {
    occ.innerOpen = false;
    occ.stage = "room";
  }
  const p = cache.permits.find((x) => x.permitNo === permitNo);
  if (p) p.status = "entered";
}

// ---------- 服务端回传处理：单个门事件 ----------

function processServerEvent(s: AppState, ev: GateEvent): void {
  const permit = s.permits.find((p) => p.permitNo === ev.permitNo);
  const channel = s.channels.find((c) => c.id === ev.channelId);
  const prefix = `[${ev.id}] ${ev.permitNo} · ${channel?.name ?? ev.channelId}`;

  if (!permit) {
    rejectEvent(s, ev, "PERMIT_STALE", { detail: "许可不存在或已撤销" }, `${prefix} 驳回：许可不存在`);
    return;
  }

  // 幂等：同一门动作只处理一次
  if (s.processedResults[ev.id]) {
    ev.state = ev.state === "rejected" ? "rejected" : "acked";
    return;
  }

  // 门控重复刷卡（离线时本应挡住的“重复放行”），服务端一律驳回
  if (ev.dup) {
    rejectEvent(s, ev, "PERMIT_CONSUMED", { detail: ev.permitNo }, `${prefix} 门控重复刷卡，已驳回，通行未重复开门`);
    return;
  }

  // 双方同改同一字段：保留两版，整组事件暂扣等班长裁决
  const gateNote = s.gateEdits[ev.permitNo]?.[NOTE_FIELD];
  const serverNote = s.serverEdits[ev.permitNo]?.[NOTE_FIELD];
  if (gateNote && serverNote && gateNote.value !== serverNote.value && permit.status !== "conflict") {
    permit.status = "conflict";
    permit.conflict = {
      field: NOTE_FIELD,
      fieldLabel: NOTE_LABEL,
      serverValue: serverNote.value,
      gateValue: gateNote.value,
    };
    addAudit(
      s,
      "danger",
      "回传合并",
      reasonText("PERMIT_CONFLICT", {
        fieldLabel: NOTE_LABEL,
        serverValue: serverNote.value,
        gateValue: gateNote.value,
      }) + `（许可 ${ev.permitNo}，触发事件 ${ev.id}）`,
      {
        permitNo: ev.permitNo,
        channelId: ev.channelId,
        reasonCode: "PERMIT_CONFLICT",
        reasonText: reasonText("PERMIT_CONFLICT", {
          fieldLabel: NOTE_LABEL,
          serverValue: serverNote.value,
          gateValue: gateNote.value,
        }),
      },
    );
  }
  if (permit.status === "conflict" && permit.conflict && !permit.conflict.resolved) {
    ev.state = "held";
    return;
  }

  if (ev.kind === "outer") {
    // 门控本地已经硬阻挡（过期/压差/重复刷卡），中心不会补开门，只做复核归档
    if (ev.gateDecision === "block" && ev.gateReasonCode) {
      const check = checkOuter(s, permit, ev.channelId, new Date());
      rejectEvent(
        s,
        ev,
        ev.gateReasonCode,
        check.ok ? { detail: ev.gateReasonText } : check.ctx,
        `${prefix} 门控本地已阻挡（${ev.gateReasonCode}），中心不予补开门`,
      );
      return;
    }
    // 回传时中心再次按最新数据校验：过期/压差等硬性失败一律停在外门
    const check = checkOuter(s, permit, ev.channelId, new Date());
    if (!check.ok) {
      rejectEvent(s, ev, check.code!, check.ctx, `${prefix} 中心复核未通过，停在外门`);
      return;
    }
    s.occupancy[ev.channelId] = {
      permitNo: permit.permitNo,
      groupId: permit.groupId,
      stage: "airlock",
      outerOpen: true,
      since: ts(),
    };
    ev.state = "acked";
    ev.applied = true;
    s.processedResults[ev.id] = "外门开启";
    addAudit(s, "success", "离线回传", `${prefix} 外门开启结果已并入中心，互锁通道占用`, {
      permitNo: ev.permitNo,
      channelId: ev.channelId,
    });
    return;
  }

  if (ev.kind === "airlock") {
    const occ = s.occupancy[ev.channelId];
    if (occ && occ.permitNo === ev.permitNo) {
      occ.outerOpen = false;
    } else {
      rejectEvent(
        s,
        ev,
        "PERMIT_CONSUMED",
        { detail: ev.permitNo },
        `${prefix} 无对应占用记录，禁止重复开门`,
      );
      return;
    }
    ev.state = "acked";
    ev.applied = true;
    s.processedResults[ev.id] = "进入互锁";
    addAudit(s, "success", "离线回传", `${prefix} 进入互锁区，外门已关`, {
      permitNo: ev.permitNo,
      channelId: ev.channelId,
    });
    return;
  }

  if (ev.kind === "room") {
    const occ = s.occupancy[ev.channelId];
    if (occ && occ.permitNo === ev.permitNo && occ.stage === "airlock") {
      occ.innerOpen = false;
      occ.stage = "room";
      permit.status = "entered";
    } else if (permit.status === "entered") {
      rejectEvent(
        s,
        ev,
        "PERMIT_CONSUMED",
        { detail: ev.permitNo },
        `${prefix} 该通行已进入，不能再次开门`,
      );
      return;
    } else {
      rejectEvent(
        s,
        ev,
        "PERMIT_CONSUMED",
        { detail: ev.permitNo },
        `${prefix} 中心无未完成行程，不能再次开门`,
      );
      return;
    }
    ev.state = "acked";
    ev.applied = true;
    s.processedResults[ev.id] = "进入房间";
    addAudit(s, "success", "离线回传", `${prefix} 内门开启，人员进入 ${roomName(s, permit.roomId)}，许可核销`, {
      permitNo: ev.permitNo,
      channelId: ev.channelId,
    });
  }
}

function rejectEvent(
  s: AppState,
  ev: GateEvent,
  code: ReasonCode,
  ctx: ReasonContext,
  message: string,
) {
  ev.state = "rejected";
  ev.applied = false;
  ev.serverReasonCode = code;
  ev.resultText = reasonText(code, ctx);
  s.processedResults[ev.id] = "已驳回";
  reasonAudit(s, "danger", "离线回传驳回", code, ctx, {
    permitNo: ev.permitNo,
    channelId: ev.channelId,
  });
  addAudit(s, "danger", "离线回传驳回", message, { permitNo: ev.permitNo, channelId: ev.channelId });
}

// ---------- 主 reducer ----------

export function reducer(prev: AppState, action: Action): AppState {
  switch (action.type) {
    case "RESET":
      return initialState();

    case "GO_OFFLINE": {
      let s = structuredClone(prev);
      if (!s.online) return s;
      s.online = false;
      s.gateCacheAt = ts();
      s.gateCache = snapshotOf(s);
      addAudit(s, "warn", "网络", "门控与中心断网：门控按本地缓存继续放行判定，门动作进入回传队列");
      return s;
    }

    case "GO_ONLINE": {
      let s = structuredClone(prev);
      if (s.online) return s;
      s.online = true;
      s.gateCache = undefined;
      s.gateCacheAt = undefined;
      addAudit(s, "success", "网络", "网络恢复，请按批次回传门控事件，按许可编号合并");
      return s;
    }

    case "TOGGLE_FAIL_NEXT": {
      let s = structuredClone(prev);
      s.failNext = !s.failNext;
      return s;
    }

    // ===== 在线：外门刷卡 =====
    case "ONLINE_OUTER": {
      let s = structuredClone(prev);
      const permit = s.permits.find((p) => p.permitNo === action.permitNo);
      if (!permit) return s;
      const room = s.rooms.find((r) => r.id === permit.roomId)!;
      const channelId = room.channelId;
      const check = checkOuter(s, permit, channelId, new Date());
      if (!check.ok && check.code) {
        reasonAudit(s, "danger", "外门拦截", check.code, check.ctx, {
          permitNo: permit.permitNo,
          channelId,
        });
        // 通道满载 / 异常未结：进入待处理队列，阻挡原因与追溯同源
        if (QUEUEABLE.includes(check.code)) {
          const text = reasonText(check.code, check.ctx);
          const entry: QueueEntry = {
            id: `WQ-${s.seq.queue}`,
            permitNo: permit.permitNo,
            channelId,
            reasonCode: check.code,
            reasonText: text,
            at: ts(),
            status: "waiting",
          };
          s.seq.queue += 1;
          s.queue = [entry, ...s.queue];
          addAudit(s, "warn", "待处理队列", `${permit.permitNo} 已进入待处理队列：${text}`, {
            permitNo: permit.permitNo,
            channelId,
            reasonCode: check.code,
            reasonText: text,
          });
        }
        return s;
      }
      s.occupancy[channelId] = {
        permitNo: permit.permitNo,
        groupId: permit.groupId,
        stage: "airlock",
        outerOpen: true,
        since: ts(),
      };
      addAudit(
        s,
        "success",
        "外门放行",
        `${permit.permitNo} ${groupName(s, permit.groupId)} 携 ${materialNames(s, permit)} 外门开启，进入互锁（同通道其余人员禁止进入）`,
        { permitNo: permit.permitNo, channelId },
      );
      return s;
    }

    // ===== 在线：进入互锁（关外门） =====
    case "ONLINE_AIRLOCK": {
      let s = structuredClone(prev);
      const occ = s.occupancy[action.channelId];
      if (!occ || !occ.outerOpen) return s;
      occ.outerOpen = false;
      addAudit(s, "info", "互锁", `${occ.permitNo} 已进入互锁区，外门关闭`, {
        permitNo: occ.permitNo,
        channelId: action.channelId,
      });
      return s;
    }

    // ===== 在线：内门开启进入房间 =====
    case "ONLINE_ROOM": {
      let s = structuredClone(prev);
      const occ = s.occupancy[action.channelId];
      if (!occ) return s;
      const permit = s.permits.find((p) => p.permitNo === occ.permitNo);
      if (!permit || permit.status !== "active" || occ.stage !== "airlock") return s;
      occ.stage = "room";
      permit.status = "entered";
      addAudit(
        s,
        "success",
        "内门放行",
        `${permit.permitNo} 内门开启，进入 ${roomName(s, permit.roomId)}，许可核销，不可重复开门`,
        { permitNo: permit.permitNo, channelId: action.channelId },
      );
      return s;
    }

    // ===== 离开：释放互锁通道 =====
    case "EXIT": {
      let s = structuredClone(prev);
      const occ = s.occupancy[action.channelId];
      if (!occ) return s;
      const permitNo = occ.permitNo;
      delete s.occupancy[action.channelId];
      addAudit(s, "info", "离场", `${permitNo} 离开，${channelName(s, action.channelId)} 释放，队列可继续处理`, {
        permitNo,
        channelId: action.channelId,
      });
      return s;
    }

    // ===== 待处理队列推进（FIFO，每次处理队首，原因会按最新状态重新判定） =====
    case "QUEUE_TICK": {
      let s = structuredClone(prev);
      const waiting = [...s.queue]
        .filter((q) => q.status === "waiting")
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (waiting.length === 0) return s;
      const head = waiting[0];
      const permit = s.permits.find((p) => p.permitNo === head.permitNo);
      if (!permit) {
        head.status = "canceled";
        addAudit(s, "warn", "待处理队列", `${head.permitNo} 许可已不存在，队列项作废`);
        return s;
      }
      const check = checkOuter(s, permit, head.channelId, new Date());
      if (!check.ok && check.code) {
        const text = reasonText(check.code, check.ctx);
        addAudit(s, "warn", "待处理队列", `${head.permitNo} 仍被阻挡：${text}`, {
          permitNo: head.permitNo,
          channelId: head.channelId,
          reasonCode: check.code,
          reasonText: text,
        });
        // 阻挡原因变化时，队列项同步成最新原因，操作页/队列/追溯仍是同一句
        if (head.reasonCode !== check.code || head.reasonText !== text) {
          head.reasonCode = check.code;
          head.reasonText = text;
        }
        return s;
      }
      s.occupancy[head.channelId] = {
        permitNo: permit.permitNo,
        groupId: permit.groupId,
        stage: "airlock",
        outerOpen: true,
        since: ts(),
      };
      head.status = "released";
      addAudit(s, "success", "队列放行", `${head.permitNo} 阻挡解除，队列放行，外门开启，进入互锁`, {
        permitNo: head.permitNo,
        channelId: head.channelId,
      });
      return s;
    }

    // ===== 签发新许可 =====
    case "ISSUE_PERMIT": {
      let s = structuredClone(prev);
      const permitNo = `XK-20261001-${String(s.seq.permit).padStart(3, "0")}`;
      s.seq.permit += 1;
      const batchVersions: Record<string, number> = {};
      action.materialIds.forEach((mid) => {
        const m = s.materials.find((x) => x.id === mid);
        const b = m && s.batches.find((x) => x.id === m.batchId);
        if (b) batchVersions[b.id] = b.version;
      });
      const p: Permit = {
        permitNo,
        groupId: action.groupId,
        roomId: action.roomId,
        materialIds: action.materialIds,
        status: "active",
        issuedAt: ts(),
        ruleVersion: s.rules[action.roomId].version,
        batchVersions,
      };
      s.permits = [p, ...s.permits];
      addAudit(
        s,
        "success",
        "许可签发",
        `${permitNo} 已签发：${groupName(s, p.groupId)} → ${roomName(s, p.roomId)}，携 ${materialNames(s, p)}（规则 v${p.ruleVersion}）`,
        { permitNo },
      );
      return s;
    }

    // ===== 失效许可重新确认（按当前最新规则/批次版本重跑有效期与压差） =====
    case "RECONFIRM": {
      let s = structuredClone(prev);
      const permit = s.permits.find((p) => p.permitNo === action.permitNo);
      if (!permit) return s;
      const check = revalidate(s, permit, new Date());
      if (!check.ok && check.code) {
        reasonAudit(s, "danger", "重新确认", check.code, check.ctx, { permitNo: permit.permitNo });
        return s;
      }
      permit.status = "active";
      permit.staleText = undefined;
      permit.ruleVersion = s.rules[permit.roomId].version;
      Object.keys(permit.batchVersions).forEach((bid) => {
        const b = s.batches.find((x) => x.id === bid);
        if (b) permit.batchVersions[bid] = b.version;
      });
      addAudit(s, "success", "重新确认", `${permit.permitNo} 已按最新规则/批次重新确认通过，可以进入`, {
        permitNo: permit.permitNo,
      });
      return s;
    }

    // ===== 实时压差变化（巡检读数） =====
    case "SET_PRESSURE": {
      let s = structuredClone(prev);
      const room = s.rooms.find((r) => r.id === action.roomId);
      if (!room) return s;
      room.pressurePa = action.pressurePa;
      const rule = s.rules[room.id];
      const ok = action.pressurePa >= rule.minPa && action.pressurePa <= rule.maxPa;
      addAudit(
        s,
        ok ? "info" : "danger",
        "压差读数",
        `${room.name} 实时压差更新为 ${action.pressurePa}Pa（要求 ≥${rule.minPa} 且 ≤${rule.maxPa}），${
          ok ? "合格" : "不合格，外门将阻挡"
        }`,
      );
      return s;
    }

    // ===== 压差规则调整：已签发许可立即失效，重新确认前不能进入 =====
    case "ADJUST_RULE": {
      let s = structuredClone(prev);
      const rule = s.rules[action.roomId];
      const oldV = rule.version;
      rule.minPa = action.minPa;
      rule.maxPa = action.maxPa;
      rule.version = oldV + 1;
      addAudit(
        s,
        "warn",
        "规则调整",
        `${roomName(s, action.roomId)} 压差规则 v${oldV} → v${rule.version}（≥${rule.minPa}Pa，≤${rule.maxPa}Pa），关联已签发许可立即失效`,
      );
      s.permits.forEach((p) => {
        if (p.roomId !== action.roomId || p.status === "entered") return;
        p.status = "stale";
        p.staleText = `压差规则已调整至 v${rule.version}（≥${rule.minPa}Pa，≤${rule.maxPa}Pa）`;
        addAudit(
          s,
          "warn",
          "许可失效",
          `${p.permitNo} 因压差规则调整立即失效，须重新确认通过后才能进入`,
          { permitNo: p.permitNo, reasonCode: "PERMIT_STALE", reasonText: reasonText("PERMIT_STALE", { detail: p.staleText }) },
        );
      });
      return s;
    }

    // ===== 灭菌批次调整：有效期变化，关联许可立即失效 =====
    case "ADJUST_BATCH": {
      let s = structuredClone(prev);
      const batch = s.batches.find((b) => b.id === action.batchId);
      if (!batch) return s;
      const oldV = batch.version;
      const oldUntil = batch.validUntil;
      batch.validUntil = action.validUntil;
      batch.version = oldV + 1;
      addAudit(
        s,
        "warn",
        "批次调整",
        `灭菌批次 ${batch.id} 调整 v${oldV} → v${batch.version}，有效期 ${oldUntil} → ${batch.validUntil}，关联已签发许可立即失效`,
      );
      s.permits.forEach((p) => {
        if (p.status === "entered" || p.batchVersions[batch.id] === undefined) return;
        p.status = "stale";
        p.staleText = `灭菌批次 ${batch.id} 已调整至 v${batch.version}（有效期 ${batch.validUntil}）`;
        addAudit(
          s,
          "warn",
          "许可失效",
          `${p.permitNo} 因灭菌批次 ${batch.id} 调整立即失效，须重新确认通过后才能进入`,
          { permitNo: p.permitNo, reasonCode: "PERMIT_STALE", reasonText: reasonText("PERMIT_STALE", { detail: p.staleText }) },
        );
      });
      return s;
    }

    // ===== 通道异常登记/关闭 =====
    case "OPEN_ANOMALY": {
      let s = structuredClone(prev);
      const ch = s.channels.find((c) => c.id === action.channelId);
      if (!ch) return s;
      ch.anomalyOpen = true;
      ch.anomalyNote = action.note;
      addAudit(
        s,
        "danger",
        "异常登记",
        `${ch.name} 登记异常未结：${action.note}，异常关闭前任何许可进入待处理队列`,
        { channelId: ch.id, reasonCode: "ANOMALY_OPEN", reasonText: reasonText("ANOMALY_OPEN", { anomalyNote: action.note }) },
      );
      return s;
    }

    case "CLOSE_ANOMALY": {
      let s = structuredClone(prev);
      const ch = s.channels.find((c) => c.id === action.channelId);
      if (!ch || !ch.anomalyOpen) return s;
      ch.anomalyOpen = false;
      ch.anomalyNote = undefined;
      addAudit(s, "success", "异常关闭", `${ch.name} 异常已关闭，待处理队列可重新尝试放行`, { channelId: ch.id });
      return s;
    }

    // ===== 断网：门控本地外门刷卡 =====
    case "GATE_OUTER": {
      let s = structuredClone(prev);
      if (s.online || !s.gateCache) return s;
      const permit = s.gateCache.permits.find((p) => p.permitNo === action.permitNo);
      if (!permit) return s;
      const room = s.gateCache.rooms.find((r) => r.id === permit.roomId)!;
      const channelId = room.channelId;
      const ev = newGateEvent(s, "outer", permit, channelId);
      s.seq.event += 1;

      // 门控重复刷卡：即使离线也直接挡住（门控离线时重复放行的问题在这里被纠正）
      if (action.dup) {
        ev.dup = true;
        ev.gateDecision = "block";
        ev.gateReasonCode = "PERMIT_CONSUMED";
        s.gateEvents = [ev, ...s.gateEvents];
        reasonAudit(
          s,
          "warn",
          "门控本地",
          "PERMIT_CONSUMED",
          { detail: permit.permitNo },
          { permitNo: permit.permitNo, channelId },
        );
        return s;
      }

      const check = checkOuter(s.gateCache, permit, channelId, new Date());
      ev.gateDecision = check.ok ? "pass" : "block";
      ev.gateReasonCode = check.ok ? undefined : check.code;

      if (!check.ok && check.code) {
        // 硬阻挡（过期/压差/失效/冲突）：门控不开门，仍记录事件待回传复核
        s.gateEvents = [ev, ...s.gateEvents];
        reasonAudit(s, "warn", "门控本地", check.code, check.ctx, {
          permitNo: permit.permitNo,
          channelId,
        });
        return s;
      }

      gateApplyOuter(s.gateCache, permit, channelId);
      s.gateEvents = [ev, ...s.gateEvents];
      addAudit(
        s,
        "success",
        "门控本地",
        `${permit.permitNo} 门控按缓存放行外门（离线待回传，事件 ${ev.id}），互锁通道本地占用`,
        { permitNo: permit.permitNo, channelId },
      );
      return s;
    }

    // ===== 断网：门控本地进入互锁 =====
    case "GATE_AIRLOCK": {
      let s = structuredClone(prev);
      if (s.online || !s.gateCache) return s;
      const occ = s.gateCache.occupancy[action.channelId];
      if (!occ || !occ.outerOpen) return s;
      const permit = s.gateCache.permits.find((p) => p.permitNo === occ.permitNo)!;
      gateApplyAirlock(s.gateCache, occ.permitNo, action.channelId);
      const ev = newGateEvent(s, "airlock", permit, action.channelId);
      s.seq.event += 1;
      s.gateEvents = [ev, ...s.gateEvents];
      addAudit(s, "info", "门控本地", `${permit.permitNo} 门控本地进入互锁区（事件 ${ev.id}，待回传）`, {
        permitNo: permit.permitNo,
        channelId: action.channelId,
      });
      return s;
    }

    // ===== 断网：门控本地内门开启进入房间 =====
    case "GATE_ROOM": {
      let s = structuredClone(prev);
      if (s.online || !s.gateCache) return s;
      const occ = s.gateCache.occupancy[action.channelId];
      if (!occ) return s;
      const permit = s.gateCache.permits.find((p) => p.permitNo === occ.permitNo)!;
      const ev = newGateEvent(s, "room", permit, action.channelId);
      s.seq.event += 1;
      gateApplyRoom(s.gateCache, occ.permitNo, action.channelId);
      s.gateEvents = [ev, ...s.gateEvents];
      addAudit(
        s,
        "success",
        "门控本地",
        `${permit.permitNo} 门控本地内门开启进入房间（事件 ${ev.id}，待回传），本地许可核销`,
        { permitNo: permit.permitNo, channelId: action.channelId },
      );
      return s;
    }

    // ===== 断网：门控侧改许可字段 =====
    case "GATE_EDIT_PERMIT": {
      let s = structuredClone(prev);
      s.gateEdits[action.permitNo] ??= {};
      s.gateEdits[action.permitNo][NOTE_FIELD] = { value: action.note, at: ts() };
      addAudit(s, "info", "门控本地", `${action.permitNo} 门控侧修改「${NOTE_LABEL}」=${action.note}（待回传合并）`, {
        permitNo: action.permitNo,
      });
      return s;
    }

    // ===== 断网：中心侧改许可字段 =====
    case "SERVER_EDIT_PERMIT": {
      let s = structuredClone(prev);
      const p = s.permits.find((x) => x.permitNo === action.permitNo);
      if (!p) return s;
      p.note = action.note;
      s.serverEdits[action.permitNo] ??= {};
      s.serverEdits[action.permitNo][NOTE_FIELD] = { value: action.note, at: ts() };
      addAudit(s, "info", "中心修改", `${action.permitNo} 中心侧修改「${NOTE_LABEL}」=${action.note}（断网期间）`, {
        permitNo: action.permitNo,
      });
      return s;
    }

    // ===== 按批次回传（每批 3 条；失败批次单独重试，只补未完成的门，已进入不重复开门） =====
    case "SYNC_BATCH": {
      let s = structuredClone(prev);
      if (!s.online) return s;

      // 优先重试失败批次（只重发未 acked 的事件）；必须按门动作发生顺序补，不能先补内门
      const failedBatch = s.syncBatches.find((b) => b.state === "failed");
      let batchId: string;
      let picks: GateEvent[];
      const bySeq = (a: GateEvent, b: GateEvent) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]);
      if (failedBatch) {
        batchId = failedBatch.id;
        picks = s.gateEvents
          .filter((e) => e.batchId === batchId && e.state !== "acked" && e.state !== "held")
          .sort(bySeq);
        if (picks.length === 0) {
          failedBatch.state = "acked";
          addAudit(s, "success", "回传批次", `失败批次 ${batchId} 已无待完成事件，标记完成`);
          return s;
        }
        failedBatch.attempts += 1;
      } else {
        // 只取还没归属任何批次、且未被暂扣的事件
        picks = s.gateEvents.filter((e) => !e.batchId && e.state !== "held").slice().reverse().slice(0, 3);
        if (picks.length === 0) return s;
        batchId = `SYNC-${s.seq.batch}`;
        s.seq.batch += 1;
      }

      if (s.failNext) {
        s.failNext = false;
        picks.forEach((e) => (e.batchId = batchId));
        if (!failedBatch) {
          s.syncBatches = [
            {
              id: batchId,
              eventIds: picks.map((e) => e.id),
              state: "failed",
              attempts: 1,
              error: "模拟网络抖动，批次回传失败，等待按批次重试",
              at: ts(),
            },
            ...s.syncBatches,
          ];
        } else {
          failedBatch.error = `第 ${failedBatch.attempts} 次重试仍失败（模拟），只补未完成的门`;
        }
        addAudit(
          s,
          "danger",
          "回传失败",
          `批次 ${batchId} 回传失败（${picks.length} 个事件：${picks
            .map((e) => e.id)
            .join("、")}）；已 acked 的门不重发，已进入的通行不会再次开门`,
        );
        return s;
      }

      picks.forEach((e) => {
        e.batchId = batchId;
        processServerEvent(s, e);
      });

      const acked = picks.filter((e) => e.state === "acked").length;
      const held = picks.filter((e) => e.state === "held").length;
      const rejected = picks.filter((e) => e.state === "rejected").length;
      if (failedBatch) {
        failedBatch.state = "acked";
        failedBatch.error = undefined;
      } else {
        s.syncBatches = [
          {
            id: batchId,
            eventIds: picks.map((e) => e.id),
            state: "acked",
            attempts: 1,
            at: ts(),
          },
          ...s.syncBatches,
        ];
      }
      addAudit(
        s,
        "success",
        "回传合并",
        `批次 ${batchId} 已按许可编号合并：确认 ${acked}、暂扣 ${held}、驳回 ${rejected}（同许可事件归并，已进入的不重复开门）`,
      );
      return s;
    }

    // ===== 班长冲突裁决：两版都保留，裁决后才放行 =====
    case "RESOLVE_CONFLICT": {
      let s = structuredClone(prev);
      const permit = s.permits.find((p) => p.permitNo === action.permitNo);
      if (!permit || permit.status !== "conflict" || !permit.conflict) return s;
      const conflict = permit.conflict;
      conflict.resolved = action.winner;
      permit.note = action.winner === "gate" ? conflict.gateValue : conflict.serverValue;

      addAudit(
        s,
        "warn",
        "班长裁决",
        `${permit.permitNo} 字段「${conflict.fieldLabel}」冲突裁决：采用${
          action.winner === "gate" ? "门控版" : "中心版"
        }（门控=${conflict.gateValue} / 中心=${conflict.serverValue}，两版已留档）`,
        { permitNo: permit.permitNo },
      );

      const held = s.gateEvents.filter((e) => e.permitNo === permit.permitNo && e.state === "held");
      // 先清掉双方离线编辑，避免补执行事件时又被判定成新冲突
      delete s.gateEdits[permit.permitNo];
      delete s.serverEdits[permit.permitNo];
      if (held.length === 0) {
        permit.status = "active";
        return s;
      }

      if (action.winner === "gate") {
        // 采用门控版：承认离线通行，暂扣事件按顺序补执行
        permit.status = "active";
        held
          .sort((a, b) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]))
          .forEach((ev) => processServerEvent(s, ev));
        addAudit(s, "success", "班长裁决", `${permit.permitNo} 离线门动作已按门控版补并入中心`, {
          permitNo: permit.permitNo,
        });
      } else {
        // 采用中心版：离线门动作一律驳回，停在外门等重新安排
        held
          .sort((a, b) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]))
          .forEach((ev) =>
            rejectEvent(
              s,
              ev,
              "PERMIT_CONFLICT",
              {
                fieldLabel: conflict.fieldLabel,
                serverValue: conflict.serverValue,
                gateValue: conflict.gateValue,
                detail: "班长裁决采用中心版",
              },
              `${ev.id} 裁决采用中心版，离线门动作驳回`,
            ),
          );
        permit.status = "stale";
        permit.staleText = `冲突裁决采用中心版，门控版未采纳，需重新确认后安排进入`;
      }
      return s;
    }

    default:
      return prev;
  }
}
