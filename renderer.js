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

const setupView = $('#setup-view');
const stage = $('#stage');
const targetDateInput = $('#target-date-input');
const targetDateHint = $('#target-date-hint');
const messageInput = $('#message-input');
const btnActiveTextInput = $('#btn-active-text-input');
const btnDoneTextInput = $('#btn-done-text-input');
const displayModeSelect = $('#display-mode-select');
const saveSettingsBtn = $('#save-settings-btn');
const cancelEditBtn = $('#cancel-edit-btn');
const setupError = $('#setup-error');

// ---------- 状态 ----------
let currentState = null;
let isAnimating = false;
let historyOpen = false;
let editing = false; // 是否处于「编辑设置」模式（避免 render 覆盖设置页）
let panelOpen = false; // 下拉面板是否展开（点击切换，不再 hover）
let didDrag = false;   // 标记是否刚发生过拖动（用于区分「点击」和「拖动」）

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

/** 渲染历史记录统计摘要（已打卡 N 天） */
function renderHistory() {
  const count = currentState ? (currentState.eliminatedCount || 0) : 0;
  historySummary.textContent = count > 0 ? `已打卡 ${count} 天` : '还没有打卡记录';
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

/** 根据当前状态刷新整个界面 */
function render() {
  if (!currentState) return;
  const s = currentState;

  // 编辑模式下不要覆盖设置页（保持输入框焦点和内容）
  if (editing) {
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

  // 消除按钮状态（悬浮条 + 下拉面板两处同步）
  const isDone = s.remainingDays <= 0;
  const eliminated = s.eliminatedToday;

  // 按钮文案：优先用户自定义，为空则回退默认
  const activeText = (s.btnActiveText && s.btnActiveText.trim()) || '忍忍就过去了！';
  const doneText = (s.btnDoneText && s.btnDoneText.trim()) || '牛逼，又活一天！';

  [eliminateBtn, floatEliminateBtn].forEach((btn) => {
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
      btn.textContent = activeText;
    }
  });
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

  const message = messageInput.value;
  const btnActiveText = btnActiveTextInput.value;
  const btnDoneText = btnDoneTextInput.value;
  const displayMode = displayModeSelect.value;
  const result = await window.api.saveSettings({ targetDate, totalDays: days, message, btnActiveText, btnDoneText, displayMode });

  if (result.ok) {
    currentState = result.view;
    editing = false;
    setupError.textContent = '';
    cancelEditBtn.classList.add('hidden');
    messageInput.value = currentState.message;
    btnActiveTextInput.value = currentState.btnActiveText || '';
    btnDoneTextInput.value = currentState.btnDoneText || '';
    displayModeSelect.value = currentState.displayMode || 'days';
    // 保存成功回到主界面，收起窗口（只保留悬浮条）
    window.api.setPanelOpen(false);
    render();
  } else {
    setupError.textContent = result.error || '保存失败，请重试';
  }
}

/** 消除今天（悬浮条和下拉面板共用） */
async function handleEliminate() {
  if (isAnimating || !currentState) return;
  if (!currentState.configured || currentState.eliminatedToday) return;
  if (currentState.remainingDays <= 0) return;

  isAnimating = true;
  eliminateBtn.disabled = true;
  floatEliminateBtn.disabled = true;

  const result = await window.api.eliminateToday();

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

  const confirmed = window.confirm('确定要清空所有历史消除记录吗？剩余天数将恢复为总天数。');
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
  messageInput.value = currentState.message;
  btnActiveTextInput.value = currentState.btnActiveText || '';
  btnDoneTextInput.value = currentState.btnDoneText || '';
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

/** 新增待办 */
async function handleAddTodo() {
  if (!currentState || !currentState.configured) return;
  const text = todoInput.value.trim();
  if (!text) return;

  const result = await window.api.addTodo(text);
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
    // 只有鼠标左键且目标不在 input/button 上才触发拖动
    if (e.button !== 0) return;
    if (e.target.closest('input, button')) return;

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

saveSettingsBtn.addEventListener('click', handleSaveSettings);
cancelEditBtn.addEventListener('click', handleCancelEdit);
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
