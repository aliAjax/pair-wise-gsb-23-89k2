import { initialState } from "../src/seed";
import { reducer } from "../src/store";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

type S = ReturnType<typeof initialState>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(actions: any[], init: S = initialState()): S {
  return actions.reduce((s, a) => reducer(s, a), init);
}

const occ = (s: S, ch: string) => s.occupancy[ch];
const permit = (s: S, no: string) => s.permits.find((p) => p.permitNo === no)!;
const lastReason = (s: S) => s.audit.find((a) => a.reasonCode)?.reasonCode;

console.log("1. 过期物料停在外门，不开门、不入队");
{
  const s = run([{ type: "ONLINE_OUTER", permitNo: "XK-20261001-002" }]);
  check("阻挡码 MATERIAL_EXPIRED", lastReason(s) === "MATERIAL_EXPIRED", lastReason(s) ?? "");
  check("通道未占用", !occ(s, "CH-A"));
  check("不入待处理队列", s.queue.length === 0);
}

console.log("2. 压差不合格停在外门");
{
  const s = run([
    { type: "SET_PRESSURE", roomId: "CR-2107", pressurePa: 3 },
    { type: "ONLINE_OUTER", permitNo: "XK-20261001-001" },
  ]);
  check("阻挡码 PRESSURE_FAIL", lastReason(s) === "PRESSURE_FAIL", lastReason(s) ?? "");
  check("通道未占用", !occ(s, "CH-A"));
}

console.log("3. 互锁通道同刻一组 + 满载排队 + 离场后队列放行");
{
  let s = run([
    { type: "ONLINE_OUTER", permitNo: "XK-20261001-001" }, // G1 进 CH-A
    { type: "ONLINE_AIRLOCK", channelId: "CH-A" },
    { type: "ISSUE_PERMIT", groupId: "G2", roomId: "CR-1201", materialIds: ["MAT-A"] },
  ]);
  const newNo = s.permits[0].permitNo;
  s = reducer(s, { type: "ONLINE_OUTER", permitNo: newNo });
  check("第二组阻挡码 CHANNEL_OCCUPIED", lastReason(s) === "CHANNEL_OCCUPIED", lastReason(s) ?? "");
  check("进入待处理队列", s.queue.filter((q) => q.status === "waiting").length === 1);
  check("队列原因与追溯同源", s.queue[0].reasonText === s.audit.find((a) => a.reasonCode === "CHANNEL_OCCUPIED")!.reasonText);
  // 队首处理时通道仍占 -> 继续等待
  s = reducer(s, { type: "QUEUE_TICK" });
  check("通道仍占用，队列不放行", s.queue[0].status === "waiting");
  // 第一组离开，队列再推进
  s = reducer(s, { type: "ONLINE_ROOM", channelId: "CH-A" });
  s = reducer(s, { type: "EXIT", channelId: "CH-A" });
  s = reducer(s, { type: "QUEUE_TICK" });
  check("离场后队首放行并占用互锁", s.queue[0].status === "released" && occ(s, "CH-A")?.outerOpen === true);
}

console.log("4. 已进入的通行不能再次开门");
{
  const s = run([
    { type: "ONLINE_OUTER", permitNo: "XK-20261001-001" },
    { type: "ONLINE_AIRLOCK", channelId: "CH-A" },
    { type: "ONLINE_ROOM", channelId: "CH-A" },
    { type: "ONLINE_OUTER", permitNo: "XK-20261001-001" },
  ]);
  check("重复刷卡被 PERMIT_CONSUMED 驳回", lastReason(s) === "PERMIT_CONSUMED", lastReason(s) ?? "");
  check("许可仍为 entered", permit(s, "XK-20261001-001").status === "entered");
}

console.log("5. 压差规则调整，已签发许可立即失效，重新确认后才能进入");
{
  let s = run([{ type: "ADJUST_RULE", roomId: "CR-3302", minPa: 10, maxPa: 20 }]);
  check("许可 stale", permit(s, "XK-20261001-003").status === "stale");
  s = reducer(s, { type: "ONLINE_OUTER", permitNo: "XK-20261001-003" });
  check("失效许可外门拦截", lastReason(s) === "PERMIT_STALE");
  s = reducer(s, { type: "RECONFIRM", permitNo: "XK-20261001-003" });
  check("重新确认通过恢复 active", permit(s, "XK-20261001-003").status === "active");
  s = reducer(s, { type: "ONLINE_OUTER", permitNo: "XK-20261001-003" });
  check("确认后可进入", occ(s, "CH-B")?.permitNo === "XK-20261001-003");
}

