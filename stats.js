'use strict';

/**
 * 统计图表 —— 纯 Canvas 手绘（不引入第三方库）
 *
 * 暴露给日历回看窗口使用（挂载到 window.CountdownStats）：
 *  - drawBarChart(canvas, data, mode, isDark)  周/月打卡率柱状图
 *  - drawDonut(canvas, items, isDark)          类目分布环形图
 */

window.CountdownStats = (function () {
  const COLORS = {
    light: {
      bg: '#ffffff',
      text: '#23262f',
      muted: '#9aa0ac',
      grid: '#eef0f4',
      accent: '#ff6b5e',
      accentSoft: 'rgba(255, 107, 94, 0.18)'
    },
    dark: {
      bg: '#1a1e26',
      text: '#eef0f5',
      muted: '#aab3c0',
      grid: '#323946',
      accent: '#4cc2ff',
      accentSoft: 'rgba(76, 194, 255, 0.20)'
    }
  };

  /**
   * 处理高 DPI 缩放并返回绘图上下文与逻辑尺寸。
   * @param {HTMLCanvasElement} canvas
   * @returns {{ctx:CanvasRenderingContext2D,w:number,h:number}}
   */
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width || canvas.clientWidth || 300);
    const h = Math.max(1, rect.height || canvas.clientHeight || 120);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
  }

  /** dateStr → 周X 简称 */
  function weekdayLabel(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return '';
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return names[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
  }

  /** dateStr → 日号（月视图标签） */
  function dayLabel(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    return m ? String(Number(m[3])) : '';
  }

  /**
   * 绘制打卡率柱状图。
   * @param {HTMLCanvasElement} canvas
   * @param {{labels:string[],rates:number[]}} data labels 为 YYYY-MM-DD，rates 为 0..1
   * @param {'week'|'month'} mode
   * @param {boolean} isDark
   */
  function drawBarChart(canvas, data, mode, isDark) {
    const { ctx, w, h } = setupCanvas(canvas);
    const c = isDark ? COLORS.dark : COLORS.light;
    ctx.clearRect(0, 0, w, h);

    const labels = (data && Array.isArray(data.labels)) ? data.labels : [];
    const rates = (data && Array.isArray(data.rates)) ? data.rates : [];

    if (labels.length === 0) {
      ctx.fillStyle = c.muted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无打卡数据', w / 2, h / 2);
      return;
    }

    const pad = { top: 10, bottom: 20, left: 2, right: 2 };
    const chartW = Math.max(1, w - pad.left - pad.right);
    const chartH = Math.max(1, h - pad.top - pad.bottom);
    const slot = chartW / labels.length;
    const barW = Math.max(2, Math.min(slot * 0.62, 14));

    // 网格线（0% / 50% / 100%）
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    [0, 0.5, 1].forEach((r) => {
      const y = pad.top + chartH - r * chartH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    });

    labels.forEach((label, i) => {
      const rate = Math.max(0, Math.min(Number(rates[i]) || 0, 1));
      const x = pad.left + slot * i + (slot - barW) / 2;
      const bh = rate * chartH;
      const y = pad.top + chartH - bh;

      const grad = ctx.createLinearGradient(0, y, 0, pad.top + chartH);
      grad.addColorStop(0, c.accent);
      grad.addColorStop(1, c.accentSoft);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, bh);

      ctx.fillStyle = c.muted;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const lbl = mode === 'week' ? weekdayLabel(label) : dayLabel(label);
      ctx.fillText(lbl, pad.left + slot * i + slot / 2, h - 6);
    });
  }

  /**
   * 绘制类目分布环形图。
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{id:string,name:string,color:string,count:number}>} items
   * @param {boolean} isDark
   */
  function drawDonut(canvas, items, isDark) {
    const { ctx, w, h } = setupCanvas(canvas);
    const c = isDark ? COLORS.dark : COLORS.light;
    ctx.clearRect(0, 0, w, h);

    const list = Array.isArray(items) ? items : [];
    const total = list.reduce((s, it) => s + (Number(it && it.count) || 0), 0);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.max(4, Math.min(w, h) / 2 - 8);
    const inner = R * 0.62;

    if (total === 0 || list.length === 0) {
      ctx.fillStyle = c.muted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无打卡数据', cx, cy);
      return;
    }

    let start = -Math.PI / 2;
    list.forEach((it) => {
      const count = Number(it && it.count) || 0;
      if (count === 0) return;
      const angle = (count / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = (it && it.color) || c.accent;
      ctx.fill();
      start += angle;
    });

    // 内圆挖空形成环形
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = c.bg;
    ctx.fill();

    ctx.fillStyle = c.text;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(total), cx, cy - 4);

    ctx.fillStyle = c.muted;
    ctx.font = '10px sans-serif';
    ctx.fillText('总打卡', cx, cy + 12);
  }

  return { drawBarChart, drawDonut };
})();
