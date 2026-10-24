import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 原生菜单 / 右键菜单 / 原生对话框的语言。
 * 界面语言保存在渲染进程 localStorage（lulux.language），界面启动和切换语言时经 IPC `app:set-language` 告诉主进程；
 * 主进程把偏好写到 userData/ui-language.json，下次启动在界面加载前就能用（例如更新提示、MCP 确认框）。
 * 'system' 或未知时按系统首选语言：中文 → zh-CN，其它 → en。
 */
export type Locale = "zh-CN" | "en";
export type LanguagePref = Locale | "system";

const STRINGS = {
  "zh-CN": {
    about: "关于 {0}",
    hide: "隐藏 {0}",
    hideOthers: "隐藏其他",
    showAll: "全部显示",
    quit: "退出 {0}",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    pasteAndMatch: "粘贴并匹配样式",
    delete: "删除",
    selectAll: "全选",
    view: "显示",
    reload: "重新加载",
    devtools: "开发者工具",
    resetZoom: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    fullscreen: "切换全屏",
    window: "窗口",
    minimize: "最小化",
    zoom: "缩放",
    front: "前置全部窗口",
    close: "关闭窗口",
    copyLink: "复制链接地址",
    copyImage: "复制图片",
    noSuggestions: "没有拼写建议",
    addToDictionary: "添加到词典",
    // MCP 命令确认
    mcpMessage: "允许运行 MCP Server「{0}」吗？",
    mcpDetail: "将以你的用户权限执行以下命令：\n\n{0}",
    mcpEnv: "\n\n额外环境变量：{0}",
    mcpTrust: "\n\n只在你确认这个命令来源可信时允许。",
    deny: "拒绝",
    allowRun: "允许运行",
    // 自动更新（无界面订阅时）
    updDownloaded: "新版本 {0} 已下载",
    updDownloadedDetail:
      "重启后完成安装。也可以稍后再装：下次正常退出应用时会自动安装。",
    later: "稍后",
    restartInstall: "重启并安装",
    updFound: "发现新版本 {0}",
    updMacUnsigned: "当前 macOS 版本没有开发者签名，无法在应用内自动更新。",
    updPortable: "免安装版不支持应用内自动更新。",
    updNotAppImage: "当前不是以 AppImage 方式运行，无法在应用内自动更新。",
    updUnsupported: "当前安装方式不支持应用内自动更新。",
    updGoDownload: "{0}请前往下载页下载新版本安装（数据不会丢失）。",
    skipVersion: "跳过此版本",
    openDownload: "前往下载页",
    newTab: "新标签页",
    pickRegionTip: "拖动框选要发送到会话的区域 · Esc 取消",
    pickElementTip: "点击要发送到会话的元素 · Esc 取消",
    runsActive: "还有 {0} 个对话正在运行",
    runsActiveDetail:
      "关闭窗口会退出 LULUX 并中断它们（已经输出的部分会保留，标记为“已中断”）。",
    runsKeepOpen: "继续运行",
    runsCloseAnyway: "仍然关闭",
    // 托盘
    trayOpen: "打开 LULUX",
    trayNewChat: "新建对话",
    trayQuit: "退出",
    trayTooltip: "LULUX ETA",
    trayHintTitle: "LULUX 仍在后台运行",
    trayHintBody: "定时任务和邮箱同步会继续进行。右键托盘图标可以打开或退出。",
    runsQuitDetail:
      "退出会中断它们（已经输出的部分会保留，标记为“已中断”）。",
    runsQuitAnyway: "仍然退出",
    // 本地服务 / 界面进程
    serverGaveUp: "本地服务多次意外退出，已停止自动重启。",
    serverGaveUpDetail: "{0}\n\n可以在 设置 → 关于 导出诊断包发给技术支持，然后重新打开应用。",
    rendererGone: "界面进程意外退出",
    rendererGoneDetail: "原因：{0}。重新加载不会丢失已保存的数据。",
    rendererUnresponsive: "界面没有响应",
    rendererUnresponsiveDetail: "可以继续等待，或重新加载界面（正在输入但未发送的内容可能丢失）。",
    wait: "继续等待",
    quitApp: "退出应用",
    diagSaveTitle: "导出诊断包",
  },
  en: {
    about: "About {0}",
    hide: "Hide {0}",
    hideOthers: "Hide Others",
    showAll: "Show All",
    quit: "Quit {0}",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAndMatch: "Paste and Match Style",
    delete: "Delete",
    selectAll: "Select All",
    view: "View",
    reload: "Reload",
    devtools: "Developer Tools",
    resetZoom: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    fullscreen: "Toggle Full Screen",
    window: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    front: "Bring All to Front",
    close: "Close Window",
    copyLink: "Copy Link Address",
    copyImage: "Copy Image",
    noSuggestions: "No spelling suggestions",
    addToDictionary: "Add to Dictionary",
    mcpMessage: "Allow MCP server “{0}” to run?",
    mcpDetail:
      "The following command will run with your user permissions:\n\n{0}",
    mcpEnv: "\n\nExtra environment variables: {0}",
    mcpTrust: "\n\nOnly allow this if you trust where the command came from.",
    deny: "Deny",
    allowRun: "Allow",
    updDownloaded: "Version {0} has been downloaded",
    updDownloadedDetail:
      "Restart to finish installing, or install later: it installs automatically the next time you quit the app.",
    later: "Later",
    restartInstall: "Restart and Install",
    updFound: "New version {0} available",
    updMacUnsigned:
      "This macOS build is not signed by a developer, so it cannot update itself in the app.",
    updPortable: "The portable build does not support in-app updates.",
    updNotAppImage:
      "The app is not running as an AppImage, so it cannot update itself.",
    updUnsupported: "This installation type does not support in-app updates.",
    updGoDownload:
      "{0} Download and install the new version from the download page (your data is kept).",
    skipVersion: "Skip This Version",
    openDownload: "Open Download Page",
    newTab: "New Tab",
    pickRegionTip: "Drag to select an area to send to the chat · Esc to cancel",
    pickElementTip: "Click an element to send to the chat · Esc to cancel",
    runsActive: "{0} conversation(s) still running",
    runsActiveDetail:
      "Closing the window quits LULUX and interrupts them (output so far is kept and marked as interrupted).",
    runsKeepOpen: "Keep running",
    runsCloseAnyway: "Close anyway",
    trayOpen: "Open LULUX",
    trayNewChat: "New Conversation",
    trayQuit: "Quit",
    trayTooltip: "LULUX ETA",
    trayHintTitle: "LULUX is still running",
    trayHintBody: "Schedules and mailbox sync keep running. Right-click the tray icon to open or quit.",
    runsQuitDetail:
      "Quitting interrupts them (output so far is kept and marked as interrupted).",
    runsQuitAnyway: "Quit anyway",
    serverGaveUp: "The local service stopped unexpectedly several times; automatic restart has been stopped.",
    serverGaveUpDetail: "{0}\n\nYou can export a diagnostics bundle in Settings → About for support, then reopen the app.",
    rendererGone: "The window process stopped unexpectedly",
    rendererGoneDetail: "Reason: {0}. Reloading does not lose saved data.",
    rendererUnresponsive: "The window is not responding",
    rendererUnresponsiveDetail: "You can keep waiting or reload the window (unsent input may be lost).",
    wait: "Keep waiting",
    quitApp: "Quit",
    diagSaveTitle: "Export diagnostics bundle",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["zh-CN"];

/** 首次启动默认简体中文（不看系统语言），与界面一致 */
let pref: LanguagePref = "zh-CN";
let loaded = false;
/** ui-language.json 里确实存过偏好（界面在 localStorage 丢失时用它） */
let stored = false;
const listeners = new Set<() => void>();

function prefFile(): string {
  return join(app.getPath("userData"), "ui-language.json");
}

function loadPref(): void {
  if (loaded) return;
  loaded = true;
  try {
    const value = JSON.parse(readFileSync(prefFile(), "utf8")) as {
      language?: unknown;
    };
    if (
      value.language === "zh-CN" ||
      value.language === "en" ||
      value.language === "system"
    ) {
      pref = value.language;
      stored = true;
    }
  } catch {
    // 首次启动：简体中文
  }
}

export function systemLocale(
  languages: string[] = safeSystemLanguages(),
): Locale {
  const first = languages.find(Boolean) ?? "zh-CN";
  return first.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function safeSystemLanguages(): string[] {
  try {
    const list = app.getPreferredSystemLanguages?.() ?? [];
    return list.length ? list : [app.getLocale()];
  } catch {
    return [];
  }
}

export function currentLocale(): Locale {
  loadPref();
  return pref === "system" ? systemLocale() : pref;
}

/** 保存过的界面语言偏好；没有保存过返回 null（界面用默认的简体中文） */
export function storedLanguagePref(): LanguagePref | null {
  loadPref();
  return stored ? pref : null;
}

/** 渲染进程报告界面语言；变化时持久化并通知（重建菜单） */
export function setLanguagePref(value: unknown): void {
  if (value !== "zh-CN" && value !== "en" && value !== "system") return;
  loadPref();
  if (value === pref && stored) return;
  const changed = value !== pref;
  pref = value;
  try {
    writeFileSync(prefFile(), JSON.stringify({ language: value }));
    stored = true;
  } catch {
    // 只影响下次启动前的默认语言
  }
  if (changed) for (const listener of listeners) listener();
}

export function onLanguageChange(listener: () => void): void {
  listeners.add(listener);
}

export function tr(key: StringKey, ...args: Array<string | number>): string {
  const text: string = STRINGS[currentLocale()][key] ?? STRINGS["zh-CN"][key];
  return text.replace(/\{(\d+)\}/g, (raw, i: string) =>
    args[Number(i)] === undefined ? raw : String(args[Number(i)]),
  );
}

/**
 * 应用菜单：
 *  - macOS 必须有，否则 ⌘C / ⌘V / ⌘Q 等快捷键都不可用；标签按界面语言。
 *  - Windows / Linux 用自绘标题栏，不显示菜单栏（null）；Ctrl+C 等由 Chromium 处理。
 */
export function buildAppMenu(appName: string, dev: boolean): Menu | null {
  if (process.platform !== "darwin") return null;
  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: "about", label: tr("about", appName) },
        { type: "separator" },
        { role: "hide", label: tr("hide", appName) },
        { role: "hideOthers", label: tr("hideOthers") },
        { role: "unhide", label: tr("showAll") },
        { type: "separator" },
        { role: "quit", label: tr("quit", appName) },
      ],
    },
    {
      label: tr("edit"),
      submenu: [
        { role: "undo", label: tr("undo") },
        { role: "redo", label: tr("redo") },
        { type: "separator" },
        { role: "cut", label: tr("cut") },
        { role: "copy", label: tr("copy") },
        { role: "paste", label: tr("paste") },
        { role: "pasteAndMatchStyle", label: tr("pasteAndMatch") },
        { role: "delete", label: tr("delete") },
        { role: "selectAll", label: tr("selectAll") },
      ],
    },
    {
      label: tr("view"),
      submenu: [
        ...(dev
          ? ([
              { role: "reload", label: tr("reload") },
              { role: "toggleDevTools", label: tr("devtools") },
              { type: "separator" },
            ] as MenuItemConstructorOptions[])
          : []),
        { role: "resetZoom", label: tr("resetZoom") },
        { role: "zoomIn", label: tr("zoomIn") },
        { role: "zoomOut", label: tr("zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: tr("fullscreen") },
      ],
    },
    {
      label: tr("window"),
      role: "windowMenu",
      submenu: [
        { role: "minimize", label: tr("minimize") },
        { role: "zoom", label: tr("zoom") },
        { type: "separator" },
        { role: "front", label: tr("front") },
        { type: "separator" },
        { role: "close", label: tr("close") },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

export function applyAppMenu(appName: string, dev: boolean): void {
  Menu.setApplicationMenu(buildAppMenu(appName, dev));
}

/** 右键菜单模板（纯函数，便于测试）：可编辑区域给剪切 / 复制 / 粘贴 / 全选与拼写建议；选中文字给复制；链接给复制链接 */
export function contextMenuTemplate(
  params: {
    isEditable: boolean;
    selectionText: string;
    linkURL: string;
    mediaType: string;
    hasImageContents?: boolean;
    misspelledWord: string;
    dictionarySuggestions: string[];
    editFlags: {
      canCut: boolean;
      canCopy: boolean;
      canPaste: boolean;
      canSelectAll: boolean;
      canUndo: boolean;
      canRedo: boolean;
    };
  },
  contents?: Pick<WebContents, "replaceMisspelling" | "session">,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable && params.misspelledWord) {
    if (params.dictionarySuggestions.length) {
      for (const word of params.dictionarySuggestions.slice(0, 5)) {
        items.push({
          label: word,
          click: () => contents?.replaceMisspelling(word),
        });
      }
    } else {
      items.push({ label: tr("noSuggestions"), enabled: false });
    }
    items.push({
      label: tr("addToDictionary"),
      click: () =>
        contents?.session.addWordToSpellCheckerDictionary(
          params.misspelledWord,
        ),
    });
    items.push({ type: "separator" });
  }
  if (params.isEditable) {
    items.push(
      { role: "undo", label: tr("undo"), enabled: params.editFlags.canUndo },
      { role: "redo", label: tr("redo"), enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", label: tr("cut"), enabled: params.editFlags.canCut },
      { role: "copy", label: tr("copy"), enabled: params.editFlags.canCopy },
      { role: "paste", label: tr("paste"), enabled: params.editFlags.canPaste },
      { type: "separator" },
      {
        role: "selectAll",
        label: tr("selectAll"),
        enabled: params.editFlags.canSelectAll,
      },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy", label: tr("copy") });
  }
  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    if (items.length) items.push({ type: "separator" });
    items.push({
      label: tr("copyLink"),
      click: () => {
        void import("electron").then(({ clipboard }) =>
          clipboard.writeText(params.linkURL),
        );
      },
    });
  }
  return items;
}

/** 给应用页面挂上本地化右键菜单（Electron 默认没有右键菜单） */
export function attachContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params, contents);
    if (!template.length) return;
    const window = BrowserWindow.fromWebContents(contents) ?? undefined;
    Menu.buildFromTemplate(template).popup({ window });
  });
}
