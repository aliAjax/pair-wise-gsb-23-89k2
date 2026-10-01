import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCK_REASONS } from "./engine";

// 每个用例重新加载 store 模块，获得干净的初始状态
let api: typeof import("./store");

beforeEach(async () => {
  vi.resetModules();
  api = await import("./store");
});

function permits() {
  return [...api.store.getState().permits]; // 预置顺序即签发顺序 001..004
}

function gateFor(channelId: string) {
  return api.store.getState().gates.find((g) => g.channelId === channelId)!;
}

describe("外门准入规则", () => {
  it("正常许可可进入并锁定互锁，第二组排队，离开后自动放行", () => {
    const [p1] = permits();
    api.store.swipe(p1.id);
    let st = api.store.getState();
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("used");
    expect(st.channels.find((c) => c.id === "A-01")!.occupiedByPermitId).toBe(p1.id);

    // 新发第二组 A-01 许可
    api.store.issuePermit("A-01", ["P-05"], []);
    const second = api.store.getState().permits[0];
    api.store.swipe(second.id);
    st = api.store.getState();
    expect(st.queue.some((q) => q.permitId === second.id)).toBe(true);
    expect(st.permits.find((p) => p.id === second.id)!.status).toBe("issued");
    const qAudit = st.audit.find((a) => a.code === "CHANNEL_OCCUPIED");
    expect(qAudit?.text).toContain(BLOCK_REASONS.CHANNEL_OCCUPIED.label);

    // 第一组离开 → 互锁释放 → 队列自动放行
    api.store.exit(p1.id);
    st = api.store.getState();
    expect(st.queue.some((q) => q.permitId === second.id)).toBe(false);
    expect(st.permits.find((p) => p.id === second.id)!.status).toBe("used");
  });

  it("已进入的许可再次刷卡不能重复开门（PERMIT_USED）", () => {
    const [p1] = permits();
    api.store.swipe(p1.id);
    api.store.swipe(p1.id);
    const st = api.store.getState();
    expect(st.audit.filter((a) => a.code === "PERMIT_USED").length).toBe(1);
    expect(st.channels.find((c) => c.id === "A-01")!.occupiedByPermitId).toBe(p1.id);
  });

  it("物料灭菌过期停在外门并写明物料与到期时间", () => {
    const [, , p3] = permits(); // 携带 ST-20260929-02，09:00 到期
    api.store.tick(70); // 08:00 → 09:10
    api.store.swipe(p3.id);
    const st = api.store.getState();
    expect(st.permits.find((p) => p.id === p3.id)!.status).not.toBe("used");
    const block = st.audit.find((a) => a.code === "MATERIAL_EXPIRED");
    expect(block).toBeTruthy();
    expect(block!.text).toContain("光刻胶");
    expect(block!.text).toContain("停在外门");
  });

  it("灭菌批次已作废停在外门（MATERIAL_BATCH_REVOKED）", () => {
    const [, , , p4] = permits(); // M-03 属已作废批次
    api.store.swipe(p4.id);
    const st = api.store.getState();
    expect(st.audit.some((a) => a.code === "MATERIAL_BATCH_REVOKED")).toBe(true);
    expect(st.permits.find((p) => p.id === p4.id)!.status).not.toBe("used");
  });

  it("压差低于规则下限停在外门（PRESSURE_FAIL）", () => {
    const [p1] = permits();
    api.store.setPressure("A-01", 10); // 下限 15
    api.store.swipe(p1.id);
    const st = api.store.getState();
    const block = st.audit.find((a) => a.code === "PRESSURE_FAIL");
    expect(block).toBeTruthy();
    expect(block!.text).toContain("10Pa");
    expect(st.permits.find((p) => p.id === p1.id)!.status).not.toBe("used");
  });

  it("人员资质失效拦截（PERSON_INVALID）", () => {
    api.store.issuePermit("A-01", ["P-04"], []);
    const p = api.store.getState().permits[0];
    api.store.swipe(p.id);
    const st = api.store.getState();
    expect(st.audit.some((a) => a.code === "PERSON_INVALID" && a.text.includes("赵敏"))).toBe(true);
  });

  it("通道未结异常时进入待处理队列，结异常后自动放行", () => {
    const [, p2] = permits(); // B-02 自带未结异常
    api.store.swipe(p2.id);
    let st = api.store.getState();
    expect(st.queue.some((q) => q.permitId === p2.id)).toBe(true);
    expect(st.audit.some((a) => a.code === "ANOMALY_OPEN")).toBe(true);
    api.store.resolveAnomaly("B-02");
    st = api.store.getState();
    expect(st.queue.length).toBe(0);
    expect(st.permits.find((p) => p.id === p2.id)!.status).toBe("used");
  });
});

