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
      cleanStatusBarItem,
      cleanBuildStatusBarItem,
      buildStatusBarItem,
    ),
  );
  // 扩展激活时先做一次项目检测，并在缺少 cpptools 配置时自动补齐。
  void initializeProjectState(
    providers,
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
    cleanStatusBarItem,
    cleanBuildStatusBarItem,
    buildStatusBarItem,
  );
}

function createBuildStatusBarItem(
  text: string,
  command: string,
  name: string,
  priority: number,
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

function updateBuildStatusBarItems(
  cleanStatusBarItem: vscode.StatusBarItem,
  cleanBuildStatusBarItem: vscode.StatusBarItem,
  buildStatusBarItem: vscode.StatusBarItem,
): void {
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
