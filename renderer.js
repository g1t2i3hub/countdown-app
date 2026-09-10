'use strict';

/**
 * 倒数日 —— 渲染进程逻辑（悬浮条 + 点击展开下拉面板版）
 *
 * 窗口固定尺寸（透明），悬浮条常驻顶部，点击悬浮条切换下拉面板展开/收起。
 * JS 只负责：数据渲染 + 消除 + 历史折叠 + 设置 + 面板切换。
 */

const $ = (selector) => document.querySelector(selector);

// ---------- DOM 引用 ----------
const floatBar = $('#float-bar');
const floatDaysEl = $('#float-days');
const floatUnitEl = $('#float-unit');
const floatEliminateBtn = $('#float-eliminate-btn');
const floatAlarmEl = $('#float-alarm');

const messageText = $('#message-text');
const remainingDaysEl = $('#remaining-days');
const numberUnitEl = $('#number-unit');
const eliminateBtn = $('#eliminate-btn');

const historyToggle = $('#history-toggle');
const historyToggleChevron = $('#history-toggle-chevron');
const historyPanel = $('#history-panel');
const historySummary = $('#history-summary');
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
const targetDateInput = $('#target-date-input');
const targetDateHint = $('#target-date-hint');
const displayModeSelect = $('#display-mode-select');
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
const alarmFixedField = $('#alarm-fixed-field');
const alarmTimeInput = $('#alarm-time-input');
const alarmRepeatSelect = $('#alarm-repeat-select');
const saveAlarmBtn = $('#save-alarm-btn');
const cancelAlarmBtn = $('#cancel-alarm-btn');
const alarmError = $('#alarm-error');

// ---------- 状态 ----------
let currentState = null;
let isAnimating = false;
let historyOpen = false;
let editing = false; // 是否处于「编辑设置」模式（避免 render 覆盖设置页）
let panelOpen = false; // 下拉面板是否展开（点击切换，不再 hover）
let didDrag = false;   // 标记是否刚发生过拖动（用于区分「点击」和「拖动」）
let categoryInputActive = false; // 是否正在内联输入类目名（新增/重命名），避免重复开输入框
let editingCategoryTexts = false; // 是否正在编辑类目文案（浮层打开中）
let editingCategoryId = '';       // 正在编辑文案的类目 id
let alarmType = 'countdown';      // 当前新建闹钟的类型：countdown | fixed
let alarmEditing = false;         // 是否正在新建闹钟（浮层打开中）

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

/** 从今天起算，往后加 N 天得到目标日期字符串（用于编辑回显反推） */
function addDaysToToday(n) {
  const dt = new Date();
  dt.setDate(dt.getDate() + n);
  return toDateStr(dt);
}

/** 计算今天到目标日期相差的天数（不含今天，未来为正，否则 0） */
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

/** 将自定义文字中的占位符替换为剩余天数 */
function renderMessage(raw, remaining) {
  return raw
    .replace(/\{remaining\}/g, String(remaining))
    .replace(/\{days\}/g, String(remaining))
    .replace(/\bX\b/g, String(remaining));
}

// ---------- 类目选择 ----------

/** 悬浮条按钮文字较长，类目名超 4 字截断为「…」 */
function truncateCategoryName(name) {
  const str = String(name || '');
  return str.length > 4 ? `${str.slice(0, 4)}…` : str;
}

/** 渲染类目 chips（色点 + 名称 + hover 删除 ×）；选中项高亮；末位 ＋ 号由 index.html 提供 */
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

    // 编辑文案按钮（✎）：打开类目文案编辑浮层
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

    // 单击切换当前类目
    chip.addEventListener('click', () => {
      if (cat.id !== currentId) {
        handleSelectCategory(cat.id);
      }
    });

    // 双击重命名
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

// ---------- 历史折叠 ----------

function setHistoryOpen(open) {
  historyOpen = open;
  historyPanel.classList.toggle('hidden', !open);
  historyToggle.classList.toggle('open', open);
}

// ---------- 下拉面板展开/收起（点击切换） ----------

function setPanelOpen(open) {
  panelOpen = open;
  stage.classList.toggle('open', open);
  // 通知主进程调整窗口高度：收起时只保留悬浮条，不挡底层应用
  window.api.setPanelOpen(open);
}

