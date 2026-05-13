import * as vscode from "vscode";
import {
  buildCurrentProjectAndWait,
  buildResolvedProjectAndWait,
} from "./buildProjectTask";
import type {
  BuildProjectSelector,
  ResolvedBuildProject,
} from "./buildProjectResolver";
import { resolveBuildProjectForExecutionBySelector } from "./buildProjectResolver";
import {
  downloadCurrentProject,
  downloadResolvedProject,
  getCurrentDownloadTargetTooltip,
} from "./downloadProjectTask";
import { t } from "../i18n";

export const BUILD_DOWNLOAD_PROJECT_COMMAND = "wchVscode.buildDownloadProject";

export type BuildDownloadCommandOptions = BuildProjectSelector & {
  showSuccessMessage?: boolean;
};

export function getCurrentBuildDownloadTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const downloadTooltip = getCurrentDownloadTargetTooltip(editor);
  const downloadPrefix = `${t("action.download")} `;
  return downloadTooltip.startsWith(downloadPrefix)
    ? downloadTooltip.replace(new RegExp(`^${escapeRegExp(downloadPrefix)}`), `${t("action.buildDownload")} `)
    : downloadTooltip;
}

export async function buildDownloadCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<boolean> {
  let buildSucceeded = false;
  try {
    buildSucceeded = await buildCurrentProjectAndWait(editor, false);
  } catch (error) {
    void vscode.window.showErrorMessage(t("error.buildFailed", { message: asErrorMessage(error) }));
    return false;
  }

  if (!buildSucceeded) {
    return false;
  }

  return downloadCurrentProject(editor, false);
}

export async function buildDownloadProject(
  input?: unknown,
): Promise<boolean> {
  const options = normalizeBuildDownloadOptions(input);
  if (!options || Object.keys(options).length === 0) {
    return buildDownloadCurrentProject();
  }

  let project: ResolvedBuildProject;
  try {
    project = await resolveBuildProjectForExecutionBySelector(options);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return false;
  }

  const buildSucceeded = await buildResolvedProjectAndWait(project, false);
  if (!buildSucceeded) {
    return false;
  }

  const showSuccessMessage = options.showSuccessMessage ?? false;
  return downloadResolvedProject(project, showSuccessMessage);
}

function normalizeBuildDownloadOptions(
  input: unknown,
): BuildDownloadCommandOptions | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (typeof input === "string") {
    return input.toLowerCase().endsWith(".wvproj")
      ? { wvprojPath: input }
      : { folderPath: input };
  }

  if (input instanceof vscode.Uri) {
    return normalizeBuildDownloadOptions(input.fsPath);
  }

  if (typeof input === "object") {
    return input as BuildDownloadCommandOptions;
  }

  return undefined;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
