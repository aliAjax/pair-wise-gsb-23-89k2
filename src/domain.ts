import type {
  AppState,
  Material,
  Permit,
  ReasonCode,
  ReasonContext,
  SterBatch,
} from "./types";

// 所有阻挡原因统一从此函数出文案，操作页 / 待处理队列 / 追溯记录看到的是同一句话
export function reasonText(code: ReasonCode, ctx: ReasonContext = {}): string {
  switch (code) {
    case "MATERIAL_EXPIRED":
      return `物料「${ctx.materialName ?? "未知物料"}」灭菌批次 ${ctx.batchId ?? "-"} 有效期至 ${ctx.validUntil ?? "-"} 已过期，停在外门`;
    case "PRESSURE_FAIL":
      return `${ctx.roomName ?? "目标房间"}压差 ${ctx.actual ?? "-"}Pa 不符合要求（要求 ≥${ctx.min ?? "-"}Pa 且 ≤${ctx.max ?? "-"}Pa），停在外门`;
    case "CHANNEL_OCCUPIED":
      return `互锁通道被「${ctx.groupName ?? "其他人员"}」占用，同一通道同时只允许一组人员，进入待处理队列`;
    case "ANOMALY_OPEN":
      return `通道异常未结（${ctx.anomalyNote ?? ctx.detail ?? "未填写"}），禁止进入，进入待处理队列`;
    case "PERMIT_STALE":
      return `通行许可已失效待重新确认：${ctx.detail ?? "规则已调整"}，未通过前不能进入`;
    case "PERMIT_CONSUMED":
      return `该许可已进入（许可编号 ${ctx.detail ?? ""}），通行不可重复开门，门控重复放行请求已驳回`;
    case "PERMIT_CONFLICT":
      return `字段「${ctx.fieldLabel ?? ""}」中心=${ctx.serverValue ?? "-"} / 门控=${ctx.gateValue ?? "-"}，双方各改一版，已暂扣等待班长裁决`;
  }
}

export const QUEUEABLE: ReasonCode[] = ["CHANNEL_OCCUPIED", "ANOMALY_OPEN"];

export function isExpired(batch: SterBatch, now: Date): boolean {
  const end = new Date(batch.validUntil + "T23:59:59");
  return end.getTime() < now.getTime();
}

export function materialExpired(
  material: Material,
  batches: Record<string, SterBatch>,
  now: Date,
): { batch: SterBatch; expired: boolean } | undefined {
  const batch = batches[material.batchId];
  if (!batch) return undefined;
  return { batch, expired: isExpired(batch, now) };
}

export function pressureFail(actual: number, rule: { minPa: number; maxPa: number }): boolean {
  return actual < rule.minPa || actual > rule.maxPa;
}

export interface GateCheckResult {
  ok: boolean;
  code?: ReasonCode;
  ctx: ReasonContext;
}

// 外门统一判定：许可状态 → 物料灭菌有效期 → 房间压差 → 通道异常 → 互锁占用
// 前两项是硬性停在外门；通道满载/异常进入待处理队列
export function checkOuter(
  s: Pick<
    AppState,
    "groups" | "permits" | "rooms" | "channels" | "materials" | "batches" | "rules" | "occupancy"
  >,
  permit: Permit,
  channelId: string,
  now: Date,
): GateCheckResult {
  if (permit.status === "conflict" && permit.conflict && !permit.conflict.resolved) {
    const c = permit.conflict;
    return {
      ok: false,
      code: "PERMIT_CONFLICT",
      ctx: { fieldLabel: c.fieldLabel, serverValue: c.serverValue, gateValue: c.gateValue },
    };
  }
  if (permit.status === "stale") {
    return { ok: false, code: "PERMIT_STALE", ctx: { detail: permit.staleText ?? "规则已调整" } };
  }
  if (permit.status === "entered") {
    return { ok: false, code: "PERMIT_CONSUMED", ctx: { detail: permit.permitNo } };
  }

  const batchesById: Record<string, SterBatch> = {};
  s.batches.forEach((b) => (batchesById[b.id] = b));

  for (const mid of permit.materialIds) {
    const material = s.materials.find((m) => m.id === mid);
    if (!material) continue;
    const check = materialExpired(material, batchesById, now);
    if (check?.expired) {
      return {
        ok: false,
        code: "MATERIAL_EXPIRED",
        ctx: { materialName: material.name, batchId: check.batch.id, validUntil: check.batch.validUntil },
      };
    }
  }

  const room = s.rooms.find((r) => r.id === permit.roomId)!;
  const rule = s.rules[room.id];
  if (pressureFail(room.pressurePa, rule)) {
    return {
      ok: false,
      code: "PRESSURE_FAIL",
      ctx: { roomName: room.name, actual: room.pressurePa, min: rule.minPa, max: rule.maxPa },
    };
  }

  const channel = s.channels.find((c) => c.id === channelId)!;
  if (channel.anomalyOpen) {
    return { ok: false, code: "ANOMALY_OPEN", ctx: { anomalyNote: channel.anomalyNote } };
  }

  const occ = s.occupancy[channelId];
  if (occ) {
    const occGroup = s.groups.find((g) => g.id === occ.groupId);
    return { ok: false, code: "CHANNEL_OCCUPIED", ctx: { groupName: occGroup?.name ?? occ.groupId } };
  }

  return { ok: true, ctx: {} };
}

// 重新确认（规则调整后的再校验）：只跑物料有效期 + 压差
export function revalidate(
  s: Pick<AppState, "rooms" | "materials" | "batches" | "rules">,
  permit: Permit,
  now: Date,
): GateCheckResult {
  const batchesById: Record<string, SterBatch> = {};
  s.batches.forEach((b) => (batchesById[b.id] = b));
  for (const mid of permit.materialIds) {
    const material = s.materials.find((m) => m.id === mid);
    if (!material) continue;
    const check = materialExpired(material, batchesById, now);
    if (check?.expired) {
      return {
        ok: false,
        code: "MATERIAL_EXPIRED",
        ctx: { materialName: material.name, batchId: check.batch.id, validUntil: check.batch.validUntil },
      };
    }
  }
  const room = s.rooms.find((r) => r.id === permit.roomId)!;
  const rule = s.rules[room.id];
  if (pressureFail(room.pressurePa, rule)) {
    return {
      ok: false,
      code: "PRESSURE_FAIL",
      ctx: { roomName: room.name, actual: room.pressurePa, min: rule.minPa, max: rule.maxPa },
    };
  }
  return { ok: true, ctx: {} };
}

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "有效", cls: "ok" },
  stale: { label: "失效待确认", cls: "warn" },
  entered: { label: "已进入", cls: "muted" },
  conflict: { label: "冲突待裁决", cls: "danger" },
};
