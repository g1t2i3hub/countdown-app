'use strict';

/**
 * 倒数日桌面应用 —— Electron 主进程（v3 多目标版本）
 *
 * 职责：
 *  - 创建应用窗口（contextIsolation: true, nodeIntegration: false）
 *  - 管理数据文件的读写（存放在 app.getPath('userData') 目录）
 *  - 通过 IPC 暴露安全的增删改查接口给渲染进程
 *  - 番茄钟内存运行态 + 系统设置 / 番茄钟子窗口
 */

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { migrateV2toV3, computeStreakFromHistory } = require('./migrate');

/**
 * 窗口固定尺寸（含悬浮条 + 下拉面板区域）。
 * 采用纯 CSS hover 下拉，不需要动态缩放窗口：
 * 透明窗口让收起态看起来只是一个悬浮条，悬停时下拉面板在窗口内滑出。
 */
const BAR_HEIGHT = 60;          // 悬浮条高度
const WINDOW_SIZE = { width: 340, height: 640 };
const CALENDAR_SIZE = { width: 380, height: 640 }; // 日历回看弹窗尺寸（v3 增加统计区）
const POMODORO_SIZE = { width: 300, height: 300 }; // 番茄钟子窗口尺寸
const SYSTEM_SIZE = { width: 280, height: 240 };   // 系统设置子窗口尺寸

/** 数据版本号：任何不等于 3 的存量数据按版本迁移或重建 */
const SCHEMA_VERSION = 3;

/** 类目调色板（珊瑚红系 8 色，新增类目时循环分配） */
const CATEGORY_COLORS = ['#ff6b5e', '#ffa26b', '#f5a623', '#4caf7d', '#5b8def', '#8f6bf0', '#e056a0', '#4fb3bf'];

/** 类目数量 / 名称长度上限 */
const MAX_CATEGORIES = 10;
const MAX_CATEGORY_NAME_LENGTH = 12;

/** 应用数据的默认结构（v3：多目标 + 顶层全局字段） */
const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION, // 数据版本号
  currentTargetId: '',           // 当前选中目标 id
  theme: 'light',                // 主题：'light'（浅色暖红）| 'dark'（深色冷青）| 'green'（护眼绿，半透明）
  targets: [],                   // 多目标数组（自包含），见 normalizeTarget
  alarms: [],                    // 闹钟列表（顶层全局）
  streak: { current: 0, longest: 0, lastCheckinDate: '' }, // 跨目标合并的连续打卡
  pomodoro: { workMin: 25, breakMin: 5, cycles: 4 },       // 番茄钟设置
  autoLaunch: false              // 开机自启动
};

let mainWindow = null;
let calendarWindow = null;
let pomodoroWindow = null;
let systemWindow = null;
let dataFilePath = null;
let tray = null;        // 系统托盘图标（常驻，避免被 GC 回收导致图标消失）
let isQuitting = false; // 是否正在真正退出应用（用于区分「关闭窗口=隐藏」与「托盘退出」）
let alarmTimer = null;  // 闹钟检查定时器
let alarmWindow = null; // 闹钟提醒弹窗
let pendingRestore = null; // 待恢复的备份内容（pick-restore-file 之后、apply-restore 之前）
const alarmTriggeredIds = new Set(); // 已触发待确认的闹钟 id（避免重复弹窗）

/** 番茄钟内存运行态（不持久化） */
const pomodoroRuntime = {
  active: false,
  phase: 'work',        // 'work' | 'break'
  endsAt: 0,            // 当前阶段结束时间戳
  durationSeconds: 0,   // 当前阶段时长（秒）
  cycleIndex: 0,        // 已完成的工作段数（0-based）
  settings: { workMin: 25, breakMin: 5, cycles: 4 },
  timer: null
};

/**
 * 返回今天的日期字符串（本地时区），格式：YYYY-MM-DD
 */
function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 返回当前时间字符串（本地时区），格式：HH:MM:SS
 */
function getTimeString() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/**
 * 返回「昨天」的日期字符串（本地时区），格式：YYYY-MM-DD
 */
function getYesterdayString() {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 计算从今天到目标日期相差的天数（不含今天本身）。
 * 目标日期必须是未来日期；返回正整数天数，非法或非未来日期返回 0。
 * @param {string} targetDateStr 目标日期 YYYY-MM-DD
 * @returns {number} 天数差
 */
function daysUntil(targetDateStr) {
  if (!targetDateStr) return 0;
  const [ty, tm, td] = String(targetDateStr).split('-').map(Number);
  if (!ty || !tm || !td) return 0;
  const target = new Date(ty, tm - 1, td);
  if (isNaN(target.getTime())) return 0;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

/**
 * 计算从起点日期到今天（含今天）已坚持的天数。
 * 起点日期不能是未来；非法返回 0。
 * @param {string} startDateStr 起点日期 YYYY-MM-DD
 * @returns {number} 已坚持天数（起点当天算第 1 天）
 */
function daysSince(startDateStr) {
  if (!startDateStr) return 0;
  const [sy, sm, sd] = String(startDateStr).split('-').map(Number);
  if (!sy || !sm || !sd) return 0;
  const start = new Date(sy, sm - 1, sd);
  if (isNaN(start.getTime())) return 0;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - start.getTime()) / 86400000);
  return diff >= 0 ? diff + 1 : 0;
}

/** 严格校验 YYYY-MM-DD 是否为真实日期 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 生成带前缀的唯一 id：`<prefix>_<时间戳>_<随机串>` */
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成默认类目「打卡」（颜色取调色板第一色） */
function makeDefaultCategory() {
  return {
    id: generateId('cat'),
    name: '打卡',
    color: CATEGORY_COLORS[0],
    createdAt: Date.now()
  };
}

/** 生成默认目标（未配置，供首次启动 / 新建目标使用） */
function makeDefaultTarget() {
  const cat = makeDefaultCategory();
  return {
    id: generateId('tgt'),
    name: '我的目标',
    countMode: 'countdown',
    targetDate: '',
    startDate: '',
    totalDays: 0,
    displayMode: 'days',
    createdAt: Date.now(),
    history: [],
    categories: [cat],
    currentCategoryId: cat.id,
    checkinsByDate: {},
    todosByDate: {}
  };
}

/**
 * 规范化单个目标：补齐缺失字段、保证类目至少 1 个、修正 currentCategoryId。
 * @param {object} t
 * @returns {object}
 */
function normalizeTarget(t) {
  const target = {
    id: String((t && t.id) || generateId('tgt')),
    name: String((t && t.name) || '').trim() || '我的目标',
    countMode: (t && t.countMode) === 'countup' ? 'countup' : 'countdown',
    targetDate: String((t && t.targetDate) || ''),
    startDate: String((t && t.startDate) || ''),
    totalDays: Number(t && t.totalDays) || 0,
    displayMode: ['days', 'months', 'years'].includes(t && t.displayMode) ? t.displayMode : 'days',
    createdAt: Number(t && t.createdAt) || Date.now(),
    history: Array.isArray(t && t.history) ? t.history : [],
    categories: [],
    currentCategoryId: String((t && t.currentCategoryId) || ''),
    checkinsByDate: (t && t.checkinsByDate && typeof t.checkinsByDate === 'object' && !Array.isArray(t.checkinsByDate))
      ? t.checkinsByDate
      : {},
    todosByDate: (t && t.todosByDate && typeof t.todosByDate === 'object' && !Array.isArray(t.todosByDate))
      ? t.todosByDate
      : {}
  };

  target.categories = (Array.isArray(t && t.categories) ? t.categories : []).map((c) => ({
    id: String((c && c.id) || ''),
    name: String((c && c.name) || '').trim() || '打卡',
    color: String((c && c.color) || CATEGORY_COLORS[0]),
    createdAt: Number(c && c.createdAt) || Date.now(),
    message: String((c && c.message) || ''),
    btnActiveText: String((c && c.btnActiveText) || ''),
    btnDoneText: String((c && c.btnDoneText) || '')
  }));

  // 类目至少 1 个
  if (target.categories.length === 0) {
    target.categories = [makeDefaultCategory()];
  }

  // currentCategoryId 必须指向存在的类目
  const hasCurrent = target.categories.some((c) => c.id === target.currentCategoryId);
  if (!hasCurrent) {
    target.currentCategoryId = target.categories[0].id;
  }

  return target;
}

