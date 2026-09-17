'use strict';

/**
 * 倒数日 —— 渲染进程逻辑（v3 多目标版本）
 *
 * 窗口固定尺寸（透明），悬浮条常驻顶部，点击悬浮条切换下拉面板展开/收起。
 * JS 负责：数据渲染 + 打卡 + 目标/类目/待办/闹钟 + 番茄钟 + 备份 + 面板切换。
 */

const $ = (selector) => document.querySelector(selector);

// ---------- DOM 引用 ----------
const floatBar = $('#float-bar');
const floatDaysEl = $('#float-days');
const floatUnitEl = $('#float-unit');
const floatEliminateBtn = $('#float-eliminate-btn');
const floatAlarmEl = $('#float-alarm');

const targetChips = $('#target-chips');
const targetAdd = $('#target-add');

const messageText = $('#message-text');
const streakBadge = $('#streak-badge');
const streakCountEl = $('#streak-count');
const streakLongestEl = $('#streak-longest');
const remainingDaysEl = $('#remaining-days');
const numberUnitEl = $('#number-unit');
const eliminateBtn = $('#eliminate-btn');

const resetHistoryBtn = $('#reset-history-btn');
const editSettingsBtn = $('#edit-settings-btn');

const todoInput = $('#todo-input');
const todoAddBtn = $('#todo-add-btn');
const todoList = $('#todo-list');
const todoEmpty = $('#todo-empty');
const todoCalendarToggle = $('#todo-calendar-toggle');

const categoryChips = $('#category-chips');
const categoryAdd = $('#category-add');

const setupView = $('#setup-view');
const stage = $('#stage');
const setupTitle = $('#setup-title');
const targetNameInput = $('#target-name-input');
const countModeSelect = $('#count-mode-select');
const targetDateField = $('#target-date-field');
const targetDateInput = $('#target-date-input');
const targetDateHint = $('#target-date-hint');
const startDateField = $('#start-date-field');
const startDateInput = $('#start-date-input');
const displayModeField = $('#display-mode-field');
const displayModeSelect = $('#display-mode-select');
const themeSelect = $('#theme-select');
const saveSettingsBtn = $('#save-settings-btn');
const cancelEditBtn = $('#cancel-edit-btn');
const setupError = $('#setup-error');

// 类目文案编辑浮层
const categoryEditView = $('#category-edit-view');
const categoryEditTitle = $('#category-edit-title');
const categoryMessageInput = $('#category-message-input');
const categoryActiveTextInput = $('#category-active-text-input');
const categoryDoneTextInput = $('#category-done-text-input');
const saveCategoryTextsBtn = $('#save-category-texts-btn');
const cancelCategoryTextsBtn = $('#cancel-category-texts-btn');

// 闹钟区
const alarmSection = $('#alarm-section');
const alarmList = $('#alarm-list');
const alarmEmpty = $('#alarm-empty');
const alarmAddBtn = $('#alarm-add-btn');
const alarmEditView = $('#alarm-edit-view');
const alarmTabCountdown = $('#alarm-tab-countdown');
const alarmTabFixed = $('#alarm-tab-fixed');
const alarmLabelInput = $('#alarm-label-input');
const alarmCountdownField = $('#alarm-countdown-field');
const alarmDurationInput = $('#alarm-duration-input');
const alarmSubTabRelative = $('#alarm-subtab-relative');
const alarmSubTabAbsolute = $('#alarm-subtab-absolute');
const alarmRelativeField = $('#alarm-relative-field');
const alarmAbsoluteField = $('#alarm-absolute-field');
const alarmDateInput = $('#alarm-date-input');
const alarmTimeAbsoluteInput = $('#alarm-time-absolute-input');
const alarmFixedField = $('#alarm-fixed-field');
const alarmTimeInput = $('#alarm-time-input');
const alarmRepeatSelect = $('#alarm-repeat-select');
const saveAlarmBtn = $('#save-alarm-btn');
const cancelAlarmBtn = $('#cancel-alarm-btn');
const alarmError = $('#alarm-error');

// 番茄钟 / 系统区
const pomodoroOpenBtn = $('#pomodoro-open-btn');
const pomodoroStatusEl = $('#pomodoro-status');
const pomodoroWorkInput = $('#pomodoro-work-input');
const pomodoroBreakInput = $('#pomodoro-break-input');
const pomodoroCyclesInput = $('#pomodoro-cycles-input');
const pomodoroStartBtn = $('#pomodoro-start-btn');
const floatSystemBtn = $('#float-system-btn');

// ---------- 状态 ----------
let currentState = null;
let isAnimating = false;
let editing = false; // 是否处于「目标 新建/编辑」模式
let panelOpen = false; // 下拉面板是否展开
let didDrag = false;   // 标记是否刚发生过拖动
let categoryInputActive = false; // 是否正在内联输入类目名
let editingCategoryTexts = false; // 类目文案浮层打开中
let editingCategoryId = '';       // 正在编辑文案的类目 id
let alarmType = 'countdown';      // 当前新建闹钟类型
let alarmCountdownMode = 'relative'; // 倒计时子模式：relative（相对时长）| absolute（指定日期时间）
let alarmEditing = false;         // 是否正在新建闹钟

// ---------- 工具函数 ----------

/** 格式化日期字符串为「M月D日 · 周X」 */
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const dt = new Date(y, m - 1, d);
  const wd = weekdays[dt.getDay()];
  return `${m}月${d}日 · 周${wd}`;
}

