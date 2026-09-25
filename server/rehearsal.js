'use strict';

/**
 * 片段排练单（Rehearsal Cue Sheet）：
 * - 输入原演出时间窗 [windowStart, windowEnd)（左闭右开，正长度）
 * - 按现有 evaluate 的重算结果，选出与窗口有正长度交集的提示
 * - 将区间截到窗口并整体平移到 0
 * - 保留片段内仍有效的相对前置关系；前置未入选、或提示自身跨左边界时改为固定开始
 * - 对新提示单重新 evaluate，保证重算时刻与截取结果一致、且无悬空引用
 */

const { round, evaluate } = require('./scheduler');

function httpError(status, errors) {
  const err = new Error(Array.isArray(errors) ? errors.join('；') : String(errors));
  err.status = status;
  err.errors = Array.isArray(errors) ? errors : [String(errors)];
  return err;
}

/**
 * 校验窗口入参，返回 { start, end }（均为非负有限数且 start < end），否则抛 400。
 */
function parseWindow(input) {
  const errors = [];
  const w = input && typeof input === 'object' ? input : {};

  const take = (key, label) => {
    const v = w[key];
    if (typeof v === 'boolean' || v === null || v === undefined || String(v).trim() === '') {
      errors.push(`${label}必须填写数字`);
      return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors.push(`${label}必须是有限数字`);
      return null;
    }
    if (n < 0) {
      errors.push(`${label}不能为负数`);
      return null;
    }
    return round(n);
  };

  const start = take('start', '窗口起始秒数');
  const end = take('end', '窗口结束秒数');

  if (errors.length) throw httpError(400, errors);
  if (!(start < end)) {
    throw httpError(400, ['窗口非法：[起, 止) 必须有正长度，起始秒数需严格小于结束秒数']);
  }
  return { start, end };
}

/**
 * 依据源提示单与窗口构建片段排练单。
 * 源提示存在时间未定（缺失引用/循环依赖）时抛 409。
 * 返回 { window, cues, schedule, conflicts, adjustments }。
 */
function buildRehearsal(cues, window) {
  const wStart = window.start;
  const wEnd = window.end;

  // 1) 源提示按现有逻辑重算；任一时间未定则无法截取
  const source = evaluate(cues);
  const sched = new Map(source.schedule.map((s) => [s.id, s]));
  const unresolved = cues.filter((c) => {
    const t = sched.get(c.id);
    return !t || t.start === null || t.end === null;
  });
  if (source.errors.length || unresolved.length) {
    const names = unresolved.map((c) => `「${c.name}」`).join('、');
    const msg = names
      ? `源提示单存在时间未定的提示（${names}），请先解决缺失引用或循环依赖后再截取片段`
      : '源提示单存在缺失引用或循环依赖，无法截取片段排练单';
    throw httpError(409, [msg]);
  }

  // 2) 选出与窗口有正长度交集的提示，截到窗口并平移到 0
  const picked = [];
  for (const c of cues) {
    const t = sched.get(c.id);
    const clipStart = Math.max(t.start, wStart);
    const clipEnd = Math.min(t.end, wEnd);
    if (!(clipStart < clipEnd - 1e-9)) continue; // 左闭右开：仅端点相接不算交集

    picked.push({
      cue: c,
      localStart: round(clipStart - wStart),
      localEnd: round(clipEnd - wStart),
      duration: round(clipEnd - clipStart),
      crossesLeft: t.start < wStart - 1e-9,
    });
  }
  const pickedIds = new Set(picked.map((p) => p.cue.id));

  // 3) 构建片段提示：保留有效相对关系，其余改为固定开始
  const newCues = [];
  const adjustments = [];
  for (const p of picked) {
    const c = p.cue;
    const base = {
      id: c.id,
      name: c.name,
      channel: c.channel,
      duration: p.duration,
    };

    const predPicked =
      c.startType === 'after' && !p.crossesLeft && pickedIds.has(c.afterCueId)
        ? picked.find((q) => q.cue.id === c.afterCueId)
        : null;

    if (predPicked) {
      // 前置入选且自身未跨左边界：保留相对关系；
      // 延迟按截取后的端点重算，确保重新 evaluate 得到的时刻与截取结果一致
      base.startType = 'after';
      base.fixedAt = null;
      base.afterCueId = c.afterCueId;
      base.delayAfter = round(p.localStart - predPicked.localEnd);
    } else if (c.startType === 'after') {
      // 前置未入选，或提示自身跨左边界：改为固定开始，消除悬空/越界引用
      base.startType = 'fixed';
      base.fixedAt = p.localStart;
      base.afterCueId = null;
      base.delayAfter = 0;
      adjustments.push({
        id: c.id,
        from: 'after',
        to: 'fixed',
        reason: p.crossesLeft ? 'cross-left' : 'pred-excluded',
      });
    } else {
      // 原本就是固定开始
      base.startType = 'fixed';
      base.fixedAt = p.localStart;
      base.afterCueId = null;
      base.delayAfter = 0;
    }
    newCues.push(base);
  }

  // 4) 对片段单重新重算与冲突检测；构造上不应再有引用/环问题
  const re = evaluate(newCues);
  if (re.errors.length) {
    throw httpError(500, ['片段排练单重算失败：' + re.errors.map((e) => e.message).join('；')]);
  }
  const reMap = new Map(re.schedule.map((s) => [s.id, s]));
  for (const p of picked) {
    const t = reMap.get(p.cue.id);
    if (!t || Math.abs(t.start - p.localStart) > 1e-9 || Math.abs(t.end - p.localEnd) > 1e-9) {
      throw httpError(500, ['片段排练单重算时刻与截取结果不一致，请检查窗口与源数据']);
    }
  }

  return {
    window: { start: wStart, end: wEnd },
    cues: newCues,
    schedule: re.schedule,
    conflicts: re.conflicts,
    adjustments,
  };
}

module.exports = { parseWindow, buildRehearsal };
