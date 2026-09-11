'use strict';

/**
 * 大字模式子窗口脚本：
 *  - 番茄钟运行中优先显示 MM:SS
 *  - 否则显示当前目标剩余天数（倒计时）或已坚持天数（正计时）
 *  - 每 1 秒刷新一次（仅显示用途，开销可忽略）
 */

const $ = (selector) => document.querySelector(selector);

const theme = new URLSearchParams(window.location.search).get('theme');
if (theme === 'dark') {
  document.body.classList.add('theme-dark');
}

const labelEl = $('#bigtext-label');
const valueEl = $('#bigtext-value');
const unitEl = $('#bigtext-unit');
const closeBtn = $('#bigtext-close');
const dragEl = $('#bigtext-card');

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

async function refresh() {
  let pomodoro = null;
  let state = null;

  try {
    pomodoro = await window.api.getPomodoroStatus();
  } catch (err) {
    // 忽略
  }
  try {
    state = await window.api.getState();
  } catch (err) {
    // 忽略
  }

  // 番茄钟运行中：优先显示 MM:SS
  if (pomodoro && pomodoro.active) {
    labelEl.textContent = pomodoro.phase === 'work' ? '专注中' : '休息中';
    valueEl.textContent = fmtTime(pomodoro.remainingSeconds);
    unitEl.textContent = '';
    valueEl.classList.add('is-time');
    return;
  }

  valueEl.classList.remove('is-time');

  if (!state) {
    labelEl.textContent = '倒数日';
    valueEl.textContent = '--';
    unitEl.textContent = '天';
    return;
  }

  const targetName = (state.currentTarget && state.currentTarget.name) || '';

  if (state.isCountup) {
    labelEl.textContent = targetName || '已坚持';
    valueEl.textContent = String(state.remainingDays);
    unitEl.textContent = '天';
  } else if (state.displayMode === 'days') {
    labelEl.textContent = targetName || '剩余';
    valueEl.textContent = String(state.remainingDays);
    unitEl.textContent = '天';
  } else {
    labelEl.textContent = targetName || '剩余';
    valueEl.textContent = state.remainingText || '';
    unitEl.textContent = '';
  }
}

closeBtn.addEventListener('click', () => {
  window.api.setBigText(false);
});

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
    if (rafId === null) rafId = requestAnimationFrame(flush);
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

attachDrag(dragEl);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showContextMenu();
});

refresh();
setInterval(refresh, 1000);
