import * as vscode from "vscode";
import type { WchLinkedFolder, WchProjectModel } from "../models/WchProjectModel";
import type { ProjectDetectionResult } from "../projectDetection";
import type { ParsedWchProject } from "../projectState";
import { getWchProjectState } from "../projectState";

class FileTreeItem extends vscode.TreeItem {
  children?: FileTreeItem[];
  loadChildren?: () => Promise<FileTreeItem[]>;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode
      .TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState);
  }
}

// 项目文件树视图，专门按 linkedFolders 逻辑展示项目内容。
export class WchProjectFilesProvider
  implements vscode.TreeDataProvider<FileTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    FileTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  setResults(): void {
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
    if (element) {
      if (element.loadChildren) {
        return element.loadChildren();
      }

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
  ): FileTreeItem {
    const models = project?.models ?? [];
    const isUnsupported = Boolean(project?.unsupportedReason);
    const item = new FileTreeItem(
      result.folder.name,
      result.isTargetProject && !isUnsupported
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = isUnsupported
      ? "Unsupported project"
      : result.isTargetProject
      ? `${models.length} project`
      : "Not matched";
    item.tooltip = result.folder.uri.fsPath;
    item.iconPath = new vscode.ThemeIcon(
      isUnsupported ? "error" : result.isTargetProject ? "root-folder-opened" : "warning",
    );

    if (isUnsupported) {
      item.command = {
        command: "workbench.action.showCommands",
        title: "Unsupported Project",
      };
      item.tooltip = project?.unsupportedReason ?? result.folder.uri.fsPath;
    } else if (result.isTargetProject) {
      item.loadChildren = async () =>
        this.loadWorkspaceProjectItems(result.folder.uri.fsPath, models);
    }

    return item;
  }

  // 工作区未打开时给出统一提示，避免资源管理器视图看起来像加载失败。
  private createEmptyWorkspaceItem(): FileTreeItem {
    const item = new FileTreeItem("未打开工作区");
    item.description = "请先打开要检测的项目目录";
    item.iconPath = new vscode.ThemeIcon("folder-opened");
    return item;
  }

  // 同一工作区下可能有多个匹配项目，按项目名拆分顶层节点。
  private async loadWorkspaceProjectItems(
    folderPath: string,
    models: WchProjectModel[],
  ): Promise<FileTreeItem[]> {
    return models.map((model) => this.createProjectRootItem(folderPath, model));
  }

  // 单个项目的文件树顶层同时展示 linkedFolders 和本地目录。
  private createProjectRootItem(
    folderPath: string,
    model: WchProjectModel,
  ): FileTreeItem {
    const item = new FileTreeItem(
      model.project.name || model.baseName,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = model.chip.mcu || model.baseName;
    item.iconPath = new vscode.ThemeIcon("project");
    item.loadChildren = async () => this.loadProjectFileTree(folderPath, model);
    return item;
  }

  // 文件树顶层同时展示映射目录和本地目录。
  private async loadProjectFileTree(
    folderPath: string,
    model: WchProjectModel,
  ): Promise<FileTreeItem[]> {
    // 同名映射目录会覆盖本地目录展示，避免顶层出现两个同名节点。
    const linkedFolderNames = new Set(model.linkedFolders.map((item) => item.name));
    const localItems = await this.readDirectoryItems(
      vscode.Uri.file(folderPath),
      linkedFolderNames,
    );
    const linkedFolderItems = model.linkedFolders.map((item) =>
      this.createLinkedFolderItem(folderPath, item),
    );

    return [...linkedFolderItems, ...localItems].sort((left, right) =>
      this.compareTreeItems(left, right),
    );
  }

  // 读取实际目录内容，并转换成可展开的文件节点。
  private async readDirectoryItems(
    directoryUri: vscode.Uri,
    excludedNames?: Set<string>,
  ): Promise<FileTreeItem[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(directoryUri);
      return entries
        .filter(([name]) => !excludedNames?.has(name))
        .sort((left, right) => this.compareDirectoryEntries(left, right))
        .map(([name, fileType]) =>
          this.createFileSystemItem(vscode.Uri.joinPath(directoryUri, name), fileType),
        );
    } catch {
      const item = new FileTreeItem("读取目录失败");
      item.description = directoryUri.fsPath;
      item.iconPath = new vscode.ThemeIcon("warning");
      return [item];
    }
  }

  // linkedFolders 在树上显示逻辑目录名，背后读取真实共享目录。
  private createLinkedFolderItem(
    folderPath: string,
    linkedFolder: WchLinkedFolder,
  ): FileTreeItem {
    const item = new FileTreeItem(
      linkedFolder.name,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.tooltip = `${linkedFolder.name} -> ${linkedFolder.location}`;
    item.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(folderPath), linkedFolder.name);
    item.loadChildren = async () =>
      this.readDirectoryItems(this.resolveLinkedFolderUri(folderPath, linkedFolder));
    return item;
  }

  // 为真实文件系统对象创建节点，文件点击后直接打开。
  private createFileSystemItem(
    fileUri: vscode.Uri,
    fileType: vscode.FileType,
  ): FileTreeItem {
    const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
    const item = new FileTreeItem(
      this.getBaseName(fileUri),
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = fileUri;
    item.tooltip = fileUri.fsPath;
    item.iconPath = isDirectory
      ? new vscode.ThemeIcon("folder")
      : new vscode.ThemeIcon("file");

    if (isDirectory) {
      item.loadChildren = async () => this.readDirectoryItems(fileUri);
    } else {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [fileUri],
      };
    }

    return item;
  }

  // 将 linkedFolders 的相对 location 解析成实际文件系统目录。
  private resolveLinkedFolderUri(
    folderPath: string,
    linkedFolder: WchLinkedFolder,
  ): vscode.Uri {
    return vscode.Uri.file(
      vscode.Uri.joinPath(
        vscode.Uri.file(folderPath),
        linkedFolder.location,
      ).fsPath,
    );
  }

  private compareDirectoryEntries(
    left: [string, vscode.FileType],
    right: [string, vscode.FileType],
  ): number {
    const leftIsDirectory = (left[1] & vscode.FileType.Directory) !== 0;
    const rightIsDirectory = (right[1] & vscode.FileType.Directory) !== 0;

    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return left[0].localeCompare(right[0], "zh-Hans-CN");
  }

  // 让映射目录和本地目录按普通资源管理器的方式一起排序。
  private compareTreeItems(left: FileTreeItem, right: FileTreeItem): number {
    const leftIsDirectory = left.collapsibleState !== vscode.TreeItemCollapsibleState.None;
    const rightIsDirectory = right.collapsibleState !== vscode.TreeItemCollapsibleState.None;

    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return this.getItemLabel(left).localeCompare(this.getItemLabel(right), "zh-Hans-CN");
  }

  private getBaseName(fileUri: vscode.Uri): string {
    const parts = fileUri.path.split("/");
    return parts[parts.length - 1] || fileUri.fsPath;
  }

  // TreeItem 的 label 可能是字符串，也可能是对象，这里统一取成可排序文本。
  private getItemLabel(item: FileTreeItem): string {
    if (typeof item.label === "string") {
      return item.label;
    }

    return item.label?.label ?? "";
  }
}
