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
import { getWchProjectState } from "./projectState";
import { resolveCurrentBuildTarget } from "./build/buildProjectResolver";
import {
  COPY_SIDEBAR_VALUE_COMMAND,
  WchVscodeSidebarProvider,
} from "./sidebar/WchVscodeSidebarProvider";
import { WchProjectFilesProvider } from "./sidebar/WchProjectFilesProvider";
import type { WchProjectModel } from "./models/WchProjectModel";

export function activate(context: vscode.ExtensionContext) {
  // 扩展入口只负责组装侧栏和项目检测服务。
  const sidebarProvider = new WchVscodeSidebarProvider();
  const projectFilesProvider = new WchProjectFilesProvider();
  const providers = [sidebarProvider, projectFilesProvider];
  const targetInfoStatusBarItem = createStatusBarItem(
    "WCH",
    "WCH Target",
    -99,
  );
  const cleanStatusBarItem = createBuildStatusBarItem(
    "$(trash) Clean",
    CLEAN_PROJECT_COMMAND,
    "WCH Clean",
    -102,
  );
  const cleanBuildStatusBarItem = createBuildStatusBarItem(
    "$(debug-restart) Clean Build",
    CLEAN_BUILD_PROJECT_COMMAND,
    "WCH Clean Build",
    -101,
  );
  const buildStatusBarItem = createBuildStatusBarItem(
    "$(tools) Build",
    BUILD_PROJECT_COMMAND,
    "WCH Build",
    -100,
  );
  registerWorkspaceRefresh(providers, context, () =>
    updateBuildStatusBarItems(
      targetInfoStatusBarItem,
      cleanStatusBarItem,
      cleanBuildStatusBarItem,
      buildStatusBarItem,
    ),
  );
  // 扩展激活时先做一次项目检测，并在缺少 cpptools 配置时自动补齐。
  void initializeProjectState(
    providers,
    targetInfoStatusBarItem,
    cleanStatusBarItem,
    buildStatusBarItem,
    cleanBuildStatusBarItem,
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
      );
    },
  );
  // 注册侧栏复制命令，点击叶子节点时将对应值写入剪贴板。
  const copySidebarValueCommand = vscode.commands.registerCommand(
    COPY_SIDEBAR_VALUE_COMMAND,
    async (label: string, value: string) => {
      await vscode.env.clipboard.writeText(value);
      void vscode.window.showInformationMessage(`已复制 ${label}`);
    },
  );
  // 注册 cpptools 配置生成命令，基于当前工作区项目模型写入 c_cpp_properties.json。
  const generateCppToolsConfigCommand = vscode.commands.registerCommand(
    GENERATE_CPPTOOLS_CONFIG_COMMAND,
    async (folder: vscode.WorkspaceFolder, models: WchProjectModel[]) => {
      const file = await generateCppToolsConfigFile(folder, models);
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document, { preview: false });
      void vscode.window.showInformationMessage("已生成 C/C++ 配置文件");
    },
  );

  context.subscriptions.push(
    buildProjectCommand,
    cleanProjectCommand,
    cleanBuildProjectCommand,
    targetInfoStatusBarItem,
    cleanStatusBarItem,
    buildStatusBarItem,
    cleanBuildStatusBarItem,
    copySidebarValueCommand,
    generateCppToolsConfigCommand,
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
  const projectName = model.project.name || model.baseName;
  const mcuName = model.chip.mcu || model.chip.series || model.project.architecture;
  targetInfoStatusBarItem.text = `${projectName} · ${mcuName}`;
  targetInfoStatusBarItem.tooltip = `${projectName}\nMCU: ${mcuName}`;
  targetInfoStatusBarItem.show();
}
