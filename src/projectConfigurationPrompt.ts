import * as vscode from "vscode";
import { t } from "./i18n";
import { openProjectInMounRiverStudio } from "./mounRiverStudioLauncher";

export async function showProjectConfigurationRequiredMessage(
  message: string,
  wvprojPath: string,
): Promise<void> {
  const openAction = t("command.openInMrs2");
  const selected = await vscode.window.showWarningMessage(message, openAction);
  if (selected === openAction) {
    await openProjectInMounRiverStudio(wvprojPath);
  }
}

