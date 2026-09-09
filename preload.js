'use strict';

/**
 * 预加载脚本
 *
 * 通过 contextBridge 向渲染进程暴露一个最小、安全的 API，
 * 渲染进程无法直接访问 Node.js / 文件系统，只能通过 IPC 与主进程通信。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 读取应用状态 */
  getState: () => ipcRenderer.invoke('get-state'),

  /** 保存设置：{ totalDays: number, message: string } */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  /** 消除今天（同一天只能消除一次） */
  eliminateToday: () => ipcRenderer.invoke('eliminate-today'),

  /** 清空历史消除记录 */
  resetHistory: () => ipcRenderer.invoke('reset-history'),

  /** 新增待办 */
  addTodo: (text) => ipcRenderer.invoke('add-todo', text),

  /** 切换待办完成状态 */
  toggleTodo: (id) => ipcRenderer.invoke('toggle-todo', id),

  /** 删除待办 */
  deleteTodo: (id) => ipcRenderer.invoke('delete-todo', id),

  /** 查询指定日期的待办（供日历回看） */
  getTodosByDate: (dateStr) => ipcRenderer.invoke('get-todos-by-date', dateStr),

  /** 获取日历回看全局概况（todoDates 概况 + todosByDate） */
  getCalendarOverview: () => ipcRenderer.invoke('get-calendar-overview'),

  /** 打开日历回看弹窗 */
  openCalendar: () => ipcRenderer.invoke('open-calendar'),

  /** 关闭日历回看弹窗 */
  closeCalendar: () => ipcRenderer.invoke('close-calendar'),

  /** 拖动窗口（无边框窗口移动）：传入增量位移 { dx, dy }（主窗口与日历弹窗共用）。
   *  用 send（单向、fire-and-forget）而非 invoke，避免拖动时高频 IPC 往返导致卡顿。 */
  dragWindow: (delta) => ipcRenderer.send('drag-window', delta),

  /** 展开/收起主窗口下拉面板（动态调整窗口高度，收起时不挡底层应用） */
  setPanelOpen: (open) => ipcRenderer.send('set-panel-open', open),

  /** 弹出右键系统菜单（最小化 / 关闭 / 退出） */
  showContextMenu: () => ipcRenderer.send('show-context-menu')
});