/** Date → YYYY-MM-DD */
function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 从今天起算，往后加 N 天得到目标日期字符串 */
function addDaysToToday(n) {
  const dt = new Date();
  dt.setDate(dt.getDate() + n);
  return toDateStr(dt);
}

/** 计算今天到目标日期相差的天数（未来为正，否则 0） */
function daysUntilLocal(targetDateStr) {
  if (!targetDateStr) return 0;
  const [ty, tm, td] = targetDateStr.split('-').map(Number);
  if (!ty || !tm || !td) return 0;
  const target = new Date(ty, tm - 1, td);
  if (isNaN(target.getTime())) return 0;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

/** 是否为未来日期 */
function isFutureDate(dateStr) {
  return daysUntilLocal(dateStr) > 0;
}

/** 将自定义文字中的占位符替换为剩余天数 */
function renderMessage(raw, remaining) {
  return raw
    .replace(/\{remaining\}/g, String(remaining))
    .replace(/\{days\}/g, String(remaining))
    .replace(/\bX\b/g, String(remaining));
}

// ---------- 目标选择 ----------

/** 渲染目标 chips（名称 + 摘要 + 删除；选中项高亮） */
function renderTargets() {
  const s = currentState;
  targetChips.innerHTML = '';
  const targets = (s && s.targets) || [];
  const currentId = (s && s.currentTargetId) || (targets[0] && targets[0].id) || '';

  targets.forEach((t) => {
    const chip = document.createElement('div');
    chip.className = 'target-chip' + (t.id === currentId ? ' active' : '');
    chip.dataset.id = t.id;

    const name = document.createElement('span');
    name.className = 'target-name';
    name.textContent = t.name;

    const sub = document.createElement('span');
    sub.className = 'target-sub';
    sub.textContent = t.isCountup
      ? `已坚持${t.remainingDays}天`
      : (t.remainingText || '');

    chip.appendChild(name);
    chip.appendChild(sub);

    // 至少保留一个目标：多于一个时才显示删除
    if (targets.length > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'target-del';
      del.textContent = '×';
      del.title = '删除目标';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDeleteTarget(t.id);
      });
      chip.appendChild(del);
    }

    chip.addEventListener('click', () => {
      if (t.id !== currentId) {
        handleSelectTarget(t.id);
      }
    });

    // 双击编辑目标
    chip.addEventListener('dblclick', async () => {
      if (t.id !== currentId) {
        await handleSelectTarget(t.id);
      }
      handleEditSettings();
    });

    targetChips.appendChild(chip);
  });
}

/** 渲染连续打卡火焰角标 */
function renderStreak() {
  const streak = currentState ? currentState.streak : null;
  if (streak && (streak.current > 0 || streak.longest > 0)) {
    streakCountEl.textContent = String(streak.current);
    streakLongestEl.textContent = String(streak.longest);
    streakBadge.classList.remove('hidden');
  } else {
    streakBadge.classList.add('hidden');
  }
}

// ---------- 类目选择 ----------

/** 悬浮条按钮文字较长，类目名超 4 字截断为「…」 */
function truncateCategoryName(name) {
  const str = String(name || '');
  return str.length > 4 ? `${str.slice(0, 4)}…` : str;
}

/** 渲染类目 chips */
function renderCategories() {
  const s = currentState;
  categoryChips.innerHTML = '';
  const categories = (s && s.categories) || [];
  const currentId = (s && s.currentCategoryId) || (categories[0] && categories[0].id) || '';

  categories.forEach((cat) => {
    const chip = document.createElement('div');
    chip.className = 'category-chip' + (cat.id === currentId ? ' active' : '');
    chip.dataset.id = cat.id;

    const dot = document.createElement('span');
    dot.className = 'category-dot';
    dot.style.background = cat.color;

    const name = document.createElement('span');
    name.className = 'category-name';
    name.textContent = cat.name;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'category-del';
    del.textContent = '×';
    del.title = '删除类目';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteCategory(cat.id);
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'category-edit';
    edit.textContent = '✎';
    edit.title = '编辑含义与按钮文字';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openCategoryTextEditor(cat.id);
    });

    chip.appendChild(dot);
    chip.appendChild(name);
    chip.appendChild(edit);
    chip.appendChild(del);

    chip.addEventListener('click', () => {
      if (cat.id !== currentId) {
        handleSelectCategory(cat.id);
      }
    });

    chip.addEventListener('dblclick', () => {
      startRenameCategory(cat);
    });

    categoryChips.appendChild(chip);
  });
}

/** 点击 ＋ 展开内联输入框，新建类目 */
function startCreateCategory() {
  if (categoryInputActive) return;
  categoryInputActive = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'category-input';
  input.placeholder = '类目名（≤12字）';
  input.maxLength = 12;
  categoryChips.appendChild(input);
  input.focus();

  let finished = false;
  const commit = async () => {
    if (finished) return;
    finished = true;
    categoryInputActive = false;
    const name = input.value.trim();
    input.remove();
    if (name) {
      await handleCreateCategory(name);
    }
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    categoryInputActive = false;
    input.remove();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', () => {
    if (!finished) commit();
  });
}

