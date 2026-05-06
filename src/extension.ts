import * as vscode from "vscode";
import {
  buildCurrentProject,
  BUILD_PROJECT_COMMAND,
  cleanCurrentProject,
  cleanBuildCurrentProject,
  CLEAN_BUILD_PROJECT_COMMAND,
  CLEAN_PROJECT_COMMAND,
  getCurrentBuildTargetTooltip,
} from "./build/buildProjectTask";
import {
  ensureCppToolsConfigFileIfMissing,
  generateCppToolsConfigFile,
  GENERATE_CPPTOOLS_CONFIG_COMMAND,
} from "./cpptoolsConfigGenerator";
import {
  refreshProjectDetectionViews,
  registerWorkspaceRefresh,
} from "./projectDetection";
import {
  downloadCurrentProject,
  DOWNLOAD_PROJECT_COMMAND,
  getCurrentDownloadTargetTooltip,
} from "./build/downloadProjectTask";
import {
  buildDownloadCurrentProject,
  BUILD_DOWNLOAD_PROJECT_COMMAND,
  getCurrentBuildDownloadTargetTooltip,
} from "./build/buildDownloadProjectTask";
import {
  debugCurrentProject,
  DEBUG_PROJECT_COMMAND,
  getCurrentDebugTargetTooltip,
} from "./debug/debugProjectCommand";
import { registerWchDebugLogTracker } from "./debug/debugLog";
import { getWchProjectState } from "./projectState";
import { resolveCurrentBuildTarget } from "./build/buildProjectResolver";
import {
  COPY_SIDEBAR_VALUE_COMMAND,
  WchVscodeSidebarProvider,
} from "./sidebar/WchVscodeSidebarProvider";
import {
  openProjectInMounRiverStudio,
  OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
} from "./mounRiverStudioLauncher";
import { WchProjectFilesProvider } from "./sidebar/WchProjectFilesProvider";
import type { WchProjectModel } from "./models/WchProjectModel";

