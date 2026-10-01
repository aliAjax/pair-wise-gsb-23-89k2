import type { AppState } from "./types";

const today = "2026-10-01";

export const now = () => new Date();

export function initialState(): AppState {
  return {
    online: true,
    people: [
      { id: "P01", name: "张敏", role: "巡检员" },
      { id: "P02", name: "李伟", role: "巡检员" },
      { id: "P03", name: "王芳", role: "厂务工程师" },
      { id: "P04", name: "陈晨", role: "操作员" },
      { id: "P05", name: "赵磊", role: "操作员" },
      { id: "P06", name: "孙倩", role: "班组长" },
    ],
    groups: [
      { id: "G1", name: "甲班一组", memberIds: ["P01", "P02"] },
      { id: "G2", name: "设备维护组", memberIds: ["P03"] },
      { id: "G3", name: "乙班二组", memberIds: ["P04", "P05"] },
    ],
    batches: [
      { id: "SB2609-020", name: "高温灭菌批", sterilizedAt: "2026-09-20", validUntil: "2026-10-04", version: 1 },
      { id: "SB2609-010", name: "高压灭菌批", sterilizedAt: "2026-09-10", validUntil: "2026-09-28", version: 1 },
      { id: "SB2609-025", name: "干热灭菌批", sterilizedAt: "2026-09-25", validUntil: "2026-10-09", version: 1 },
    ],
    materials: [
      { id: "MAT-A", name: "硅片周转框", batchId: "SB2609-020" },
      { id: "MAT-B", name: "光刻胶辅料瓶", batchId: "SB2609-010" },
      { id: "MAT-C", name: "掩膜版保护盒", batchId: "SB2609-025" },
    ],
    channels: [
      { id: "CH-A", name: "更衣互锁通道 A", outerDoorId: "OD-A1", innerDoorId: "ID-A1", anomalyOpen: false },
      { id: "CH-B", name: "气闸通道 B", outerDoorId: "OD-B1", innerDoorId: "ID-B1", anomalyOpen: false },
    ],
    rooms: [
      { id: "CR-1201", name: "光刻间 1201", className: "ISO 5", channelId: "CH-A", pressurePa: 18 },
      { id: "CR-2107", name: "刻蚀间 2107", className: "ISO 6", channelId: "CH-A", pressurePa: 15 },
      { id: "CR-3302", name: "清洗间 3302", className: "ISO 7", channelId: "CH-B", pressurePa: 12 },
    ],
    rules: {
      "CR-1201": { roomId: "CR-1201", minPa: 10, maxPa: 25, version: 1 },
      "CR-2107": { roomId: "CR-2107", minPa: 10, maxPa: 25, version: 1 },
      "CR-3302": { roomId: "CR-3302", minPa: 5, maxPa: 20, version: 1 },
    },
    permits: [
      {
        permitNo: "XK-20261001-001",
        groupId: "G1",
        roomId: "CR-2107",
        materialIds: ["MAT-A"],
        status: "active",
        issuedAt: `${today} 08:05`,
        ruleVersion: 1,
        batchVersions: { "SB2609-020": 1 },
      },
      {
        permitNo: "XK-20261001-002",
        groupId: "G2",
        roomId: "CR-1201",
        materialIds: ["MAT-B"],
        status: "active",
        issuedAt: `${today} 08:20`,
        ruleVersion: 1,
        batchVersions: { "SB2609-010": 1 },
      },
      {
        permitNo: "XK-20261001-003",
        groupId: "G3",
        roomId: "CR-3302",
        materialIds: ["MAT-C"],
        status: "active",
        issuedAt: `${today} 08:35`,
        ruleVersion: 1,
        batchVersions: { "SB2609-025": 1 },
      },
    ],
    occupancy: {},
    queue: [],
    audit: [
      {
        id: "AU-1000",
        at: `${today} 08:00`,
        level: "info",
        typeLabel: "系统",
        message: "门禁联动初始化：人员 6 名、通道 2 条、许可 3 张，规则版本 v1 已签发",
      },
    ],
    gateEvents: [],
    syncBatches: [],
    failNext: false,
    serverEdits: {},
    gateEdits: {},
    processedResults: {},
    seq: { audit: 1001, queue: 1, event: 1, batch: 1, permit: 4 },
  };
}
