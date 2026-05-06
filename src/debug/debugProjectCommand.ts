import * as vscode from "vscode";
import { buildCurrentProjectAndWait } from "../build/buildProjectTask";
import { resolveBuildProjectForExecution, resolveCurrentBuildTarget } from "../build/buildProjectResolver";
import { refreshWchProjectState } from "../projectDetection";
import { buildWchRiscvDebugLaunchConfig } from "./debugConfig";

export const DEBUG_PROJECT_COMMAND = "wchVscode.debugProject";

export function getCurrentDebugTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? "当前未找到可调试的 WCH 工程";
  }

  const { model } = resolution.target;
  return `Debug ${model.project.name || model.baseName}`;
}

export async function debugCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<boolean> {
  await refreshWchProjectState();
  const buildSucceeded = await buildCurrentProjectAndWait(editor, false);
  if (!buildSucceeded) {
    return false;
  }

  try {
    const project = await resolveBuildProjectForExecution(editor);
    const launchConfig = await buildWchRiscvDebugLaunchConfig(project);
    return await vscode.debug.startDebugging(project.workspaceFolder, launchConfig);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return false;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