/**
 * 规范化状态：补齐顶层字段、规范化所有目标、修正 currentTargetId。
 * @param {object} state
 * @returns {object}
 */
function normalizeState(state) {
  const s = { ...DEFAULT_STATE, ...(state && typeof state === 'object' ? state : {}) };

  if (!Array.isArray(s.targets)) s.targets = [];
  s.targets = s.targets.map(normalizeTarget);

  if (!Array.isArray(s.alarms)) s.alarms = [];
  if (s.theme !== 'dark' && s.theme !== 'light' && s.theme !== 'green') s.theme = 'light';

  if (!s.streak || typeof s.streak !== 'object' || Array.isArray(s.streak)) {
    s.streak = { current: 0, longest: 0, lastCheckinDate: '' };
  }
  s.streak = {
    current: Number(s.streak.current) || 0,
    longest: Number(s.streak.longest) || 0,
    lastCheckinDate: String(s.streak.lastCheckinDate || '')
  };

  if (!s.pomodoro || typeof s.pomodoro !== 'object' || Array.isArray(s.pomodoro)) {
    s.pomodoro = { workMin: 25, breakMin: 5, cycles: 4 };
  }
  s.pomodoro = {
    workMin: Number(s.pomodoro.workMin) || 25,
    breakMin: Number(s.pomodoro.breakMin) || 5,
    cycles: Number(s.pomodoro.cycles) || 4
  };

  s.autoLaunch = !!s.autoLaunch;

  // 目标至少 1 个
  if (s.targets.length === 0) {
    s.targets = [makeDefaultTarget()];
  }

  // currentTargetId 必须指向存在的目标
  const hasCurrent = s.targets.some((t) => t.id === s.currentTargetId);
  if (!hasCurrent) {
    s.currentTargetId = s.targets[0].id;
  }

  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

/**
 * 从磁盘读取状态；文件不存在或损坏时回退到默认状态。
 * - v3：直接 normalize
 * - v2：备份原始内容到 <userData>/countdown-data.v2.backup.json 后迁移
 * - 其他：重建全新空状态
 * @returns {object} 规范化后的状态对象
 */
function readState() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const raw = fs.readFileSync(dataFilePath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === SCHEMA_VERSION) {
        return normalizeState(parsed);
      }

      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 2) {
        console.warn('[main] 检测到 v2 旧数据，正在迁移到 v3');
        // 迁移前备份原始 v2 内容
        const backupPath = path.join(app.getPath('userData'), 'countdown-data.v2.backup.json');
        try {
          fs.writeFileSync(backupPath, raw, 'utf-8');
        } catch (backupErr) {
          console.error('[main] 备份 v2 数据失败:', backupErr);
        }
        const migrated = migrateV2toV3(parsed);
        const fresh = normalizeState(migrated);
        writeState(fresh);
        return fresh;
      }

      // 未知版本 / 非对象：直接丢弃并重建
      console.warn('[main] 检测到未知版本数据，已清空重建');
      const fresh = normalizeState({ ...DEFAULT_STATE });
      writeState(fresh);
      return fresh;
    }
  } catch (err) {
    console.error('[main] 读取数据失败:', err);
  }
  return normalizeState({ ...DEFAULT_STATE });
}

/**
 * 将状态写入磁盘（JSON 文件，2 空格缩进，便于人工查看）。
 * @param {object} state
 */
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(dataFilePath), { recursive: true });
    fs.writeFileSync(dataFilePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[main] 写入数据失败:', err);
    throw err;
  }
}

/**
 * 处理单个目标跨天待办：若今天还没有记录，把昨天「未完成」的待办顺延到今天。
 * 返回是否发生顺延（true 表示需要写盘）。
 * @param {object} target
 * @returns {boolean}
 */
function rolloverTargetTodos(target) {
  const today = getTodayString();
  const byDate = (target.todosByDate && typeof target.todosByDate === 'object')
    ? target.todosByDate
    : {};

  if (Array.isArray(byDate[today])) {
    return false;
  }

  const yesterday = getYesterdayString();
  const yestTodos = Array.isArray(byDate[yesterday]) ? byDate[yesterday] : [];
  const carried = yestTodos
    .filter((t) => !t.done)
    .map((t) => ({
      id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: t.text,
      done: false,
      carried: true,
      categoryId: t.categoryId || target.currentCategoryId || (target.categories[0] && target.categories[0].id) || ''
    }));

  byDate[today] = carried;
  target.todosByDate = byDate;
  return true;
}

/**
 * 处理所有目标的跨天待办顺延。
 * @param {object} state
 * @returns {boolean} 是否发生顺延
 */
function rolloverTodosIfNeeded(state) {
  let changed = false;
  state.targets.forEach((t) => {
    if (rolloverTargetTodos(t)) changed = true;
  });
  return changed;
}

/** 把剩余天数格式化成用户选择的显示方式 */
function formatRemaining(remainingDays, mode) {
  const days = Math.max(Number(remainingDays) || 0, 0);

  if (mode === 'years') {
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    const d = days % 30;
    const parts = [];
    if (years > 0) parts.push(`${years}年`);
    if (months > 0) parts.push(`${months}个月`);
    if (d > 0 || parts.length === 0) parts.push(`${d}天`);
    return parts.join('');
  }

  if (mode === 'months') {
    const totalMonths = Math.floor(days / 30);
    const d = days % 30;
    if (totalMonths >= 12) {
      const years = Math.floor(totalMonths / 12);
      const months = totalMonths % 12;
      const parts = [];
      if (years > 0) parts.push(`${years}年`);
      if (months > 0) parts.push(`${months}个月`);
      if (d > 0) parts.push(`${d}天`);
      return parts.join('');
    }
    const parts = [];
    if (totalMonths > 0) parts.push(`${totalMonths}个月`);
    if (d > 0 || parts.length === 0) parts.push(`${d}天`);
    return parts.join('');
  }

  return String(days);
}