/** 双击 chip 展开内联输入框，重命名类目 */
function startRenameCategory(cat) {
  if (categoryInputActive) return;
  const chip = categoryChips.querySelector(`.category-chip[data-id="${cat.id}"]`);
  if (!chip) return;
  const nameEl = chip.querySelector('.category-name');
  if (!nameEl) return;

  categoryInputActive = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'category-input';
  input.value = cat.name;
  input.maxLength = 12;
  chip.replaceChild(input, nameEl);
  input.focus();
  input.select();

  let finished = false;
  const commit = async () => {
    if (finished) return;
    finished = true;
    categoryInputActive = false;
    const name = input.value.trim();
    if (name && name !== cat.name) {
      await handleRenameCategory(cat.id, name);
    } else {
      renderCategories();
    }
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    categoryInputActive = false;
    renderCategories();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', () => {
    if (!finished) commit();
  });
}

// ---------- 下拉面板展开/收起 ----------

function setPanelOpen(open) {
  panelOpen = open;
  stage.classList.toggle('open', open);
  window.api.setPanelOpen(open);
}

function togglePanel() {
  setPanelOpen(!panelOpen);
}

// ---------- 渲染 ----------

/** 应用主题 */
function applyTheme(theme) {
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-green', theme === 'green');
  if (themeSelect) {
    themeSelect.value = (theme === 'dark' || theme === 'green') ? theme : 'light';
  }
}

/** 渲染今日待办列表 */
function renderTodos() {
  const todos = currentState ? currentState.todos || [] : [];
  todoList.innerHTML = '';

  if (todos.length === 0) {
    todoEmpty.classList.remove('hidden');
    todoList.classList.add('hidden');
    return;
  }

  todoEmpty.classList.add('hidden');
  todoList.classList.remove('hidden');

  todos.forEach((todo) => {
    const li = document.createElement('li');
    li.className = 'todo-item' + (todo.done ? ' done' : '');

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'todo-check' + (todo.done ? ' checked' : '');
    check.textContent = todo.done ? '✓' : '';
    check.setAttribute('aria-label', '标记完成');
    check.addEventListener('click', () => handleToggleTodo(todo.id));

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', '删除待办');
    del.addEventListener('click', () => handleDeleteTodo(todo.id));

    li.appendChild(check);
    li.appendChild(text);

    if (todo.carried) {
      const badge = document.createElement('span');
      badge.className = 'todo-carried-badge';
      badge.textContent = '遗留';
      li.appendChild(badge);
    }

    li.appendChild(del);
    todoList.appendChild(li);
  });
}

// ---------- 日历回看 ----------

function handleToggleCalendar() {
  window.api.openCalendar();
}

// ---------- 闹钟 ----------

