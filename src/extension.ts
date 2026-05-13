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
import { MOUN_RIVER_STUDIO_PATH_SETTING } from "./build/buildShared";
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
  buildDownloadProject,
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
  OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND,
  WchVscodeSidebarProvider,
} from "./sidebar/WchVscodeSidebarProvider";
import {
  openProjectInMounRiverStudio,
  OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
} from "./mounRiverStudioLauncher";
import { WchProjectFilesProvider } from "./sidebar/WchProjectFilesProvider";
import type { WchProjectModel } from "./models/WchProjectModel";
import { t } from "./i18n";

type WchStatusBarItems = {
  targetInfo: vscode.StatusBarItem;
  clean: vscode.StatusBarItem;
  build: vscode.StatusBarItem;
  cleanBuild: vscode.StatusBarItem;
  download: vscode.StatusBarItem;
  buildDownload: vscode.StatusBarItem;
  debug: vscode.StatusBarItem;
};

const WCH_CONFIGURATION_SECTION = "wchVscode";

export function activate(context: vscode.ExtensionContext) {
  // 扩展入口只负责组装侧栏和项目检测服务。
  registerWchDebugLogTracker(context);
  const sidebarProvider = new WchVscodeSidebarProvider();
  const projectFilesProvider = new WchProjectFilesProvider();
  const providers = [sidebarProvider, projectFilesProvider];
  const statusBarItems = createWchStatusBarItems();
  const refreshStatusBarItems = () => updateBuildStatusBarItems(statusBarItems);
  registerWorkspaceRefresh(providers, context, () =>
    refreshStatusBarItems(),
  );
  // 扩展激活时先做一次项目检测，并在缺少 cpptools 配置时自动补齐。
  const initialization = initializeProjectState(providers, statusBarItems);
  void initialization;
  // 注册侧栏刷新命令，供标题栏按钮触发重新检测和解析。
  const refreshProjectsCommand = registerCommandAndRefresh(
    "wchVscode.refreshProjects",
    async () => {
      await refreshProjectDetectionViews(providers);
    },
    refreshStatusBarItems,
  );
  const buildProjectCommand = registerCommandAndRefresh(
    BUILD_PROJECT_COMMAND,
    async () => {
      await buildCurrentProject();
    },
    refreshStatusBarItems,
  );
  const cleanProjectCommand = registerCommandAndRefresh(
    CLEAN_PROJECT_COMMAND,
    async () => {
      await cleanCurrentProject();
    },
    refreshStatusBarItems,
  );
  const cleanBuildProjectCommand = registerCommandAndRefresh(
    CLEAN_BUILD_PROJECT_COMMAND,
    async () => {
      await cleanBuildCurrentProject();
    },
    refreshStatusBarItems,
  );
  const downloadProjectCommand = registerCommandAndRefresh(
    DOWNLOAD_PROJECT_COMMAND,
    async () => {
      await downloadCurrentProject();
    },
    refreshStatusBarItems,
  );
  const buildDownloadProjectCommand = registerCommandAndRefresh(
    BUILD_DOWNLOAD_PROJECT_COMMAND,
    async (input?: unknown) => {
      await initialization;
      await refreshProjectDetectionViews(providers);
      const succeeded =
        input === undefined
          ? await buildDownloadCurrentProject()
          : await buildDownloadProject(input);
      if (succeeded) {
        void vscode.window.showInformationMessage(t("message.buildDownloadSucceeded"));
      }
      return succeeded;
    },
    refreshStatusBarItems,
  );
  const debugProjectCommand = registerCommandAndRefresh(
    DEBUG_PROJECT_COMMAND,
    async () => {
      await debugCurrentProject();
    },
    refreshStatusBarItems,
  );
  // 注册侧栏复制命令，点击叶子节点时将对应值写入剪贴板。
  const copySidebarValueCommand = vscode.commands.registerCommand(
    COPY_SIDEBAR_VALUE_COMMAND,
    async (label: string, value: string) => {
      await vscode.env.clipboard.writeText(value);
      void vscode.window.showInformationMessage(t("message.copied", { label }));
    },
  );
  // 注册 cpptools 配置生成命令，基于当前工作区项目模型写入 c_cpp_properties.json。
  const generateCppToolsConfigCommand = vscode.commands.registerCommand(
    GENERATE_CPPTOOLS_CONFIG_COMMAND,
    async (folder: vscode.WorkspaceFolder, models: WchProjectModel[]) => {
      await generateCppToolsConfigFile(folder, models);
      void vscode.window.showInformationMessage(t("message.cppToolsConfigGenerated"));
    },
  );
  const openInMounRiverStudioCommand = vscode.commands.registerCommand(
    OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
    async (wvprojPath: string) => {
      await openProjectInMounRiverStudio(wvprojPath);
    },
  );
  const openMounRiverStudioPathSettingCommand = vscode.commands.registerCommand(
    OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND,
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `${WCH_CONFIGURATION_SECTION}.${MOUN_RIVER_STUDIO_PATH_SETTING}`,
      );
    },
  );

  context.subscriptions.push(
    buildProjectCommand,
    cleanProjectCommand,
    cleanBuildProjectCommand,
    downloadProjectCommand,
    buildDownloadProjectCommand,
    debugProjectCommand,
    ...Object.values(statusBarItems),
    copySidebarValueCommand,
    generateCppToolsConfigCommand,
    openInMounRiverStudioCommand,
    openMounRiverStudioPathSettingCommand,
    refreshProjectsCommand,
    vscode.window.registerTreeDataProvider(
      "wchVscodeSidebarView",
      sidebarProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "wchVscodeProjectFilesView",
      projectFilesProvider,
    ),
    vscode.window.onDidChangeActiveTextEditor(refreshStatusBarItems),
  );
}

