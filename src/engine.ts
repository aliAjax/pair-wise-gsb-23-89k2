import type {
  BlockCode,
  Decision,
  EvalContext,
  Permit,
  RuleSignature,
  SterBatch,
} from "./types";

// ====== 阻挡原因字典：操作页与追溯记录必须渲染同一份文案 ======
export const BLOCK_REASONS: Record<
  BlockCode,
  { label: string; message: (detail: string) => string; kind: "hard" | "wait" }
> = {
  GATE_OFFLINE: {
    label: "门控离线",
    message: (d) => `门控离线，在线指令无法送达外门（${d}）`,
    kind: "hard",
  },
  PERMIT_NOT_FOUND: {
    label: "无此许可",
    message: (d) => `许可编号不存在或未下发到该门：${d}`,
    kind: "hard",
  },
  PERMIT_REVOKED: {
    label: "许可已吊销",
    message: (d) => `许可已吊销，禁止进入（${d}）`,
    kind: "hard",
  },
  PERMIT_EXPIRED: {
    label: "许可超时",
    message: (d) => `通行许可已超过有效时段（${d}）`,
    kind: "hard",
  },
  PERMIT_USED: {
    label: "许可已使用",
    message: () => "该许可已完成一次进入，通行不可重复开门",
    kind: "hard",
  },
  PERMIT_CONFLICT: {
    label: "字段冲突待裁决",
    message: (d) => `离线回传同一字段存在两个版本，等待班长裁决（${d}）`,
    kind: "hard",
  },
  NEED_RECONFIRM: {
    label: "规则已变更·待重新确认",
    message: (d) => `签发后灭菌批次或压差规则有调整，许可已即时失效，重新确认通过前不能进入（${d}）`,
    kind: "hard",
  },
  PERSON_INVALID: {
    label: "人员资质失效",
    message: (d) => `随行人员洁净资质失效：${d}`,
    kind: "hard",
  },
  MATERIAL_EXPIRED: {
    label: "物料灭菌过期",
    message: (d) => `物料超过灭菌有效期，停在外门：${d}`,
    kind: "hard",
  },
  MATERIAL_BATCH_REVOKED: {
    label: "灭菌批次作废",
    message: (d) => `物料所属灭菌批次已作废，停在外门：${d}`,
    kind: "hard",
  },
  PRESSURE_FAIL: {
    label: "压差不合格",
    message: (d) => `通道压差不合格，停在外门：${d}`,
    kind: "hard",
  },
  CHANNEL_OCCUPIED: {
    label: "通道满载（互锁）",
    message: (d) => `同一互锁通道内已有一组人员，本许可进入待处理队列：${d}`,
    kind: "wait",
  },
  ANOMALY_OPEN: {
    label: "异常未结",
    message: (d) => `通道存在未结异常，进入待处理队列：${d}`,
    kind: "wait",
  },
};

export const HOUR = 3600_000;
export const MINUTE = 60_000;

export function batchExpiry(b: SterBatch): number {
  return b.sterilizedAt + b.validHours * HOUR;
}

export function formatClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export function materialExpiryText(b: SterBatch): string {
  return `灭菌于 ${formatClock(b.sterilizedAt)}，有效期 ${b.validHours}h，至 ${formatClock(
    batchExpiry(b)
  )}`;
}

// 签发时按当时的压差规则版本与批次修订号打指纹
export function buildSignature(
  pressureVersion: number,
  materialIds: string[],
  materials: { id: string; batchId: string }[],
  batches: Record<string, SterBatch>
): RuleSignature {
  const batchRevisions: Record<string, number> = {};
  for (const m of materials) {
    if (materialIds.includes(m.id) && batches[m.batchId]) {
      batchRevisions[m.batchId] = batches[m.batchId].revision;
    }
  }
  return { pressureVersion, batchRevisions };
}

export function signatureStale(
  sig: RuleSignature,
  ruleVersion: number,
  materialIds: string[],
  materials: { id: string; batchId: string }[],
  batches: Record<string, SterBatch>
): boolean {
  if (sig.pressureVersion !== ruleVersion) return true;
  for (const m of materials) {
    if (!materialIds.includes(m.id)) continue;
    const b = batches[m.batchId];
    if (!b) continue;
    if ((sig.batchRevisions[m.batchId] ?? -1) !== b.revision) return true;
  }
  return false;
}

function deny(code: BlockCode, detail = ""): Decision {
  return { outcome: "deny", code, detail };
}

// ====== 外门准入评估：人员/房间/物料/灭菌有效期/压差/互锁/队列 全部接起来 ======
export function evaluate(ctx: EvalContext): Decision {
  const { now, permit, channel, gate, people, materials, batches, pressureRule } =
    ctx;

  if (!gate.online) return deny("GATE_OFFLINE", gate.id);
  if (!permit) return deny("PERMIT_NOT_FOUND", "");
  if (permit.status === "voided") return deny("PERMIT_REVOKED", permit.id);
  if (permit.status === "used") return deny("PERMIT_USED", permit.id);
  if (permit.status === "exited") return deny("PERMIT_USED", permit.id);
  if (permit.status === "conflict") return deny("PERMIT_CONFLICT", permit.id);
  if (now > permit.validUntil || permit.status === "expired")
    return deny("PERMIT_EXPIRED", `${formatClock(permit.validUntil)} 截止`);
  if (permit.status === "reconfirm")
    return deny(
      "NEED_RECONFIRM",
      `许可 ${permit.id}，${permit.reconfirmFailReason ?? "待重新确认"}`
    );

  // 人员资质
  const bad = permit.personIds
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !p?.certified)
    .map((p) => p.name);
  if (bad.length) return deny("PERSON_INVALID", bad.join("、"));

  // 物料：灭菌批次作废 / 超过灭菌有效期 → 停在外门
  for (const mid of permit.materialIds) {
    const m = materials.find((x) => x.id === mid);
    if (!m) continue;
    const b = batches[m.batchId];
    if (b?.revoked)
      return deny("MATERIAL_BATCH_REVOKED", `${m.name} / ${b.id}`);
    if (b && now > batchExpiry(b))
      return deny(
        "MATERIAL_EXPIRED",
        `${m.name}（${b.id}，${formatClock(batchExpiry(b))} 到期）`
      );
  }

  // 压差：规则下限 vs 通道实时值
  if (channel.pressurePa < pressureRule.minPa)
    return deny(
      "PRESSURE_FAIL",
      `实测 ${channel.pressurePa}Pa < 规则 ${pressureRule.id} 下限 ${pressureRule.minPa}Pa`
    );

  // 未结异常 → 待处理队列（不算硬拒，结异常后自动放行）
  if (channel.openAnomaly)
    return {
      outcome: "queue",
      code: "ANOMALY_OPEN",
      detail: `${channel.id} · ${channel.openAnomaly.reason}`,
    };

  // 互锁：同一通道同时只允许一组 → 队列
  if (
    channel.occupiedByPermitId &&
    channel.occupiedByPermitId !== permit.id
  ) {
    const occ = channel.occupiedByPermitId;
    return {
      outcome: "queue",
      code: "CHANNEL_OCCUPIED",
      detail: `当前在内：${occ}`,
    };
  }

  return { outcome: "allow" };
}

export function permitBlockedFromEnter(p: Permit): boolean {
  return ["voided", "used", "exited", "expired", "conflict", "reconfirm"].includes(
    p.status
  );
}
