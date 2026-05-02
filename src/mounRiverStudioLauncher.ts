import * as vscode from "vscode";
import {
  getConfiguredMounRiverStudioPath,
  resolveMounRiverStudioExecutable,
} from "./build/buildShared";

export const OPEN_IN_MOUN_RIVER_STUDIO_COMMAND = "wchVscode.openInMounRiverStudio";

const outputChannel = vscode.window.createOutputChannel("wch-vscode MRS2");
let hiddenMrsTerminal: vscode.Terminal | undefined;

vscode.window.onDidCloseTerminal((terminal) => {
  if (terminal === hiddenMrsTerminal) {
    hiddenMrsTerminal = undefined;
  }
});

export async function openProjectInMounRiverStudio(wvprojPath: string): Promise<void> {
  outputChannel.appendLine(`[${new Date().toISOString()}] Open in MRS2 requested`);
  outputChannel.appendLine(`wvprojPath: ${wvprojPath}`);

  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  outputChannel.appendLine(`mounRiverStudioPath: ${mounRiverStudioPath || "<empty>"}`);

  const executablePath = resolveMounRiverStudioExecutable(mounRiverStudioPath);
  outputChannel.appendLine(`executablePath: ${executablePath ?? "<unresolved>"}`);

  if (!executablePath) {
    outputChannel.show(true);
    void vscode.window.showErrorMessage("请先配置 wchVscode.mounRiverStudioPath");
    return;
  }

  if (!await fileExists(executablePath)) {
    outputChannel.appendLine("executable exists: false");
    outputChannel.show(true);
    void vscode.window.showErrorMessage(`MRS2 安装路径无效，未找到主程序：${executablePath}`);
    return;
  }
  outputChannel.appendLine("executable exists: true");

  if (!await fileExists(wvprojPath)) {
    outputChannel.appendLine("wvproj exists: false");
    outputChannel.show(true);
    void vscode.window.showErrorMessage(`未找到 .wvproj 文件：${wvprojPath}`);
    return;
  }
  outputChannel.appendLine("wvproj exists: true");

  try {
    const projectUri = vscode.Uri.file(wvprojPath);
    outputChannel.appendLine(`openExternal target: ${projectUri.toString(true)}`);
    const opened = await vscode.env.openExternal(projectUri);
    outputChannel.appendLine(`openExternal result: ${opened}`);
    if (opened) {
      void vscode.window.showInformationMessage("已在 MRS2 打开项目");
      return;
    }

    const command = `${quoteCmdArgument(executablePath)} ${quoteCmdArgument(wvprojPath)}`;
    outputChannel.appendLine(`hidden terminal command: ${command}`);
    const terminal = getOrCreateHiddenTerminal(mounRiverStudioPath);
    terminal.sendText(command);
    void vscode.window.showInformationMessage("已在 MRS2 打开项目");
  } catch (error) {
    outputChannel.appendLine(`terminal launch threw: ${asErrorMessage(error)}`);
    outputChannel.show(true);
    void vscode.window.showErrorMessage(`打开 MRS2 失败：${asErrorMessage(error)}`);
  }
}

function getOrCreateHiddenTerminal(cwd: string): vscode.Terminal {
  if (hiddenMrsTerminal) {
    return hiddenMrsTerminal;
  }

  hiddenMrsTerminal = vscode.window.createTerminal({
    name: "Open MRS2",
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
