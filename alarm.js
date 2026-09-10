'use strict';

/**
 * 闹钟提醒弹窗脚本：
 *  - 从 URL query 读取闹钟标签并显示
 *  - 「知道了」按钮关闭弹窗
 */

const params = new URLSearchParams(window.location.search);
const label = params.get('label') || '时间到了';
const theme = params.get('theme') || 'light';
if (theme === 'dark') {
  document.body.classList.add('theme-dark');
}
document.getElementById('alarm-label').textContent = label;

document.getElementById('dismiss-btn').addEventListener('click', () => {
  window.close();
});