/** 计算定点闹钟（HH:MM）下一次触发的时间戳 */
function nextFixedTimestamp(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return 0;

  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/** 跨目标合并计算连续打卡（任一目标打卡即 +1，断签归零） */
function recomputeStreak(targets) {
  const merged = [];
  (Array.isArray(targets) ? targets : []).forEach((t) => {
    (Array.isArray(t.history) ? t.history : []).forEach((h) => merged.push(h));
  });
  return computeStreakFromHistory(merged);
}

/** 构建目标摘要（供目标选择条 / 悬浮条使用） */
function buildTargetSummary(target) {
  const isCountup = target.countMode === 'countup';
  const history = Array.isArray(target.history) ? target.history : [];

  let configured;
  let remainingDays;
  let remainingText;

  if (isCountup) {
    configured = true;
    remainingDays = daysSince(target.startDate || '');
    remainingText = String(remainingDays);
  } else {
    const totalDays = Number(target.totalDays) || 0;
    configured = totalDays > 0 || !!target.targetDate;
    remainingDays = Math.max(totalDays - history.length, 0);
    remainingText = formatRemaining(remainingDays, target.displayMode);
  }

  return {
    id: target.id,
    name: target.name,
    countMode: target.countMode,
    isCountup,
    targetDate: target.targetDate || '',
    startDate: target.startDate || '',
    totalDays: Number(target.totalDays) || 0,
    displayMode: target.displayMode,
    configured,
    remainingDays,
    remainingText,
    eliminatedCount: history.length
  };
}

/** 构建闹钟视图（附加派生字段） */
function buildAlarms(alarms) {
  const now = Date.now();
  return (Array.isArray(alarms) ? alarms : []).map((a) => {
    if (a.type === 'countdown') {
      return {
        ...a,
        endsAt: Number(a.endsAt) || 0,
        remainingSeconds: Math.max(Math.ceil(((Number(a.endsAt) || 0) - now) / 1000), 0)
      };
    }
    return {
      ...a,
      time: String(a.time || ''),
      nextAt: nextFixedTimestamp(String(a.time || ''))
    };
  });
}

/** 空统计汇总（无当前目标时） */
function emptyStats() {
  return { weekly: { labels: [], rates: [] }, monthly: { labels: [], rates: [] }, categoryDist: [] };
}

/** 计算某天的打卡率（已打卡类目数 / 类目总数，0..1） */
function dayCheckinRate(dayMap, totalCats) {
  if (!dayMap || typeof dayMap !== 'object' || totalCats <= 0) return 0;
  const done = Object.keys(dayMap).length;
  return Math.min(done / totalCats, 1);
}

/** 构建统计汇总（周/月打卡率 + 类目分布），供日历回看统计区 */
function buildStatsSummary(target) {
  if (!target) return emptyStats();

  const categories = Array.isArray(target.categories) ? target.categories : [];
  const checkinsByDate = (target.checkinsByDate && typeof target.checkinsByDate === 'object')
    ? target.checkinsByDate
    : {};
  const now = new Date();

  const toDateStr = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  // 本周一至周日
  const dow = now.getDay(); // 0=周日
  const mondayOffset = (dow + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - mondayOffset);
  const weeklyLabels = [];
  const weeklyRates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = toDateStr(d);
    weeklyLabels.push(dateStr);
    weeklyRates.push(dayCheckinRate(checkinsByDate[dateStr], categories.length));
  }

  // 本月 1..N
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthlyLabels = [];
  const monthlyRates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toDateStr(new Date(year, month, d));
    monthlyLabels.push(dateStr);
    monthlyRates.push(dayCheckinRate(checkinsByDate[dateStr], categories.length));
  }

  // 类目分布：各日期各类目打卡计数汇总
  const catCounts = {};
  categories.forEach((c) => { catCounts[c.id] = 0; });
  Object.keys(checkinsByDate).forEach((date) => {
    const dayMap = checkinsByDate[date] || {};
    Object.keys(dayMap).forEach((cid) => {
      if (catCounts[cid] !== undefined) catCounts[cid] += 1;
    });
  });
  const categoryDist = categories.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    count: catCounts[c.id] || 0
  }));

  return {
    weekly: { labels: weeklyLabels, rates: weeklyRates },
    monthly: { labels: monthlyLabels, rates: monthlyRates },
    categoryDist
  };
}

/**
 * 由原始状态构建「视图模型」，把派生字段一次性计算好交给渲染进程。
 * 保留旧字段名（theme/countMode/isCountup/displayMode/targetDate/startDate/totalDays/
 * remainingDays/remainingText/history/message/btnActiveText/btnDoneText/categories/
 * currentCategoryId/currentCategory/checkinsByDate/checkinsToday/
 * currentCategoryCheckedToday/todos/todosByDate/todoDates/configured/eliminatedCount/
 * eliminatedToday/alarms），并新增 currentTarget/targets 摘要/floatTarget/streak/
 * pomodoro/autoLaunch/stats。
 */
function buildViewModel(state) {
  const targets = Array.isArray(state.targets) ? state.targets : [];
  const currentTargetId = state.currentTargetId || (targets[0] && targets[0].id) || '';
  const currentTarget = targets.find((t) => t.id === currentTargetId) || targets[0] || null;
  const today = getTodayString();

  const targetSummaries = targets.map(buildTargetSummary);

  // 悬浮条「最近到期目标」
  let floatTarget = null;
  if (targets.length > 0) {
    let best = null;
    let bestDate = '';
    targets.forEach((t) => {
      if (t.countMode !== 'countup' && t.targetDate && daysUntil(t.targetDate) > 0) {
        if (!bestDate || t.targetDate < bestDate) {
          bestDate = t.targetDate;
          best = t;
        }
      }
    });
    if (!best) {
      best = currentTarget || targets[0];
    }
    floatTarget = buildTargetSummary(best);
  }

  // 顶层字段
  const base = {
    theme: state.theme === 'dark' ? 'dark' : (state.theme === 'green' ? 'green' : 'light'),
    alarms: buildAlarms(state.alarms),
    streak: state.streak || { current: 0, longest: 0, lastCheckinDate: '' },
    pomodoro: state.pomodoro || { workMin: 25, breakMin: 5, cycles: 4 },
    autoLaunch: !!state.autoLaunch,
    currentTargetId,
    targets: targetSummaries,
    floatTarget,
    currentTarget: targetSummaries.find((t) => t.id === currentTargetId) || targetSummaries[0] || null,
    stats: buildStatsSummary(currentTarget)
  };

  if (!currentTarget) {
    return {
      ...base,
      configured: false,
      countMode: 'countdown',
      isCountup: false,
      displayMode: 'days',
      targetDate: '',
      startDate: '',
      totalDays: 0,
      remainingDays: 0,
      remainingText: '0',
      message: '距离完成还有 X 天',
      btnActiveText: '',
      btnDoneText: '',
      eliminatedCount: 0,
      eliminatedToday: false,
      history: [],
      categories: [],
      currentCategoryId: '',
      currentCategory: null,
      checkinsByDate: {},
      checkinsToday: {},
      currentCategoryCheckedToday: false,
      todos: [],
      todosByDate: {},
      todoDates: {}
    };
  }

  // ---------- 当前目标派生字段 ----------
  const isCountup = currentTarget.countMode === 'countup';
  const history = Array.isArray(currentTarget.history) ? currentTarget.history : [];
  const categories = Array.isArray(currentTarget.categories) ? currentTarget.categories : [];
  const currentCategoryId = currentTarget.currentCategoryId || (categories[0] && categories[0].id) || '';
  const currentCategory = categories.find((c) => c.id === currentCategoryId) || categories[0] || null;
  const checkinsByDate = (currentTarget.checkinsByDate && typeof currentTarget.checkinsByDate === 'object')
    ? currentTarget.checkinsByDate
    : {};
  const todosByDate = (currentTarget.todosByDate && typeof currentTarget.todosByDate === 'object')
    ? currentTarget.todosByDate
    : {};

  const checkinsToday = checkinsByDate[today] || {};
  const currentCategoryCheckedToday = !!(currentCategory && checkinsToday[currentCategory.id]);

  const allTodayTodos = Array.isArray(todosByDate[today]) ? todosByDate[today] : [];
  const todos = currentCategory
    ? allTodayTodos.filter((t) => t.categoryId === currentCategory.id)
    : [];

  const todoDates = {};
  Object.keys(todosByDate).forEach((date) => {
    const list = todosByDate[date] || [];
    todoDates[date] = { done: list.filter((t) => t.done).length, total: list.length };
  });

  const eliminatedCount = history.length;
  const eliminatedToday = history.some((h) => h.date === today);

  let configured;
  let displayMode;
  let remainingDays;
  let remainingText;
  let message;

  if (isCountup) {
    configured = true;
    displayMode = 'days';
    remainingDays = daysSince(currentTarget.startDate || '');
    remainingText = String(remainingDays);
    const defaultMessage = '已坚持 X 天';
    message = (currentCategory && currentCategory.message && currentCategory.message.trim())
      ? currentCategory.message
      : defaultMessage;
  } else {
    displayMode = ['days', 'months', 'years'].includes(currentTarget.displayMode)
      ? currentTarget.displayMode
      : 'days';
    configured = (Number(currentTarget.totalDays) || 0) > 0 || !!currentTarget.targetDate;
    remainingDays = Math.max((Number(currentTarget.totalDays) || 0) - eliminatedCount, 0);
    remainingText = formatRemaining(remainingDays, displayMode);
    const defaultMessage = '距离完成还有 X 天';
    message = (currentCategory && currentCategory.message && currentCategory.message.trim())
      ? currentCategory.message
      : defaultMessage;
  }

  return {
    ...base,
    configured,
    countMode: currentTarget.countMode,
    isCountup,
    displayMode,
    targetDate: currentTarget.targetDate || '',
    startDate: currentTarget.startDate || '',
    totalDays: Number(currentTarget.totalDays) || 0,
    remainingDays,
    remainingText,
    message,
    btnActiveText: (currentCategory && currentCategory.btnActiveText) || '',
    btnDoneText: (currentCategory && currentCategory.btnDoneText) || '',
    eliminatedCount,
    eliminatedToday,
    history,
    categories,
    currentCategoryId,
    currentCategory,
    checkinsByDate,
    checkinsToday,
    currentCategoryCheckedToday,
    todos,
    todosByDate,
    todoDates
  };
}

