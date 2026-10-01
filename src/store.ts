import { useSyncExternalStore } from "react";
import {
  BLOCK_REASONS,
  batchExpiry,
  buildSignature,
  evaluate,
  signatureStale,
} from "./engine";
import {
  T0,
  makeGate,
  seedBatches,
  seedChannels,
  seedMaterials,
  seedPeople,
  seedRules,
} from "./seed";
import type {
  AuditEvent,
  BlockCode,
  Channel,
  FieldConflict,
  Gate,
  GateEvent,
  Material,
  Permit,
  Person,
  PressureRule,
  QueueItem,
  SterBatch,
  SyncBatch,
} from "./types";

let auditSeq = 1;
let permitSeq = 100;
let conflictSeq = 1;
let batchSyncSeq = 1;

type State = {
  now: number;
  people: Person[];
  batches: Record<string, SterBatch>;
  materials: Material[];
  channels: Channel[];
  rules: PressureRule[];
  gates: Gate[];
  permits: Permit[];
  queue: QueueItem[];
  conflicts: FieldConflict[];
  audit: AuditEvent[];
  syncBatches: SyncBatch[];
  linkDown: boolean; // 模拟回传链路故障
};

function makePermit(
  channelId: string,
  personIds: string[],
  materialIds: string[],
  state: State,
  opts?: { note?: string }
): Permit {
  const rule = state.rules.find((r) => r.channelId === channelId)!;
  permitSeq += 1;
  const id = `XK-20261001-${String(permitSeq - 100).padStart(3, "0")}`;
  return {
    id,
    personIds,
    channelId,
    materialIds,
    validFrom: state.now,
    validUntil: state.now + 4 * 3600_000,
    status: "issued",
    signature: buildSignature(
      rule.version,
      materialIds,
      state.materials,
      state.batches
    ),
    note: opts?.note ?? "",
    enteredAt: null,
    exitedAt: null,
    enteredOffline: false,
  };
}

function initialState(): State {
  const now = T0;
  const state: State = {
    now,
    people: seedPeople.map((p) => ({ ...p })),
    batches: Object.fromEntries(
      Object.entries(seedBatches).map(([k, b]) => [k, { ...b }])
    ),
    materials: seedMaterials.map((m) => ({ ...m })),
    channels: seedChannels.map((c) => ({ ...c })),
    rules: seedRules.map((r) => ({ ...r })),
    gates: [
      makeGate({ id: "GATE-01", channelId: "A-01", online: true }),
      makeGate({ id: "GATE-02", channelId: "B-02", online: true }),
    ],
    permits: [],
    queue: [],
    conflicts: [],
    audit: [],
    syncBatches: [],
    linkDown: false,
  };
  // 预置许可，覆盖各类现场情形
  const p1 = makePermit("A-01", ["P-01", "P-02"], ["M-01", "M-04"], state, {
    note: "刻蚀腔例行保养",
  });
  const p2 = makePermit("B-02", ["P-03"], [], state, { note: "黄光区抽检" });
  const p3 = makePermit("A-01", ["P-05"], ["M-02"], state, {
    note: "携带临期光刻胶分装瓶",
  });
  const p4 = makePermit("A-01", ["P-01"], ["M-03"], state, {
    note: "领用密封件",
  });
  state.permits.push(p1, p2, p3, p4);
  log(state, "info", "系统就绪：人员、房间、物料、灭菌批次、压差规则与通行许可已接通");
  pushGateData(state);
  return state;
}

// ====== 审计：操作页与追溯共用 BLOCK_REASONS 文案 ======
function log(
  state: State,
  level: AuditEvent["level"],
  text: string,
  code?: BlockCode,
  detail?: string
) {
  state.audit.unshift({ id: auditSeq++, at: state.now, level, text, code, detail });
  if (state.audit.length > 200) state.audit.length = 200;
}

