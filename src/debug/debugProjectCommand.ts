import * as vscode from "vscode";
import { buildCurrentProjectAndWait } from "../build/buildProjectTask";
import { resolveBuildProjectForExecution, resolveCurrentBuildTarget } from "../build/buildProjectResolver";
import { buildWchRiscvDebugLaunchConfig } from "./debugConfig";
import { logDebug, showDebugLog } from "./debugLog";

export const DEBUG_PROJECT_COMMAND = "wchVscode.debugProject";

export function getCurrentDebugTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? "当前未找到可调试的 WCH 工程";
  }

  const { model } = resolution.target;
  return `Debug ${model.identity.name || model.identity.baseName}`;
}

export async function debugCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<boolean> {
  showDebugLog(true);
  logDebug("Debug command requested");
  const buildSucceeded = await buildCurrentProjectAndWait(editor, false);
  if (!buildSucceeded) {
    logDebug("Debug command stopped because build failed");
    return false;
  }

  try {
    const project = await resolveBuildProjectForExecution(editor);
    logDebug(`Resolved debug project: ${project.model.identity.name || project.model.identity.baseName}`);
    logDebug(`ELF: ${project.elfPath}`);
    const launchConfig = await buildWchRiscvDebugLaunchConfig(project);
    logDebug(`Starting VS Code debug session: ${launchConfig.name}`);
    const started = await vscode.debug.startDebugging(project.workspaceFolder, launchConfig);
    logDebug(`VS Code debug session start result: ${started}`);
    return started;
  } catch (error) {
    const message = asErrorMessage(error);
    logDebug(`Debug command failed: ${message}`);
    void vscode.window.showErrorMessage(message);
    return false;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