/** 创建主窗口 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: BAR_HEIGHT,      // 初始只显示悬浮条高度，展开时再动态增高
    minWidth: WINDOW_SIZE.width,
    maxWidth: WINDOW_SIZE.width,
    minHeight: BAR_HEIGHT,
    maxHeight: WINDOW_SIZE.height,
    title: '倒数日',
    frame: false,           // 无边框，去掉标题栏
    transparent: true,      // 透明背景：收起态只显示悬浮条，其余区域透明
    hasShadow: false,       // 透明窗口需关闭原生阴影，由 CSS 控制圆角阴影
    alwaysOnTop: true,      // 悬浮在桌面顶层，像输入法
    resizable: true,        // 必须为 true，否则 setBounds 无法动态调整窗口高度
    skipTaskbar: true,      // 始终不显示在任务栏（由系统托盘管理）
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 透明窗口在 Windows 上需额外处理
  mainWindow.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  // 页面就绪后再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    positionWindow({ width: WINDOW_SIZE.width, height: BAR_HEIGHT });
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 拦截关闭：除非真正退出，否则「关闭」只是隐藏到后台，应用驻留。
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    if (calendarWindow && !calendarWindow.isDestroyed()) {
      calendarWindow.close();
    }
    mainWindow = null;
  });
}

/**
 * 将窗口定位到屏幕右上角（保留边距）。
 */
function positionWindow(size) {
  if (!mainWindow) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const margin = 16;
  const nx = x + width - size.width - margin;
  const ny = y + margin;
  mainWindow.setBounds({ x: Math.round(nx), y: Math.round(ny), width: size.width, height: size.height });
}

/**
 * 展开/收起下拉面板：动态调整窗口高度。
 */
function setPanelExpanded(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const targetHeight = expanded ? WINDOW_SIZE.height : BAR_HEIGHT;
  const currentBounds = mainWindow.getBounds();
  if (currentBounds.height === targetHeight && currentBounds.width === WINDOW_SIZE.width) {
    return;
  }
  mainWindow.setBounds({ x, y, width: WINDOW_SIZE.width, height: targetHeight });
  if (expanded && mainWindow.isVisible()) {
    mainWindow.focus();
  }
}

/** 将日历回看弹窗定位到主窗口左侧 */
function positionCalendarWindow() {
  if (!calendarWindow || calendarWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const margin = 16;
  const gap = 12;

  let nx;
  let ny;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [mx, my] = mainWindow.getPosition();
    nx = mx - CALENDAR_SIZE.width - gap;
    ny = my;
  } else {
    nx = x + width - CALENDAR_SIZE.width - margin;
    ny = y + margin;
  }

  if (nx < x + margin) {
    nx = x + margin;
  }
  if (ny < y + margin) {
    ny = y + margin;
  }
  if (ny + CALENDAR_SIZE.height > y + height) {
    ny = y + height - CALENDAR_SIZE.height - margin;
  }

  calendarWindow.setBounds({
    x: Math.round(nx),
    y: Math.round(ny),
    width: CALENDAR_SIZE.width,
    height: CALENDAR_SIZE.height
  });
}

