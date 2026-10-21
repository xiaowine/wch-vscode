import * as vscode from "vscode";
import { resolveBuildProjectForExecution } from "./buildProjectResolver";
import { powerCycleProject } from "./powerOffReset";
import {
  createOpenOcdTerminalWriter,
  type OpenOcdTerminalWriter,
} from "./openOcdOutput";
import { t } from "../i18n";

export const POWER_OFF_RESET_COMMAND = "wchVscode.powerOffReset";

export async function powerOffResetCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<boolean> {
  let output: OpenOcdTerminalWriter | undefined;
  try {
    const project = await resolveBuildProjectForExecution(editor);
    output = createOpenOcdTerminalWriter();
    await powerCycleProject(project, {
      log: (message) => output?.writeLine(message),
    });
    output.writeLine(t("message.powerOffResetSucceeded"));
    void vscode.window.showInformationMessage(
      t("message.powerOffResetSucceeded"),
    );
    return true;
  } catch (error) {
    const message = t("error.powerResetFailed", {
      message: asErrorMessage(error),
    });
    output?.writeLine(message);
    void vscode.window.showErrorMessage(message);
    return false;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