export function deactivate() {}

// 初始化项目状态，并为命中的工作区自动生成缺失的 cpptools 配置文件。
async function initializeProjectState(
  providers: Array<{ setResults(): void }>,
  statusBarItems: WchStatusBarItems,
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

  updateBuildStatusBarItems(statusBarItems);
}

function registerCommandAndRefresh(
  command: string,
  callback: (...args: unknown[]) => Promise<unknown>,
  afterCommand: () => void,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    const result = await callback(...args);
    afterCommand();
    return result;
  });
}

function createWchStatusBarItems(): WchStatusBarItems {
  return {
    targetInfo: createStatusBarItem("WCH", t("status.name.target"), -99),
    clean: createBuildStatusBarItem(
      t("status.text.clean"),
      CLEAN_PROJECT_COMMAND,
      t("status.name.clean"),
      -100,
    ),
    build: createBuildStatusBarItem(
      t("status.text.build"),
      BUILD_PROJECT_COMMAND,
      t("status.name.build"),
      -101,
    ),
    cleanBuild: createBuildStatusBarItem(
      t("status.text.cleanBuild"),
      CLEAN_BUILD_PROJECT_COMMAND,
      t("status.name.cleanBuild"),
      -102,
    ),
    download: createBuildStatusBarItem(
      t("status.text.download"),
      DOWNLOAD_PROJECT_COMMAND,
      t("status.name.download"),
      -103,
    ),
    buildDownload: createBuildStatusBarItem(
      t("status.text.buildDownload"),
      BUILD_DOWNLOAD_PROJECT_COMMAND,
      t("status.name.buildDownload"),
      -104,
    ),
    debug: createBuildStatusBarItem(
      t("status.text.debug"),
      DEBUG_PROJECT_COMMAND,
      t("status.name.debug"),
      -105,
    ),
  };
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

function updateBuildStatusBarItems(items: WchStatusBarItems): void {
  updateTargetInfoStatusBarItem(items.targetInfo);
  items.clean.tooltip = getCurrentBuildTargetTooltip(undefined, t("action.clean"));
  items.clean.show();
  items.cleanBuild.tooltip = getCurrentBuildTargetTooltip(
    undefined,
    t("action.cleanBuild"),
  );
  items.cleanBuild.show();
  items.build.tooltip = getCurrentBuildTargetTooltip(undefined, t("action.build"));
  items.build.show();
  items.download.tooltip = getCurrentDownloadTargetTooltip();
  items.download.show();
  items.buildDownload.tooltip = getCurrentBuildDownloadTargetTooltip();
  items.buildDownload.show();
  items.debug.tooltip = getCurrentDebugTargetTooltip();
  items.debug.show();
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
  targetInfoStatusBarItem.tooltip = t("status.tooltip.mcu", {
    projectName,
    mcuName,
  });
  targetInfoStatusBarItem.show();
}
