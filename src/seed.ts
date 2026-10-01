import type {
  Channel,
  Gate,
  Material,
  Person,
  PressureRule,
  SterBatch,
} from "./types";
import { HOUR } from "./engine";

// 演示时间从 2026-10-01 08:00 起步，之后用真实流逝毫秒推进
export const T0 = new Date(2026, 9, 1, 8, 0, 0).getTime();

export const seedPeople: Person[] = [
  { id: "P-01", name: "张磊", team: "刻蚀工艺一班", certified: true },
  { id: "P-02", name: "李薇", team: "刻蚀工艺一班", certified: true },
  { id: "P-03", name: "王强", team: "黄光工艺二班", certified: true },
  { id: "P-04", name: "赵敏", team: "黄光工艺二班", certified: false }, // 资质失效，演示人员拦截
  { id: "P-05", name: "陈晨", team: "厂务", certified: true },
];

export const seedBatches: Record<string, SterBatch> = {
  // 有效期内
  "ST-20260930-07": {
    id: "ST-20260930-07",
    sterilizedAt: T0 - 20 * HOUR,
    validHours: 48,
    revoked: false,
    revision: 1,
  },
  // 即将于 09:00 过期（签发时 08:00 未过期，进入时可能已过期 → 现场拦截）
  "ST-20260929-02": {
    id: "ST-20260929-02",
    sterilizedAt: T0 - 23 * HOUR,
    validHours: 24, // 08:00 签发，09:00 到期
    revoked: false,
    revision: 1,
  },
  // 批次作废
  "ST-20260928-11": {
    id: "ST-20260928-11",
    sterilizedAt: T0 - 60 * HOUR,
    validHours: 72,
    revoked: true,
    revision: 2,
  },
};

export const seedMaterials: Material[] = [
  { id: "M-01", name: "12寸石英环", batchId: "ST-20260930-07" },
  { id: "M-02", name: "光刻胶分装瓶", batchId: "ST-20260929-02" },
  { id: "M-03", name: "备用密封件", batchId: "ST-20260928-11" },
  { id: "M-04", name: "洁净擦拭布", batchId: "ST-20260930-07" },
];

export const seedChannels: Channel[] = [
  {
    id: "A-01",
    name: "一更 → CR-1201（ISO 5 刻蚀区）",
    gateId: "GATE-01",
    roomIds: ["CR-1201"],
    maxGroups: 1,
    occupiedByPermitId: null,
    pressurePa: 18,
    openAnomaly: null,
  },
  {
    id: "B-02",
    name: "二更 → Y-0302（黄光区）",
    gateId: "GATE-02",
    roomIds: ["Y-0302"],
    maxGroups: 1,
    occupiedByPermitId: null,
    pressurePa: 12,
    openAnomaly: { reason: "风淋门密封条异响（工单 WO-7781）", at: T0 - 40 * 60000 },
  },
];

export const seedRules: PressureRule[] = [
  { id: "PR-01", channelId: "A-01", minPa: 15, version: 1, updatedAt: T0 },
  { id: "PR-02", channelId: "B-02", minPa: 10, version: 1, updatedAt: T0 },
];

export function makeGate(g: { id: string; channelId: string; online: boolean }): Gate {
  return {
    ...g,
    snapshot: {},
    cache: null,
    localQueue: [],
    usedPermitIds: [],
    journal: [],
    journalSeq: 0,
    lastSyncAt: null,
  };
}