function reasonText(code: BlockCode, detail?: string): string {
  const r = BLOCK_REASONS[code];
  return `${r.label}｜${r.message(detail ?? "")}`;
}

// 在线门控实时缓存许可与判定上下文；离线后冻结
function pushGateData(state: State) {
  for (const gate of state.gates) {
    if (!gate.online) continue;
    const rule = state.rules.find((r) => r.channelId === gate.channelId)!;
    const channel = state.channels.find((c) => c.id === gate.channelId)!;
    gate.snapshot = {};
    for (const p of state.permits.filter((p) => p.channelId === gate.channelId)) {
      gate.snapshot[p.id] = { ...p };
    }
    gate.cache = {
      at: state.now,
      people: state.people.map((x) => ({ ...x })),
      materials: state.materials.map((x) => ({ ...x })),
      batches: Object.fromEntries(
        Object.entries(state.batches).map(([k, b]) => [k, { ...b }])
      ),
      rule: { ...rule },
      pressurePa: channel.pressurePa,
      openAnomaly: channel.openAnomaly ? { ...channel.openAnomaly } : null,
    };
    // 在线门控以中央占用为准，同步已使用许可（不覆盖门控本地状态以外的内容）
    gate.usedPermitIds = state.permits
      .filter((p) => p.channelId === gate.channelId && (p.status === "used" || p.status === "exited"))
      .map((p) => p.id);
    gate.lastSyncAt = state.now;
  }
}

// 离线门内占用：由本地流水重放得到
function localOccupancy(gate: Gate): string | null {
  const inside = new Set<string>();
  for (const e of gate.journal) {
    if (e.type === "ENTER" && !e.localBlock) inside.add(e.permitId);
    if (e.type === "EXIT") inside.delete(e.permitId);
  }
  return inside.values().next().value ?? null;
}

// 分布式 Omit：保持 GateEvent 联合判别
type EventInput = GateEvent extends infer E
  ? E extends GateEvent
    ? Omit<E, "seq" | "gateId" | "ack">
    : never
  : never;

function addEvent(gate: Gate, e: EventInput) {
  gate.journal.push({ ...e, seq: ++gate.journalSeq, gateId: gate.id, ack: false } as GateEvent);
}

function ruleOf(state: State, channelId: string) {
  return state.rules.find((r) => r.channelId === channelId)!;
}
function gateOf(state: State, channelId: string) {
  return state.gates.find((g) => g.channelId === channelId)!;
}

// 通道队列调度：条件解除后按 FIFO 自动放行；硬阻挡的队头保留原因，不卡住后续
function drainQueue(state: State, channelId: string) {
  const channel = state.channels.find((c) => c.id === channelId)!;
  const gate = gateOf(state, channelId);
  if (!gate.online) return; // 离线通道的队列由门控本地维持
  const items = state.queue.filter((q) => q.channelId === channelId);
  for (const item of items) {
    const permit = state.permits.find((p) => p.id === item.permitId);
    if (!permit) continue;
    const decision = evaluate({
      now: state.now,
      permit,
      channel,
      gate,
      people: state.people,
      materials: state.materials,
      batches: state.batches,
      pressureRule: ruleOf(state, channelId),
      queue: state.queue,
      alreadyQueued: true,
    });
    if (decision.outcome === "allow") {
      applyEntry(state, permit, channel, gate, false);
      state.queue = state.queue.filter((q) => q !== item);
      log(
        state,
        "info",
        `排队结束，许可 ${permit.id} 自动放行进入 ${channelId}`
      );
      return; // 互锁：一次只放一组，下一组等其离开
    }
  }
}

function applyEntry(
  state: State,
  permit: Permit,
  channel: Channel,
  gate: Gate,
  offline: boolean,
  at?: number
) {
  permit.status = "used";
  permit.enteredAt = at ?? state.now;
  permit.enteredOffline = offline;
  permit.lastBlock = undefined;
  channel.occupiedByPermitId = permit.id;
  if (!gate.usedPermitIds.includes(permit.id)) gate.usedPermitIds.push(permit.id);
}