/** 把秒数格式化为「X小时X分X秒」或「X分X秒」 */
function formatAlarmDuration(totalSeconds) {
  const s = Math.max(Number(totalSeconds) || 0, 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小时${m}分${sec}秒`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

/** 解析本地「YYYY-MM-DD HH:mm」为 Date；非法返回 null */
function parseLocalDateTime(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!dm || !tm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  const h = Number(tm[1]);
  const min = Number(tm[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const dt = new Date(y, mo - 1, d, h, min, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** 渲染闹钟列表 */
function renderAlarms() {
  const alarms = currentState ? currentState.alarms || [] : [];
  alarmList.innerHTML = '';

  if (alarms.length === 0) {
    alarmEmpty.classList.remove('hidden');
    alarmList.classList.add('hidden');
    return;
  }

  alarmEmpty.classList.add('hidden');
  alarmList.classList.remove('hidden');

  alarms.forEach((alarm) => {
    const item = document.createElement('div');
    item.className = 'alarm-item' + (alarm.active ? '' : ' paused');

    const icon = document.createElement('span');
    icon.className = 'alarm-item-icon';
    icon.textContent = alarm.type === 'countdown' ? '⏳' : '⏰';

    const info = document.createElement('div');
    info.className = 'alarm-item-info';
    const label = document.createElement('div');
    label.className = 'alarm-item-label';
    label.textContent = alarm.label || (alarm.type === 'countdown' ? '倒计时' : '闹钟');

    const meta = document.createElement('div');
    meta.className = 'alarm-item-meta';
    if (alarm.type === 'countdown') {
      const remaining = alarm.active
        ? '剩余 ' + formatAlarmDuration(alarm.remainingSeconds || 0)
        : '已暂停';
      // 指定日期时间模式的闹钟会带 time（HH:MM），展示时前置该时刻更直观
      meta.textContent = alarm.time ? (alarm.time + ' · ' + remaining) : remaining;
    } else {
      const repeatText = alarm.repeat === 'daily' ? ' · 每天' : ' · 仅一次';
      meta.textContent = alarm.time + repeatText + (alarm.active ? '' : ' · 已暂停');
    }
    info.appendChild(label);
    info.appendChild(meta);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'alarm-item-toggle';
    toggle.textContent = alarm.active ? '暂停' : '恢复';
    toggle.setAttribute('aria-label', alarm.active ? '暂停闹钟' : '恢复闹钟');
    toggle.addEventListener('click', () => handleToggleAlarm(alarm.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'alarm-item-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', '删除闹钟');
    del.addEventListener('click', () => handleDeleteAlarm(alarm.id));

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(toggle);
    item.appendChild(del);
    alarmList.appendChild(item);
  });
}

/** 打开新建闹钟浮层 */
function openAlarmEditor() {
  alarmEditing = true;
  alarmType = 'countdown';
  alarmError.textContent = '';
  alarmLabelInput.value = '';
  alarmDurationInput.value = '';
  alarmTimeInput.value = '';
  alarmDateInput.value = '';
  alarmTimeAbsoluteInput.value = '';
  alarmRepeatSelect.value = 'once';
  switchAlarmType('countdown');
  switchAlarmCountdownMode('relative');
  stage.classList.add('hidden');
  setupView.classList.add('hidden');
  alarmEditView.classList.remove('hidden');
  window.api.setPanelOpen(true);
}

/** 切换闹钟类型 */
function switchAlarmType(type) {
  alarmType = type;
  alarmTabCountdown.classList.toggle('active', type === 'countdown');
  alarmTabFixed.classList.toggle('active', type === 'fixed');
  alarmCountdownField.classList.toggle('hidden', type !== 'countdown');
  alarmFixedField.classList.toggle('hidden', type !== 'fixed');
  syncAlarmRepeatLock();
}

/** 切换倒计时的子模式：相对时长 / 指定日期时间 */
function switchAlarmCountdownMode(mode) {
  alarmCountdownMode = mode === 'absolute' ? 'absolute' : 'relative';
  const absolute = alarmCountdownMode === 'absolute';
  alarmSubTabRelative.classList.toggle('active', !absolute);
  alarmSubTabAbsolute.classList.toggle('active', absolute);
  alarmRelativeField.classList.toggle('hidden', absolute);
  alarmAbsoluteField.classList.toggle('hidden', !absolute);
  if (absolute) {
    // 每次切换到「指定日期时间」时刷新最小日期，避免跨天后当天日期失效
    alarmDateInput.min = toDateStr(new Date());
  }
  syncAlarmRepeatLock();
}

/** 依据当前类型 + 子模式同步「重复」下拉框的锁定状态（仅指定日期时间锁定为一次） */
function syncAlarmRepeatLock() {
  const locked = alarmType === 'countdown' && alarmCountdownMode === 'absolute';
  if (locked) {
    alarmRepeatSelect.value = 'once';
    alarmRepeatSelect.disabled = true;
    alarmRepeatSelect.title = '指定日期时间闹钟仅支持一次性提醒';
  } else {
    alarmRepeatSelect.disabled = false;
    alarmRepeatSelect.title = '';
  }
}

function closeAlarmEditor() {
  alarmEditing = false;
  alarmEditView.classList.add('hidden');
  stage.classList.remove('hidden');
  window.api.setPanelOpen(false);
}

async function handleSaveAlarm() {
  alarmError.textContent = '';
  const label = alarmLabelInput.value.trim();
  const repeat = alarmRepeatSelect.value;

  let payload;
  if (alarmType === 'countdown') {
    if (alarmCountdownMode === 'absolute') {
      const date = alarmDateInput.value;
      const time = alarmTimeAbsoluteInput.value;
      if (!date || !time) {
        alarmError.textContent = '请选择提醒的日期和时间';
        return;
      }
      const triggerDate = parseLocalDateTime(date, time);
      if (!triggerDate || triggerDate.getTime() <= Date.now()) {
        alarmError.textContent = '提醒时间必须是未来的日期时间';
        return;
      }
      payload = { type: 'countdown', label, repeat: 'once', triggerAt: triggerDate.getTime() };
    } else {
      const minutes = Number(alarmDurationInput.value);
      if (!Number.isInteger(minutes) || minutes <= 0) {
        alarmError.textContent = '请输入有效的倒计时时长（分钟）';
        return;
      }
      payload = { type: 'countdown', label, repeat, durationSeconds: minutes * 60 };
    }
  } else {
    const time = alarmTimeInput.value;
    if (!time) {
      alarmError.textContent = '请选择提醒时刻';
      return;
    }
    payload = { type: 'fixed', label, repeat, time };
  }

  const result = await window.api.createAlarm(payload);
  if (result.ok) {
    currentState = result.view;
    closeAlarmEditor();
    render();
  } else {
    alarmError.textContent = result.error || '保存失败，请重试';
  }
}

async function handleDeleteAlarm(id) {
  const result = await window.api.deleteAlarm(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

async function handleToggleAlarm(id) {
  const result = await window.api.toggleAlarm(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

function handleAlarmTriggered() {
  // 提醒弹窗由主进程独立弹出，悬浮条无需闪烁
}

/** 计算「最近即将触发的启用中闹钟」展示文本 */
function computeFloatAlarmText() {
  if (!currentState) return '';
  const alarms = (currentState.alarms || []).filter((a) => a.active);
  if (alarms.length === 0) return '';

  const now = Date.now();
  let nearest = null;
  let nearestAt = Infinity;

  alarms.forEach((a) => {
    let at;
    if (a.type === 'countdown') {
      at = Number(a.endsAt) || 0;
    } else {
      at = Number(a.nextAt) || nextFixedLocal(a.time);
    }
    if (at > 0 && at < nearestAt) {
      nearestAt = at;
      nearest = a;
    }
  });

  if (!nearest) return '';

  if (nearest.type === 'countdown') {
    const remaining = Math.max(Math.ceil((nearestAt - now) / 1000), 0);
    return formatAlarmDurationShort(remaining);
  }
  return String(nearest.time || '');
}

function nextFixedLocal(time) {
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

function formatAlarmDurationShort(totalSeconds) {
  const s = Math.max(Number(totalSeconds) || 0, 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分`;
  return `${sec}秒`;
}

function renderFloatAlarm() {
  if (!floatAlarmEl) return;
  const text = computeFloatAlarmText();
  if (text) {
    floatAlarmEl.textContent = '⏰ ' + text;
    floatAlarmEl.classList.remove('hidden');
  } else {
    floatAlarmEl.classList.add('hidden');
  }
}

/** 渲染悬浮条（显示「最近到期目标」，仅作展示） */
function renderFloatBar() {
  const ft = currentState ? currentState.floatTarget : null;

  if (!ft) {
    floatDaysEl.textContent = '--';
    floatDaysEl.classList.remove('is-text');
    floatUnitEl.textContent = '天';
    floatUnitEl.classList.remove('hidden');
    return;
  }

  const mode = ft.isCountup ? 'days' : ft.displayMode;
  if (mode === 'days') {
    floatDaysEl.textContent = String(ft.remainingDays);
    floatDaysEl.classList.remove('is-text');
    floatUnitEl.textContent = '天';
    floatUnitEl.classList.remove('hidden');
  } else {
    floatDaysEl.textContent = ft.remainingText || '';
    floatDaysEl.classList.add('is-text');
    floatUnitEl.textContent = '';
    floatUnitEl.classList.add('hidden');
  }
}

/** 渲染番茄钟设置回显（仅在输入框未聚焦时） */
function renderPomodoroSettings() {
  const p = currentState ? currentState.pomodoro : null;
  if (!p) return;
  if (document.activeElement !== pomodoroWorkInput) pomodoroWorkInput.value = p.workMin;
  if (document.activeElement !== pomodoroBreakInput) pomodoroBreakInput.value = p.breakMin;
  if (document.activeElement !== pomodoroCyclesInput) pomodoroCyclesInput.value = p.cycles;
}

/** 渲染番茄钟运行状态文本 */
function renderPomodoroStatus(status) {
  if (!pomodoroStatusEl) return;
  if (!status || !status.active) {
    pomodoroStatusEl.textContent = '未运行';
    pomodoroStatusEl.classList.remove('running');
    return;
  }
  const s = Math.max(Number(status.remainingSeconds) || 0, 0);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const phaseText = status.phase === 'work' ? '专注' : '休息';
  pomodoroStatusEl.textContent = `${phaseText} ${mm}:${ss} · 第${(status.cycleIndex || 0) + 1}/${status.cycles}轮`;
  pomodoroStatusEl.classList.add('running');
}

/** 根据当前状态刷新整个界面 */
function render() {
  if (!currentState) return;
  const s = currentState;

  applyTheme(s.theme);

  if (editing || editingCategoryTexts || alarmEditing) {
    return;
  }

  // 未配置 → 显示目标设置页
  if (!s.configured) {
    setupView.classList.remove('hidden');
    stage.classList.add('hidden');
    cancelEditBtn.classList.add('hidden');
    window.api.setPanelOpen(true);
    return;
  }

  setupView.classList.add('hidden');
  stage.classList.remove('hidden');

  // 含义文字（countup 默认「已坚持 X 天」，countdown 默认「距离完成还有 X 天」）
  messageText.textContent = renderMessage(s.message, s.remainingDays);

  // 剩余/坚持天数（大字 + 悬浮条小字）
  const displayMode = s.displayMode || 'days';
  if (displayMode === 'days') {
    remainingDaysEl.textContent = String(s.remainingDays);
    remainingDaysEl.classList.remove('is-text');
    numberUnitEl.textContent = '天';
  } else {
    remainingDaysEl.textContent = s.remainingText || '';
    remainingDaysEl.classList.add('is-text');
    numberUnitEl.textContent = '';
  }

  renderFloatBar();
  renderTargets();
  renderStreak();
  renderTodos();
  renderCategories();
  renderAlarms();
  renderFloatAlarm();
  renderPomodoroSettings();

  // 打卡按钮状态（悬浮条 + 下拉面板两处同步）
  const isDone = !s.isCountup && s.remainingDays <= 0;
  const eliminated = s.currentCategoryCheckedToday;
  const catName = (s.currentCategory && s.currentCategory.name) || '打卡';

  const activeText = (s.btnActiveText && s.btnActiveText.trim()) || `打卡·${catName}`;
  const floatActiveText = (s.btnActiveText && s.btnActiveText.trim()) || `打卡·${truncateCategoryName(catName)}`;
  const doneText = (s.btnDoneText && s.btnDoneText.trim()) || '已打卡';

  const applyBtnState = (btn, active) => {
    if (eliminated) {
      btn.classList.add('disabled');
      btn.disabled = true;
      btn.textContent = doneText;
    } else if (isDone) {
      btn.classList.add('disabled');
      btn.disabled = true;
      btn.textContent = '已完成 ✓';
    } else {
      btn.classList.remove('disabled');
      btn.disabled = false;
      btn.textContent = active;
    }
  };

  applyBtnState(eliminateBtn, activeText);
  applyBtnState(floatEliminateBtn, floatActiveText);
}

// ---------- 粒子动画 ----------

function spawnParticles(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const colors = ['#ff6b5e', '#ffa26b', '#ffd166', '#8ac6ff'];
  const count = 12;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'particle';

    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const dist = 40 + Math.random() * 60;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    const size = 3 + Math.random() * 4;

    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--tx', `${tx}px`);
    p.style.setProperty('--ty', `${ty}px`);
    p.style.animationDuration = `${0.5 + Math.random() * 0.4}s`;

    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }
}

