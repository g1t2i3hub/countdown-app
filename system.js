'use strict';

/**
 * 系统设置子窗口脚本：
 *  - 备份数据 / 恢复备份 / 开机自启动
 *  - 无边框窗口拖动
 */

const $ = (selector) => document.querySelector(selector);

const theme = new URLSearchParams(window.location.search).get('theme');
if (theme === 'dark') {
  document.body.classList.add('theme-dark');
} else if (theme === 'green') {
  document.body.classList.add('theme-green');
}

const card = $('#system-card');
const closeBtn = $('#system-close');
const backupBtn = $('#backup-btn');
const restoreBtn = $('#restore-btn');
const autoLaunchCheck = $('#auto-launch-check');
const hintEl = $('#system-hint');

/** 刷新开机自启动开关状态 */
async function refreshAutoLaunch() {
  try {
    const state = await window.api.getState();
    autoLaunchCheck.checked = !!state.autoLaunch;
  } catch (err) {
    // 忽略
  }
}

function showHint(text) {
  hintEl.textContent = text || '';
  if (text) {
    clearTimeout(showHint._timer);
    showHint._timer = setTimeout(() => {
      hintEl.textContent = '';
    }, 2500);
  }
}

async function handleBackup() {
  const result = await window.api.backupData();
  if (result.ok) {
    showHint('备份成功 ✓');
  } else if (result.error && result.error !== '已取消') {
    showHint(result.error);
  }
}

async function handleRestore() {
  const picked = await window.api.pickRestoreFile();
  if (!picked.ok) {
    if (picked.error && picked.error !== '已取消') showHint(picked.error);
    return;
  }
  const confirmed = window.confirm(`确定用备份文件「${picked.fileName}」恢复数据吗？\n当前数据将被覆盖。`);
  if (!confirmed) return;
  const result = await window.api.applyRestore();
  if (result.ok) {
    showHint('恢复成功 ✓');
  } else {
    showHint(result.error || '恢复失败');
  }
}

async function handleToggleAutoLaunch() {
  const result = await window.api.setAutoLaunch(autoLaunchCheck.checked);
  if (result.ok) {
    showHint(autoLaunchCheck.checked ? '已开启开机自启动' : '已关闭开机自启动');
  } else {
    showHint(result.error || '设置失败');
    autoLaunchCheck.checked = !autoLaunchCheck.checked;
  }
}

closeBtn.addEventListener('click', () => {
  window.api.closeSystem();
});
backupBtn.addEventListener('click', handleBackup);
restoreBtn.addEventListener('click', handleRestore);
autoLaunchCheck.addEventListener('change', handleToggleAutoLaunch);

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
    if (e.target.closest('button, input, label')) return;
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

attachDrag(document.querySelector('.system-drag'));

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showContextMenu();
});

refreshAutoLaunch();