export function activate(context: vscode.ExtensionContext) {
  // 扩展入口只负责组装侧栏和项目检测服务。
  registerWchDebugLogTracker(context);
  const sidebarProvider = new WchVscodeSidebarProvider();
  const projectFilesProvider = new WchProjectFilesProvider();
  const providers = [sidebarProvider, projectFilesProvider];
  const targetInfoStatusBarItem = createStatusBarItem("WCH", "WCH Target", -99);
  const cleanStatusBarItem = createBuildStatusBarItem(
    "$(trash) Clean",
    CLEAN_PROJECT_COMMAND,
    "WCH Clean",
    -100,
  );
  const buildStatusBarItem = createBuildStatusBarItem(
    "$(tools) Build",
    BUILD_PROJECT_COMMAND,
    "WCH Build",
    -101,
  );
  const cleanBuildStatusBarItem = createBuildStatusBarItem(
    "$(debug-restart) Clean Build",
    CLEAN_BUILD_PROJECT_COMMAND,
    "WCH Clean Build",
    -102,
  );
  const downloadStatusBarItem = createBuildStatusBarItem(
    "$(cloud-download) Download",
    DOWNLOAD_PROJECT_COMMAND,
    "WCH Download",
    -103,
  );
  const buildDownloadStatusBarItem = createBuildStatusBarItem(
    "$(sync) Build Download",
    BUILD_DOWNLOAD_PROJECT_COMMAND,
    "WCH Build Download",
    -104,
  );
  const debugStatusBarItem = createBuildStatusBarItem(
    "$(debug-alt) Debug",
    DEBUG_PROJECT_COMMAND,
    "WCH Debug",
    -105,
  );
  registerWorkspaceRefresh(providers, context, () =>
    updateBuildStatusBarItems(
      targetInfoStatusBarItem,
      cleanStatusBarItem,
      cleanBuildStatusBarItem,
      buildStatusBarItem,
      downloadStatusBarItem,
      buildDownloadStatusBarItem,
      debugStatusBarItem,
    ),
  );
  // 扩展激活时先做一次项目检测，并在缺少 cpptools 配置时自动补齐。
  void initializeProjectState(
    providers,
    targetInfoStatusBarItem,
    cleanStatusBarItem,
    buildStatusBarItem,
    cleanBuildStatusBarItem,
    downloadStatusBarItem,
    buildDownloadStatusBarItem,
    debugStatusBarItem,
  );
  // 注册侧栏刷新命令，供标题栏按钮触发重新检测和解析。
  const refreshProjectsCommand = vscode.commands.registerCommand(
    "wchVscode.refreshProjects",
    async () => {
      await refreshProjectDetectionViews(providers);
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
    },
  );
  const buildProjectCommand = vscode.commands.registerCommand(
    BUILD_PROJECT_COMMAND,
    async () => {
      await buildCurrentProject();
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
    },
  );
  const cleanProjectCommand = vscode.commands.registerCommand(
    CLEAN_PROJECT_COMMAND,
    async () => {
      await cleanCurrentProject();
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
    },
  );
  const cleanBuildProjectCommand = vscode.commands.registerCommand(
    CLEAN_BUILD_PROJECT_COMMAND,
    async () => {
      await cleanBuildCurrentProject();
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
    },
  );
  const downloadProjectCommand = vscode.commands.registerCommand(
    DOWNLOAD_PROJECT_COMMAND,
    async () => {
      await downloadCurrentProject();
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
    },
  );
  const buildDownloadProjectCommand = vscode.commands.registerCommand(
    BUILD_DOWNLOAD_PROJECT_COMMAND,
    async () => {
      const succeeded = await buildDownloadCurrentProject();
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
      if (succeeded) {
        void vscode.window.showInformationMessage("WCH: 编译下载成功");
      }
    },
  );
  const debugProjectCommand = vscode.commands.registerCommand(
    DEBUG_PROJECT_COMMAND,
    async () => {
      await debugCurrentProject();
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      );
    },
  );
  // 注册侧栏复制命令，点击叶子节点时将对应值写入剪贴板。
  const copySidebarValueCommand = vscode.commands.registerCommand(
    COPY_SIDEBAR_VALUE_COMMAND,
    async (label: string, value: string) => {
      await vscode.env.clipboard.writeText(value);
      void vscode.window.showInformationMessage(`WCH: 已复制 ${label}`);
    },
  );
  // 注册 cpptools 配置生成命令，基于当前工作区项目模型写入 c_cpp_properties.json。
  const generateCppToolsConfigCommand = vscode.commands.registerCommand(
    GENERATE_CPPTOOLS_CONFIG_COMMAND,
    async (folder: vscode.WorkspaceFolder, models: WchProjectModel[]) => {
      await generateCppToolsConfigFile(folder, models);
      void vscode.window.showInformationMessage("WCH: 已生成 C/C++ 配置文件");
    },
  );
  const openInMounRiverStudioCommand = vscode.commands.registerCommand(
    OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
    async (wvprojPath: string) => {
      await openProjectInMounRiverStudio(wvprojPath);
    },
  );

  context.subscriptions.push(
    buildProjectCommand,
    cleanProjectCommand,
    cleanBuildProjectCommand,
    downloadProjectCommand,
    buildDownloadProjectCommand,
    debugProjectCommand,
    targetInfoStatusBarItem,
    cleanStatusBarItem,
    buildStatusBarItem,
    cleanBuildStatusBarItem,
    downloadStatusBarItem,
    buildDownloadStatusBarItem,
    debugStatusBarItem,
    copySidebarValueCommand,
    generateCppToolsConfigCommand,
    openInMounRiverStudioCommand,
    refreshProjectsCommand,
    vscode.window.registerTreeDataProvider(
      "wchVscodeSidebarView",
      sidebarProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "wchVscodeProjectFilesView",
      projectFilesProvider,
    ),
    vscode.window.onDidChangeActiveTextEditor(() =>
      updateBuildStatusBarItems(
        targetInfoStatusBarItem,
        cleanStatusBarItem,
        cleanBuildStatusBarItem,
        buildStatusBarItem,
        downloadStatusBarItem,
        buildDownloadStatusBarItem,
        debugStatusBarItem,
      ),
    ),
  );
}