// ---------- 事件处理 ----------

/** 切换正计时/倒计时字段显示 */
function updateCountModeFields() {
  const isCountup = countModeSelect.value === 'countup';
  targetDateField.classList.toggle('hidden', isCountup);
  startDateField.classList.toggle('hidden', !isCountup);
  displayModeField.classList.toggle('hidden', isCountup);
}

/** 保存目标（新建/编辑统一走 updateTarget） */
async function handleSaveSettings() {
  const name = targetNameInput.value.trim() || '我的目标';
  const countMode = countModeSelect.value === 'countup' ? 'countup' : 'countdown';
  const payload = { name, countMode };

  if (countMode === 'countup') {
    const startDate = startDateInput.value;
    if (startDate && isFutureDate(startDate)) {
      setupError.textContent = '起点日期不能是未来';
      return;
    }
    payload.startDate = startDate;
  } else {
    const targetDate = targetDateInput.value;
    if (!targetDate) {
      setupError.textContent = '请选择目标日期';
      return;
    }
    const days = daysUntilLocal(targetDate);
    if (days <= 0) {
      setupError.textContent = '目标日期必须是未来的日期';
      return;
    }
    payload.targetDate = targetDate;
    payload.totalDays = days;
    payload.displayMode = displayModeSelect.value;
  }

  const result = await window.api.updateTarget(currentState.currentTarget.id, payload);

  if (result.ok) {
    currentState = result.view;
    editing = false;
    setupError.textContent = '';
    cancelEditBtn.classList.add('hidden');
    window.api.setPanelOpen(false);
    render();
  } else {
    setupError.textContent = result.error || '保存失败，请重试';
  }
}

