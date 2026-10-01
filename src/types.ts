// ====== 洁净室互锁门禁：领域模型 ======

export type Role = "operator" | "leader";

export type Person = {
  id: string;
  name: string;
  team: string; // 班组/单位
  certified: boolean; // 洁净培训是否有效
};

export type Room = {
  id: string;
  name: string;
  iso: string; // ISO 5 / ISO 6 / 黄光区
  pressurePa: number; // 相对走廊实时压差
};

export type PressureRule = {
  id: string; // PR-01 ...
  channelId: string;
  minPa: number; // 准入最低压差
  version: number; // 调整一次 +1
  updatedAt: number;
};

export type SterBatch = {
  id: string; // ST-20260920-03
  sterilizedAt: number;
  validHours: number; // 灭菌有效期
  revoked: boolean; // 批次作废
  revision: number; // 有效期/作废调整 +1
};

export type Material = {
  id: string;
  name: string;
  batchId: string;
};

export type Channel = {
  id: string; // A-01
  name: string;
  gateId: string; // 对应门控
  roomIds: string[];
  maxGroups: 1; // 互锁：同时只允许一组
  occupiedByPermitId: string | null;
  pressurePa: number; // 关键房间实时压差
  openAnomaly: { reason: string; at: number } | null; // 未结异常
};

// 许可签发时绑定的规则指纹：压差规则版本 + 全部携带物料批次修订号
export type RuleSignature = {
  pressureVersion: number;
  batchRevisions: Record<string, number>;
};

// issued 有效；reconfirm 规则变更后待重新确认；used 已进入（不得再开）；
// exited 已离开；expired 超时；voided 手动吊销；conflict 离线字段冲突待裁决
export type PermitStatus =
  | "issued"
  | "reconfirm"
  | "used"
  | "exited"
  | "expired"
  | "voided"
  | "conflict";

export type Permit = {
  id: string; // XK-20261001-001
  personIds: string[];
  channelId: string;
  materialIds: string[];
  validFrom: number;
  validUntil: number;
  status: PermitStatus;
  signature: RuleSignature;
  note: string; // 现场备注（离线可编辑 → 回传可能与中央改的同一字段冲突）
  enteredAt: number | null;
  exitedAt: number | null;
  enteredOffline: boolean; // 离线期间进入，回传需复核
  lastBlock?: BlockCode;
  reconfirmFailReason?: string;
};

export type Gate = {
  id: string; // GATE-01
  channelId: string;
  online: boolean;
  // 离线本地缓存的许可快照
  snapshot: Record<string, Permit>;
  // 门控最后同步到的判定上下文（人员资质/物料批次/压差规则/通道状态均冻结于此）
  cache: GateCache | null;
  localQueue: string[]; // 离线本地排队的许可编号
  usedPermitIds: string[]; // 本地已放行，防止离线重复开门
  journal: GateEvent[]; // 离线期间事件流水
  journalSeq: number;
  lastSyncAt: number | null;
};

export type GateCache = {
  at: number;
  people: Person[];
  materials: Material[];
  batches: Record<string, SterBatch>;
  rule: PressureRule;
  pressurePa: number;
  openAnomaly: Channel["openAnomaly"];
};

// gate 本地事件：进入 / 离开 / 备注编辑（双方都可能改 note）/ 排队
export type GateEvent =
  | {
      seq: number;
      gateId: string;
      permitId: string;
      type: "ENTER";
      at: number;
      localBlock?: BlockCode;
      detail?: string;
      ack: boolean;
    }
  | {
      seq: number;
      gateId: string;
      permitId: string;
      type: "EXIT";
      at: number;
      ack: boolean;
    }
  | {
      seq: number;
      gateId: string;
      permitId: string;
      type: "EDIT_NOTE";
      at: number;
      baseNote: string; // 门控侧编辑时所依据的备注
      value: string;
      ack: boolean;
    }
  | {
      seq: number;
      gateId: string;
      permitId: string;
      type: "ENQUEUE";
      at: number;
      code: BlockCode;
      detail: string;
      ack: boolean;
    };

export type FieldConflict = {
  id: string;
  permitId: string;
  gateId: string;
  field: "note";
  centerValue: string;
  gateValue: string;
  at: number;
  resolved?: "center" | "gate";
  resolvedAt?: number;
};

export type QueueItem = {
  permitId: string;
  channelId: string;
  queuedAt: number;
};

export type AuditEvent = {
  id: number;
  at: number;
  level: "info" | "block" | "queue" | "warn" | "rule" | "sync";
  text: string;
  code?: BlockCode;
  detail?: string;
};

// 回传批次：按门分批重试，记录每批完成到哪条流水
export type SyncBatch = {
  id: string;
  gateId: string;
  total: number;
  doneSeqs: number[];
  status: "pending" | "partial" | "done" | "failed";
  lastError: string;
  attempts: number;
  at: number;
};

// ====== 阻挡原因：操作页与追溯记录共用同一份字典 ======
export type BlockCode =
  | "GATE_OFFLINE"
  | "PERMIT_NOT_FOUND"
  | "PERMIT_REVOKED"
  | "PERMIT_EXPIRED"
  | "PERMIT_USED"
  | "PERMIT_CONFLICT"
  | "NEED_RECONFIRM"
  | "PERSON_INVALID"
  | "MATERIAL_EXPIRED"
  | "MATERIAL_BATCH_REVOKED"
  | "PRESSURE_FAIL"
  | "CHANNEL_OCCUPIED"
  | "ANOMALY_OPEN";

export type Decision =
  | { outcome: "allow" }
  | { outcome: "deny"; code: BlockCode; detail: string }
  | { outcome: "queue"; code: BlockCode; detail: string };

export type EvalContext = {
  now: number;
  permit?: Permit;
  channel: Channel;
  gate: Gate;
  people: Person[];
  materials: Material[];
  batches: Record<string, SterBatch>;
  pressureRule: PressureRule;
  queue: QueueItem[];
  // 该许可是否已在队列中（队列复检时占用不再重复排队）
  alreadyQueued?: boolean;
};
