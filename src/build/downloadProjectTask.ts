import * as path from "node:path";
import * as vscode from "vscode";
import { getConfiguredMounRiverStudioPath, resolveOpenOcdPaths } from "./buildShared";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
  resolveBuildProjectForExecution,
  resolveCurrentBuildTarget,
  resolveProjectFileSystemPath,
} from "./buildProjectResolver";
import { executeTaskAndWait } from "./taskExecution";

export const DOWNLOAD_PROJECT_COMMAND = "wchVscode.downloadProject";

export function getCurrentDownloadTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? "当前未找到可下载的 WCH 工程";
  }

  const { model } = resolution.target;
  return `Download ${model.project.name || model.baseName}`;
}

export async function downloadCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
  showSuccessMessage = true,
): Promise<boolean> {
  let project: ResolvedBuildProject;
  try {
    project = await resolveBuildProjectForExecution(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return false;
  }

  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  const openOcdPaths = resolveOpenOcdPaths(mounRiverStudioPath);
  if (!openOcdPaths) {
    void vscode.window.showErrorMessage("请先配置 wchVscode.mounRiverStudioPath");
    return false;
  }

  if (!await fileExists(openOcdPaths.executable)) {
    void vscode.window.showErrorMessage(`MRS 安装路径无效，未找到 openocd.exe：${openOcdPaths.executable}`);
    return false;
  }

  if (!await fileExists(openOcdPaths.config)) {
    void vscode.window.showErrorMessage(`MRS 安装路径无效，未找到 OpenOCD 配置：${openOcdPaths.config}`);
    return false;
  }

  const downloadTargetPath = resolveDownloadTargetPath(project);
  if (!await fileExists(downloadTargetPath)) {
    void vscode.window.showErrorMessage(`未找到可下载文件，请先构建工程：${downloadTargetPath}`);
    return false;
  }

  const task = createDownloadTask(project, openOcdPaths, downloadTargetPath);
  try {
    const exitCode = await executeTaskAndWait(task);
    if (exitCode === 0) {
      if (showSuccessMessage) {
        void vscode.window.showInformationMessage("WCH: 下载成功");
      }
      return true;
    }

    void vscode.window.showErrorMessage(`下载失败，OpenOCD 退出码：${exitCode ?? "未知"}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`下载失败：${asErrorMessage(error)}`);
  }
  return false;
}

function createDownloadTask(
  project: ResolvedBuildProject,
  openOcdPaths: { executable: string; config: string },
  downloadTargetPath: string,
): vscode.Task {
  const execution = new vscode.ProcessExecution(
    openOcdPaths.executable,
    [
      "-f",
      openOcdPaths.config,
      "-c",
      buildOpenOcdProgramCommand(project, downloadTargetPath),
    ],
    {
      cwd: path.dirname(openOcdPaths.executable),
    },
  );
  const task = new vscode.Task(
    {
      type: "wchDownload",
      workspaceFolder: project.workspaceFolder.name,
      projectName: project.model.project.name || project.model.baseName,
    },
    project.workspaceFolder,
    `Download ${project.model.project.name || project.model.baseName}`,
    "wch-vscode",
    execution,
    [],
  );
  task.group = vscode.TaskGroup.Build;
  task.presentationOptions = {
    clear: true,
    panel: vscode.TaskPanelKind.Dedicated,
    reveal: vscode.TaskRevealKind.Always,
  };
  return task;
}

function resolveDownloadTargetPath(project: ResolvedBuildProject): string {
  const targetPath = project.model.flash.targetPath.trim();
  return targetPath ? resolveProjectFileSystemPath(project.model, targetPath) : project.elfPath;
}

function buildOpenOcdProgramCommand(
  project: ResolvedBuildProject,
  downloadTargetPath: string,
): string {
  const args = [`program "${toOpenOcdPath(downloadTargetPath)}"`];
  const address = project.model.flash.address.trim();
  if (address) {
    args.push(address);
  }
  args.push("verify", "reset", "exit");
  return args.join(" ");
}

export function toOpenOcdPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
