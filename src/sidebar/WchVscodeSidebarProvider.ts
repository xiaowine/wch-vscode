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
        this.createLeaf("Parallel Jobs", model.build.parallelizationNumber),
        this.createLeaf("Stop On First Error", String(model.build.stopOnFirstBuildError)),
        this.createLeaf("Pre Script", model.build.preScript),
        this.createLeaf("Post Script", model.build.postScript),
        this.createLeaf("Toolchain", model.build.toolchainName),
        this.createLeaf("Prefix", model.build.commandPrefix),
        this.createLeaf(
          "Target",
          `${model.build.targetArchitecture} / ${model.build.targetAbi}`,
        ),
        this.createLeaf("Extensions", model.build.riscvExtensions.join(", ")),
        this.createListSection("Architecture Args", model.build.architectureArgs),
        this.createLeaf("Optimize", model.build.optimizationLevel),
        this.createListSection("Common Optimization Flags", model.build.commonOptimizationFlags),
        this.createListSection("Common Warning Flags", model.build.commonWarningFlags),
        this.createListSection("Common Debugging Flags", model.build.commonDebuggingFlags),
        this.createLeaf("Linker Script", model.build.linkerScript),
        this.createListSection("Include Paths", model.build.includePaths),
        this.createListSection("System Include Paths", model.build.includeSystemPaths),
        this.createListSection("Include Files", model.build.includeFiles),
        this.createListSection("Defined Symbols", model.build.definedSymbols),
        this.createListSection("Other Compiler Flags", model.build.otherCompilerFlags),
        this.createListSection("Libraries", model.build.libraries),
        this.createListSection("Library Paths", model.build.librarySearchPaths),
        this.createListSection("Source Excludes", model.build.sourceExcludes),
      ]),
      this.createSection("Resolved Toolchain", [
        this.createLeaf("Directory", model.resolvedToolchain.directoryName),
        this.createLeaf("Executable Prefix", model.resolvedToolchain.executablePrefix),
        this.createLeaf("gcc", model.resolvedToolchain.executables.gcc),
        this.createLeaf("g++", model.resolvedToolchain.executables.gpp),
        this.createLeaf("objcopy", model.resolvedToolchain.executables.objcopy),
        this.createLeaf("objdump", model.resolvedToolchain.executables.objdump),
        this.createLeaf("size", model.resolvedToolchain.executables.size),
      ]),
      this.createSection("Assembler", [
        this.createLeaf("Use Preprocessor", String(model.assembler.usePreprocessor)),
        this.createLeaf(
          "No System Includes",
          String(model.assembler.doNotSearchSystemDirectories),
        ),
        this.createLeaf("Preprocess Only", String(model.assembler.preprocessOnly)),
        this.createListSection("Include Paths", model.assembler.includePaths),
        this.createListSection("System Include Paths", model.assembler.includeSystemPaths),
        this.createListSection("Include Files", model.assembler.includeFiles),
        this.createListSection("Defined Symbols", model.assembler.definedSymbols),
        this.createListSection("Undefined Symbols", model.assembler.undefinedSymbols),
        this.createListSection("Assembler Flags", model.assembler.assemblerFlags),
        this.createLeaf(
          "Misc",
          `listing:${model.assembler.generateAssemblerListing} temps:${model.assembler.saveTemporaryFiles} verbose:${model.assembler.verbose}`,
        ),
        this.createListSection("Warning Flags", model.assembler.warningFlags),
        this.createListSection("Other Flags", model.assembler.otherAssemblerFlags),
        this.createListSection("Args", model.assembler.args),
      ]),
      this.createSection("C", [
        this.createLeaf("Standard", model.c.standard),
        this.createLeaf(
          "Preprocessor",
          `nostdinc:${model.c.doNotSearchSystemDirectories} preprocessOnly:${model.c.preprocessOnly}`,
        ),
        this.createListSection("Include Paths", model.c.includePaths),
        this.createListSection("System Include Paths", model.c.includeSystemPaths),
        this.createListSection("Include Files", model.c.includeFiles),
        this.createListSection("Defined Symbols", model.c.definedSymbols),
        this.createListSection("Undefined Symbols", model.c.undefinedSymbols),
        this.createListSection("Optimization Flags", model.c.optimizationFlags),
        this.createListSection("Warning Flags", model.c.warningFlags),
        this.createListSection("Debugging Flags", model.c.debuggingFlags),
        this.createLeaf(
          "Misc",
          `listing:${model.c.generateAssemblerListing} temps:${model.c.saveTemporaryFiles} verbose:${model.c.verbose}`,
        ),
        this.createListSection("Other Flags", model.c.otherCompilerFlags),
        this.createListSection("Args", model.c.args),
      ]),
      this.createSection("C++", [
        this.createLeaf("Standard", model.cpp.standard),
        this.createLeaf(
          "Preprocessor",
          `nostdinc:${model.cpp.doNotSearchSystemDirectories} nostdinc++:${model.cpp.doNotSearchSystemCppDirectories} preprocessOnly:${model.cpp.preprocessOnly}`,
        ),
        this.createListSection("Include Paths", model.cpp.includePaths),
        this.createListSection("System Include Paths", model.cpp.includeSystemPaths),
        this.createListSection("Include Files", model.cpp.includeFiles),
        this.createListSection("Defined Symbols", model.cpp.definedSymbols),
        this.createListSection("Undefined Symbols", model.cpp.undefinedSymbols),
        this.createListSection("Optimization Flags", model.cpp.optimizationFlags),
        this.createListSection("Warning Flags", model.cpp.warningFlags),
        this.createListSection("Debugging Flags", model.cpp.debuggingFlags),
        this.createLeaf(
          "Misc",
          `listing:${model.cpp.generateAssemblerListing} temps:${model.cpp.saveTemporaryFiles} verbose:${model.cpp.verbose}`,
        ),
        this.createListSection("Other Flags", model.cpp.otherCompilerFlags),
        this.createListSection("Args", model.cpp.args),
      ]),
      this.createSection("Linker", [
        this.createLeaf("Script", model.linker.linkerScript),
        this.createLeaf("Map", model.linker.generateMap),
        this.createLeaf(
          "Options",
          `nostart:${model.linker.doNotUseStandardStartFiles} nodefault:${model.linker.doNotUseDefaultLibraries} nostd:${model.linker.noStartupOrDefaultLibs}`,
        ),
        this.createLeaf(
          "Specs",
          `nano:${model.linker.useNewlibNano} nosys:${model.linker.doNotUseSyscalls} printfFloat:${model.linker.useFloatWithNanoPrintf} scanfFloat:${model.linker.useFloatWithNanoScanf}`,
        ),
        this.createLeaf(
          "Misc",
          `cref:${model.linker.crossReference} printMap:${model.linker.printLinkMap} verbose:${model.linker.verbose} picolibc:${model.linker.picolibc || "-"}`,
        ),
        this.createLeaf(
          "WCH Extras",
          `printfloat:${model.linker.useWchPrintffloat} printf:${model.linker.useWchPrintf} iqmath:${model.linker.useIqmath}`,
        ),
        this.createListSection("Libraries", model.linker.libraries),
        this.createListSection("Library Paths", model.linker.librarySearchPaths),
        this.createListSection("Linker Flags", model.linker.linkerFlags),
        this.createListSection("Other Flags", model.linker.otherLinkerFlags),
        this.createListSection("Other Objects", model.linker.otherObjects),
        this.createListSection("Args", model.linker.args),
      ]),
      this.createSection("Post Build", [
        this.createLeaf(
          "Flash",
          `enabled:${model.postBuild.createFlash} format:${model.postBuild.flashOutputFormat || "-"}`,
        ),
        this.createLeaf(
          "Flash Sections",
          `text:${model.postBuild.copyOnlySectionText} data:${model.postBuild.copyOnlySectionData}`,
        ),
        this.createListSection("Flash Only Sections", model.postBuild.copyOnlySections),
        this.createListSection("Flash Flags", model.postBuild.flashFlags),
        this.createListSection("Flash Args", model.postBuild.flashArgs),
        this.createLeaf("List", `enabled:${model.postBuild.createList}`),
        this.createListSection("List Flags", model.postBuild.listFlags),
        this.createListSection("List Args", model.postBuild.listArgs),
        this.createLeaf(
          "Size",
          `enabled:${model.postBuild.printSize} format:${model.postBuild.sizeFormat || "-"}`,
        ),
        this.createListSection("Size Flags", model.postBuild.sizeFlags),
        this.createListSection("Size Args", model.postBuild.sizeArgs),
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
