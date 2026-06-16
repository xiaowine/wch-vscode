import * as vscode from "vscode";
import { GENERATE_CPPTOOLS_CONFIG_COMMAND } from "../cpptoolsConfigGenerator";
import type { WchProjectModel } from "../models/WchProjectModel";
import { OPEN_IN_MOUN_RIVER_STUDIO_COMMAND } from "../mounRiverStudioLauncher";
import type { ProjectDetectionResult } from "../projectDetection";
import type { ParsedWchProject } from "../projectState";
import { getWchProjectState } from "../projectState";
import { t } from "../i18n";

const COPY_SIDEBAR_VALUE_COMMAND = "wchVscode.copySidebarValue";
const OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND =
  "wchVscode.openMounRiverStudioPathSetting";

class SidebarItem extends vscode.TreeItem {
  children?: SidebarItem[];

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode
      .TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState);
  }
}

// 侧栏数据提供器，只负责展示已经缓存好的检测结果。
export class WchVscodeSidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    SidebarItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  setResults(): void {
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
    if (element) {
      return element.children ?? [];
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [this.createEmptyWorkspaceItem()];
    }

    const state = getWchProjectState();
    const projectMap = new Map(
      state.projects.map((project) => [project.folderPath, project]),
    );
    return state.results.map((result) =>
      this.buildWorkspaceItem(
        result,
        projectMap.get(result.folder.uri.fsPath),
      ),
    );
  }

  private buildWorkspaceItem(
    result: ProjectDetectionResult,
    project?: ParsedWchProject,
  ): SidebarItem {
    const models = project?.models ?? [];
    const isUnsupported = Boolean(project?.unsupportedReason);
    const hasValidationErrors = result.validationErrors.length > 0;
    const item = new SidebarItem(result.folder.name);
    item.description = isUnsupported
      ? t("sidebar.unsupportedProject")
      : hasValidationErrors
      ? t("sidebar.invalidProject")
      : result.isTargetProject
      ? t("sidebar.matchedProject")
      : t("sidebar.notMatched");
    item.tooltip = this.buildTooltip(result);
    item.iconPath = new vscode.ThemeIcon(
      isUnsupported || hasValidationErrors ? "error" : result.isTargetProject ? "pass-filled" : "warning",
    );
    item.contextValue = isUnsupported
      ? "unsupportedProject"
      : hasValidationErrors
      ? "invalidProject"
      : result.isTargetProject
      ? "matchedProject"
      : "unmatchedProject";
    item.collapsibleState = result.isTargetProject
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    item.children = result.isTargetProject
      ? isUnsupported
        ? this.buildUnsupportedProjectItems(project)
        : [
          this.createMounRiverStudioPathSettingItem(),
          this.createGenerateCppToolsItem(result.folder, models),
          ...models.map((model) => this.createOpenInMounRiverStudioItem(model)),
          ...models.flatMap((model) => this.buildProjectModelItems(model)),
        ]
      : [];

    return item;
  }

  // 工作区未打开时给出统一提示，避免顶层出现空白视图。
  private createEmptyWorkspaceItem(): SidebarItem {
    const item = new SidebarItem(t("sidebar.emptyWorkspace"));
    item.description = t("sidebar.emptyWorkspaceDescription");
    item.iconPath = new vscode.ThemeIcon("folder-opened");
    return item;
  }

  // 在工作区层级提供 cpptools 配置生成入口，避免多项目时重复生成。
  private createGenerateCppToolsItem(
    folder: vscode.WorkspaceFolder,
    models: WchProjectModel[],
  ): SidebarItem {
    const item = new SidebarItem(t("command.generateCppToolsConfig"));
    item.description = ".vscode/c_cpp_properties.json";
    item.tooltip = t("sidebar.generateCppToolsConfigTooltip");
    item.iconPath = new vscode.ThemeIcon("gear");
    item.command = {
      command: GENERATE_CPPTOOLS_CONFIG_COMMAND,
      title: t("command.generateCppToolsConfig"),
      arguments: [folder, models],
    };
    return item;
  }

  // 当前只支持 RISC-V 工程，不支持的工程直接给出提示，不继续加载业务数据。
  private buildUnsupportedProjectItems(project?: ParsedWchProject): SidebarItem[] {
    const items = [
      this.createUnsupportedItem(project?.unsupportedReason ?? t("sidebar.unsupportedProjectFallback")),
    ];
    if (project?.configurationWvprojPath) {
      items.push(this.createOpenInMounRiverStudioPathItem(project.configurationWvprojPath));
    }

    return items;
  }

  private createUnsupportedItem(message: string): SidebarItem {
    const item = new SidebarItem(t("sidebar.unsupportedProjectTitle"));
    item.description = message;
    item.tooltip = message;
    item.iconPath = new vscode.ThemeIcon("error");
    return item;
  }

  // 将精简后的项目模型转换成侧栏树节点。
  private buildProjectModelItems(model: WchProjectModel): SidebarItem[] {
    const root = new SidebarItem(
      model.identity.name || model.identity.baseName,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    root.description = model.target.mcu || model.target.architecture;
    root.iconPath = new vscode.ThemeIcon("project");
    root.children = [
      this.createSection(t("sidebar.project"), [
        this.createLeaf(t("sidebar.name"), model.identity.name),
        this.createLeaf(t("sidebar.architecture"), model.target.architecture),
        this.createLeaf(
          t("sidebar.artifact"),
          model.build.artifact.outputFile || this.buildArtifactName(model),
        ),
        this.createListSection(
          t("sidebar.linkedFolders"),
          model.target.linkedFolders.map(
            (item) => `${item.name} -> ${item.location}`,
          ),
        ),
      ]),
      this.createSection(t("sidebar.target"), [
        this.createLeaf("MCU", model.target.mcu),
        this.createLeaf(t("sidebar.rtos"), model.target.rtos),
        this.createLeaf(t("sidebar.toolchain"), model.target.toolchain),
        this.createLeaf(t("sidebar.svd"), model.target.svdPath),
      ]),
      this.createSection(t("sidebar.build"), [
        this.createLeaf(t("sidebar.config"), model.build.configName),
        this.createLeaf(t("sidebar.toolchain"), model.build.toolchainName),
        this.createLeaf(
          t("sidebar.target"),
          `${model.build.targetArchitecture} / ${model.build.targetAbi}`,
        ),
        this.createLeaf(t("sidebar.output"), model.build.configName),
        this.createLeaf(t("sidebar.linkerScript"), model.build.linker.script),
      ]),
      this.createSection(t("sidebar.debug"), [
        this.createLeaf(t("sidebar.openOcd"), model.debug.openOcdExecutable),
        this.createLeaf(t("sidebar.host"), model.debug.host),
        this.createLeaf(t("sidebar.gdbPort"), String(model.debug.gdbPort || "")),
        this.createLeaf(t("sidebar.stopAt"), model.debug.stopAt),
      ]),
      this.createSection(t("sidebar.flash"), [
        this.createLeaf(t("sidebar.target"), model.flash.targetPath),
        this.createLeaf(t("sidebar.address"), model.flash.address),
        this.createLeaf(
          t("sidebar.action.flash"),
          `erase:${model.flash.erase} program:${model.flash.program} verify:${model.flash.verify} reset:${model.flash.reset}`,
        ),
      ]),
    ];

    return [root];
  }

  private createOpenInMounRiverStudioItem(model: WchProjectModel): SidebarItem {
    return this.createOpenInMounRiverStudioPathItem(
      model.identity.files.wvproj,
      model.identity.name || model.identity.baseName,
    );
  }

  private createOpenInMounRiverStudioPathItem(
    wvprojPath: string,
    description = ".wvproj",
  ): SidebarItem {
    const item = new SidebarItem(t("command.openInMrs2"));
    item.description = description;
    item.tooltip = t("sidebar.openInMrs2Tooltip", { filePath: wvprojPath });
    item.iconPath = new vscode.ThemeIcon("window");
    item.command = {
      command: OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
      title: t("command.openInMrs2"),
      arguments: [wvprojPath],
    };
    return item;
  }

  private createMounRiverStudioPathSettingItem(): SidebarItem {
    const item = new SidebarItem(t("command.openMounRiverStudioPathSetting"));
    item.description = "wchVscode.mounRiverStudioPath";
    item.tooltip = t("sidebar.openMounRiverStudioPathSettingTooltip");
    item.iconPath = new vscode.ThemeIcon("settings-gear");
    item.command = {
      command: OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND,
      title: t("command.openMounRiverStudioPathSetting"),
    };
    return item;
  }

  // 创建分组节点，自动剔除空内容。
  private createSection(
    label: string,
    children: Array<SidebarItem | null>,
  ): SidebarItem {
    const visibleChildren = children.filter(
      (item): item is SidebarItem => item !== null,
    );
    const item = new SidebarItem(
      label,
      visibleChildren.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon("list-tree");
    item.children = visibleChildren;
    return item;
  }

  // 创建单值展示节点，空字符串直接忽略。
  private createLeaf(label: string, value: string): SidebarItem | null {
    if (!value) {
      return null;
    }

    const item = new SidebarItem(label);
    item.description = value;
    item.tooltip = `${label}: ${value}`;
    item.iconPath = new vscode.ThemeIcon("circle-small-filled");
    // 叶子节点点击后直接复制值，方便快速取用项目信息。
    item.command = this.createCopyCommand(label, value);
    return item;
  }

  // 创建字符串列表分组，空列表直接忽略。
  private createListSection(
    label: string,
    values: string[],
  ): SidebarItem | null {
    const visibleValues = values.filter((value) => value.length > 0);
    if (visibleValues.length === 0) {
      return null;
    }

    const item = new SidebarItem(
      label,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon("symbol-array");
    item.children = visibleValues.map((value) => {
      const child = new SidebarItem(value);
      child.tooltip = value;
      child.iconPath = new vscode.ThemeIcon("circle-small-filled");
      // 列表项本身就是目标值，点击后直接复制。
      child.command = this.createCopyCommand(label, value);
      return child;
    });
    return item;
  }

  // 构建产物名优先显示完整输出文件，缺失时退回 name + extension。
  private buildArtifactName(model: WchProjectModel): string {
    if (!model.build.artifact.name) {
      return "";
    }

    return model.build.artifact.extension
      ? `${model.build.artifact.name}.${model.build.artifact.extension}`
      : model.build.artifact.name;
  }

  // 侧栏悬停信息展示检测明细，便于定位规则是否命中。
  private buildTooltip(result: ProjectDetectionResult): string {
    const lines = [
      `${t("sidebar.folder")}: ${result.folder.uri.fsPath}`,
      `.cproject files: ${result.cprojectCount}`,
      `.launch files: ${result.launchCount}`,
      `.wvproj files: ${result.wvprojCount}`,
    ];

    if (result.matchingBaseNames.length > 0) {
      lines.push(`${t("sidebar.matchedBaseNames")}: ${result.matchingBaseNames.join(", ")}`);
    } else {
      lines.push(t("sidebar.matchedBaseNamesNone"));
    }

    if (result.validationErrors.length > 0) {
      lines.push(t("sidebar.projectFileErrors"));
      lines.push(...result.validationErrors.map((error) => `${error.fileName}: ${error.message}`));
    }

    return lines.join("\n");
  }

  // 为可复制节点生成统一命令参数，避免各处重复拼装。
  private createCopyCommand(label: string, value: string): vscode.Command {
    return {
      command: COPY_SIDEBAR_VALUE_COMMAND,
      title: t("command.copySidebarValue"),
      arguments: [label, value],
    };
  }
}

// 导出复制命令 id，供扩展入口统一注册。
export {
  COPY_SIDEBAR_VALUE_COMMAND,
  OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND,
};
