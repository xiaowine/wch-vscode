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
import { t } from "../i18n";

export const DOWNLOAD_PROJECT_COMMAND = "wchVscode.downloadProject";

export function getCurrentDownloadTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? t("error.noDownloadableWchProject");
  }

  const { model } = resolution.target;
  return t("tooltip.actionTarget", {
    action: t("action.download"),
    projectName: model.identity.name || model.identity.baseName,
  });
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

  return downloadResolvedProject(project, showSuccessMessage);
}

export async function downloadResolvedProject(
  project: ResolvedBuildProject,
  showSuccessMessage = true,
): Promise<boolean> {
  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  const openOcdPaths = resolveOpenOcdPaths(mounRiverStudioPath);
  if (!openOcdPaths) {
    void vscode.window.showErrorMessage(t("setting.mounRiverStudioPathRequired"));
    return false;
  }

  if (!await fileExists(openOcdPaths.executable)) {
    void vscode.window.showErrorMessage(t("error.mrsOpenOcdExecutableMissing", { filePath: openOcdPaths.executable }));
    return false;
  }

  if (!await fileExists(openOcdPaths.config)) {
    void vscode.window.showErrorMessage(t("error.mrsOpenOcdConfigMissing", { filePath: openOcdPaths.config }));
    return false;
  }

  const downloadTargetPath = resolveDownloadTargetPath(project);
  if (!await fileExists(downloadTargetPath)) {
    void vscode.window.showErrorMessage(t("error.downloadTargetMissing", { filePath: downloadTargetPath }));
    return false;
  }

  const task = createDownloadTask(project, openOcdPaths, downloadTargetPath);
  try {
    const exitCode = await executeTaskAndWait(task);
    if (exitCode === 0) {
      if (showSuccessMessage) {
        void vscode.window.showInformationMessage(t("message.downloadSucceeded"));
      }
      return true;
    }

    void vscode.window.showErrorMessage(formatOpenOcdFailureMessage(
      t("error.operationDownloadFailed"),
      t("error.openOcdExitCode", { exitCode: exitCode ?? t("value.unknown") }),
    ));
  } catch (error) {
    void vscode.window.showErrorMessage(formatOpenOcdFailureMessage(t("error.operationDownloadFailed"), asErrorMessage(error)));
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
      projectName: project.model.identity.name || project.model.identity.baseName,
    },
    project.workspaceFolder,
    t("tooltip.actionTarget", {
      action: t("action.download"),
      projectName: project.model.identity.name || project.model.identity.baseName,
    }),
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
  const address = normalizeFlashAddress(project.model.flash.address);
  if (address) {
    args.push(address);
  }
  args.push("verify", "reset", "exit");
  return args.join(" ");
}

export function toOpenOcdPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function normalizeFlashAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) {
    return "";
  }

  return /^0x08000000$/i.test(trimmed) ? "0x00000000" : trimmed;
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

function formatOpenOcdFailureMessage(operation: string, detail: string): string {
  return t("error.openOcdFailure", { operation, detail });
}
