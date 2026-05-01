import * as vscode from "vscode";
import { GENERATE_CPPTOOLS_CONFIG_COMMAND } from "../cpptoolsConfigGenerator";
import type { WchProjectModel } from "../models/WchProjectModel";
import type { ProjectDetectionResult } from "../projectDetection";
import type { ParsedWchProject } from "../projectState";
import { getWchProjectState } from "../projectState";

const COPY_SIDEBAR_VALUE_COMMAND = "wchVscode.copySidebarValue";

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
    const item = new SidebarItem(result.folder.name);
    item.description = isUnsupported
      ? "Unsupported project"
      : result.isTargetProject
      ? "Matched project"
      : "Not matched";
    item.tooltip = this.buildTooltip(result);
    item.iconPath = new vscode.ThemeIcon(
      isUnsupported ? "error" : result.isTargetProject ? "pass-filled" : "warning",
    );
    item.contextValue = isUnsupported
      ? "unsupportedProject"
      : result.isTargetProject
      ? "matchedProject"
      : "unmatchedProject";
    item.collapsibleState = result.isTargetProject
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    item.children = result.isTargetProject
      ? isUnsupported
        ? [this.createUnsupportedItem(project?.unsupportedReason ?? "当前工程暂不支持")]
        : [
          this.createGenerateCppToolsItem(result.folder, models),
          ...models.flatMap((model) => this.buildProjectModelItems(model)),
        ]
      : [];

    return item;
  }

  // 工作区未打开时给出统一提示，避免顶层出现空白视图。
  private createEmptyWorkspaceItem(): SidebarItem {
    const item = new SidebarItem("未打开工作区");
    item.description = "请先打开要检测的项目目录";
    item.iconPath = new vscode.ThemeIcon("folder-opened");
    return item;
  }

  // 在工作区层级提供 cpptools 配置生成入口，避免多项目时重复生成。
  private createGenerateCppToolsItem(
    folder: vscode.WorkspaceFolder,
    models: WchProjectModel[],
  ): SidebarItem {
    const item = new SidebarItem("Generate C/C++ Config");
    item.description = ".vscode/c_cpp_properties.json";
    item.tooltip = "根据当前项目模型生成 cpptools 配置";
    item.iconPath = new vscode.ThemeIcon("gear");
    item.command = {
      command: GENERATE_CPPTOOLS_CONFIG_COMMAND,
      title: "Generate C/C++ Config",
      arguments: [folder, models],
    };
    return item;
  }

  // 当前只支持 RISC-V 工程，不支持的工程直接给出提示，不继续加载业务数据。
  private createUnsupportedItem(message: string): SidebarItem {
    const item = new SidebarItem("当前工程不支持");
    item.description = message;
    item.tooltip = message;
    item.iconPath = new vscode.ThemeIcon("error");
    return item;
  }

  // 将精简后的项目模型转换成侧栏树节点。
  private buildProjectModelItems(model: WchProjectModel): SidebarItem[] {
    const root = new SidebarItem(
      model.project.name || model.baseName,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    root.description = model.chip.mcu || model.project.architecture;
    root.iconPath = new vscode.ThemeIcon("project");
    root.children = [
      this.createSection("Project", [
        this.createLeaf("Type", model.project.projectType),
        this.createLeaf("Architecture", model.project.architecture),
        this.createLeaf(
          "Artifact",
          model.project.artifact.outputFile || this.buildArtifactName(model),
        ),
        this.createListSection(
          "Linked Folders",
          model.linkedFolders.map(
            (item) => `${item.name} -> ${item.location}`,
          ),
        ),
      ]),
      this.createSection("Chip", [
        this.createLeaf("Vendor", model.chip.vendor),
        this.createLeaf("Series", model.chip.series),
        this.createLeaf("MCU", model.chip.mcu),
        this.createLeaf("RTOS", model.chip.rtos),
        this.createLeaf("Toolchain", model.chip.toolchain),
        this.createLeaf("Link", model.chip.debugLink),
        this.createLeaf("SVD", model.chip.svdPath),
      ]),
      this.createSection("Build", [
        this.createLeaf("Config", model.build.configName),
        this.createLeaf("Toolchain", model.build.toolchainName),
        this.createLeaf("Prefix", model.build.commandPrefix),
        this.createLeaf(
          "Target",
          `${model.build.targetArchitecture} / ${model.build.targetAbi}`,
        ),
        this.createLeaf("Extensions", model.build.riscvExtensions.join(", ")),
        this.createLeaf("Optimize", model.build.optimizationLevel),
        this.createLeaf("Linker Script", model.build.linkerScript),
        this.createListSection("Include Paths", model.build.includePaths),
        this.createListSection("Defined Symbols", model.build.definedSymbols),
        this.createListSection("Libraries", model.build.libraries),
        this.createListSection("Library Paths", model.build.librarySearchPaths),
        this.createListSection("Source Excludes", model.build.sourceExcludes),
      ]),
      this.createSection("Debug", [
        this.createLeaf("Program", model.debug.programName),
        this.createLeaf("GDB", model.debug.gdbExecutable),
        this.createLeaf("OpenOCD", model.debug.openOcdExecutable),
        this.createLeaf("Host", model.debug.host),
        this.createLeaf(
          "Ports",
          `gdb:${model.debug.gdbPort} telnet:${model.debug.telnetPort} tcl:${model.debug.tclPort}`,
        ),
        this.createLeaf("Stop At", model.debug.stopAt),
        this.createLeaf(
          "Reset",
          `${model.debug.firstResetType} -> ${model.debug.secondResetType}`,
        ),
        this.createListSection(
          "OpenOCD Options",
          model.debug.openOcdConfigOptions,
        ),
        this.createListSection("Startup Commands", model.debug.startupCommands),
      ]),
      this.createSection("Flash", [
        this.createLeaf("Target", model.flash.targetPath),
        this.createLeaf("Address", model.flash.address),
        this.createLeaf(
          "Action",
          `erase:${model.flash.erase} program:${model.flash.program} verify:${model.flash.verify} reset:${model.flash.reset}`,
        ),
      ]),
    ];

    return [root];
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
    if (!model.project.artifact.name) {
      return "";
    }

    return model.project.artifact.extension
      ? `${model.project.artifact.name}.${model.project.artifact.extension}`
      : model.project.artifact.name;
  }

  // 侧栏悬停信息展示检测明细，便于定位规则是否命中。
  private buildTooltip(result: ProjectDetectionResult): string {
    const lines = [
      `Folder: ${result.folder.uri.fsPath}`,
      `.cproject files: ${result.cprojectCount}`,
      `.launch files: ${result.launchCount}`,
      `.wvproj files: ${result.wvprojCount}`,
    ];

    if (result.matchingBaseNames.length > 0) {
      lines.push(`Matched base names: ${result.matchingBaseNames.join(", ")}`);
    } else {
      lines.push("Matched base names: none");
    }

    return lines.join("\n");
  }

  // 为可复制节点生成统一命令参数，避免各处重复拼装。
  private createCopyCommand(label: string, value: string): vscode.Command {
    return {
      command: COPY_SIDEBAR_VALUE_COMMAND,
      title: "Copy Sidebar Value",
      arguments: [label, value],
    };
  }
}

// 导出复制命令 id，供扩展入口统一注册。
export { COPY_SIDEBAR_VALUE_COMMAND };
