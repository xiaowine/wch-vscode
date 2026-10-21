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
import { BUILD_METHOD_SETTING } from "./build/buildMethod";
import {
  POWER_OFF_DELAY_SETTING,
  POWER_OUTPUT_SETTING,
  RESET_MODE_SETTING,
} from "./build/powerOffReset";
import { disposeOpenOcdTerminal } from "./build/openOcdOutput";
import {
  POWER_OFF_RESET_COMMAND,
  powerOffResetCurrentProject,
} from "./build/powerOffResetCommand";
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
  WchVscodeSidebarProvider,
} from "./sidebar/WchVscodeSidebarProvider";
import {
  OPEN_BUILD_METHOD_SETTING_COMMAND,
  OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND,
  OPEN_POWER_OFF_DELAY_SETTING_COMMAND,
  OPEN_POWER_OUTPUT_SETTING_COMMAND,
  OPEN_RESET_MODE_SETTING_COMMAND,
  WchToolsSidebarProvider,
} from "./sidebar/WchToolsSidebarProvider";
import {
  openCurrentProjectInMounRiverStudio,
  openProjectInMounRiverStudio,
  OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
} from "./mounRiverStudioLauncher";
import { WchProjectFilesProvider } from "./sidebar/WchProjectFilesProvider";
import type { WchProjectModel } from "./models/WchProjectModel";
import { t } from "./i18n";
import { showProjectConfigurationRequiredMessage } from "./projectConfigurationPrompt";

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
const UNOFFICIAL_DISCLAIMER_SHOWN_KEY = "unofficialDisclaimerShown";
const promptedConfigurationProjects = new Set<string>();

async function showUnofficialDisclaimer(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(UNOFFICIAL_DISCLAIMER_SHOWN_KEY)) {
    return;
  }

  await vscode.window.showWarningMessage(t("message.unofficialDisclaimer"));
  await context.globalState.update(UNOFFICIAL_DISCLAIMER_SHOWN_KEY, true);
}

export function activate(context: vscode.ExtensionContext) {
  void showUnofficialDisclaimer(context);
  // 扩展入口只负责组装侧栏和项目检测服务。
  registerWchDebugLogTracker(context);
  const sidebarProvider = new WchVscodeSidebarProvider();
  const projectFilesProvider = new WchProjectFilesProvider();
  const toolsSidebarProvider = new WchToolsSidebarProvider();
  const providers = [sidebarProvider, projectFilesProvider, toolsSidebarProvider];
  const statusBarItems = createWchStatusBarItems();
  const refreshStatusBarItems = async () => {
    updateBuildStatusBarItems(statusBarItems);
    await showPendingProjectConfigurationPrompt();
  };
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
  const powerOffResetCommand = registerCommandAndRefresh(
    POWER_OFF_RESET_COMMAND,
    async () => {
      await powerOffResetCurrentProject();
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
    async (wvprojPath?: string) => {
      if (wvprojPath) {
        await openProjectInMounRiverStudio(wvprojPath);
        return;
      }
      await openCurrentProjectInMounRiverStudio();
    },
  );
  const toolsConfigurationListener = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (
        event.affectsConfiguration(
          `${WCH_CONFIGURATION_SECTION}.${MOUN_RIVER_STUDIO_PATH_SETTING}`,
        )
        || event.affectsConfiguration(
          `${WCH_CONFIGURATION_SECTION}.${BUILD_METHOD_SETTING}`,
        )
        || event.affectsConfiguration(
          `${WCH_CONFIGURATION_SECTION}.${RESET_MODE_SETTING}`,
        )
        || event.affectsConfiguration(
          `${WCH_CONFIGURATION_SECTION}.${POWER_OFF_DELAY_SETTING}`,
        )
        || event.affectsConfiguration(
          `${WCH_CONFIGURATION_SECTION}.${POWER_OUTPUT_SETTING}`,
        )
      ) {
        toolsSidebarProvider.refresh();
      }
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
  const openBuildMethodSettingCommand = vscode.commands.registerCommand(
    OPEN_BUILD_METHOD_SETTING_COMMAND,
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `${WCH_CONFIGURATION_SECTION}.${BUILD_METHOD_SETTING}`,
      );
    },
  );
  const openResetModeSettingCommand = vscode.commands.registerCommand(
    OPEN_RESET_MODE_SETTING_COMMAND,
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `${WCH_CONFIGURATION_SECTION}.${RESET_MODE_SETTING}`,
      );
    },
  );
  const openPowerOffDelaySettingCommand = vscode.commands.registerCommand(
    OPEN_POWER_OFF_DELAY_SETTING_COMMAND,
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `${WCH_CONFIGURATION_SECTION}.${POWER_OFF_DELAY_SETTING}`,
      );
    },
  );
  const openPowerOutputSettingCommand = vscode.commands.registerCommand(
    OPEN_POWER_OUTPUT_SETTING_COMMAND,
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `${WCH_CONFIGURATION_SECTION}.${POWER_OUTPUT_SETTING}`,
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
    powerOffResetCommand,
    ...Object.values(statusBarItems),
    copySidebarValueCommand,
    generateCppToolsConfigCommand,
    openInMounRiverStudioCommand,
    openMounRiverStudioPathSettingCommand,
    openBuildMethodSettingCommand,
    openResetModeSettingCommand,
    openPowerOffDelaySettingCommand,
    openPowerOutputSettingCommand,
    toolsConfigurationListener,
    { dispose: disposeOpenOcdTerminal },
    refreshProjectsCommand,
    vscode.window.registerTreeDataProvider(
      "wchVscodeSidebarView",
      sidebarProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "wchVscodeToolsView",
      toolsSidebarProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "wchVscodeProjectFilesView",
      projectFilesProvider,
    ),
    vscode.window.onDidChangeActiveTextEditor(refreshStatusBarItems),
    vscode.window.onDidChangeActiveTextEditor(() =>
      toolsSidebarProvider.refresh(),
    ),
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
  await showPendingProjectConfigurationPrompt();
}

function registerCommandAndRefresh(
  command: string,
  callback: (...args: unknown[]) => Promise<unknown>,
  afterCommand: () => void | Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    const result = await callback(...args);
    await afterCommand();
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
  const resolution = resolveCurrentBuildTarget();
  if (!resolution.target) {
    hideWchStatusBarItems(items);
    return;
  }

  updateTargetInfoStatusBarItem(items.targetInfo, resolution.target.model);
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
  model: WchProjectModel,
): void {
  const projectName = model.identity.name || model.identity.baseName;
  const mcuName = model.target.mcu || model.target.architecture;
  targetInfoStatusBarItem.text = `${projectName} · ${mcuName}`;
  targetInfoStatusBarItem.tooltip = t("status.tooltip.mcu", {
    projectName,
    mcuName,
  });
  targetInfoStatusBarItem.show();
}

function hideWchStatusBarItems(items: WchStatusBarItems): void {
  for (const item of Object.values(items)) {
    item.hide();
  }
}

async function showPendingProjectConfigurationPrompt(): Promise<void> {
  const project = getWchProjectState().projects.find(
    (item) => item.configurationWvprojPath && item.unsupportedReason,
  );
  if (!project?.configurationWvprojPath || !project.unsupportedReason) {
    return;
  }

  const wvprojPath = project.configurationWvprojPath;
  if (promptedConfigurationProjects.has(wvprojPath)) {
    return;
  }

  promptedConfigurationProjects.add(wvprojPath);
  await showProjectConfigurationRequiredMessage(project.unsupportedReason, wvprojPath);
}