function togglePanel() {
  setPanelOpen(!panelOpen);
}

// ---------- 渲染 ----------

/** 渲染历史记录统计摘要（已打卡 N 天 · M 个类目） */
function renderHistory() {
  const count = currentState ? (currentState.eliminatedCount || 0) : 0;
  const catCount = currentState ? ((currentState.categories && currentState.categories.length) || 0) : 0;
  if (count > 0) {
    historySummary.textContent = `已打卡 ${count} 天 · ${catCount} 个类目`;
  } else {
    historySummary.textContent = '还没有打卡记录';
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

    // 打勾方块
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'todo-check' + (todo.done ? ' checked' : '');
    check.textContent = todo.done ? '✓' : '';
    check.setAttribute('aria-label', '标记完成');
    check.addEventListener('click', () => handleToggleTodo(todo.id));

    // 待办文字
    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;

    // 删除按钮
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', '删除待办');
    del.addEventListener('click', () => handleDeleteTodo(todo.id));

    li.appendChild(check);
    li.appendChild(text);

    // 遗留标签
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

// ---------- 日历回看（独立悬浮弹窗） ----------

/** 点击「回看历史」→ 打开独立的日历弹窗窗口 */
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

    // 图标
    const icon = document.createElement('span');
    icon.className = 'alarm-item-icon';
    icon.textContent = alarm.type === 'countdown' ? '⏳' : '⏰';

    // 信息
    const info = document.createElement('div');
    info.className = 'alarm-item-info';
    const label = document.createElement('div');
    label.className = 'alarm-item-label';
    label.textContent = alarm.label || (alarm.type === 'countdown' ? '倒计时' : '闹钟');

    const meta = document.createElement('div');
    meta.className = 'alarm-item-meta';
    if (alarm.type === 'countdown') {
      meta.textContent = alarm.active
        ? '剩余 ' + formatAlarmDuration(alarm.remainingSeconds || 0)
        : '已暂停';
    } else {
      const repeatText = alarm.repeat === 'daily' ? ' · 每天' : ' · 仅一次';
      meta.textContent = alarm.time + repeatText + (alarm.active ? '' : ' · 已暂停');
    }
    info.appendChild(label);
    info.appendChild(meta);

    // 暂停/恢复按钮
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'alarm-item-toggle';
    toggle.textContent = alarm.active ? '暂停' : '恢复';
    toggle.setAttribute('aria-label', alarm.active ? '暂停闹钟' : '恢复闹钟');
    toggle.addEventListener('click', () => handleToggleAlarm(alarm.id));

    // 删除按钮
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
  alarmRepeatSelect.value = 'once';
  switchAlarmType('countdown');
  // 隐藏主面板、展开窗口（与类目文案浮层一致），否则浮层被挤出视口看不到
  stage.classList.add('hidden');
  setupView.classList.add('hidden');
  alarmEditView.classList.remove('hidden');
  window.api.setPanelOpen(true);
}

/** 切换闹钟类型（倒计时 / 定点） */
function switchAlarmType(type) {
  alarmType = type;
  alarmTabCountdown.classList.toggle('active', type === 'countdown');
  alarmTabFixed.classList.toggle('active', type === 'fixed');
  alarmCountdownField.classList.toggle('hidden', type !== 'countdown');
  alarmFixedField.classList.toggle('hidden', type !== 'fixed');
}

/** 关闭新建闹钟浮层，返回主面板 */
function closeAlarmEditor() {
  alarmEditing = false;
  alarmEditView.classList.add('hidden');
  stage.classList.remove('hidden');
  // 回到主面板，收起窗口（只保留悬浮条）
  window.api.setPanelOpen(false);
}

/** 保存闹钟 */
async function handleSaveAlarm() {
  alarmError.textContent = '';
  const label = alarmLabelInput.value.trim();
  const repeat = alarmRepeatSelect.value;

  let payload;
  if (alarmType === 'countdown') {
    const minutes = Number(alarmDurationInput.value);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      alarmError.textContent = '请输入有效的倒计时时长（分钟）';
      return;
    }
    payload = { type: 'countdown', label, repeat, durationSeconds: minutes * 60 };
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

/** 删除闹钟 */
async function handleDeleteAlarm(id) {
  const result = await window.api.deleteAlarm(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

/** 暂停/恢复闹钟 */
async function handleToggleAlarm(id) {
  const result = await window.api.toggleAlarm(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

/** 闹钟触发：仅关闭提醒弹窗，不再闪烁悬浮条（悬浮条常驻显示最近闹钟时间） */
function handleAlarmTriggered() {
  // 无操作：提醒弹窗由主进程独立弹出，悬浮条无需闪烁
}

/**
 * 计算「最近即将触发的启用中闹钟」，返回其在悬浮条上的展示文本。
 * - 倒计时闹钟：返回剩余时长（如「25分」「1小时5分」）
 * - 定点闹钟：返回 HH:MM
 * 多个闹钟取触发时间最近的那个；无启用闹钟返回空字符串。
 */
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

/** 计算定点闹钟（HH:MM）下一次触发的本地时间戳（渲染进程辅助，供悬浮条显示） */
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

/** 把秒数格式化为精简文本（悬浮条用）：「25分」「1小时5分」 */
function formatAlarmDurationShort(totalSeconds) {
  const s = Math.max(Number(totalSeconds) || 0, 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}小时${m}分`;
  }
  if (m > 0) {
    return `${m}分`;
  }
  return `${sec}秒`;
}

/** 更新悬浮条上的闹钟时间显示（有启用闹钟时显示，否则隐藏） */
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

/** 根据当前状态刷新整个界面 */
function render() {
  if (!currentState) return;
  const s = currentState;

  // 编辑模式下不要覆盖设置页（保持输入框焦点和内容）
  if (editing || editingCategoryTexts || alarmEditing) {
    return;
  }

  // 未配置 → 显示设置引导页（占满窗口）
  if (!s.configured) {
    setupView.classList.remove('hidden');
    stage.classList.add('hidden');
    cancelEditBtn.classList.add('hidden');
    // 设置页需要完整高度，展开窗口
    window.api.setPanelOpen(true);
    return;
  }

  setupView.classList.add('hidden');
  stage.classList.remove('hidden');

  // 含义文字（突出显示，为空时用默认文案）
  const rawMessage = s.message && s.message.trim()
    ? s.message
    : '距离完成还有 X 天';
  messageText.textContent = renderMessage(rawMessage, s.remainingDays);

  // 剩余天数（大字 + 悬浮条小字）
  // 根据显示方式：days 显示纯数字 + 「天」单位；months/years 显示完整文本（如「3个月10天」）
  const displayMode = s.displayMode || 'days';
  if (displayMode === 'days') {
    remainingDaysEl.textContent = String(s.remainingDays);
    remainingDaysEl.classList.remove('is-text');
    numberUnitEl.textContent = '天';
    floatDaysEl.textContent = String(s.remainingDays);
    floatDaysEl.classList.remove('is-text');
    floatUnitEl.textContent = '天';
    floatUnitEl.classList.remove('hidden');
  } else {
    remainingDaysEl.textContent = s.remainingText || '';
    remainingDaysEl.classList.add('is-text');
    numberUnitEl.textContent = '';
    floatDaysEl.textContent = s.remainingText || '';
    floatDaysEl.classList.add('is-text');
    floatUnitEl.textContent = '';
    floatUnitEl.classList.add('hidden');
  }

  // 历史
  renderHistory();

  // 待办
  renderTodos();

  // 类目选择条
  renderCategories();

  // 闹钟列表
  renderAlarms();

  // 悬浮条闹钟时间（常驻显示最近闹钟，无需展开面板）
  renderFloatAlarm();

  // 打卡按钮状态（悬浮条 + 下拉面板两处同步），按「当前类目今日是否已打卡」判定
  const isDone = s.remainingDays <= 0;
  const eliminated = s.currentCategoryCheckedToday;
  const catName = (s.currentCategory && s.currentCategory.name) || '打卡';

  // 按钮文案：优先用户自定义，为空则回退默认（活跃态=打卡·类目名）
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

// ---------- 粒子动画（克制、柔和） ----------

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

/** 保存设置 */
async function handleSaveSettings() {
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

  const displayMode = displayModeSelect.value;
  const result = await window.api.saveSettings({ targetDate, totalDays: days, displayMode });

  if (result.ok) {
    currentState = result.view;
    editing = false;
    setupError.textContent = '';
    cancelEditBtn.classList.add('hidden');
    displayModeSelect.value = currentState.displayMode || 'days';
    // 保存成功回到主界面，收起窗口（只保留悬浮条）
    window.api.setPanelOpen(false);
    render();
  } else {
    setupError.textContent = result.error || '保存失败，请重试';
  }
}

/** 对当前选中类目打卡（悬浮条和下拉面板共用） */
async function handleEliminate() {
  if (isAnimating || !currentState) return;
  if (!currentState.configured || currentState.currentCategoryCheckedToday) return;
  if (currentState.remainingDays <= 0) return;
  if (!currentState.currentCategory) return;

  isAnimating = true;
  eliminateBtn.disabled = true;
  floatEliminateBtn.disabled = true;

  const result = await window.api.eliminateCategory(currentState.currentCategoryId);

  if (result.ok) {
    currentState = result.view;
    render();

    // 仪式感动效：数字跳动 + 柔和粒子
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

/** 重置历史记录 */
async function handleResetHistory() {
  if (!currentState || !currentState.configured) return;
  if (currentState.history.length === 0) return;

  const confirmed = window.confirm('确定要清空所有历史打卡记录吗？剩余天数将恢复为总天数。');
  if (!confirmed) return;

  const result = await window.api.resetHistory();
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

/** 进入编辑模式（显示设置页） */
function handleEditSettings() {
  if (!currentState) return;
  editing = true;
  // 回显目标日期：优先用存储的 targetDate，否则由 totalDays 反推
  const targetDate = currentState.targetDate || addDaysToToday(currentState.totalDays || 0);
  targetDateInput.value = targetDate;
  updateTargetDateHint();
  displayModeSelect.value = currentState.displayMode || 'days';
  setupError.textContent = '';
  cancelEditBtn.classList.remove('hidden');
  setupView.classList.remove('hidden');
  stage.classList.add('hidden');
  // 设置页需要完整高度，展开窗口
  window.api.setPanelOpen(true);
}

/** 取消编辑，返回主界面 */
function handleCancelEdit() {
  editing = false;
  cancelEditBtn.classList.add('hidden');
  setupError.textContent = '';
  // 回到主界面，收起窗口（只保留悬浮条）
  window.api.setPanelOpen(false);
  render();
}

/** 切换历史记录展开 / 收起 */
function handleToggleHistory() {
  setHistoryOpen(!historyOpen);
}

/** 新增待办（默认挂到当前选中类目） */
async function handleAddTodo() {
  if (!currentState || !currentState.configured) return;
  const text = todoInput.value.trim();
  if (!text) return;

  const result = await window.api.addTodo(text, currentState.currentCategoryId);
  if (result.ok) {
    currentState = result.view;
    todoInput.value = '';
    render();
  }
}

/** 切换待办完成状态 */
async function handleToggleTodo(id) {
  const result = await window.api.toggleTodo(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

/** 删除待办 */
async function handleDeleteTodo(id) {
  const result = await window.api.deleteTodo(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

/** 新建类目 */
async function handleCreateCategory(name) {
  if (!currentState) return;
  const result = await window.api.createCategory(name);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '创建失败');
    render();
  }
}

/** 重命名类目 */
async function handleRenameCategory(id, name) {
  if (!currentState) return;
  const result = await window.api.renameCategory(id, name);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '重命名失败');
    render();
  }
}

/** 删除类目（需二次确认：会连同其打卡与待办一起清除） */
async function handleDeleteCategory(id) {
  if (!currentState) return;
  const cat = (currentState.categories || []).find((c) => c.id === id);
  if (!cat) return;
  const confirmed = window.confirm(`确定删除类目「${cat.name}」吗？\n会同时清除该类目的待办与打卡记录。`);
  if (!confirmed) return;
  const result = await window.api.deleteCategory(id);
  if (result.ok) {
    currentState = result.view;
    render();
  } else {
    window.alert(result.error || '删除失败');
  }
}

/** 切换当前类目 */
async function handleSelectCategory(id) {
  if (!currentState || currentState.currentCategoryId === id) return;
  const result = await window.api.setCurrentCategory(id);
  if (result.ok) {
    currentState = result.view;
    render();
  }
}

// ---------- 类目文案编辑浮层 ----------

/** 打开类目文案编辑浮层，回显该类目当前的文案 */
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
  // 浮层需要完整高度，展开窗口
  window.api.setPanelOpen(true);
}

/** 保存类目文案 */
async function handleSaveCategoryTexts() {
  if (!currentState || !editingCategoryId) return;
  const result = await window.api.updateCategoryTexts(editingCategoryId, {
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

/** 关闭类目文案编辑浮层，返回主界面 */
function closeCategoryTextEditor() {
  editingCategoryTexts = false;
  editingCategoryId = '';
  categoryEditView.classList.add('hidden');
  stage.classList.remove('hidden');
  // 回到主界面，收起窗口（只保留悬浮条）
  window.api.setPanelOpen(false);
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
    // 重算剩余秒数（基于 endsAt）
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

// ---------- 无边框窗口拖动（替代 -webkit-app-region: drag） ----------
// 用 setPointerCapture 捕获指针，鼠标移出窗口也能持续收到 mousemove/mouseup，
// 通过 IPC 把增量位移发给主进程移动窗口。这样避免 drag region 吞掉输入框焦点。

function attachDrag(el) {
  if (!el) return;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let pendingDx = 0;   // 待发送的累计位移
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

  // 用 pointerdown（有正确的 pointerId），setPointerCapture 才能真正生效，
  // 鼠标快速移出窗口也能持续收到 pointermove，避免「卡顿、不跟手」。
  el.addEventListener('pointerdown', (e) => {
    // 只有鼠标左键且目标不在可编辑元素上才触发拖动
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
      // 忽略捕获失败，仍可继续拖动
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 累计增量位移，交给 rAF 每帧合并发送，避免高频 IPC
    pendingDx += e.screenX - lastX;
    pendingDy += e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;

    // 累计位移超过阈值 → 判定为「拖动」，抑制后续的 click 切换
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
    // 结束前把最后累积的位移发出，保证窗口落到位
    flush();
    if (e && e.pointerId !== undefined && el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {
        // 忽略
      }
    }
    // 拖动结束后，短暂保留 didDrag 标记以抑制本次 click，随后重置
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

saveSettingsBtn.addEventListener('click', handleSaveSettings);
cancelEditBtn.addEventListener('click', handleCancelEdit);
saveCategoryTextsBtn.addEventListener('click', handleSaveCategoryTexts);
cancelCategoryTextsBtn.addEventListener('click', closeCategoryTextEditor);
targetDateInput.addEventListener('change', updateTargetDateHint);
// 目标日期不能早于今天
targetDateInput.min = toDateStr(new Date());
eliminateBtn.addEventListener('click', handleEliminate);
floatEliminateBtn.addEventListener('click', handleEliminate);
resetHistoryBtn.addEventListener('click', handleResetHistory);
editSettingsBtn.addEventListener('click', handleEditSettings);
historyToggle.addEventListener('click', handleToggleHistory);

todoAddBtn.addEventListener('click', handleAddTodo);
todoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleAddTodo();
  }
});
todoCalendarToggle.addEventListener('click', handleToggleCalendar);

categoryAdd.addEventListener('click', startCreateCategory);

// 闹钟相关事件
alarmAddBtn.addEventListener('click', openAlarmEditor);
alarmTabCountdown.addEventListener('click', () => switchAlarmType('countdown'));
alarmTabFixed.addEventListener('click', () => switchAlarmType('fixed'));
saveAlarmBtn.addEventListener('click', handleSaveAlarm);
cancelAlarmBtn.addEventListener('click', closeAlarmEditor);
alarmDurationInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSaveAlarm();
  }
});
attachDrag(document.querySelector('#alarm-edit-view .setup-drag'));

// 主进程通知：闹钟触发 → 悬浮条闪烁
window.api.onAlarmTriggered(() => {
  handleAlarmTriggered();
});

// 主进程通知：闹钟列表更新（单次闹钟自动停用）
window.api.onAlarmsUpdated((view) => {
  if (view) {
    currentState = view;
    render();
  }
});

// 点击悬浮条（消除按钮除外）切换下拉面板；拖动后不切换
floatBar.addEventListener('click', (e) => {
  if (didDrag) return;                    // 刚拖动过，不切换
  if (e.target.closest('.float-eliminate')) return; // 消除按钮独立处理
  togglePanel();
});

// 右键弹出系统菜单（最小化 / 关闭 / 退出）
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showContextMenu();
});

init();
