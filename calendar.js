'use strict';

/**
 * 待办回看 —— 独立日历悬浮弹窗的渲染逻辑
 *
 * 数据来源：window.api.getCalendarOverview()（一次性拿到 todoDates 概况）
 *           + window.api.getTodosByDate(dateStr)（选中日期详情）
 * 窗口拖动：复用主窗口方案 —— setPointerCapture + IPC drag-window
 */

const $ = (selector) => document.querySelector(selector);

// ---------- DOM 引用 ----------
const calTitleEl = $('#cal-title');
const calWeekdaysEl = $('#cal-weekdays');
const calGridEl = $('#cal-grid');
const calDetailEl = $('#cal-detail');
const calPrev = $('#cal-prev');
const calNext = $('#cal-next');
const calClose = $('#calendar-close');
const dragEl = $('#calendar-drag');

// ---------- 状态 ----------
let cursor = new Date(); // 当前显示的月份（取当月 1 号）
let selected = null;     // 选中的日期字符串 YYYY-MM-DD
let todoDates = {};      // { "YYYY-MM-DD": { done, total } }

// ---------- 工具 ----------
function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const wd = weekdays[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日 · 周${wd}`;
}

// ---------- 渲染 ----------
function renderWeekdays() {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  calWeekdaysEl.innerHTML = '';
  weekdays.forEach((w) => {
    const wd = document.createElement('div');
    wd.className = 'cal-weekday';
    wd.textContent = w;
    calWeekdaysEl.appendChild(wd);
  });
}

function renderGrid() {
  calTitleEl.textContent = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;

  const todayStr = toDateStr(new Date());
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  calGridEl.innerHTML = '';

  // 上月末尾空白占位
  for (let i = 0; i < startWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day other-month';
    calGridEl.appendChild(blank);
  }

  // 本月每一天
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = toDateStr(new Date(year, month, d));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = String(d);

    if (dateStr === todayStr) btn.classList.add('today');
    if (dateStr === selected) btn.classList.add('selected');

    const info = todoDates[dateStr];
    if (info && info.total > 0) {
      btn.classList.add('has-todo');
      if (info.done === info.total) btn.classList.add('all-done');
    }

    btn.addEventListener('click', () => {
      selected = dateStr;
      renderGrid();
      renderDetail();
    });

    calGridEl.appendChild(btn);
  }
}

async function renderDetail() {
  calDetailEl.innerHTML = '';

  if (!selected) {
    const empty = document.createElement('div');
    empty.className = 'cal-detail-empty';
    empty.textContent = '点击日期查看当天待办';
    calDetailEl.appendChild(empty);
    return;
  }

  const title = document.createElement('div');
  title.className = 'cal-detail-title';
  title.textContent = formatDateLabel(selected);
  calDetailEl.appendChild(title);

  const result = await window.api.getTodosByDate(selected);
  const list = result.todos || [];

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cal-detail-empty';
    empty.textContent = '当天没有待办记录';
    calDetailEl.appendChild(empty);
    return;
  }

  list.forEach((todo) => {
    const item = document.createElement('div');
    item.className = 'cal-detail-item' + (todo.done ? ' done' : '');

    const mark = document.createElement('span');
    mark.className = 'cal-detail-mark';
    mark.textContent = todo.done ? '✓' : '';

    const text = document.createElement('span');
    text.textContent = todo.text;

    item.appendChild(mark);
    item.appendChild(text);
    calDetailEl.appendChild(item);
  });
}

function changeMonth(delta) {
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() + delta);
  renderGrid();
}

// ---------- 无边框窗口拖动 ----------
function attachDrag(el) {
  if (!el) return;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
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
    if (e.target.closest('button')) return;
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
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

// ---------- 初始化 ----------
async function init() {
  renderWeekdays();

  // 默认选中今天
  selected = toDateStr(new Date());

  try {
    const overview = await window.api.getCalendarOverview();
    todoDates = overview.todoDates || {};
  } catch (err) {
    console.error('获取日历概况失败:', err);
  }

  renderGrid();
  renderDetail();
}

calPrev.addEventListener('click', () => changeMonth(-1));
calNext.addEventListener('click', () => changeMonth(1));
calClose.addEventListener('click', () => window.api.closeCalendar());
attachDrag(dragEl);

// 右键弹出系统菜单（最小化 / 关闭 / 退出）
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showContextMenu();
});

init();
