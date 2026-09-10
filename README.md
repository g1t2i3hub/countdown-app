# 倒数日（countdown-app）

一个 Electron 桌面应用：**天数倒数 + 每日打卡仪式感**。

支持设置总天数（或目标日期），每天点一次打卡减一天，附带自定义含义文字、待办、日历回看等功能。

## 多打卡类目

- 可创建多个打卡类目（如运动 / 饮食 / 早睡），每类目每天独立打一次卡、互不影响。
- 待办归属类目：添加待办时默认挂到当前选中类目，主面板只显示当前类目的待办。
- **倒计时本身与类目无关**：`剩余天数 = 总天数 - 天级打卡次数`，当天「第一次」任一类目打卡时递减 1 天，多类目打卡不会重复递减。
- 类目管理：点击彩色 chip 切换当前类目，双击重命名，悬停出现 `×` 删除（删除会连同该类目的待办与打卡记录一起清除），末位 `＋` 新增；最多 10 个类目、名称 ≤ 12 字。
- 删除最后一个类目会被拒绝；颜色由珊瑚红调色板循环分配。

### 数据模型（schemaVersion = 2）

```jsonc
{
  "schemaVersion": 2,
  "totalDays": 0, "targetDate": "", "message": "",
  "btnActiveText": "", "btnDoneText": "", "displayMode": "days",
  "history": [],                       // 天级打卡，每天最多 1 条，倒计时递减依据
  "categories": [ { "id", "name", "color", "createdAt" } ],
  "currentCategoryId": "",
  "checkinsByDate": {},                // { "YYYY-MM-DD": { catId: { time, timestamp } } }
  "todosByDate": {}                    // 待办元素含 categoryId
}
```

