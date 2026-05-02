import * as vscode from "vscode";
import { buildCurrentProjectAndWait } from "./buildProjectTask";
import { downloadCurrentProject, getCurrentDownloadTargetTooltip } from "./downloadProjectTask";

export const BUILD_DOWNLOAD_PROJECT_COMMAND = "wchVscode.buildDownloadProject";

export function getCurrentBuildDownloadTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const downloadTooltip = getCurrentDownloadTargetTooltip(editor);
  return downloadTooltip.startsWith("Download ")
    ? downloadTooltip.replace(/^Download /, "Build Download ")
    : downloadTooltip;
}

export async function buildDownloadCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  let buildSucceeded = false;
  try {
    buildSucceeded = await buildCurrentProjectAndWait(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(`编译失败：${asErrorMessage(error)}`);
    return;
  }

  if (!buildSucceeded) {
    return;
  }

  await downloadCurrentProject(editor);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