console.log("6. 灭菌批次调整：关联许可失效；提前到过期日则重新确认也不通过");
{
  let s = run([{ type: "ADJUST_BATCH", batchId: "SB2609-025", validUntil: "2026-09-28" }]);
  check("批次 v2 许可 stale", permit(s, "XK-20261001-003").status === "stale");
  s = reducer(s, { type: "RECONFIRM", permitNo: "XK-20261001-003" });
  check("有效期已过，重新确认不通过（仍 stale）", permit(s, "XK-20261001-003").status === "stale");
  s = reducer(s, { type: "ADJUST_BATCH", batchId: "SB2609-025", validUntil: "2026-10-09" });
  s = reducer(s, { type: "RECONFIRM", permitNo: "XK-20261001-003" });
  check("改回有效日期后重新确认通过", permit(s, "XK-20261001-003").status === "active");
}

console.log("7. 离线完整行程回传：三事件按序合并，重复刷卡被驳回，不重复开门");
{
  let s = run([
    { type: "GO_OFFLINE" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-001" },
    { type: "GATE_AIRLOCK", channelId: "CH-A" },
    { type: "GATE_ROOM", channelId: "CH-A" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-001", dup: true },
    { type: "GO_ONLINE" },
    { type: "SYNC_BATCH" },
  ]);
  const byId = (id: string) => s.gateEvents.find((e) => e.id === id)!;
  // 列表最新在前：dup 最新，行程依次 room/airlock/outer
  const [dup, rEv, aEv, oEv] = s.gateEvents;
  check("三条行程事件首批全部 acked", [oEv.state, aEv.state, rEv.state].every((x) => x === "acked"));
  check("重复刷卡首批尚未回传（每批 3 条）", dup.state === "queued");
  check("中心占用已推进到 room", occ(s, "CH-A")?.stage === "room");
  check("中心许可核销 entered", permit(s, "XK-20261001-001").status === "entered");
  // 再同步把重复刷卡这批也回传（被幂等驳回），不补开门
  s = reducer(s, { type: "SYNC_BATCH" });
  check("重复刷卡回传后 rejected", byId(dup.id).state === "rejected" && byId(dup.id).serverReasonCode === "PERMIT_CONSUMED");
  check("不重复开门", occ(s, "CH-A")?.stage === "room");
  check("再无可回传事件", s.gateEvents.every((e) => e.state === "acked" || e.state === "rejected"));
}

console.log("8. 离线过期物料：门控本地即阻挡，回传中心不补开门");
{
  const s = run([
    { type: "GO_OFFLINE" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-002" },
    { type: "GO_ONLINE" },
    { type: "SYNC_BATCH" },
  ]);
  const ev = s.gateEvents[0];
  check("门控本地 block", ev.gateDecision === "block" && ev.gateReasonCode === "MATERIAL_EXPIRED");
  check("中心 rejected，不补开门", ev.state === "rejected" && !ev.applied && !occ(s, "CH-A"));
}

console.log("9. 双方同改一字段：保留两版、整组暂扣，班长裁决后放行/驳回");
{
  let s = run([
    { type: "GO_OFFLINE" },
    { type: "SERVER_EDIT_PERMIT", permitNo: "XK-20261001-003", note: "中心值A" },
    { type: "GATE_EDIT_PERMIT", permitNo: "XK-20261001-003", note: "门控值B" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-003" },
    { type: "GATE_AIRLOCK", channelId: "CH-B" },
    { type: "GATE_ROOM", channelId: "CH-B" },
    { type: "GO_ONLINE" },
    { type: "SYNC_BATCH" },
  ]);
  check("许可挂冲突", permit(s, "XK-20261001-003").status === "conflict");
  const c = permit(s, "XK-20261001-003").conflict!;
  check("两版都保留", c.serverValue === "中心值A" && c.gateValue === "门控值B");
  check("整组事件 held", s.gateEvents.every((e) => e.state === "held"));
  check("冲突未裁前门未开（中心无占用）", !occ(s, "CH-B"));
  // 裁决采用门控版 -> 事件补执行
  s = reducer(s, { type: "RESOLVE_CONFLICT", permitNo: "XK-20261001-003", winner: "gate" });
  const resolved = permit(s, "XK-20261001-003");
  check("采用门控版后事件补并入、人员在房间", occ(s, "CH-B")?.stage === "room");
  check("许可核销，冲突留档为已裁决", resolved.status === "entered" && !!resolved.conflict?.resolved);

  // 另一张许可裁决采用中心版 -> 离线门动作驳回
  let s2 = run([
    { type: "GO_OFFLINE" },
    { type: "SERVER_EDIT_PERMIT", permitNo: "XK-20261001-001", note: "S" },
    { type: "GATE_EDIT_PERMIT", permitNo: "XK-20261001-001", note: "G" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-001" },
    { type: "GO_ONLINE" },
    { type: "SYNC_BATCH" },
    { type: "RESOLVE_CONFLICT", permitNo: "XK-20261001-001", winner: "server" },
  ]);
  check("采用中心版：事件驳回、门没开", s2.gateEvents[0].state === "rejected" && !occ(s2, "CH-A"));
  check("许可转 stale 待重新确认", permit(s2, "XK-20261001-001").status === "stale");
  check("采用中心值", permit(s2, "XK-20261001-001").note === "S");
}

console.log("10. 批次回传失败后按批次重试，只补未完成门");
{
  let s = run([
    { type: "GO_OFFLINE" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-001" },
    { type: "GATE_AIRLOCK", channelId: "CH-A" },
    { type: "GATE_ROOM", channelId: "CH-A" },
    { type: "GATE_OUTER", permitNo: "XK-20261001-003" },
    { type: "GO_ONLINE" },
    { type: "TOGGLE_FAIL_NEXT" },
    { type: "SYNC_BATCH" },
  ]);
  check("批次失败", s.syncBatches[0].state === "failed" && s.syncBatches[0].attempts === 1);
  check("3 个事件带 batchId 未确认", s.gateEvents.filter((e) => e.batchId).length === 3);
  check("第 4 个事件未被卷入失败批次", s.gateEvents.find((e) => e.permitNo === "XK-20261001-003")!.batchId === undefined);
  // 重试成功：只发失败批次的 3 个
  s = reducer(s, { type: "SYNC_BATCH" });
  check("失败批次重试成功", s.syncBatches[0].state === "acked");
  check("只补了失败批次的 3 个门", s.gateEvents.filter((e) => e.state === "acked").length === 3);
  check("已进入不重复开门（中心一个 room 占用）", occ(s, "CH-A")?.stage === "room");
  check("第 4 个事件仍未回传", s.gateEvents.find((e) => e.permitNo === "XK-20261001-003")!.state === "queued");
  // 再传新批次
  s = reducer(s, { type: "SYNC_BATCH" });
  check("剩余 1 个事件进入新批次并确认", s.syncBatches.length === 2);
}

console.log("11. 通道异常未结进入队列，关闭后队列放行（同一原因三处可见）");
{
  let s = run([
    { type: "OPEN_ANOMALY", channelId: "CH-B", note: "门锁故障维修中" },
    { type: "ONLINE_OUTER", permitNo: "XK-20261001-003" },
  ]);
  check("阻挡码 ANOMALY_OPEN", lastReason(s) === "ANOMALY_OPEN");
  check("进入队列", s.queue[0].status === "waiting");
  s = reducer(s, { type: "QUEUE_TICK" });
  check("异常未结不放行", s.queue[0].status === "waiting");
  s = reducer(s, { type: "CLOSE_ANOMALY", channelId: "CH-B" });
  s = reducer(s, { type: "QUEUE_TICK" });
  check("异常关闭后放行", s.queue[0].status === "released" && !!occ(s, "CH-B"));
  const qText = s.queue.find((q) => q.status === "released")!.reasonText;
  const aText = s.audit.find((a) => a.reasonCode === "ANOMALY_OPEN")!.reasonText;
  check("队列与追溯原因一致", qText === aText);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