export function deactivate() {}

// 初始化项目状态，并为命中的工作区自动生成缺失的 cpptools 配置文件。
async function initializeProjectState(
  providers: Array<{ setResults(): void }>,
  targetInfoStatusBarItem: vscode.StatusBarItem,
  cleanStatusBarItem: vscode.StatusBarItem,
  buildStatusBarItem: vscode.StatusBarItem,
  cleanBuildStatusBarItem: vscode.StatusBarItem,
  downloadStatusBarItem: vscode.StatusBarItem,
  buildDownloadStatusBarItem: vscode.StatusBarItem,
  debugStatusBarItem: vscode.StatusBarItem,
): Promise<void> {
  await refreshProjectDetectionViews(providers);

  for (const project of getWchProjectState().projects) {
    const folder = vscode.workspace.workspaceFolders?.find(
      (item) => item.uri.fsPath === project.folderPath,
    );

    if (!folder || project.models.length === 0) {
      continue;
    }

    await ensureCppToolsConfigFileIfMissing(folder, project.models);
  }

  updateBuildStatusBarItems(
    targetInfoStatusBarItem,
    cleanStatusBarItem,
    cleanBuildStatusBarItem,
    buildStatusBarItem,
    downloadStatusBarItem,
    buildDownloadStatusBarItem,
    debugStatusBarItem,
  );
}

function createStatusBarItem(
  text: string,
  name: string,
  priority: number,
  command?: string,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority,
  );
  item.text = text;
  item.command = command;
  item.name = name;
  return item;
}

function createBuildStatusBarItem(
  text: string,
  command: string,
  name: string,
  priority: number,
): vscode.StatusBarItem {
  return createStatusBarItem(text, name, priority, command);
}

function updateBuildStatusBarItems(
  targetInfoStatusBarItem: vscode.StatusBarItem,
  cleanStatusBarItem: vscode.StatusBarItem,
  cleanBuildStatusBarItem: vscode.StatusBarItem,
  buildStatusBarItem: vscode.StatusBarItem,
  downloadStatusBarItem: vscode.StatusBarItem,
  buildDownloadStatusBarItem: vscode.StatusBarItem,
  debugStatusBarItem: vscode.StatusBarItem,
): void {
  updateTargetInfoStatusBarItem(targetInfoStatusBarItem);
  cleanStatusBarItem.tooltip = getCurrentBuildTargetTooltip(undefined, "Clean");
  cleanStatusBarItem.show();
  cleanBuildStatusBarItem.tooltip = getCurrentBuildTargetTooltip(
    undefined,
    "Clean Build",
  );
  cleanBuildStatusBarItem.show();
  buildStatusBarItem.tooltip = getCurrentBuildTargetTooltip(undefined, "Build");
  buildStatusBarItem.show();
  downloadStatusBarItem.tooltip = getCurrentDownloadTargetTooltip();
  downloadStatusBarItem.show();
  buildDownloadStatusBarItem.tooltip = getCurrentBuildDownloadTargetTooltip();
  buildDownloadStatusBarItem.show();
  debugStatusBarItem.tooltip = getCurrentDebugTargetTooltip();
  debugStatusBarItem.show();
}

function updateTargetInfoStatusBarItem(
  targetInfoStatusBarItem: vscode.StatusBarItem,
): void {
  const resolution = resolveCurrentBuildTarget();
  if (!resolution.target) {
    targetInfoStatusBarItem.hide();
    return;
  }

  const { model } = resolution.target;
  const projectName = model.identity.name || model.identity.baseName;
  const mcuName = model.target.mcu || model.target.architecture;
  targetInfoStatusBarItem.text = `${projectName} · ${mcuName}`;
  targetInfoStatusBarItem.tooltip = `${projectName}\nMCU: ${mcuName}`;
  targetInfoStatusBarItem.show();
}
