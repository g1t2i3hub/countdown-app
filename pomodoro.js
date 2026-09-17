'use strict';

/**
 * 番茄钟子窗口脚本：
 *  - 显示当前阶段倒计时（MM:SS）与循环进度
 *  - 开始 / 停止 / 修改设置均通过 window.api 调主进程
 *  - 实时状态由主进程 push（pomodoro-tick）驱动
 */

const $ = (selector) => document.querySelector(selector);

const theme = new URLSearchParams(window.location.search).get('theme');
if (theme === 'dark') {
  document.body.classList.add('theme-dark');
} else if (theme === 'green') {
  document.body.classList.add('theme-green');
}

// ---------- DOM ----------
const phaseEl = $('#pomodoro-phase');
const timeEl = $('#pomodoro-time');
const cycleEl = $('#pomodoro-cycle');
const workInput = $('#pomodoro-work');
const breakInput = $('#pomodoro-break');
const cyclesInput = $('#pomodoro-cycles');
const startBtn = $('#pomodoro-start');
const stopBtn = $('#pomodoro-stop');
const closeBtn = $('#pomodoro-close');
const dragEl = $('#pomodoro-drag');

// ---------- 状态 ----------
let status = {
  active: false,
  phase: 'work',
  remainingSeconds: 25 * 60,
  totalSeconds: 25 * 60,
  cycleIndex: 0,
  cycles: 4,
  settings: { workMin: 25, breakMin: 5, cycles: 4 }
};

function fmt(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function render() {
  const settings = status.settings || { workMin: 25, breakMin: 5, cycles: 4 };

  // 仅在输入框未聚焦时回填，避免覆盖用户正在输入的值
  if (document.activeElement !== workInput) workInput.value = settings.workMin;
  if (document.activeElement !== breakInput) breakInput.value = settings.breakMin;
  if (document.activeElement !== cyclesInput) cyclesInput.value = settings.cycles;

  if (status.active) {
    phaseEl.textContent = status.phase === 'work' ? '专注中' : '休息中';
    timeEl.textContent = fmt(status.remainingSeconds);
    cycleEl.textContent = `第 ${(status.cycleIndex || 0) + 1}/${status.cycles} 轮`;
    startBtn.textContent = '运行中';
  } else {
    phaseEl.textContent = '番茄钟';
    timeEl.textContent = fmt(settings.workMin * 60);
    cycleEl.textContent = `共 ${settings.cycles} 轮`;
    startBtn.textContent = '开始';
  }
}

async function refreshStatus() {
  try {
    status = await window.api.getPomodoroStatus();
  } catch (err) {
    console.error('获取番茄钟状态失败:', err);
  }
  render();
}

async function handleStart() {
  const workMin = Math.min(Math.max(Number(workInput.value) || 25, 1), 180);
  const breakMin = Math.min(Math.max(Number(breakInput.value) || 5, 1), 60);
  const cycles = Math.min(Math.max(Number(cyclesInput.value) || 4, 1), 12);

  await window.api.updatePomodoroSettings({ workMin, breakMin, cycles });
  await window.api.startPomodoro({ workMin, breakMin, cycles });
  await refreshStatus();
}

async function handleStop() {
  await window.api.stopPomodoro();
  await refreshStatus();
}

startBtn.addEventListener('click', handleStart);
stopBtn.addEventListener('click', handleStop);
closeBtn.addEventListener('click', () => window.api.closePomodoro());

window.api.onPomodoroTick((s) => {
  status = s;
  render();
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
    if (e.target.closest('button, input')) return;
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

refreshStatus();
