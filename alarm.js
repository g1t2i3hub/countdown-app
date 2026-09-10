'use strict';

/**
 * 闹钟提醒弹窗脚本：
 *  - 从 URL query 读取闹钟标签并显示
 *  - 「知道了」按钮关闭弹窗
 */

const label = new URLSearchParams(window.location.search).get('label') || '时间到了';
document.getElementById('alarm-label').textContent = label;

document.getElementById('dismiss-btn').addEventListener('click', () => {
  window.close();
});