// ====== Store ======
let state: State = initialState();
const listeners = new Set<() => void>();

function commit() {
  pushGateData(state);
  state = { ...state };
  listeners.forEach((l) => l());
}

export const store = {
  getState: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  // 时钟推进：许可超时在此时点失效
  tick(minutes: number) {
    state.now += minutes * 60_000;
    for (const p of state.permits) {
      if (
        (p.status === "issued" || p.status === "reconfirm") &&
        state.now > p.validUntil
      ) {
        p.status = "expired";
        log(state, "warn", `许可 ${p.id} 超过有效时段，已失效`, "PERMIT_EXPIRED");
      }
    }
    log(state, "info", `时间推进 ${minutes} 分钟至 ${new Date(state.now).toLocaleString("zh-CN", { hour12: false })}`);
    commit();
  },

  issuePermit(channelId: string, personIds: string[], materialIds: string[]) {
    if (personIds.length === 0) return;
    const p = makePermit(channelId, personIds, materialIds, state);
    state.permits.unshift(p);
    log(
      state,
      "info",
      `签发许可 ${p.id}：${personIds.length} 人 / 物料 ${materialIds.length} 件 / 通道 ${channelId}，已绑定当前压差规则与灭菌批次版本`
    );
    commit();
  },

  // 外门刷卡：在线走中央判定，离线走门控冻结快照
  swipe(permitId: string) {
    const permit = state.permits.find((p) => p.id === permitId);
    if (!permit) return;
    const channel = state.channels.find((c) => c.id === permit.channelId)!;
    const gate = gateOf(state, permit.channelId);

    if (gate.online) {
      const d = evaluate({
        now: state.now,
        permit,
        channel,
        gate,
        people: state.people,
        materials: state.materials,
        batches: state.batches,
        pressureRule: ruleOf(state, permit.channelId),
        queue: state.queue,
      });
      finishDecision(d, permit, channel, gate, false);
    } else {
      // —— 离线：门控只认最后同步的冻结快照 ——
      const snap = gate.snapshot[permitId];
      if (!snap) {
        addEvent(gate, {
          permitId,
          type: "ENTER",
          at: state.now,
          localBlock: "PERMIT_NOT_FOUND",
          detail: gate.id,
        });
        commit();
        return;
      }
      if (
        gate.usedPermitIds.includes(permitId) ||
        snap.status === "used" ||
        snap.status === "exited"
      ) {
        addEvent(gate, {
          permitId,
          type: "ENTER",
          at: state.now,
          localBlock: "PERMIT_USED",
        });
        commit();
        return;
      }
      const cache = gate.cache!;
      const pseudoChannel: Channel = {
        ...channel,
        pressurePa: cache.pressurePa,
        openAnomaly: cache.openAnomaly,
        occupiedByPermitId: localOccupancy(gate),
      };
      // 离线判定基于最后同步时刻的冻结快照；门在线状态不参与本地规则
      const frozenGate: Gate = { ...gate, online: true };
      const d = evaluate({
        now: state.now,
        permit: snap,
        channel: pseudoChannel,
        gate: frozenGate,
        people: cache.people,
        materials: cache.materials,
        batches: cache.batches,
        pressureRule: cache.rule,
        queue: [],
      });
      if (d.outcome === "allow") {
        addEvent(gate, { permitId, type: "ENTER", at: state.now });
        snap.status = "used";
        snap.enteredAt = state.now;
        snap.enteredOffline = true;
        gate.usedPermitIds.push(permitId);
      } else if (d.outcome === "queue") {
        addEvent(gate, {
          permitId,
          type: "ENQUEUE",
          at: state.now,
          code: d.code,
          detail: d.detail,
        });
        if (!gate.localQueue.includes(permitId)) gate.localQueue.push(permitId);
      } else {
        addEvent(gate, {
          permitId,
          type: "ENTER",
          at: state.now,
          localBlock: d.code,
          detail: d.detail,
        });
      }
    }
    commit();
  },

  exit(permitId: string) {
    const permit = state.permits.find((p) => p.id === permitId)!;
    const channel = state.channels.find((c) => c.id === permit.channelId)!;
    const gate = gateOf(state, permit.channelId);
    if (gate.online) {
      if (permit.status !== "used") return;
      permit.status = "exited";
      permit.exitedAt = state.now;
      if (channel.occupiedByPermitId === permit.id)
        channel.occupiedByPermitId = null;
      log(state, "info", `许可 ${permitId} 离开 ${channel.id}，互锁复位`);
      drainQueue(state, channel.id);
    } else {
      addEvent(gate, { permitId, type: "EXIT", at: state.now });
      if (gate.snapshot[permitId]) gate.snapshot[permitId].status = "exited";
      gate.localQueue = gate.localQueue.filter((id) => id !== permitId);
    }
    commit();
  },

  // 备注：双方可改同一字段；离线侧记录编辑基线，回传时识别冲突
  editNote(permitId: string, value: string) {
    const permit = state.permits.find((p) => p.id === permitId)!;
    const gate = gateOf(state, permit.channelId);
    if (gate.online) {
      permit.note = value;
      log(state, "info", `中央端修改许可 ${permitId} 备注`);
    } else {
      const snap = gate.snapshot[permitId];
      if (!snap) return;
      addEvent(gate, {
        permitId,
        type: "EDIT_NOTE",
        at: state.now,
        baseNote: snap.note,
        value,
      });
      snap.note = value;
    }
    commit();
  },

  setGateOnline(gateId: string, online: boolean) {
    const gate = state.gates.find((g) => g.id === gateId)!;
    gate.online = online;
    if (online) {
      log(
        state,
        "info",
        `门控 ${gateId} 链路恢复，待回传本地流水（${gate.journal.filter((e) => !e.ack).length} 条未确认）`
      );
    } else {
      log(state, "warn", `门控 ${gateId} 离线，外门转入本地冻结快照模式`);
    }
    commit();
  },

  // 回传：按门分批，断点续传只补未确认流水；链路失败按批次重试
  syncGate(gateId: string) {
    const gate = state.gates.find((g) => g.id === gateId)!;
    let batch = state.syncBatches.find(
      (b) => b.gateId === gateId && b.status !== "done"
    );
    const pending = gate.journal.filter((e) => !e.ack);
    if (!batch) {
      if (pending.length === 0) {
        log(state, "info", `门控 ${gateId} 无待回传流水`);
        commit();
        return;
      }
      batch = {
        id: `BATCH-${String(batchSyncSeq++).padStart(3, "0")}`,
        gateId,
        total: gate.journal.length,
        doneSeqs: [],
        status: "pending",
        lastError: "",
        attempts: 0,
        at: state.now,
      };
      state.syncBatches.unshift(batch);
    }
    batch.attempts += 1;
    if (state.linkDown) {
      batch.status = batch.doneSeqs.length ? "partial" : "failed";
      batch.lastError = "回传链路中断，服务端不可达";
      log(
        state,
        "sync",
        `批次 ${batch.id} 第 ${batch.attempts} 次回传失败：${batch.lastError}，已保留进度，仅补未确认的门与流水`,
        "GATE_OFFLINE"
      );
      commit();
      return;
    }

    for (const e of pending) {
      mergeEvent(state, gate, e);
      e.ack = true;
      batch.doneSeqs.push(e.seq);
    }
    batch.status = "done";
    batch.lastError = "";
    gate.journal = gate.journal.filter((e) => !e.ack);
    gate.localQueue = [];
    gate.lastSyncAt = state.now;
    log(
      state,
      "sync",
      `批次 ${batch.id} 回传完成：${batch.doneSeqs.length} 条流水已按许可编号合并，重复进入未再开门`
    );
    drainQueue(state, gate.channelId);
    commit();
  },

  syncAllPending() {
    const ids = state.gates
      .filter((g) => g.journal.some((e) => !e.ack))
      .map((g) => g.id);
    if (!ids.length) {
      log(state, "info", "没有待回传的门控");
      commit();
      return;
    }
    for (const id of ids) store.syncGate(id);
  },

  // 班长对同字段两版进行裁决
  resolveConflict(conflictId: string, choice: "center" | "gate") {
    const c = state.conflicts.find((x) => x.id === conflictId)!;
    const permit = state.permits.find((p) => p.id === c.permitId)!;
    c.resolved = choice;
    c.resolvedAt = state.now;
    permit.note = choice === "center" ? c.centerValue : c.gateValue;
    if (permit.status === "conflict") {
      const stale = signatureStale(
        permit.signature,
        ruleOf(state, permit.channelId).version,
        permit.materialIds,
        state.materials,
        state.batches
      );
      permit.status = stale
        ? "reconfirm"
        : permit.enteredAt
          ? "used"
          : "issued";
    }
    log(
      state,
      "info",
      `班长裁决冲突 ${c.id}（许可 ${c.permitId} 备注）：保留${choice === "center" ? "中央版" : "门控版"}`
    );
    commit();
  },

  // 规则/批次变更后重新确认：重绑指纹，未通过不能进入
  reconfirm(permitId: string) {
    const permit = state.permits.find((p) => p.id === permitId)!;
    const badPeople = permit.personIds
      .map((id) => state.people.find((p) => p.id === id)!)
      .filter((p) => !p.certified)
      .map((p) => p.name);
    if (badPeople.length) {
      permit.reconfirmFailReason = `人员资质失效：${badPeople.join("、")}`;
      log(state, "block", `许可 ${permitId} 重新确认未通过：${permit.reconfirmFailReason}`, "PERSON_INVALID");
      commit();
      return;
    }
    for (const mid of permit.materialIds) {
      const m = state.materials.find((x) => x.id === mid)!;
      const b = state.batches[m.batchId];
      if (b.revoked) {
        permit.reconfirmFailReason = `批次 ${b.id} 已作废`;
        log(state, "block", `许可 ${permitId} 重新确认未通过：物料批次作废`, "MATERIAL_BATCH_REVOKED", b.id);
        commit();
        return;
      }
      if (state.now > batchExpiry(b)) {
        permit.reconfirmFailReason = `物料已于灭菌有效期到期`;
        log(state, "block", `许可 ${permitId} 重新确认未通过：物料灭菌过期`, "MATERIAL_EXPIRED", m.name);
        commit();
        return;
      }
    }
    permit.signature = buildSignature(
      ruleOf(state, permit.channelId).version,
      permit.materialIds,
      state.materials,
      state.batches
    );
    permit.status = "issued";
    permit.reconfirmFailReason = undefined;
    log(state, "rule", `许可 ${permitId} 已按新规则/批次重新确认通过，指纹重绑`);
    drainQueue(state, permit.channelId);
    commit();
  },

  adjustBatch(batchId: string, patch: { validHours?: number; revoked?: boolean }) {
    const b = state.batches[batchId];
    if (patch.validHours !== undefined) b.validHours = patch.validHours;
    if (patch.revoked !== undefined) b.revoked = patch.revoked;
    b.revision += 1;
    log(
      state,
      "rule",
      `灭菌批次 ${batchId} 规则调整（rev ${b.revision}）：有效期 ${b.validHours}h${b.revoked ? "，已作废" : ""}`
    );
    invalidateByBatch(batchId);
    commit();
  },

  adjustRule(channelId: string, minPa: number) {
    const r = ruleOf(state, channelId);
    r.minPa = minPa;
    r.version += 1;
    r.updatedAt = state.now;
    log(state, "rule", `压差规则 ${r.id} 调整为 ≥ ${minPa}Pa（v${r.version}）`);
    invalidateByRule(channelId);
    commit();
  },

  setPressure(channelId: string, pa: number) {
    const c = state.channels.find((x) => x.id === channelId)!;
    c.pressurePa = pa;
    const r = ruleOf(state, channelId);
    log(
      state,
      pa < r.minPa ? "warn" : "info",
      `${channelId} 实时压差 ${pa}Pa${pa < r.minPa ? `，低于规则下限 ${r.minPa}Pa，外门将阻挡` : ""}`,
      pa < r.minPa ? "PRESSURE_FAIL" : undefined
    );
    drainQueue(state, channelId);
    commit();
  },

  resolveAnomaly(channelId: string) {
    const c = state.channels.find((x) => x.id === channelId)!;
    c.openAnomaly = null;
    log(state, "info", `${channelId} 未结异常已关闭，复检待处理队列`);
    drainQueue(state, channelId);
    commit();
  },

  toggleLink() {
    state.linkDown = !state.linkDown;
    commit();
  },
};

