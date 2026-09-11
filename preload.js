'use strict';

/**
 * 预加载脚本
 *
 * 通过 contextBridge 向渲染进程暴露一个最小、安全的 API，
 * 渲染进程无法直接访问 Node.js / 文件系统，只能通过 IPC 与主进程通信。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 读取应用状态（返回 buildViewModel 结果） */
  getState: () => ipcRenderer.invoke('get-state'),

  /** 切换主题：'light' | 'dark'（不影响倒计时数据） */
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),

  // ---------- 目标 ----------
  /** 新建目标：{ name, countMode, targetDate, startDate, totalDays, displayMode } */
  createTarget: (payload) => ipcRenderer.invoke('create-target', payload),
  /** 更新目标 */
  updateTarget: (id, payload) => ipcRenderer.invoke('update-target', id, payload),
  /** 删除目标（至少保留一个） */
  deleteTarget: (id) => ipcRenderer.invoke('delete-target', id),
  /** 切换当前目标 */
  setCurrentTarget: (id) => ipcRenderer.invoke('set-current-target', id),

  // ---------- 打卡 / 类目 / 待办（targetId 首参） ----------
  /** 对指定目标的指定类目打卡 */
  checkinCategory: (targetId, categoryId) => ipcRenderer.invoke('checkin-category', targetId, categoryId),
  /** 新建类目 */
  createCategory: (targetId, name) => ipcRenderer.invoke('create-category', targetId, name),
  /** 重命名类目 */
  renameCategory: (targetId, id, name) => ipcRenderer.invoke('rename-category', targetId, id, name),
  /** 删除类目（连同其打卡与待办一起清除） */
  deleteCategory: (targetId, id) => ipcRenderer.invoke('delete-category', targetId, id),
  /** 切换当前类目 */
  setCurrentCategory: (targetId, id) => ipcRenderer.invoke('set-current-category', targetId, id),
  /** 更新指定类目的文案（含义 / 按钮文字） */
  updateCategoryTexts: (targetId, id, texts) => ipcRenderer.invoke('update-category-texts', targetId, id, texts),
  /** 清空指定目标的历史打卡记录 */
  resetHistory: (targetId) => ipcRenderer.invoke('reset-history', targetId),
  /** 新增待办（归属 categoryId，缺省回退当前类目） */
  addTodo: (targetId, text, categoryId) => ipcRenderer.invoke('add-todo', targetId, text, categoryId),
  /** 切换待办完成状态 */
  toggleTodo: (targetId, id) => ipcRenderer.invoke('toggle-todo', targetId, id),
  /** 删除待办 */
  deleteTodo: (targetId, id) => ipcRenderer.invoke('delete-todo', targetId, id),

  // ---------- 闹钟 ----------
  /** 创建闹钟：{ type, label, repeat, durationSeconds, time } */
  createAlarm: (payload) => ipcRenderer.invoke('create-alarm', payload),
  /** 删除闹钟 */
  deleteAlarm: (id) => ipcRenderer.invoke('delete-alarm', id),
  /** 暂停/恢复闹钟 */
  toggleAlarm: (id) => ipcRenderer.invoke('toggle-alarm', id),
  /** 确认闹钟提醒（关闭弹窗） */
  dismissAlarm: (id) => ipcRenderer.invoke('dismiss-alarm', id),

  /** 监听：闹钟触发 */
  onAlarmTriggered: (cb) => ipcRenderer.on('alarm-triggered', (_e, data) => cb(data)),
  /** 监听：闹钟列表更新 */
  onAlarmsUpdated: (cb) => ipcRenderer.on('alarms-updated', (_e, view) => cb(view)),

  // ---------- 日历回看 ----------
  /** 查询指定日期的待办（当前目标） */
  getTodosByDate: (dateStr) => ipcRenderer.invoke('get-todos-by-date', dateStr),
  /** 获取日历回看概况（当前目标，含统计汇总 stats） */
  getCalendarOverview: () => ipcRenderer.invoke('get-calendar-overview'),
  /** 打开日历回看弹窗 */
  openCalendar: () => ipcRenderer.invoke('open-calendar'),
  /** 关闭日历回看弹窗 */
  closeCalendar: () => ipcRenderer.invoke('close-calendar'),

  // ---------- 备份 / 恢复 ----------
  /** 备份数据到用户选择的文件 */
  backupData: () => ipcRenderer.invoke('backup-data'),
  /** 选择备份文件（读取并校验，暂存主进程） */
  pickRestoreFile: () => ipcRenderer.invoke('pick-restore-file'),
  /** 应用已选择的备份（覆盖当前数据） */
  applyRestore: () => ipcRenderer.invoke('apply-restore'),

  // ---------- 系统 ----------
  /** 设置开机自启动 */
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  /** 打开系统设置窗口 */
  openSystem: () => ipcRenderer.invoke('open-system'),
  /** 关闭系统设置窗口 */
  closeSystem: () => ipcRenderer.invoke('close-system'),

  // ---------- 番茄钟 ----------
  /** 打开番茄钟窗口 */
  openPomodoro: () => ipcRenderer.invoke('open-pomodoro'),
  /** 关闭番茄钟窗口 */
  closePomodoro: () => ipcRenderer.invoke('close-pomodoro'),
  /** 开始番茄钟：{ workMin, breakMin, cycles } */
  startPomodoro: (payload) => ipcRenderer.invoke('start-pomodoro', payload),
  /** 停止番茄钟 */
  stopPomodoro: () => ipcRenderer.invoke('stop-pomodoro'),
  /** 获取番茄钟运行状态 */
  getPomodoroStatus: () => ipcRenderer.invoke('get-pomodoro-status'),
  /** 更新番茄钟设置（持久化） */
  updatePomodoroSettings: (payload) => ipcRenderer.invoke('update-pomodoro-settings', payload),
  /** 监听：番茄钟每秒 tick / 阶段切换 */
  onPomodoroTick: (cb) => ipcRenderer.on('pomodoro-tick', (_e, status) => cb(status)),

  // ---------- 窗口控制（单向 send） ----------
  /** 拖动窗口（无边框窗口移动）：传入增量位移 { dx, dy } */
  dragWindow: (delta) => ipcRenderer.send('drag-window', delta),
  /** 展开/收起主窗口下拉面板 */
  setPanelOpen: (open) => ipcRenderer.send('set-panel-open', open),
  /** 弹出右键系统菜单 */
  showContextMenu: () => ipcRenderer.send('show-context-menu')
});
