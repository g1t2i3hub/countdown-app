'use strict';

/**
 * 倒计时桌面应用 —— Electron 主进程
 *
 * 职责：
 *  - 创建应用窗口（contextIsolation: true, nodeIntegration: false）
 *  - 管理数据文件的读写（存放在 app.getPath('userData') 目录）
 *  - 通过 IPC 暴露安全的增删改查接口给渲染进程
 */

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * 窗口固定尺寸（含悬浮条 + 下拉面板区域）。
 * 采用纯 CSS hover 下拉，不需要动态缩放窗口：
 * 透明窗口让收起态看起来只是一个悬浮条，悬停时下拉面板在窗口内滑出。
 */
const BAR_HEIGHT = 60;          // 悬浮条高度
const WINDOW_SIZE = { width: 300, height: 560 };
const CALENDAR_SIZE = { width: 360, height: 440 }; // 日历回看弹窗尺寸

/** 应用数据的默认结构 */
const DEFAULT_STATE = {
  totalDays: 0,   // 用户设置的总天数
  targetDate: '', // 目标日期（YYYY-MM-DD），设置页通过日历选中；为空时由 totalDays 反推
  message: '',    // 自定义含义文字
  history: [],    // 历史消除记录：[{ id, date, time, timestamp }]
  todosByDate: {}, // 按日期分组的待办：{ "YYYY-MM-DD": [{ id, text, done, carried }] }
  btnActiveText: '',  // 按钮「未消除」时文字（用户自定义）
  btnDoneText: '',     // 按钮「已消除」时文字（用户自定义）
  displayMode: 'days'  // 剩余时间显示方式：'days' | 'months' | 'years'
};

let mainWindow = null;
let calendarWindow = null;
let dataFilePath = null;
let tray = null;        // 系统托盘图标（常驻，避免被 GC 回收导致图标消失）
let isQuitting = false; // 是否正在真正退出应用（用于区分「关闭窗口=隐藏」与「托盘退出」）

/**
 * 返回今天的日期字符串（本地时区），格式：YYYY-MM-DD
 * 用于判断「今天」是否已经消除过。
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
 * 从磁盘读取状态；文件不存在或损坏时回退到默认状态。
 * @returns {object} 合并默认值后的状态对象
 */
function readState() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const raw = fs.readFileSync(dataFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch (err) {
    console.error('[main] 读取数据失败:', err);
  }
  return { ...DEFAULT_STATE };
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
 * 处理跨天逻辑：若今天还没有待办记录，则把昨天「未完成」的待办
 * 自动顺延到今天（标记 carried = true，表示是遗留待办）。
 * 返回是否需要写盘（true 表示发生了顺延/初始化）。
 * @param {object} state
 * @returns {boolean}
 */
function rolloverTodosIfNeeded(state) {
  const today = getTodayString();
  const byDate = (state.todosByDate && typeof state.todosByDate === 'object')
    ? state.todosByDate
    : {};

  // 今天已有记录（哪怕为空数组）→ 无需处理
  if (Array.isArray(byDate[today])) {
    return false;
  }

  // 兼容旧数据结构：若存在旧的 todos 字段，迁移到 todosByDate
  if (Array.isArray(state.todos) && state.todos.length > 0) {
    byDate[today] = state.todos.map((t) => ({
      id: t.id,
      text: t.text,
      done: !!t.done,
      carried: false
    }));
    delete state.todos;
    delete state.todoDate;
    state.todosByDate = byDate;
    return true;
  }

  // 找到昨天未完成的待办，顺延到今天
  const yesterday = getYesterdayString();
  const yestTodos = Array.isArray(byDate[yesterday]) ? byDate[yesterday] : [];
  const carried = yestTodos
    .filter((t) => !t.done)
    .map((t) => ({
      id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: t.text,
      done: false,
      carried: true
    }));

  byDate[today] = carried;
  state.todosByDate = byDate;
  return true;
}

/**
 * 把剩余天数格式化成用户选择的显示方式。
 * @param {number} remainingDays 剩余天数
 * @param {string} mode 显示方式：'days' | 'months' | 'years'
 * @returns {string} 例如 '100' / '3个月10天' / '1年2个月5天'
 */
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
    // 超过 12 个月时进位为「年」，避免出现「24个月」这类奇怪表达
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

  // 默认：纯天数
  return String(days);
}

