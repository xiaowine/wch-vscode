import * as vscode from "vscode";
import {
  getConfiguredMounRiverStudioPath,
  resolveMounRiverStudioExecutable,
} from "./build/buildShared";
import { t } from "./i18n";

export const OPEN_IN_MOUN_RIVER_STUDIO_COMMAND = "wchVscode.openInMounRiverStudio";

const outputChannel = vscode.window.createOutputChannel(t("mrs2.outputChannel"));
let hiddenMrsTerminal: vscode.Terminal | undefined;

vscode.window.onDidCloseTerminal((terminal) => {
  if (terminal === hiddenMrsTerminal) {
    hiddenMrsTerminal = undefined;
  }
});

export async function openProjectInMounRiverStudio(wvprojPath: string): Promise<void> {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${t("mrs2.openRequested")}`);
  outputChannel.appendLine(`wvprojPath: ${wvprojPath}`);

  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  outputChannel.appendLine(`mounRiverStudioPath: ${mounRiverStudioPath || "<empty>"}`);

  const executablePath = resolveMounRiverStudioExecutable(mounRiverStudioPath);
  outputChannel.appendLine(`executablePath: ${executablePath ?? "<unresolved>"}`);

  if (!executablePath) {
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("setting.mounRiverStudioPathRequired"));
    return;
  }

  if (!await fileExists(executablePath)) {
    outputChannel.appendLine("executable exists: false");
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("error.mrs2ExecutableMissing", { filePath: executablePath }));
    return;
  }
  outputChannel.appendLine("executable exists: true");

  if (!await fileExists(wvprojPath)) {
    outputChannel.appendLine("wvproj exists: false");
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("error.wvprojMissing", { filePath: wvprojPath }));
    return;
  }
  outputChannel.appendLine("wvproj exists: true");

  try {
    const projectUri = vscode.Uri.file(wvprojPath);
    outputChannel.appendLine(`openExternal target: ${projectUri.toString(true)}`);
    const opened = await vscode.env.openExternal(projectUri);
    outputChannel.appendLine(`openExternal result: ${opened}`);
    if (opened) {
      void vscode.window.showInformationMessage(t("message.mrs2ProjectOpened"));
      return;
    }

    const command = `${quoteCmdArgument(executablePath)} ${quoteCmdArgument(wvprojPath)}`;
    outputChannel.appendLine(`hidden terminal command: ${command}`);
    const terminal = getOrCreateHiddenTerminal(mounRiverStudioPath);
    terminal.sendText(command);
    void vscode.window.showInformationMessage(t("message.mrs2ProjectOpened"));
  } catch (error) {
    outputChannel.appendLine(`terminal launch threw: ${asErrorMessage(error)}`);
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("error.mrs2OpenFailed", { message: asErrorMessage(error) }));
  }
}

function getOrCreateHiddenTerminal(cwd: string): vscode.Terminal {
  if (hiddenMrsTerminal) {
    return hiddenMrsTerminal;
  }

  hiddenMrsTerminal = vscode.window.createTerminal({
    name: t("mrs2.terminalName"),
    shellPath: "cmd.exe",
    shellArgs: ["/Q"],
    cwd,
    hideFromUser: true,
    isTransient: true,
  });
  return hiddenMrsTerminal;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