/** 对当前目标的当前类目打卡 */
async function handleEliminate() {
  if (isAnimating || !currentState) return;
  if (!currentState.configured || currentState.currentCategoryCheckedToday) return;
  if (!currentState.isCountup && currentState.remainingDays <= 0) return;
  if (!currentState.currentCategory) return;

  isAnimating = true;
  eliminateBtn.disabled = true;
  floatEliminateBtn.disabled = true;

  const result = await window.api.checkinCategory(currentState.currentTarget.id, currentState.currentCategoryId);

  if (result.ok) {
    currentState = result.view;
    render();

    spawnParticles(floatEliminateBtn);
    remainingDaysEl.classList.remove('bounce');
    void remainingDaysEl.offsetWidth;
    remainingDaysEl.classList.add('bounce');
    setTimeout(() => remainingDaysEl.classList.remove('bounce'), 650);
  } else {
    currentState = result.view || currentState;
    render();
  }

  isAnimating = false;
}

/** 重置当前目标的历史记录 */
async function handleResetHistory() {
  if (!currentState || !currentState.configured) return;
  if (currentState.history.length === 0) return;

  const confirmed = window.confirm('确定要清空当前目标的所有打卡记录吗？剩余天数将恢复为总天数。');
  if (!confirmed) return;

  const result = await window.api.resetHistory(currentState.currentTarget.id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

/** 更新目标日期下方的「共 X 天」提示 */
function updateTargetDateHint() {
  const v = targetDateInput.value;
  if (!v) {
    targetDateHint.textContent = '';
    targetDateHint.classList.remove('error');
    return;
  }
  const days = daysUntilLocal(v);
  if (days <= 0) {
    targetDateHint.textContent = '请选择未来的日期';
    targetDateHint.classList.add('error');
  } else {
    targetDateHint.textContent = `共 ${days} 天`;
    targetDateHint.classList.remove('error');
  }
}

/** 进入目标编辑模式（显示目标设置页） */
function handleEditSettings() {
  if (!currentState) return;
  editing = true;

  const target = currentState.currentTarget || {};
  setupTitle.textContent = currentState.configured ? '编辑目标' : '新建目标';
  targetNameInput.value = target.name || '我的目标';
  countModeSelect.value = currentState.isCountup ? 'countup' : 'countdown';

  targetDateInput.value = currentState.targetDate ||
    (currentState.isCountup ? '' : addDaysToToday(currentState.totalDays || 0));
  startDateInput.value = currentState.startDate || '';
  updateCountModeFields();
  updateTargetDateHint();

  displayModeSelect.value = currentState.displayMode || 'days';
  themeSelect.value = (currentState.theme === 'dark' || currentState.theme === 'green') ? currentState.theme : 'light';
  setupError.textContent = '';
  cancelEditBtn.classList.remove('hidden');
  setupView.classList.remove('hidden');
  stage.classList.add('hidden');
  window.api.setPanelOpen(true);
}

/** 取消编辑，返回主界面 */
async function handleCancelEdit() {
  editing = false;
  setupError.textContent = '';
  // 若当前目标未配置且存在其它已配置目标，切回第一个已配置目标，避免卡在设置页
  if (!currentState.configured && currentState.targets && currentState.targets.length > 1) {
    const fallback = currentState.targets.find(
      (t) => t.id !== currentState.currentTargetId && t.configured
    );
    if (fallback) {
      const result = await window.api.setCurrentTarget(fallback.id);
      if (result.ok) currentState = result.view;
    }
  }
  cancelEditBtn.classList.add('hidden');
  window.api.setPanelOpen(false);
  render();
}

/** 新增待办（挂到当前类目） */
async function handleAddTodo() {
  if (!currentState || !currentState.configured) return;
  const text = todoInput.value.trim();
  if (!text) return;

  const result = await window.api.addTodo(currentState.currentTarget.id, text, currentState.currentCategoryId);
  if (result.ok) {
    currentState = result.view;
    todoInput.value = '';
    render();
  }
}

async function handleToggleTodo(id) {
  const result = await window.api.toggleTodo(currentState.currentTarget.id, id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

async function handleDeleteTodo(id) {
  const result = await window.api.deleteTodo(currentState.currentTarget.id, id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

async function handleCreateCategory(name) {
  if (!currentState) return;
  const result = await window.api.createCategory(currentState.currentTarget.id, name);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '创建失败');
    render();
  }
}

async function handleRenameCategory(id, name) {
  if (!currentState) return;
  const result = await window.api.renameCategory(currentState.currentTarget.id, id, name);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '重命名失败');
    render();
  }
}

async function handleDeleteCategory(id) {
  if (!currentState) return;
  const cat = (currentState.categories || []).find((c) => c.id === id);
  if (!cat) return;
  const confirmed = window.confirm(`确定删除类目「${cat.name}」吗？\n会同时清除该类目的待办与打卡记录。`);
  if (!confirmed) return;
  const result = await window.api.deleteCategory(currentState.currentTarget.id, id);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '删除失败');
  }
}