function finishDecision(
  d: ReturnType<typeof evaluate>,
  permit: Permit,
  channel: Channel,
  gate: Gate,
  _offline: boolean
) {
  if (d.outcome === "allow") {
    applyEntry(state, permit, channel, gate, false);
    log(state, "info", `许可 ${permit.id} 外门放行，进入 ${channel.id}（互锁锁定）`);
  } else if (d.outcome === "queue") {
    permit.lastBlock = d.code;
    if (!state.queue.some((q) => q.permitId === permit.id)) {
      state.queue.push({
        permitId: permit.id,
        channelId: channel.id,
        queuedAt: state.now,
      });
    }
    log(state, "queue", reasonText(d.code, d.detail), d.code, d.detail);
  } else {
    permit.lastBlock = d.code;
    log(state, "block", reasonText(d.code, d.detail), d.code, d.detail);
  }
}

// 离线流水回传：按许可编号合并；同字段双方都改 → 两版保留待裁决；进入事件按当前中央规则复核
function mergeEvent(state: State, gate: Gate, e: GateEvent) {
  const permit = state.permits.find((p) => p.id === e.permitId);
  const channel = state.channels.find((c) => c.id === gate.channelId)!;

  if (e.type === "ENTER") {
    if (e.localBlock) {
      log(
        state,
        "block",
        `回传补记·离线外门拦截 ${e.permitId}：${reasonText(e.localBlock, e.detail)}`,
        e.localBlock,
        e.detail
      );
      if (permit) permit.lastBlock = e.localBlock;
      return;
    }
    if (!permit) {
      log(state, "warn", `回传流水对应许可不存在：${e.permitId}，跳过`);
      return;
    }
    if (permit.status === "used" || permit.status === "exited") {
      // 已进入的通行不能再次开门：重复 ENTER 只记追溯
      log(
        state,
        "block",
        `离线重复放行 ${permit.id} 已被拒绝合并（该通行此前已进入）`,
        "PERMIT_USED"
      );
      return;
    }
    if (permit.status === "conflict") {
      log(state, "warn", `许可 ${permit.id} 字段冲突待裁决，离线进入暂缓生效`);
      return;
    }
    // 用当前中央数据复核离线期间的放行
    const d = evaluate({
      now: state.now,
      permit,
      channel,
      gate,
      people: state.people,
      materials: state.materials,
      batches: state.batches,
      pressureRule: ruleOf(state, channel.id),
      queue: state.queue,
    });
    if (d.outcome === "allow") {
      if (channel.occupiedByPermitId && channel.occupiedByPermitId !== permit.id) {
        channel.openAnomaly = {
          reason: `离线回传发现与 ${channel.occupiedByPermitId} 双重占用，待核查`,
          at: state.now,
        };
        log(state, "warn", `离线进入 ${permit.id} 与中央占用冲突，已登记通道异常`);
      }
      applyEntry(state, permit, channel, gate, true, e.at);
      log(state, "sync", `离线进入 ${permit.id} 复核通过，已按编号合并（实际进入 ${new Date(e.at).toLocaleString("zh-CN", { hour12: false })}）`);
    } else {
      // 人已物理进入但中央条件不满足：登记事实 + 挂异常阻断后续
      applyEntry(state, permit, channel, gate, true, e.at);
      channel.openAnomaly = {
        reason: `离线进入 ${permit.id} 复核未过（${BLOCK_REASONS[d.code].label}），待班长处理`,
        at: state.now,
      };
      permit.lastBlock = d.code;
      log(
        state,
        "block",
        `离线进入 ${permit.id} 复核未过：${reasonText(d.code, "detail" in d ? d.detail : "")}，已登记通道异常，后续通行进入队列`,
        d.code
      );
    }
  } else if (e.type === "EXIT") {
    if (permit && permit.status === "used") {
      permit.status = "exited";
      permit.exitedAt = e.at;
      if (channel.occupiedByPermitId === permit.id)
        channel.occupiedByPermitId = null;
      log(state, "sync", `离线离开 ${permit.id} 已合并，互锁复位`);
    } else {
      log(state, "sync", `离线离开事件 ${e.permitId} 无需合并（当前状态）`);
    }
  } else if (e.type === "EDIT_NOTE") {
    if (!permit) return;
    if (permit.note !== e.baseNote) {
      // 双方改过同一字段 → 两版都保留，挂冲突等班长裁决
      const conflict: FieldConflict = {
        id: `CF-${String(conflictSeq++).padStart(3, "0")}`,
        permitId: permit.id,
        gateId: gate.id,
        field: "note",
        centerValue: permit.note,
        gateValue: e.value,
        at: state.now,
      };
      state.conflicts.unshift(conflict);
      permit.status = "conflict";
      log(
        state,
        "block",
        `许可 ${permit.id} 备注双方都改过：两版已保留（冲突 ${conflict.id}），等待班长裁决`,
        "PERMIT_CONFLICT",
        conflict.id
      );
    } else {
      permit.note = e.value;
      log(state, "sync", `门控端备注修改已合并：${permit.id}`);
    }
  } else if (e.type === "ENQUEUE") {
    if (!state.queue.some((q) => q.permitId === e.permitId)) {
      state.queue.push({
        permitId: e.permitId,
        channelId: channel.id,
        queuedAt: e.at,
      });
    }
    if (permit) permit.lastBlock = e.code;
    log(state, "queue", `回传补记·离线排队 ${e.permitId}：${reasonText(e.code, e.detail)}`, e.code, e.detail);
  }
}