> 数据文件位于 `%APPDATA%/倒数日/countdown-data.json`。版本升级到 2 后，旧版数据会在首次启动时被清空重建。

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [打包为应用程序](#打包为应用程序)
- [后续功能迭代流程](#后续功能迭代流程)
- [常见问题](#常见问题)

---

## 快速开始

```bash
# 安装依赖（仅首次）
npm install

# 开发模式运行
npm start
```

---

## 项目结构

```
countdown-app/
├── main.js              # Electron 主进程：窗口管理、IPC、菜单、设置项校验
├── preload.js           # 预加载：contextBridge 暴露安全 API
├── renderer.js          # 渲染进程：主窗口 UI 逻辑
├── calendar.js          # 渲染进程：日历弹窗 UI 逻辑
├── index.html           # 主窗口 HTML
├── calendar.html        # 日历弹窗 HTML
├── styles.css           # 主窗口样式（珊瑚红 #ff6b5e 主题）
├── calendar.css         # 日历弹窗样式
├── build/
│   ├── icon.ico         # Windows 应用图标（NSIS/快捷方式用）
│   └── icon.png         # 256×256 PNG 图标
├── package.json         # 依赖 + electron-builder 配置
└── dist/                # 打包输出（运行 npm run build 后生成）
    ├── 倒数日-1.0.0-x64.exe          # NSIS 安装包
    ├── 倒数日-1.0.0-portable.exe     # 便携版（单 exe，解压即用）
    └── 倒数日-1.0.0-x64.zip          # 绿色版（解压后双击 倒数日.exe）
```

---

## 打包为应用程序

```bash
# 一次性生成全部三种格式（推荐）
npm run build:win

# 或分别打包
npm run build:nsis       # 只生成 NSIS 安装包
npm run build:portable   # 只生成便携 exe
npm run build:zip        # 只生成 zip 绿色版
```

### 三种产物说明

| 产物 | 文件 | 适用场景 |
|------|------|----------|
| **NSIS 安装包** | `倒数日-1.0.0-x64.exe` | 最终用户安装：可选择安装路径、自动创建桌面快捷方式 + 开始菜单、可卸载 |
| **便携版** | `倒数日-1.0.0-portable.exe` | U 盘携带，单 exe 无需安装 |
| **zip 绿色版** | `倒数日-1.0.0-x64.zip` | 压缩包分发，**解压到任何电脑**直接双击 `倒数日.exe` 即可使用，**无需安装** |

### 用户使用方式

1. **NSIS 安装包**：双击 `.exe` → 按向导安装 → 桌面双击图标启动。
2. **zip 绿色版**：解压到任意目录 → 进入 `倒数日-win32-x64/` → 双击 `倒数日.exe` 启动。可整目录拷贝到任何 Windows 电脑即开即用。
3. **便携版**：单文件，直接双击运行。

数据存放在系统 `app.getPath('userData')` 目录（通常 `%APPDATA%/倒数日/countdown-data.json`），卸载不会自动删除用户数据。

---

## 后续功能迭代流程

### 流程总览

```
修改源码 → 自测 npm start → 改 version + build 字段 → 打包 → 测试产物 → 分发
```

### 1. 修改源码

- **UI / 交互**：改 `index.html` / `renderer.js` / `styles.css`
- **日历弹窗**：改 `calendar.html` / `calendar.js` / `calendar.css`
- **窗口 / IPC / 数据 / 菜单**：改 `main.js` / `preload.js`
- **数据模型**（新增字段）：改 `main.js` 的 `DEFAULT_STATE` + `buildViewModel` + 对应 IPC handler + `readState`/`writeState`（注意 `readState` 用 `{...DEFAULT_STATE, ...parsed}` 合并，自动兼容旧数据）

### 2. 本地自测

```bash
npm start
```

手动验证：消除、待办、日历回看、设置编辑、自定义按钮文字、显示方式切换、目标日期选择、右键菜单、窗口拖动、面板展开/收起、跨天顺延待办、关闭/最小化/退出。

### 3. 更新版本号

打开 `package.json`，修改两处：

```json
{
  "version": "1.1.0",  // ← 改这里
  ...
  "build": {
    "appId": "com.workbuddy.countdownapp",  // 一般不动
    "productName": "倒数日",               // 一般不动
    ...
  }
}
```

版本号规则：主版本.次版本.补丁（修复 bug+1、新功能次版本+1、重大变更主版本+1）。

### 4. 重新打包

```bash
npm run build:win
```

输出在 `dist/`，文件名带版本号。

### 5. 测试产物

把 `dist/` 下的安装包 / 绿色版 **拷到另一台没装过 Electron 的电脑**（或当前电脑用虚拟机）实测：
- 安装包能否正常安装、卸载
- 双击 exe 能否正常启动
- 数据读写是否正常（设的总天数、待办、历史等是否在卸载重装后保留）

### 6. 分发

- **NSIS 安装包**：上传到下载站 / 网盘 / 公司内部分发
- **zip 绿色版**：直接发压缩包，收件人解压即用
- **便携版**：适合 U 盘携带

### 7. 发布说明（可选）

在仓库写 CHANGELOG.md 或 release notes，记录每个版本的改动。

---

## 常见问题

### Q1: 打包时 electron-builder 卡在下载 NSIS / winCodeSign？
首次打包会从 GitHub 下载工具包（NSIS ~3MB、winCodeSign ~5MB），国内网络可能较慢。已下载过一次后会缓存到 `%LOCALAPPDATA%/electron-builder/Cache/`，之后秒打。

如实在下载慢，可设置镜像（在 `~/.npmrc`）：
```
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### Q2: 想换图标？
替换 `build/icon.ico`（Windows 多尺寸 .ico，必须包含 16/24/32/48/64/128/256）+ `build/icon.png`（256×256）即可，重新打包生效。

### Q3: 打包后 exe 太大（100+ MB）？
正常，Electron 内嵌了 Chromium 运行时（约 100MB），精简可换用 `@electron/asar` 配合压缩（electron-builder 默认已 zip 压缩）。如需更小，可考虑 web 端方案。

### Q4: 数据存哪里？
`%APPDATA%/倒数日/countdown-data.json`（Windows）。卸载时默认**保留**，重装或升级后数据延续。如需"卸载清数据"，把 `nsis.deleteAppDataOnUninstall` 改为 `true`。

### Q5: 想支持 Mac / Linux ？
`package.json` 的 `build.win.target` 改成 `mac`/`linux` 即可。需要在对应平台或用 Docker 交叉打包。建议先在 Windows 上验证再考虑跨平台。

### Q6: 打包时提示 "cannot find module xxx" / "无法找到 electron 模块"
原因：打包时 `node_modules/electron` 被排除了（asarmode 资源在 `app.asar` 内）。这是正常行为。
如果出现真错误（缺文件），检查 `package.json` 的 `build.files` 是否包含了所有运行时需要的文件。

---

## 技术栈

- **Electron 30** —— 跨平台桌面运行时
- **原生 HTML/CSS/JS** —— 无前端框架，零构建步骤
- **electron-builder 25** —— 打包 + 安装程序生成
- **NSIS** —— Windows 安装向导

## 安全实践

- `contextIsolation: true` + `nodeIntegration: false` + `contextBridge` 隔离渲染进程
- 渲染进程只能通过 `window.api` 调用主进程暴露的 IPC 接口
- CSP 限制 `default-src 'self'`，禁止加载外部资源
- 主进程菜单/快捷键等敏感操作仅在主进程执行
