// 洁净室门禁联动领域模型

export type PermitStatus = "active" | "stale" | "entered" | "conflict";

export interface Person {
  id: string;
  name: string;
  role: string;
}

export interface Group {
  id: string;
  name: string;
  memberIds: string[];
}

export interface SterBatch {
  id: string;
  name: string;
  sterilizedAt: string; // yyyy-MM-dd
  validUntil: string; // yyyy-MM-dd 灭菌有效期
  version: number; // 批次规则版本，调整即 +1
}

export interface Material {
  id: string;
  name: string;
  batchId: string;
}

export interface Channel {
  id: string;
  name: string;
  outerDoorId: string;
  innerDoorId: string;
  anomalyOpen: boolean;
  anomalyNote?: string;
}

export interface Room {
  id: string;
  name: string;
  className: string;
  channelId: string;
  pressurePa: number; // 实时压差读数
}

export interface PressureRule {
  roomId: string;
  minPa: number;
  maxPa: number;
  version: number; // 压差规则版本，调整即 +1
}

export interface ConflictInfo {
  field: string;
  fieldLabel: string;
  serverValue: string;
  gateValue: string;
  resolved?: "server" | "gate";
}

export interface Permit {
  permitNo: string; // 许可编号，回传合并主键
  groupId: string;
  roomId: string;
  materialIds: string[];
  status: PermitStatus;
  issuedAt: string;
  // 签发时冻结的规则/批次版本快照
  ruleVersion: number;
  batchVersions: Record<string, number>;
  staleText?: string;
  conflict?: ConflictInfo;
  note?: string; // 随行备注（断网期间双方可能同改的字段示例）
}

export interface Occupant {
  permitNo: string;
  groupId: string;
  stage: "airlock" | "room";
  outerOpen?: boolean; // 外门开启、人员尚未完全进入互锁区
  innerOpen?: boolean; // 内门开启中
  since: string;
}

export type ReasonCode =
  | "MATERIAL_EXPIRED"
  | "PRESSURE_FAIL"
  | "CHANNEL_OCCUPIED"
  | "ANOMALY_OPEN"
  | "PERMIT_STALE"
  | "PERMIT_CONSUMED"
  | "PERMIT_CONFLICT";

export interface ReasonContext {
  materialName?: string;
  batchId?: string;
  validUntil?: string;
  roomName?: string;
  actual?: number;
  min?: number;
  max?: number;
  groupName?: string;
  anomalyNote?: string;
  detail?: string;
  fieldLabel?: string;
  serverValue?: string;
  gateValue?: string;
}

export type GateEventKind = "outer" | "airlock" | "room";

export interface GateEvent {
  id: string; // 门动作幂等键
  permitNo: string;
  channelId: string;
  kind: GateEventKind;
  dup?: boolean; // 离线重复刷卡（门控误放行）
  at: string;
  gateDecision: "pass" | "block"; // 门控按本地缓存快照的判定
  gateReasonCode?: ReasonCode;
  gateReasonText?: string;
  // queued 待回传 / held 冲突暂扣 / acked 服务端确认 / rejected 服务端驳回（停在外门）
  state: "queued" | "held" | "acked" | "rejected";
  applied?: boolean; // 服务端是否真正执行了门动作
  batchId?: string;
  serverReasonCode?: ReasonCode;
  resultText?: string;
}

export interface SyncBatch {
  id: string;
  eventIds: string[];
  state: "failed" | "acked";
  attempts: number;
  error?: string;
  at: string;
}

export interface QueueEntry {
  id: string;
  permitNo: string;
  channelId: string;
  reasonCode: ReasonCode; // 与追溯记录共用同一原因码/文案
  reasonText: string;
  at: string;
  status: "waiting" | "released" | "canceled";
}

export interface AuditEvent {
  id: string;
  at: string;
  level: "info" | "success" | "warn" | "danger";
  typeLabel: string;
  message: string;
  permitNo?: string;
  channelId?: string;
  reasonCode?: ReasonCode;
  reasonText?: string;
}

export interface FieldEdit {
  value: string;
  at: string;
}

// 断网期间门控缓存的中心数据快照（用于离线本地判定）
export type GateSnapshot = Pick<
  AppState,
  | "groups"
  | "permits"
  | "rooms"
  | "channels"
  | "materials"
  | "batches"
  | "rules"
  | "occupancy"
>;

export interface AppState {
  people: Person[];
  groups: Group[];
  batches: SterBatch[];
  materials: Material[];
  rooms: Room[];
  channels: Channel[];
  rules: Record<string, PressureRule>;
  permits: Permit[];
  occupancy: Record<string, Occupant | undefined>;
  queue: QueueEntry[];
  audit: AuditEvent[];
  online: boolean;
  gateCacheAt?: string;
  gateCache?: GateSnapshot;
  gateEvents: GateEvent[];
  syncBatches: SyncBatch[];
  failNext: boolean;
  // 断网窗口内双方对同一许可的字段修改（许可编号 -> 字段 -> 取值）
  serverEdits: Record<string, Record<string, FieldEdit>>;
  gateEdits: Record<string, Record<string, FieldEdit>>;
  processedResults: Record<string, string>; // 幂等：已处理门动作结果
  seq: { audit: number; queue: number; event: number; batch: number; permit: number };
}