async function handleSelectCategory(id) {
  if (!currentState || currentState.currentCategoryId === id) return;
  const result = await window.api.setCurrentCategory(currentState.currentTarget.id, id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

// ---------- 目标 CRUD ----------

async function handleSelectTarget(id) {
  if (!currentState || currentState.currentTargetId === id) return;
  const result = await window.api.setCurrentTarget(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

async function handleCreateTarget() {
  const result = await window.api.createTarget({ name: '新目标' });
  if (result.ok) {
    currentState = result.view;
    render();
    handleEditSettings();
  } else {
    window.alert(result.error || '创建失败');
  }
}

async function handleDeleteTarget(id) {
  const t = (currentState.targets || []).find((x) => x.id === id);
  if (!t) return;
  const confirmed = window.confirm(`确定删除目标「${t.name}」吗？\n会同时清除该目标的所有打卡与待办记录。`);
  if (!confirmed) return;
  const result = await window.api.deleteTarget(id);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '删除失败');
  }
}

// ---------- 类目文案编辑浮层 ----------

function openCategoryTextEditor(id) {
  if (!currentState) return;
  const cat = (currentState.categories || []).find((c) => c.id === id);
  if (!cat) return;

  editingCategoryTexts = true;
  editingCategoryId = id;
  categoryEditTitle.textContent = `编辑「${cat.name}」文案`;
  categoryMessageInput.value = cat.message || '';
  categoryActiveTextInput.value = cat.btnActiveText || '';
  categoryDoneTextInput.value = cat.btnDoneText || '';

  categoryEditView.classList.remove('hidden');
  stage.classList.add('hidden');
  setupView.classList.add('hidden');
  window.api.setPanelOpen(true);
}

async function handleSaveCategoryTexts() {
  if (!currentState || !editingCategoryId) return;
  const result = await window.api.updateCategoryTexts(currentState.currentTarget.id, editingCategoryId, {
    message: categoryMessageInput.value,
    btnActiveText: categoryActiveTextInput.value,
    btnDoneText: categoryDoneTextInput.value
  });

  if (result.ok) {
    currentState = result.view;
    closeCategoryTextEditor();
    render();
  } else {
    window.alert(result.error || '保存失败');
  }
}

function closeCategoryTextEditor() {
  editingCategoryTexts = false;
  editingCategoryId = '';
  categoryEditView.classList.add('hidden');
  stage.classList.remove('hidden');
  window.api.setPanelOpen(false);
}

// ---------- 番茄钟 / 系统 ----------

async function handleOpenPomodoro() {
  await window.api.openPomodoro();
}

async function handleStartPomodoro() {
  const workMin = Number(pomodoroWorkInput.value) || 25;
  const breakMin = Number(pomodoroBreakInput.value) || 5;
  const cycles = Number(pomodoroCyclesInput.value) || 4;

  await window.api.updatePomodoroSettings({ workMin, breakMin, cycles });
  const result = await window.api.startPomodoro({ workMin, breakMin, cycles });
  if (result.ok && result.status) {
    renderPomodoroStatus(result.status);
  }
}

async function handleOpenSystem() {
  await window.api.openSystem();
}

// ---------- 初始化 ----------

async function init() {
  try {
    currentState = await window.api.getState();
  } catch (err) {
    console.error('初始化失败:', err);
    currentState = null;
    setupError.textContent = '应用初始化失败，请重启应用';
  }
  render();

  // 每秒刷新闹钟倒计时显示与悬浮条闹钟时间（避免全量 render 干扰输入框）
  setInterval(() => {
    if (!currentState || editing || editingCategoryTexts || alarmEditing) return;
    const hasActiveAlarm = (currentState.alarms || []).some((a) => a.active);
    if (!hasActiveAlarm) return;
    const now = Date.now();
    const alarms = currentState.alarms.map((a) => {
      if (a.type === 'countdown') {
        return { ...a, remainingSeconds: Math.max(Math.ceil(((Number(a.endsAt) || 0) - now) / 1000), 0) };
      }
      return a;
    });
    currentState = { ...currentState, alarms };
    renderAlarms();
    renderFloatAlarm();
  }, 1000);
}

// ---------- 无边框窗口拖动 ----------

function attachDrag(el) {
  if (!el) return;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  let rafId = null;

  const flush = () => {
    rafId = null;
    if (!dragging || (pendingDx === 0 && pendingDy === 0)) return;
    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;
    window.api.dragWindow({ dx, dy });
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('input, button, select, textarea, [contenteditable]')) return;

    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
    startX = e.screenX;
    startY = e.screenY;
    pendingDx = 0;
    pendingDy = 0;
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      // 忽略捕获失败
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pendingDx += e.screenX - lastX;
    pendingDy += e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;

    if (Math.abs(e.screenX - startX) > 4 || Math.abs(e.screenY - startY) > 4) {
      didDrag = true;
    }

    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  });

  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    flush();
    if (e && e.pointerId !== undefined && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {
        // 忽略
      }
    }
    setTimeout(() => {
      didDrag = false;
    }, 0);
  };

  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);
  el.addEventListener('lostpointercapture', () => {
    dragging = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });
}