// 规则调整 → 已签发许可立即失效（进入中的不受影响）
function invalidateByRule(channelId: string) {
  for (const p of state.permits) {
    if (p.channelId !== channelId) continue;
    if (p.status !== "issued") continue;
    p.status = "reconfirm";
    p.lastBlock = "NEED_RECONFIRM";
    p.reconfirmFailReason = `压差规则 ${ruleOf(state, channelId).id} 已调整`;
    log(state, "rule", `许可 ${p.id} 因压差规则调整即时失效，待重新确认`, "NEED_RECONFIRM");
  }
}

function invalidateByBatch(batchId: string) {
  for (const p of state.permits) {
    if (p.status !== "issued") continue;
    const uses = p.materialIds.some(
      (mid) => state.materials.find((m) => m.id === mid)?.batchId === batchId
    );
    if (!uses) continue;
    p.status = "reconfirm";
    p.lastBlock = "NEED_RECONFIRM";
    p.reconfirmFailReason = `灭菌批次 ${batchId} 已调整`;
    log(state, "rule", `许可 ${p.id} 携带物料属批次 ${batchId}，许可即时失效，待重新确认`, "NEED_RECONFIRM");
  }
}

// ====== Hooks / 选择器 ======
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(state),
    () => selector(state)
  );
}

export { localOccupancy, reasonText };
export type { State };
