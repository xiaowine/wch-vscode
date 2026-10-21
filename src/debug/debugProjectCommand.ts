import * as vscode from "vscode";
import { buildCurrentProjectAndWait } from "../build/buildProjectTask";
import {
  resolveBuildProjectForExecution,
  resolveCurrentBuildTarget,
} from "../build/buildProjectResolver";
import { t } from "../i18n";
import { buildWchRiscvDebugLaunchConfig } from "./debugConfig";
import { logDebug, showDebugLog } from "./debugLog";
import { getResetMode, powerOffProject } from "../build/powerOffReset";

export const DEBUG_PROJECT_COMMAND = "wchVscode.debugProject";

export function getCurrentDebugTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? t("error.noDebuggableWchProject");
  }

  const { model } = resolution.target;
  return t("tooltip.actionTarget", {
    action: t("action.debug"),
    projectName: model.identity.name || model.identity.baseName,
  });
}

export async function debugCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<boolean> {
  showDebugLog(true);
  logDebug(t("debugLog.commandRequested"));
  const buildSucceeded = await buildCurrentProjectAndWait(editor, false);
  if (!buildSucceeded) {
    logDebug(t("debugLog.stoppedBecauseBuildFailed"));
    return false;
  }

  try {
    const project = await resolveBuildProjectForExecution(editor);
    logDebug(t("debugLog.resolvedProject", { projectName: project.model.identity.name || project.model.identity.baseName }));
    logDebug(`ELF: ${project.elfPath}`);

    if (getResetMode() === "powerOff") {
      // 只关闭电源；调试 OpenOCD 启动时会先上电再 init/halt，中间没有运行窗口。
      await powerOffProject(project, { log: logDebug });
    }

    const launchConfig = await buildWchRiscvDebugLaunchConfig(project);
    logDebug(t("debugLog.startingSession", { name: launchConfig.name }));
    const started = await vscode.debug.startDebugging(project.workspaceFolder, launchConfig);
    logDebug(t("debugLog.sessionStartResult", { started }));
    return started;
  } catch (error) {
    const message = asErrorMessage(error);
    logDebug(t("debugLog.commandFailed", { message }));
    void vscode.window.showErrorMessage(message);
    return false;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
