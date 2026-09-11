'use strict';

/**
 * 数据迁移与连续打卡计算（纯函数模块）
 *
 *  - migrateV2toV3(obj)：把 v2 单目标扁平结构迁移为 v3 多目标结构
 *  - computeStreakFromHistory(history)：从打卡历史计算连续打卡
 *    current / longest / lastCheckinDate
 *
 * 该模块不依赖 main.js，避免循环引用；主进程通过 require('./migrate') 引入。
 */

const DEFAULT_CATEGORY_COLOR = '#ff6b5e';

/** 把 Date 格式化为本地 YYYY-MM-DD */
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 生成带前缀的唯一 id（与 main.js 保持一致格式） */
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 严格校验 YYYY-MM-DD 是否为真实存在的日期 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 计算 b - a 的天数差（a、b 均为 YYYY-MM-DD） */
function diffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86400000);
}

/** 日期字符串偏移 delta 天 */
function shiftDateStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateStr(dt);
}

/**
 * 从打卡历史计算连续打卡（跨目标合并计数后调用）。
 * 历史项结构：{ id, date, time, timestamp }，date 为 YYYY-MM-DD。
 *
 * 规则：
 *  - 去重后按日期升序排列
 *  - longest：历史中任意一段连续天数的最大值
 *  - current：以今天（或昨天，若今天还没打但昨天打过）为终点向前连续的天数；
 *    若最后一次打卡早于昨天，说明已经断签，current = 0
 *
 * @param {Array<{date:string}>} history
 * @param {string} [todayStr] 可注入的「今天」，默认取本地今天
 * @returns {{current:number,longest:number,lastCheckinDate:string}}
 */
function computeStreakFromHistory(history, todayStr) {
  const today = isValidDateStr(todayStr) ? String(todayStr) : localDateStr(new Date());
  const yesterday = shiftDateStr(today, -1);

  const dates = Array.from(new Set(
    (Array.isArray(history) ? history : [])
      .map((h) => (h && h.date) ? String(h.date) : '')
      .filter(isValidDateStr)
  )).sort();

  if (dates.length === 0) {
    return { current: 0, longest: 0, lastCheckinDate: '' };
  }

  // 最长连续
  let longest = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (diffDays(dates[i - 1], dates[i]) === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // 当前连续：终点必须是今天或昨天
  const lastCheckinDate = dates[dates.length - 1];
  let current = 0;
  if (lastCheckinDate === today || lastCheckinDate === yesterday) {
    current = 1;
    for (let i = dates.length - 2; i >= 0; i--) {
      if (diffDays(dates[i], dates[i + 1]) === 1) {
        current += 1;
      } else {
        break;
      }
    }
  }

  return { current, longest, lastCheckinDate };
}

/**
 * v2 → v3 迁移。
 * 把 v2 顶层单目标字段下沉进 targets[0]，theme/alarms 保留顶层，
 * streak 由 history 计算，pomodoro/autoLaunch/bigTextMode 使用默认值。
 *
 * @param {object} obj v2 状态对象
 * @returns {object} v3 状态对象（未 normalize，交由主进程 normalizeState 兜底）
 */
function migrateV2toV3(obj) {
  const v2 = obj && typeof obj === 'object' ? obj : {};

  const history = Array.isArray(v2.history) ? v2.history : [];
  const categories = (Array.isArray(v2.categories) ? v2.categories : []).map((c) => ({
    id: String((c && c.id) || generateId('cat')), // 保留 v2 类目 id
    name: String((c && c.name) || '').trim() || '打卡',
    color: String((c && c.color) || DEFAULT_CATEGORY_COLOR),
    createdAt: Number(c && c.createdAt) || Date.now(),
    message: String((c && c.message) || ''),
    btnActiveText: String((c && c.btnActiveText) || ''),
    btnDoneText: String((c && c.btnDoneText) || '')
  }));

  const target = {
    id: generateId('tgt'),
    name: '我的目标',
    countMode: 'countdown',
    targetDate: String(v2.targetDate || ''),
    startDate: '',
    totalDays: Number(v2.totalDays) || 0,
    displayMode: ['days', 'months', 'years'].includes(v2.displayMode) ? v2.displayMode : 'days',
    createdAt: Date.now(),
    history,
    categories,
    currentCategoryId: '',
    checkinsByDate: (v2.checkinsByDate && typeof v2.checkinsByDate === 'object' && !Array.isArray(v2.checkinsByDate))
      ? v2.checkinsByDate
      : {},
    todosByDate: (v2.todosByDate && typeof v2.todosByDate === 'object' && !Array.isArray(v2.todosByDate))
      ? v2.todosByDate
      : {}
  };

  // currentCategoryId 必须指向存在的类目
  const v2CurrentId = String(v2.currentCategoryId || '');
  target.currentCategoryId = target.categories.some((c) => c.id === v2CurrentId)
    ? v2CurrentId
    : (target.categories[0] ? target.categories[0].id : '');

  const streak = computeStreakFromHistory(history);

  return {
    schemaVersion: 3,
    currentTargetId: target.id,
    theme: v2.theme === 'dark' ? 'dark' : 'light',
    targets: [target],
    alarms: Array.isArray(v2.alarms) ? v2.alarms : [],
    streak,
    pomodoro: { workMin: 25, breakMin: 5, cycles: 4 },
    autoLaunch: false,
    bigTextMode: false
  };
}

module.exports = { migrateV2toV3, computeStreakFromHistory };