attachDrag(document.querySelector('.float-drag'));
attachDrag(document.querySelector('.setup-drag'));
attachDrag(document.querySelector('#category-edit-view .setup-drag'));
attachDrag(document.querySelector('#alarm-edit-view .setup-drag'));

// ---------- 事件绑定 ----------

saveSettingsBtn.addEventListener('click', handleSaveSettings);
cancelEditBtn.addEventListener('click', handleCancelEdit);
saveCategoryTextsBtn.addEventListener('click', handleSaveCategoryTexts);
cancelCategoryTextsBtn.addEventListener('click', closeCategoryTextEditor);

targetDateInput.addEventListener('change', updateTargetDateHint);
countModeSelect.addEventListener('change', updateCountModeFields);

// 主题切换即时预览（不依赖保存）
themeSelect.addEventListener('change', async () => {
  const theme = (themeSelect.value === 'dark' || themeSelect.value === 'green') ? themeSelect.value : 'light';
  applyTheme(theme);
  const result = await window.api.setTheme(theme);
  if (result.ok) {
    currentState = result.view;
  }
});

targetDateInput.min = toDateStr(new Date());
startDateInput.max = toDateStr(new Date());
alarmDateInput.min = toDateStr(new Date());

eliminateBtn.addEventListener('click', handleEliminate);
floatEliminateBtn.addEventListener('click', handleEliminate);
resetHistoryBtn.addEventListener('click', handleResetHistory);
editSettingsBtn.addEventListener('click', handleEditSettings);

todoAddBtn.addEventListener('click', handleAddTodo);
todoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleAddTodo();
  }
});
todoCalendarToggle.addEventListener('click', handleToggleCalendar);

categoryAdd.addEventListener('click', startCreateCategory);
targetAdd.addEventListener('click', handleCreateTarget);

// 闹钟相关事件
alarmAddBtn.addEventListener('click', openAlarmEditor);
alarmTabCountdown.addEventListener('click', () => switchAlarmType('countdown'));
alarmTabFixed.addEventListener('click', () => switchAlarmType('fixed'));
alarmSubTabRelative.addEventListener('click', () => switchAlarmCountdownMode('relative'));
alarmSubTabAbsolute.addEventListener('click', () => switchAlarmCountdownMode('absolute'));
saveAlarmBtn.addEventListener('click', handleSaveAlarm);
cancelAlarmBtn.addEventListener('click', closeAlarmEditor);

// 指定日期时间：点击弹出原生日历/时间选择器，同时屏蔽键盘直接输入
function preventKeyboardEdit(input) {
  // 阻止所有可改变值的按键（字符、数字、方向等），仅允许 Tab/Enter 等导航键
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    e.preventDefault();
  });
}
alarmDateInput.addEventListener('click', () => {
  if (typeof alarmDateInput.showPicker === 'function') alarmDateInput.showPicker();
});
alarmTimeAbsoluteInput.addEventListener('click', () => {
  if (typeof alarmTimeAbsoluteInput.showPicker === 'function') alarmTimeAbsoluteInput.showPicker();
});
preventKeyboardEdit(alarmDateInput);
preventKeyboardEdit(alarmTimeAbsoluteInput);
alarmDurationInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSaveAlarm();
  }
});

// 番茄钟 / 系统
pomodoroOpenBtn.addEventListener('click', handleOpenPomodoro);
pomodoroStartBtn.addEventListener('click', handleStartPomodoro);
floatSystemBtn.addEventListener('click', handleOpenSystem);

// 主进程通知：闹钟触发
window.api.onAlarmTriggered(() => {
  handleAlarmTriggered();
});

// 主进程通知：闹钟列表更新
window.api.onAlarmsUpdated((view) => {
  if (view) {
    currentState = view;
    render();
  }
});

// 主进程通知：番茄钟 tick
window.api.onPomodoroTick((status) => {
  renderPomodoroStatus(status);
});

// 点击悬浮条（消除按钮、系统图标除外）切换下拉面板；拖动后不切换
floatBar.addEventListener('click', (e) => {
  if (didDrag) return;
  if (e.target.closest('.float-eliminate')) return;
  if (e.target.closest('.float-system')) return;
  togglePanel();
});

// 右键弹出系统菜单
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showContextMenu();
});

init();