/**
 * 由原始状态构建「视图模型」，把派生字段一次性计算好交给渲染进程。
 * @param {object} state
 * @returns {object}
 */
function buildViewModel(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const totalDays = Number(state.totalDays) || 0;
  const eliminatedCount = history.length;
  const remainingDays = Math.max(totalDays - eliminatedCount, 0);
  const today = getTodayString();
  const eliminatedToday = history.some((h) => h.date === today);

  const todosByDate = (state.todosByDate && typeof state.todosByDate === 'object')
    ? state.todosByDate
    : {};
  const todos = Array.isArray(todosByDate[today]) ? todosByDate[today] : [];

  // 构建日历概况：每个有记录的日期 → { done, total }
  const todoDates = {};
  Object.keys(todosByDate).forEach((date) => {
    const list = todosByDate[date] || [];
    todoDates[date] = {
      done: list.filter((t) => t.done).length,
      total: list.length
    };
  });

  return {
    configured: totalDays > 0,
    totalDays,
    targetDate: state.targetDate || '',
    message: state.message || '',
    btnActiveText: state.btnActiveText || '',
    btnDoneText: state.btnDoneText || '',
    displayMode: ['days', 'months', 'years'].includes(state.displayMode) ? state.displayMode : 'days',
    remainingDays,
    remainingText: formatRemaining(remainingDays, state.displayMode),
    eliminatedCount,
    eliminatedToday,
    history,
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
  // 只有托盘「退出」或右键系统菜单「退出」先把 isQuitting 置 true 后，
  // 这里才会放行，让窗口真正关闭。
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
 * @param {{width:number,height:number}} size
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
 * 收起态窗口只有悬浮条高度（BAR_HEIGHT），下方无透明区域，不挡底层应用；
 * 展开态窗口增高到完整高度，顶部位置（x/y）保持不变，向下延伸。
 * @param {boolean} expanded
 */
function setPanelExpanded(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const targetHeight = expanded ? WINDOW_SIZE.height : BAR_HEIGHT;
  mainWindow.setBounds({
    x,
    y,
    width: WINDOW_SIZE.width,
    height: targetHeight
  });
}

/**
 * 将日历回看弹窗定位到主窗口左侧（与主窗口顶部对齐）；
 * 若左侧空间不足，则回退到工作区左上角。
 */
function positionCalendarWindow() {
  if (!calendarWindow || calendarWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
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

  calendarWindow.setBounds({
    x: Math.round(nx),
    y: Math.round(ny),
    width: CALENDAR_SIZE.width,
    height: CALENDAR_SIZE.height
  });
}

/**
 * 打开（或聚焦）日历回看弹窗。
 * 弹窗定位在主窗口左侧（若空间不足则定位到左上角）。
 */
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
    skipTaskbar: true,      // 日历弹窗同样不显示在任务栏
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

  calendarWindow.loadFile(path.join(__dirname, 'calendar.html'));

  // 就绪前先定位，避免弹窗先出现在默认位置
  positionCalendarWindow();

  calendarWindow.on('closed', () => {
    calendarWindow = null;
  });
}

/**
 * 加载托盘图标：优先使用专为托盘生成的 16×16 小图标（build/tray-icon.png），
 * 若缺失则回退到原始 icon.png 并在运行时缩放到 16×16。
 * @returns {Electron.NativeImage|null} 托盘图标，加载失败返回 null
 */
function createTrayIcon() {
  const trayIconPath = path.join(__dirname, 'build', 'tray-icon.png');
  const image = nativeImage.createFromPath(trayIconPath);
  if (!image.isEmpty()) {
    return image;
  }

  // 回退：直接用原图运行时缩放（Windows 托盘需要小尺寸图标）
  const fallback = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (fallback.isEmpty()) {
    return null;
  }
  return fallback.resize({ width: 16, height: 16 });
}

/**
 * 显示（恢复）主窗口并聚焦。
 * 窗口可能因「关闭」被隐藏，或已被销毁（理论上不会），此处做兜底重建。
 */
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

/**
 * 切换主窗口显示/隐藏（供托盘「显示/隐藏」菜单使用）。
 */
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
 * 创建系统托盘图标：单击恢复窗口，右键弹出「显示/隐藏 / 退出」菜单。
 * 不调用 setContextMenu，改用 right-click + popUpContextMenu，
 * 这样 Windows 上单击（click）依然可靠触发，避免「设置菜单后单击失效」的问题。
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

/** 注册所有 IPC 处理器 */
function registerIpcHandlers() {
  // 读取完整状态（同时处理待办跨天清空）
  ipcMain.handle('get-state', () => {
    const state = readState();
    if (rolloverTodosIfNeeded(state)) {
      writeState(state);
    }
    return buildViewModel(state);
  });

  // 保存设置：设置新倒计时会重置历史记录（视为开启一段新的倒计时）
  ipcMain.handle('save-settings', (_event, settings) => {
    const targetDate = String(settings && settings.targetDate ? settings.targetDate : '').trim();

    // 优先用目标日期计算天数（保证与日历选中一致）；否则回退用传入的 totalDays
    let totalDays;
    if (targetDate) {
      totalDays = daysUntil(targetDate);
      if (totalDays <= 0) {
        return { ok: false, error: '目标日期必须是未来的日期' };
      }
    } else {
      totalDays = Number(settings && settings.totalDays);
      if (!Number.isInteger(totalDays) || totalDays <= 0) {
        return { ok: false, error: '请选择目标日期' };
      }
    }

    const message = String(settings && settings.message ? settings.message : '').trim();
    const btnActiveText = String(settings && settings.btnActiveText ? settings.btnActiveText : '').trim();
    const btnDoneText = String(settings && settings.btnDoneText ? settings.btnDoneText : '').trim();
    const displayMode = ['days', 'months', 'years'].includes(settings && settings.displayMode)
      ? settings.displayMode
      : 'days';
    const state = {
      totalDays,
      targetDate,
      message,
      btnActiveText,
      btnDoneText,
      displayMode,
      history: []
    };
    writeState(state);
    return { ok: true, view: buildViewModel(state) };
  });

  // 消除今天：同一天只能消除一次
  ipcMain.handle('eliminate-today', () => {
    const state = readState();
    const totalDays = Number(state.totalDays) || 0;

    if (totalDays <= 0) {
      return { ok: false, error: '请先设置倒计时', view: buildViewModel(state) };
    }

    const today = getTodayString();
    const history = Array.isArray(state.history) ? state.history : [];

    if (history.some((h) => h.date === today)) {
      return { ok: false, error: '今天已经消除过了，明天再来吧', view: buildViewModel(state) };
    }

    if (history.length >= totalDays) {
      return { ok: false, error: '倒计时已全部完成 🎉', view: buildViewModel(state) };
    }

    const entry = {
      id: `${today}_${Date.now()}`,
      date: today,
      time: getTimeString(),
      timestamp: Date.now()
    };

    // 最新的记录放在最前面
    const newState = { ...state, history: [entry, ...history] };
    writeState(newState);
    return { ok: true, entry, view: buildViewModel(newState) };
  });

  // 重置历史记录（剩余天数恢复为总天数）
  ipcMain.handle('reset-history', () => {
    const state = readState();
    const newState = { ...state, history: [] };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 新增待办
  ipcMain.handle('add-todo', (_event, text) => {
    const content = String(text || '').trim();
    if (!content) {
      return { ok: false, error: '待办内容不能为空' };
    }

    const state = readState();
    rolloverTodosIfNeeded(state);
    const today = getTodayString();
    const byDate = state.todosByDate || {};

    const todo = {
      id: `todo_${Date.now()}`,
      text: content,
      done: false,
      carried: false
    };

    byDate[today] = [...(byDate[today] || []), todo];
    const newState = { ...state, todosByDate: byDate };
    writeState(newState);
    return { ok: true, todo, view: buildViewModel(newState) };
  });

  // 切换待办完成状态（打勾 / 取消）
  ipcMain.handle('toggle-todo', (_event, id) => {
    const state = readState();
    rolloverTodosIfNeeded(state);
    const today = getTodayString();
    const byDate = state.todosByDate || {};

    byDate[today] = (byDate[today] || []).map((t) =>
      t.id === id ? { ...t, done: !t.done } : t
    );

    const newState = { ...state, todosByDate: byDate };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 删除待办（只删今天这份，不影响历史日期记录）
  ipcMain.handle('delete-todo', (_event, id) => {
    const state = readState();
    rolloverTodosIfNeeded(state);
    const today = getTodayString();
    const byDate = state.todosByDate || {};

    byDate[today] = (byDate[today] || []).filter((t) => t.id !== id);
    const newState = { ...state, todosByDate: byDate };
    writeState(newState);
    return { ok: true, view: buildViewModel(newState) };
  });

  // 查询指定日期的待办（供日历回看）
  ipcMain.handle('get-todos-by-date', (_event, dateStr) => {
    const state = readState();
    rolloverTodosIfNeeded(state);
    const byDate = state.todosByDate || {};
    const date = String(dateStr || '');
    const list = Array.isArray(byDate[date]) ? byDate[date] : [];
    return { ok: true, date, todos: list };
  });

  // 获取日历回看所需的全局概况：所有有记录的日期的 done/total + 完整 todosByDate
  ipcMain.handle('get-calendar-overview', () => {
    const state = readState();
    rolloverTodosIfNeeded(state);
    return buildViewModel(state);
  });

  // 打开日历回看弹窗
  ipcMain.handle('open-calendar', () => {
    openCalendarWindow();
    return { ok: true };
  });

  // 关闭日历回看弹窗
  ipcMain.handle('close-calendar', () => {
    if (calendarWindow && !calendarWindow.isDestroyed()) {
      calendarWindow.close();
    }
    return { ok: true };
  });

  // 拖动窗口（无边框窗口移动）：渲染进程传入增量位移 { dx, dy }
  // 根据 event.sender 判断是主窗口还是日历弹窗发起的拖动。
  // 用 ipcMain.on（对应 preload 的 send，单向），避免高频 invoke 往返造成拖动卡顿。
  ipcMain.on('drag-window', (event, delta) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const dx = Number(delta && delta.dx) || 0;
    const dy = Number(delta && delta.dy) || 0;
    const [x, y] = win.getPosition();
    win.setPosition(x + Math.round(dx), y + Math.round(dy));
  });

  // 展开/收起主窗口下拉面板：动态调整窗口高度（收起时不挡底层应用）
  ipcMain.on('set-panel-open', (_event, open) => {
    setPanelExpanded(!!open);
  });

  // 右键弹出系统菜单（最小化 / 关闭 / 退出）
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

  // macOS：点击 Dock 图标且无窗口时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时不退出：窗口「关闭」= 隐藏到后台，应用常驻，由系统托盘控制。
// 只有托盘「退出」或右键系统菜单「退出」才真正退出整个应用。
app.on('window-all-closed', () => {
  // 不退出应用，驻留后台
});

// 真正退出前置位 isQuitting，保证 close 拦截放行、窗口能正常关闭。
app.on('before-quit', () => {
  isQuitting = true;
});

// 退出时销毁托盘，避免残留一个无响应/幽灵图标。
app.on('will-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