/** 打开（或聚焦）日历回看弹窗 */
function openCalendarWindow() {
  if (calendarWindow && !calendarWindow.isDestroyed()) {
    positionCalendarWindow();
    calendarWindow.show();
    calendarWindow.focus();
    return;
  }

  calendarWindow = new BrowserWindow({
    width: CALENDAR_SIZE.width,
    height: CALENDAR_SIZE.height,
    minWidth: CALENDAR_SIZE.width,
    minHeight: CALENDAR_SIZE.height,
    maxWidth: CALENDAR_SIZE.width,
    maxHeight: CALENDAR_SIZE.height,
    title: '待办回看',
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  calendarWindow.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    calendarWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  calendarWindow.once('ready-to-show', () => {
    calendarWindow.show();
    calendarWindow.focus();
  });

  calendarWindow.loadFile(path.join(__dirname, 'calendar.html'), {
    query: { theme: readState().theme || 'light' }
  });

  positionCalendarWindow();

  calendarWindow.on('closed', () => {
    calendarWindow = null;
  });
}

/**
 * 打开闹钟提醒弹窗。
 */
function openAlarmWindow(alarm) {
  if (alarmWindow && !alarmWindow.isDestroyed()) {
    alarmWindow.close();
  }

  alarmWindow = new BrowserWindow({
    width: 320,
    height: 200,
    title: '闹钟提醒',
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  alarmWindow.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    alarmWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  alarmWindow.loadFile(path.join(__dirname, 'alarm.html'), {
    query: { label: alarm.label || '闹钟', type: alarm.type, theme: readState().theme || 'light' }
  });

  alarmWindow.once('ready-to-show', () => {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const [wx, wy] = [320, 200];
    alarmWindow.setBounds({
      x: Math.round(x + (width - wx) / 2),
      y: Math.round(y + (height - wy) / 2)
    });
    alarmWindow.show();
    alarmWindow.focus();
  });

  alarmWindow.on('closed', () => {
    alarmWindow = null;
  });
}

function closeAlarmWindow() {
  if (alarmWindow && !alarmWindow.isDestroyed()) {
    alarmWindow.close();
  }
}

/**
 * 每秒检查闹钟是否到期。
 */
function checkAlarms() {
  const state = readState();
  const alarms = Array.isArray(state.alarms) ? state.alarms : [];
  const now = Date.now();
  const nowHHMM = [new Date().getHours(), new Date().getMinutes()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  let changed = false;
  let triggeredAny = false;

  const newAlarms = alarms.map((a) => {
    if (!a.active) return a;

    let shouldTrigger = false;
    if (a.type === 'countdown') {
      shouldTrigger = (Number(a.endsAt) || 0) > 0 && now >= (Number(a.endsAt) || 0);
    } else if (a.type === 'fixed') {
      shouldTrigger = String(a.time || '') === nowHHMM;
    }

    if (shouldTrigger && !alarmTriggeredIds.has(a.id)) {
      triggeredAny = true;
      openAlarmWindow(a);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alarm-triggered', { id: a.id, label: a.label });
      }
      alarmTriggeredIds.add(a.id);

      if (a.repeat === 'once') {
        changed = true;
        return { ...a, active: false };
      }
    }

    return a;
  });

  if (newAlarms.length > 0 && alarmTriggeredIds.size > 0) {
    const toRemove = [];
    alarmTriggeredIds.forEach((id) => {
      const al = newAlarms.find((x) => x.id === id);
      if (al && al.type === 'fixed' && String(al.time || '') !== nowHHMM) {
        toRemove.push(id);
      }
    });
    toRemove.forEach((id) => alarmTriggeredIds.delete(id));
  }

  if (changed) {
    const newState = { ...state, alarms: newAlarms };
    writeState(newState);
  }

  if (triggeredAny) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('alarms-updated', buildViewModel({ ...state, alarms: newAlarms }));
    }
  }
}

function startAlarmTimer() {
  if (alarmTimer) return;
  alarmTimer = setInterval(checkAlarms, 1000);
}

/** 加载托盘图标 */
function createTrayIcon() {
  const trayIconPath = path.join(__dirname, 'build', 'tray-icon.png');
  const image = nativeImage.createFromPath(trayIconPath);
  if (!image.isEmpty()) {
    return image;
  }
  const fallback = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (fallback.isEmpty()) {
    return null;
  }
  return fallback.resize({ width: 16, height: 16 });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

/**
 * 创建系统托盘图标。
 */
function createTray() {
  if (tray) return;

  const icon = createTrayIcon();
  if (!icon) {
    console.warn('[main] 无法加载托盘图标，已跳过托盘创建');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip('倒数日');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏',
      click: () => toggleMainWindow()
    },
    {
      label: '番茄钟',
      click: () => openPomodoroWindow()
    },
    {
      label: '系统设置',
      click: () => openSystemWindow()
    },
    {
      label: '备份数据',
      click: () => {
        backupDataToFile().then((res) => {
          if (res.ok) notify('倒数日', '备份成功');
          else if (res.error && res.error !== '已取消') notify('倒数日', res.error);
        });
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.on('click', () => {
    showMainWindow();
  });

  tray.on('right-click', () => {
    tray.popUpContextMenu(contextMenu);
  });
}

// ---------- 番茄钟 ----------

function getPomodoroStatus() {
  const runtime = pomodoroRuntime;
  const settings = runtime.settings || { workMin: 25, breakMin: 5, cycles: 4 };

  if (!runtime.active) {
    return {
      active: false,
      phase: 'work',
      remainingSeconds: settings.workMin * 60,
      totalSeconds: settings.workMin * 60,
      cycleIndex: 0,
      cycles: settings.cycles,
      settings
    };
  }

  const remainingSeconds = Math.max(Math.ceil((runtime.endsAt - Date.now()) / 1000), 0);
  return {
    active: true,
    phase: runtime.phase,
    remainingSeconds,
    totalSeconds: runtime.durationSeconds,
    cycleIndex: runtime.cycleIndex,
    cycles: settings.cycles,
    settings
  };
}

function broadcastPomodoroTick() {
  const status = getPomodoroStatus();
  if (pomodoroWindow && !pomodoroWindow.isDestroyed()) {
    pomodoroWindow.webContents.send('pomodoro-tick', status);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pomodoro-tick', status);
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: String(title || '倒数日'), body: String(body || ''), silent: false }).show();
    }
  } catch (err) {
    console.error('[main] 系统通知失败:', err);
  }
}

function notifyPomodoro(body) {
  notify('番茄钟', body);
  broadcastPomodoroTick();
}

function advancePomodoroPhase() {
  const runtime = pomodoroRuntime;

  if (runtime.phase === 'work') {
    runtime.cycleIndex += 1;
    if (runtime.cycleIndex >= runtime.settings.cycles) {
      // 全部循环完成
      stopPomodoro(false);
      notify('番茄钟', '番茄钟全部完成！🎉');
      broadcastPomodoroTick();
      return;
    }
    runtime.phase = 'break';
    runtime.durationSeconds = runtime.settings.breakMin * 60;
    notifyPomodoro('工作段结束，休息一下！');
  } else {
    runtime.phase = 'work';
    runtime.durationSeconds = runtime.settings.workMin * 60;
    notifyPomodoro('休息结束，开始专注！');
  }

  runtime.endsAt = Date.now() + runtime.durationSeconds * 1000;
  broadcastPomodoroTick();
}

function pomodoroTick() {
  const runtime = pomodoroRuntime;
  if (!runtime.active) return;
  const remaining = Math.ceil((runtime.endsAt - Date.now()) / 1000);
  if (remaining <= 0) {
    advancePomodoroPhase();
    return;
  }
  broadcastPomodoroTick();
}

function startPomodoro(settings) {
  const runtime = pomodoroRuntime;
  if (runtime.active) return; // 已在运行，忽略

  const s = {
    workMin: clampInt(settings && settings.workMin, 1, 180, runtime.settings.workMin),
    breakMin: clampInt(settings && settings.breakMin, 1, 60, runtime.settings.breakMin),
    cycles: clampInt(settings && settings.cycles, 1, 12, runtime.settings.cycles)
  };
  runtime.settings = s;
  runtime.phase = 'work';
  runtime.cycleIndex = 0;
  runtime.durationSeconds = s.workMin * 60;
  runtime.endsAt = Date.now() + runtime.durationSeconds * 1000;
  runtime.active = true;

  if (runtime.timer) {
    clearInterval(runtime.timer);
  }
  runtime.timer = setInterval(pomodoroTick, 1000);

  openPomodoroWindow();
  broadcastPomodoroTick();
}

function stopPomodoro(notifyUser) {
  const runtime = pomodoroRuntime;
  runtime.active = false;
  if (runtime.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }
  runtime.phase = 'work';
  runtime.endsAt = 0;
  runtime.cycleIndex = 0;
  if (notifyUser !== false) {
    broadcastPomodoroTick();
  }
}

/** 整数夹取：非法值回退默认值 */
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** 打开（或聚焦）番茄钟子窗口 */
function openPomodoroWindow() {
  if (pomodoroWindow && !pomodoroWindow.isDestroyed()) {
    pomodoroWindow.show();
    pomodoroWindow.focus();
    return;
  }

  pomodoroWindow = new BrowserWindow({
    width: POMODORO_SIZE.width,
    height: POMODORO_SIZE.height,
    title: '番茄钟',
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  pomodoroWindow.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    pomodoroWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  pomodoroWindow.loadFile(path.join(__dirname, 'pomodoro.html'), {
    query: { theme: readState().theme || 'light' }
  });

  pomodoroWindow.once('ready-to-show', () => {
    centerWindow(pomodoroWindow, POMODORO_SIZE.width, POMODORO_SIZE.height);
    pomodoroWindow.show();
    pomodoroWindow.focus();
    broadcastPomodoroTick();
  });

  pomodoroWindow.on('closed', () => {
    pomodoroWindow = null;
  });
}

// ---------- 系统设置 ----------

/** 打开（或聚焦）系统设置子窗口 */
function openSystemWindow() {
  if (systemWindow && !systemWindow.isDestroyed()) {
    systemWindow.show();
    systemWindow.focus();
    return;
  }

  systemWindow = new BrowserWindow({
    width: SYSTEM_SIZE.width,
    height: SYSTEM_SIZE.height,
    title: '系统设置',
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  systemWindow.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    systemWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  systemWindow.loadFile(path.join(__dirname, 'system.html'), {
    query: { theme: readState().theme || 'light' }
  });

  systemWindow.once('ready-to-show', () => {
    centerWindow(systemWindow, SYSTEM_SIZE.width, SYSTEM_SIZE.height);
    systemWindow.show();
    systemWindow.focus();
  });

  systemWindow.on('closed', () => {
    systemWindow = null;
  });
}

/** 窗口居中 */
function centerWindow(win, width, height) {
  if (!win || win.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width: sw, height: sh } = display.workArea;
  win.setBounds({
    x: Math.round(x + (sw - width) / 2),
    y: Math.round(y + (sh - height) / 2),
    width,
    height
  });
}

// ---------- 备份 / 恢复 ----------

/**
 * 弹出保存对话框并写出备份文件。
 * @returns {Promise<{ok:boolean,path?:string,error?:string}>}
 */
async function backupDataToFile() {
  const state = readState();
  const defaultName = `countdown-backup-${getTodayString()}.json`;
  const result = await dialog.showSaveDialog({
    title: '备份数据',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, error: '已取消' };
  }

  try {
    fs.writeFileSync(result.filePath, JSON.stringify(state, null, 2), 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: '备份失败：' + (err && err.message ? err.message : err) };
  }
}

/** 注册所有 IPC 处理器 */
function registerIpcHandlers() {
  // 读取完整状态（同时处理待办跨天顺延）
  ipcMain.handle('get-state', () => {
    const state = readState();
    if (rolloverTodosIfNeeded(state)) {
      writeState(state);
    }
    return buildViewModel(state);
  });

  // 切换主题：仅更新主题字段
  ipcMain.handle('set-theme', (_event, theme) => {
    const state = readState();
    state.theme = (theme === 'dark' || theme === 'green') ? theme : 'light';
    writeState(state);
    return { ok: true, view: buildViewModel(state) };
  });

  // ================= 目标 CRUD =================

  // 新建目标。payload: { name?, countMode?, targetDate?, startDate?, totalDays?, displayMode? }
  ipcMain.handle('create-target', (_event, payload) => {
    const state = readState();
    const p = payload && typeof payload === 'object' ? payload : {};
    const name = String(p.name || '').trim() || '新目标';
    const countMode = p.countMode === 'countup' ? 'countup' : 'countdown';

    const target = makeDefaultTarget();
    target.name = name;
    target.countMode = countMode;

    if (countMode === 'countup') {
      const startDate = String(p.startDate || '').trim();
      if (startDate && !isValidDateStr(startDate)) {
        return { ok: false, error: '起点日期格式不正确', view: buildViewModel(state) };
      }
      if (startDate && daysUntil(startDate) > 0) {
        return { ok: false, error: '起点日期不能是未来', view: buildViewModel(state) };
      }
      target.startDate = startDate;
      target.totalDays = 0;
      target.targetDate = '';
    } else {
      const targetDate = String(p.targetDate || '').trim();
      if (targetDate) {
        const d = daysUntil(targetDate);
        if (d <= 0) {
          return { ok: false, error: '目标日期必须是未来的日期', view: buildViewModel(state) };
        }
        target.totalDays = d;
        target.targetDate = targetDate;
      } else {
        target.totalDays = Number(p.totalDays) || 0;
      }
      target.displayMode = ['days', 'months', 'years'].includes(p.displayMode) ? p.displayMode : 'days';
    }

    const newState = { ...state, targets: [...state.targets, target], currentTargetId: target.id };
    writeState(newState);
    return { ok: true, target, view: buildViewModel(newState) };
  });

  // 更新目标。payload: { name?, countMode?, targetDate?, startDate?, totalDays?, displayMode? }
  ipcMain.handle('update-target', (_event, id, payload) => {
    const state = readState();
    const tid = String(id || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const p = payload && typeof payload === 'object' ? payload : {};
    const name = String(p.name || '').trim() || target.name;
    const countMode = p.countMode === 'countup' ? 'countup' : 'countdown';

    let totalDays = Number(target.totalDays) || 0;
    let targetDate = target.targetDate || '';
    let startDate = target.startDate || '';
    let displayMode = target.displayMode || 'days';

    if (countMode === 'countup') {
      startDate = String(p.startDate || '').trim();
      if (startDate && !isValidDateStr(startDate)) {
        return { ok: false, error: '起点日期格式不正确', view: buildViewModel(state) };
      }
      if (startDate && daysUntil(startDate) > 0) {
        return { ok: false, error: '起点日期不能是未来', view: buildViewModel(state) };
      }
      targetDate = '';
      totalDays = 0;
    } else {
      startDate = '';
      targetDate = String(p.targetDate || '').trim();
      displayMode = ['days', 'months', 'years'].includes(p.displayMode) ? p.displayMode : 'days';
      if (targetDate) {
        const d = daysUntil(targetDate);
        if (d <= 0) {
          return { ok: false, error: '目标日期必须是未来的日期', view: buildViewModel(state) };
        }
        totalDays = d;
      } else {
        totalDays = Number(p.totalDays) || 0;
      }
    }

    const newTarget = { ...target, name, countMode, targetDate, startDate, totalDays, displayMode };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 删除目标（至少保留一个）
  ipcMain.handle('delete-target', (_event, id) => {
    const state = readState();
    const tid = String(id || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }
    if (state.targets.length <= 1) {
      return { ok: false, error: '至少保留一个目标', view: buildViewModel(state) };
    }

    const targets = state.targets.filter((t) => t.id !== tid);
    let currentTargetId = state.currentTargetId;
    if (currentTargetId === tid) {
      currentTargetId = targets[0].id;
    }
    const newState = { ...state, targets, currentTargetId };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 切换当前目标
  ipcMain.handle('set-current-target', (_event, id) => {
    const state = readState();
    const tid = String(id || '');
    if (!state.targets.some((t) => t.id === tid)) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }
    const newState = { ...state, currentTargetId: tid };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // ================= 打卡（作用于指定目标） =================

  // 对指定目标的指定类目打卡：每类目每天一次；当天第一次打卡才写 history；
  // countup 目标首次打卡自动回填起点日期；打卡后重算跨目标 Streak。
  ipcMain.handle('checkin-category', (_event, targetId, categoryId) => {
    const state = readState();
    if (rolloverTodosIfNeeded(state)) {
      writeState(state);
    }

    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const cid = String(categoryId || '');
    const cat = target.categories.find((c) => c.id === cid);
    if (!cat) {
      return { ok: false, error: '类目不存在', view: buildViewModel(state) };
    }

    const today = getTodayString();
    const checkinsByDate = target.checkinsByDate || {};
    const todayCheckins = checkinsByDate[today] || {};

    if (todayCheckins[cid]) {
      return { ok: false, error: '该分类今天已打卡', view: buildViewModel(state) };
    }

    // countdown：上限校验
    if (target.countMode !== 'countup') {
      const totalDays = Number(target.totalDays) || 0;
      if (totalDays <= 0) {
        return { ok: false, error: '请先设置倒计时', view: buildViewModel(state) };
      }
      if (target.history.length >= totalDays) {
        return { ok: false, error: '倒计时已全部完成 🎉', view: buildViewModel(state) };
      }
    } else if (!target.startDate) {
      // countup：首次打卡自动回填起点日期
      target.startDate = today;
    }

    const entry = {
      id: `${today}_${Date.now()}`,
      date: today,
      time: getTimeString(),
      timestamp: Date.now()
    };

    todayCheckins[cid] = { time: entry.time, timestamp: entry.timestamp };
    checkinsByDate[today] = todayCheckins;

    const isFirstToday = !target.history.some((h) => h.date === today);
    const newHistory = isFirstToday ? [entry, ...target.history] : target.history;

    const newTarget = {
      ...target,
      startDate: target.startDate,
      history: newHistory,
      checkinsByDate
    };
    const targets = state.targets.map((t) => (t.id === tid ? newTarget : t));
    const streak = recomputeStreak(targets);
    const newState = { ...state, targets, streak };
    writeState(newState);
    return { ok: true, entry, view: buildViewModel(newState) };
  });

  // ================= 类目（作用于指定目标） =================

  ipcMain.handle('create-category', (_event, targetId, name) => {
    const state = readState();
    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const trimmed = String(name || '').trim();
    if (!trimmed) {
      return { ok: false, error: '类目名称不能为空', view: buildViewModel(state) };
    }
    if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) {
      return { ok: false, error: `类目名称不能超过 ${MAX_CATEGORY_NAME_LENGTH} 个字`, view: buildViewModel(state) };
    }
    if (target.categories.length >= MAX_CATEGORIES) {
      return { ok: false, error: `最多创建 ${MAX_CATEGORIES} 个类目`, view: buildViewModel(state) };
    }

    const category = {
      id: generateId('cat'),
      name: trimmed,
      color: CATEGORY_COLORS[target.categories.length % CATEGORY_COLORS.length],
      createdAt: Date.now()
    };
    const categories = [...target.categories, category];
    const currentCategoryId = target.categories.length === 0 ? category.id : target.currentCategoryId;

    const newTarget = { ...target, categories, currentCategoryId };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, category, view: buildViewModel(newState) };
  });

  ipcMain.handle('rename-category', (_event, targetId, id, name) => {
    const state = readState();
    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const cid = String(id || '');
    const trimmed = String(name || '').trim();
    const cat = target.categories.find((c) => c.id === cid);
    if (!cat) {
      return { ok: false, error: '类目不存在', view: buildViewModel(state) };
    }
    if (!trimmed) {
      return { ok: false, error: '类目名称不能为空', view: buildViewModel(state) };
    }
    if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) {
      return { ok: false, error: `类目名称不能超过 ${MAX_CATEGORY_NAME_LENGTH} 个字`, view: buildViewModel(state) };
    }

    const categories = target.categories.map((c) => (c.id === cid ? { ...c, name: trimmed } : c));
    const newTarget = { ...target, categories };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('delete-category', (_event, targetId, id) => {
    const state = readState();
    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const cid = String(id || '');
    const cat = target.categories.find((c) => c.id === cid);
    if (!cat) {
      return { ok: false, error: '类目不存在', view: buildViewModel(state) };
    }
    if (target.categories.length <= 1) {
      return { ok: false, error: '至少保留一个类目', view: buildViewModel(state) };
    }

    const categories = target.categories.filter((c) => c.id !== cid);
    let currentCategoryId = target.currentCategoryId;
    if (currentCategoryId === cid) {
      currentCategoryId = categories[0].id;
    }

    const checkinsByDate = {};
    Object.keys(target.checkinsByDate || {}).forEach((date) => {
      const dayMap = { ...(target.checkinsByDate[date] || {}) };
      delete dayMap[cid];
      if (Object.keys(dayMap).length > 0) checkinsByDate[date] = dayMap;
    });

    const todosByDate = {};
    Object.keys(target.todosByDate || {}).forEach((date) => {
      const list = (target.todosByDate[date] || []).filter((t) => t.categoryId !== cid);
      if (list.length > 0) todosByDate[date] = list;
    });

    const newTarget = { ...target, categories, currentCategoryId, checkinsByDate, todosByDate };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('set-current-category', (_event, targetId, id) => {
    const state = readState();
    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }
    const cid = String(id || '');
    if (!target.categories.some((c) => c.id === cid)) {
      return { ok: false, error: '类目不存在', view: buildViewModel(state) };
    }

    const newTarget = { ...target, currentCategoryId: cid };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('update-category-texts', (_event, targetId, id, texts) => {
    const state = readState();
    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const cid = String(id || '');
    const cat = target.categories.find((c) => c.id === cid);
    if (!cat) {
      return { ok: false, error: '类目不存在', view: buildViewModel(state) };
    }

    const patch = texts && typeof texts === 'object' ? texts : {};
    const message = String(patch.message || '').trim();
    const btnActiveText = String(patch.btnActiveText || '').trim();
    const btnDoneText = String(patch.btnDoneText || '').trim();

    const categories = target.categories.map((c) =>
      c.id === cid ? { ...c, message, btnActiveText, btnDoneText } : c
    );
    const newTarget = { ...target, categories };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 重置指定目标的历史记录（清空 history + checkinsByDate；countup 同时清空起点）
  ipcMain.handle('reset-history', (_event, targetId) => {
    const state = readState();
    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const newTarget = { ...target, history: [], checkinsByDate: {} };
    if (newTarget.countMode === 'countup') {
      newTarget.startDate = '';
    }
    const targets = state.targets.map((t) => (t.id === tid ? newTarget : t));
    const streak = recomputeStreak(targets);
    const newState = { ...state, targets, streak };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // ================= 闹钟 =================

  ipcMain.handle('create-alarm', (_event, payload) => {
    const state = readState();
    const p = payload && typeof payload === 'object' ? payload : {};
    const type = p.type === 'countdown' ? 'countdown' : 'fixed';
    const label = String(p.label || '').trim() || (type === 'countdown' ? '倒计时' : '闹钟');
    const repeat = p.repeat === 'daily' ? 'daily' : 'once';

    let alarm;
    if (type === 'countdown') {
      // 指定日期时间模式：renderer 传入 triggerAt（绝对时间戳），换算为 endsAt
      if (p.triggerAt !== undefined && p.triggerAt !== null && p.triggerAt !== '') {
        const endsAt = Number(p.triggerAt);
        if (!Number.isFinite(endsAt) || endsAt <= Date.now()) {
          return { ok: false, error: '提醒时间必须是未来的时间', view: buildViewModel(state) };
        }
        const d = new Date(endsAt);
        const time = [d.getHours(), d.getMinutes()]
          .map((n) => String(n).padStart(2, '0'))
          .join(':');
        alarm = {
          id: generateId('alarm'),
          type,
          label,
          repeat: 'once', // 指定日期时间仅支持一次性提醒
          endsAt,
          time,
          active: true,
          createdAt: Date.now()
        };
      } else {
        const dur = Number(p.durationSeconds);
        if (!Number.isInteger(dur) || dur <= 0) {
          return { ok: false, error: '请设置有效的倒计时时长', view: buildViewModel(state) };
        }
        alarm = {
          id: generateId('alarm'),
          type,
          label,
          repeat,
          endsAt: Date.now() + dur * 1000,
          time: '',
          active: true,
          createdAt: Date.now()
        };
      }
    } else {
      const time = String(p.time || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(time)) {
        return { ok: false, error: '请设置有效的提醒时刻', view: buildViewModel(state) };
      }
      const [h, min] = time.split(':').map(Number);
      if (h < 0 || h > 23 || min < 0 || min > 59) {
        return { ok: false, error: '请设置有效的提醒时刻', view: buildViewModel(state) };
      }
      alarm = {
        id: generateId('alarm'),
        type,
        label,
        repeat,
        endsAt: 0,
        time,
        active: true,
        createdAt: Date.now()
      };
    }

    const alarms = [...(state.alarms || []), alarm];
    const newState = { ...state, alarms };
    writeState(newState);
    return { ok: true, alarm, view: buildViewModel(newState) };
  });

  ipcMain.handle('delete-alarm', (_event, id) => {
    const state = readState();
    const aid = String(id || '');
    const alarms = (state.alarms || []).filter((a) => a.id !== aid);
    alarmTriggeredIds.delete(aid);
    const newState = { ...state, alarms };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('toggle-alarm', (_event, id) => {
    const state = readState();
    const aid = String(id || '');
    const alarms = (state.alarms || []).map((a) =>
      a.id === aid ? { ...a, active: !a.active } : a
    );
    const newState = { ...state, alarms };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('dismiss-alarm', (_event, id) => {
    const aid = String(id || '');
    alarmTriggeredIds.delete(aid);
    closeAlarmWindow();
    return { ok: true };
  });

  // ================= 待办（作用于指定目标） =================

  ipcMain.handle('add-todo', (_event, targetId, text, categoryId) => {
    const content = String(text || '').trim();
    if (!content) {
      return { ok: false, error: '待办内容不能为空' };
    }

    const state = readState();
    rolloverTodosIfNeeded(state);

    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const today = getTodayString();
    const byDate = target.todosByDate || {};

    let cid = String(categoryId || '');
    if (!target.categories.some((c) => c.id === cid)) {
      cid = target.currentCategoryId || target.categories[0].id;
    }

    const todo = {
      id: `todo_${Date.now()}`,
      text: content,
      done: false,
      carried: false,
      categoryId: cid
    };

    byDate[today] = [...(byDate[today] || []), todo];
    const newTarget = { ...target, todosByDate: byDate };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, todo, view: buildViewModel(newState) };
  });

  ipcMain.handle('toggle-todo', (_event, targetId, id) => {
    const state = readState();
    rolloverTodosIfNeeded(state);

    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const today = getTodayString();
    const byDate = target.todosByDate || {};
    byDate[today] = (byDate[today] || []).map((t) =>
      t.id === id ? { ...t, done: !t.done } : t
    );

    const newTarget = { ...target, todosByDate: byDate };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('delete-todo', (_event, targetId, id) => {
    const state = readState();
    rolloverTodosIfNeeded(state);

    const tid = String(targetId || '');
    const target = state.targets.find((t) => t.id === tid);
    if (!target) {
      return { ok: false, error: '目标不存在', view: buildViewModel(state) };
    }

    const today = getTodayString();
    const byDate = target.todosByDate || {};
    byDate[today] = (byDate[today] || []).filter((t) => t.id !== id);

    const newTarget = { ...target, todosByDate: byDate };
    const newState = { ...state, targets: state.targets.map((t) => (t.id === tid ? newTarget : t)) };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 查询指定日期的待办（当前目标）
  ipcMain.handle('get-todos-by-date', (_event, dateStr) => {
    const state = readState();
    rolloverTodosIfNeeded(state);
    const currentTarget = state.targets.find((t) => t.id === state.currentTargetId) || state.targets[0];
    const byDate = (currentTarget && currentTarget.todosByDate) || {};
    const date = String(dateStr || '');
    const list = Array.isArray(byDate[date]) ? byDate[date] : [];
    return { ok: true, date, todos: list };
  });

  // 获取日历回看概况（当前目标，含统计汇总 stats）
  ipcMain.handle('get-calendar-overview', () => {
    const state = readState();
    rolloverTodosIfNeeded(state);
    return buildViewModel(state);
  });

  // 打开 / 关闭日历回看弹窗
  ipcMain.handle('open-calendar', () => {
    openCalendarWindow();
    return { ok: true };
  });

  ipcMain.handle('close-calendar', () => {
    if (calendarWindow && !calendarWindow.isDestroyed()) {
      calendarWindow.close();
    }
    return { ok: true };
  });

  // ================= 备份 / 恢复 =================

  ipcMain.handle('backup-data', async () => {
    return backupDataToFile();
  });

  ipcMain.handle('pick-restore-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择备份文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, error: '已取消' };
    }

    const filePath = result.filePaths[0];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: '备份文件格式不正确' };
      }
      if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
        return { ok: false, error: '不支持的备份版本' };
      }
      pendingRestore = { parsed, fileName: path.basename(filePath) };
      return { ok: true, fileName: path.basename(filePath), schemaVersion: parsed.schemaVersion };
    } catch (err) {
      return { ok: false, error: '读取备份失败：' + (err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('apply-restore', () => {
    if (!pendingRestore) {
      return { ok: false, error: '请先选择备份文件', view: buildViewModel(readState()) };
    }
    try {
      let parsed = pendingRestore.parsed;
      if (parsed.schemaVersion === 2) {
        parsed = migrateV2toV3(parsed);
      }
      const fresh = normalizeState(parsed);
      writeState(fresh);
      pendingRestore = null;
      return { ok: true, view: buildViewModel(fresh) };
    } catch (err) {
      return { ok: false, error: '恢复失败：' + (err && err.message ? err.message : err) };
    }
  });

  // ================= 开机自启动 / 系统设置 =================

  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    const state = readState();
    const value = !!enabled;
    try {
      app.setLoginItemSettings({ openAtLogin: value });
    } catch (err) {
      return { ok: false, error: '设置开机自启动失败：' + (err && err.message ? err.message : err), view: buildViewModel(state) };
    }
    const newState = { ...state, autoLaunch: value };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  ipcMain.handle('open-system', () => {
    openSystemWindow();
    return { ok: true };
  });

  ipcMain.handle('close-system', () => {
    if (systemWindow && !systemWindow.isDestroyed()) {
      systemWindow.close();
    }
    return { ok: true };
  });

  // ================= 番茄钟 =================

  ipcMain.handle('open-pomodoro', () => {
    openPomodoroWindow();
    return { ok: true, status: getPomodoroStatus() };
  });

  ipcMain.handle('close-pomodoro', () => {
    if (pomodoroWindow && !pomodoroWindow.isDestroyed()) {
      pomodoroWindow.close();
    }
    return { ok: true };
  });

  ipcMain.handle('start-pomodoro', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    startPomodoro({
      workMin: p.workMin,
      breakMin: p.breakMin,
      cycles: p.cycles
    });
    return { ok: true, status: getPomodoroStatus() };
  });

  ipcMain.handle('stop-pomodoro', () => {
    stopPomodoro();
    return { ok: true, status: getPomodoroStatus() };
  });

  ipcMain.handle('get-pomodoro-status', () => {
    return getPomodoroStatus();
  });

  ipcMain.handle('update-pomodoro-settings', (_event, payload) => {
    const state = readState();
    const p = payload && typeof payload === 'object' ? payload : {};
    const pomodoro = {
      workMin: clampInt(p.workMin, 1, 180, state.pomodoro.workMin),
      breakMin: clampInt(p.breakMin, 1, 60, state.pomodoro.breakMin),
      cycles: clampInt(p.cycles, 1, 12, state.pomodoro.cycles)
    };
    pomodoroRuntime.settings = pomodoro;
    const newState = { ...state, pomodoro };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // ================= 窗口控制（单向 send） =================

  ipcMain.on('drag-window', (event, delta) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const dx = Number(delta && delta.dx) || 0;
    const dy = Number(delta && delta.dy) || 0;
    const [x, y] = win.getPosition();
    win.setPosition(x + Math.round(dx), y + Math.round(dy));
  });

  ipcMain.on('set-panel-open', (_event, open) => {
    setPanelExpanded(!!open);
  });

  ipcMain.on('show-context-menu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const menu = Menu.buildFromTemplate([
      {
        label: '最小化',
        click: () => win.minimize()
      },
      {
        label: '关闭',
        click: () => win.close()
      },
      { type: 'separator' },
      {
        label: '番茄钟',
        click: () => openPomodoroWindow()
      },
      {
        label: '系统设置',
        click: () => openSystemWindow()
      },
      {
        label: '备份数据',
        click: () => {
          backupDataToFile().then((res) => {
            if (res.ok) notify('倒数日', '备份成功');
            else if (res.error && res.error !== '已取消') notify('倒数日', res.error);
          });
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    menu.popup({ window: win });
  });
}

app.whenReady().then(() => {
  // 数据文件：<userData>/countdown-data.json
  dataFilePath = path.join(app.getPath('userData'), 'countdown-data.json');
  registerIpcHandlers();
  createWindow();
  createTray();
  startAlarmTimer(); // 启动闹钟检查

  // 初始化番茄钟运行态设置
  const initialState = readState();
  pomodoroRuntime.settings = { ...initialState.pomodoro };

  // macOS：点击 Dock 图标且无窗口时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时不退出：窗口「关闭」= 隐藏到后台，应用常驻，由系统托盘控制。
app.on('window-all-closed', () => {
  // 不退出应用，驻留后台
});

// 真正退出前置位 isQuitting，保证 close 拦截放行、窗口能正常关闭。
app.on('before-quit', () => {
  isQuitting = true;
});

// 退出时清理：托盘、闹钟定时器、番茄钟定时器、各类子窗口。
app.on('will-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
  if (pomodoroRuntime.timer) {
    clearInterval(pomodoroRuntime.timer);
    pomodoroRuntime.timer = null;
  }
  if (alarmWindow && !alarmWindow.isDestroyed()) {
    alarmWindow.close();
  }
  if (pomodoroWindow && !pomodoroWindow.isDestroyed()) {
    pomodoroWindow.close();
  }
  if (systemWindow && !systemWindow.isDestroyed()) {
    systemWindow.close();
  }
});