describe("规则/批次调整 → 许可即时失效", () => {
  it("压差规则调整后已签发许可变 reconfirm，重新确认通过前不能进入", () => {
    const [p1] = permits();
    api.store.adjustRule("A-01", 17);
    let st = api.store.getState();
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("reconfirm");

    api.store.swipe(p1.id);
    st = api.store.getState();
    expect(st.audit.some((a) => a.code === "NEED_RECONFIRM")).toBe(true);
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("reconfirm");

    api.store.reconfirm(p1.id);
    api.store.swipe(p1.id);
    st = api.store.getState();
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("used");
  });

  it("灭菌批次有效期调整后相关许可失效，物料已过期时重新确认不通过", () => {
    const [, , p3] = permits();
    api.store.adjustBatch("ST-20260929-02", { validHours: 6 }); // 02:00 即到期
    let st = api.store.getState();
    expect(st.permits.find((p) => p.id === p3.id)!.status).toBe("reconfirm");
    api.store.reconfirm(p3.id);
    st = api.store.getState();
    expect(st.permits.find((p) => p.id === p3.id)!.status).toBe("reconfirm");
    expect(st.permits.find((p) => p.id === p3.id)!.reconfirmFailReason).toContain("有效期");
  });
});

describe("离线门控与回传合并", () => {
  it("离线刷卡走冻结快照；重复刷卡不放行；回传按许可编号合并", () => {
    const [p1] = permits();
    const gate = gateFor("A-01");
    api.store.setGateOnline(gate.id, false);

    // 离线放行
    api.store.swipe(p1.id);
    let g = api.store.getState().gates.find((x) => x.id === gate.id)!;
    expect(g.usedPermitIds).toContain(p1.id);
    expect(g.journal.filter((e) => e.type === "ENTER" && !e.localBlock).length).toBe(1);

    // 离线重复刷卡：本地拦截，不产生第二次有效进入
    api.store.swipe(p1.id);
    g = api.store.getState().gates.find((x) => x.id === gate.id)!;
    expect(g.journal.filter((e) => e.type === "ENTER" && !e.localBlock).length).toBe(1);
    expect(g.journal.some((e) => e.type === "ENTER" && e.localBlock === "PERMIT_USED")).toBe(true);

    // 恢复链路但回传链路故障 → 批次失败可重试
    api.store.setGateOnline(gate.id, true);
    api.store.toggleLink(); // 中断
    api.store.syncGate(gate.id);
    let batch = api.store.getState().syncBatches[0];
    expect(batch.status).toBe("failed");
    expect(batch.attempts).toBe(1);
    expect(api.store.getState().permits.find((p) => p.id === p1.id)!.status).not.toBe("used");

    // 恢复链路重试：只补未确认流水 → 合并成功，不重复开门
    api.store.toggleLink();
    api.store.syncGate(gate.id);
    batch = api.store.getState().syncBatches[0];
    expect(batch.status).toBe("done");
    expect(batch.doneSeqs.length).toBe(batch.total);
    const st = api.store.getState();
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("used");
    expect(st.permits.find((p) => p.id === p1.id)!.enteredOffline).toBe(true);

    // 完成后不再产生新批次
    api.store.syncAllPending();
    expect(api.store.getState().syncBatches.length).toBe(1);
  });

  it("回传只补未确认的门，已完成的门跳过", () => {
    const [p1, p2] = permits();
    const g1 = gateFor("A-01");
    const g2 = gateFor("B-02");
    api.store.setGateOnline(g1.id, false);
    api.store.setGateOnline(g2.id, false);
    api.store.swipe(p1.id); // 离线进入 A-01
    api.store.swipe(p2.id); // B-02 有未结异常 → 离线排队
    api.store.setGateOnline(g1.id, true);
    api.store.setGateOnline(g2.id, true);

    api.store.syncAllPending();
    let st = api.store.getState();
    expect(st.syncBatches.filter((b) => b.status === "done").length).toBe(2);
    expect(st.queue.some((q) => q.permitId === p2.id)).toBe(true);

    // 再次调用不会产生新批次
    api.store.syncAllPending();
    st = api.store.getState();
    expect(st.syncBatches.length).toBe(2);
  });

  it("双方改过同一备注字段 → 两版保留，许可挂冲突，班长裁决后恢复", () => {
    const [p1] = permits();
    const gate = gateFor("A-01");

    api.store.setGateOnline(gate.id, false);
    api.store.editNote(p1.id, "门控侧：更换密封垫");
    // 中央侧也改了同一字段（直接写中央数据）
    api.store.getState().permits.find((p) => p.id === p1.id)!.note = "中央侧：改为夜班执行";

    api.store.setGateOnline(gate.id, true);
    api.store.syncGate(gate.id);
    let st = api.store.getState();
    expect(st.conflicts).toHaveLength(1);
    const cf = st.conflicts[0];
    expect(cf.centerValue).toBe("中央侧：改为夜班执行");
    expect(cf.gateValue).toBe("门控侧：更换密封垫");
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("conflict");

    // 冲突期间刷卡被拦
    api.store.swipe(p1.id);
    st = api.store.getState();
    expect(st.audit.some((a) => a.code === "PERMIT_CONFLICT")).toBe(true);

    // 班长选择门控版 → 许可恢复有效
    api.store.resolveConflict(cf.id, "gate");
    st = api.store.getState();
    expect(st.permits.find((p) => p.id === p1.id)!.note).toBe("门控侧：更换密封垫");
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("issued");
  });

  it("离线期间规则已变更，回传进入挂异常阻断后续", () => {
    const [p1] = permits();
    const gate = gateFor("A-01");
    // 第二组许可在规则调整前已签发
    api.store.issuePermit("A-01", ["P-05"], []);
    const pNew = api.store.getState().permits[0];

    api.store.setGateOnline(gate.id, false);
    api.store.swipe(p1.id); // 离线进入
    api.store.setGateOnline(gate.id, true);
    // 回传前中央把压差下限调高，当前实测 18 < 19
    api.store.adjustRule("A-01", 19);
    api.store.syncGate(gate.id);
    const st = api.store.getState();
    expect(st.permits.find((p) => p.id === p1.id)!.status).toBe("used");
    expect(st.channels.find((c) => c.id === "A-01")!.openAnomaly).toBeTruthy();

    // 新许可虽因规则变更处于 reconfirm；即使先重新确认、压差恢复，通道异常仍让它排队
    api.store.setPressure("A-01", 20);
    api.store.reconfirm(pNew.id);
    api.store.swipe(pNew.id);
    const st2 = api.store.getState();
    expect(st2.queue.some((q) => q.permitId === pNew.id)).toBe(true);
    expect(st2.audit.some((a) => a.code === "ANOMALY_OPEN")).toBe(true);
  });
});

describe("队列阻挡原因一致性", () => {
  it("操作页复检与追溯记录使用同一 BLOCK_REASONS 文案", () => {
    const [p1] = permits();
    api.store.swipe(p1.id);
    api.store.issuePermit("A-01", ["P-05"], []);
    const p2 = api.store.getState().permits[0];
    api.store.swipe(p2.id);
    const st = api.store.getState();
    const auditText = st.audit.find((a) => a.code === "CHANNEL_OCCUPIED")!.text;
    expect(auditText).toContain(BLOCK_REASONS.CHANNEL_OCCUPIED.label);
    expect(auditText).toContain("待处理队列");
    expect(st.permits.find((p) => p.id === p2.id)!.lastBlock).toBe("CHANNEL_OCCUPIED");
  });
});
