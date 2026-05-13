import * as vscode from "vscode";
import { t } from "../i18n";

const outputChannel = vscode.window.createOutputChannel(t("debug.outputChannel"));

export function logDebug(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function appendDebugAdapterOutput(output: string): void {
  outputChannel.append(output);
}

export function showDebugLog(preserveFocus = true): void {
  outputChannel.show(preserveFocus);
}

export function registerWchDebugLogTracker(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    outputChannel,
    vscode.debug.registerDebugAdapterTrackerFactory("wch-riscv", {
      createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        logDebug(`Debug session created: ${session.name}`);
        return {
          onWillStartSession(): void {
            logDebug(`Debug session starting: ${session.name}`);
          },
          onDidSendMessage(message: unknown): void {
            const event = asRecord(message);
            if (event?.type !== "event") {
              return;
            }

            if (event.event === "output") {
              const body = asRecord(event.body);
              const output = typeof body?.output === "string" ? body.output : "";
              if (output) {
                appendDebugAdapterOutput(output);
              }
              return;
            }

            if (event.event === "terminated") {
              logDebug(`Debug session terminated: ${session.name}`);
            }
          },
          onError(error: Error): void {
            logDebug(`Debug adapter error: ${error.message}`);
          },
          onExit(code: number | undefined, signal: string | undefined): void {
            logDebug(`Debug adapter exited: code=${code ?? "unknown"} signal=${signal ?? "unknown"}`);
          },
        };
      },
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
