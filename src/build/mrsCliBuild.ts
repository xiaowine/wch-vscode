import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as vscode from "vscode";
import {
    createMounRiverStudioEnvironment,
    getConfiguredMounRiverStudioPath,
    resolveMounRiverStudioExecutable,
} from "./buildShared";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
    parseMounRiverSilentOutput,
    type MounRiverSilentAction,
} from "./mrsCliOutput";
import { t } from "../i18n";

// mrs-cli 模式由 MRS 自行解析工程参数并构建，与在 MRS 内编译一致。
// MRS 退出码恒为 0，因此只能解析日志中的成败标记。
export type MounRiverSilentOutcomeReason =
    | "succeeded"
    | "failed"
    | "no-result"
    | "canceled"
    | "busy"
    | "spawn-failed"
    | "configuration";

export type MounRiverSilentOutcome = {
    succeeded: boolean;
    reason: MounRiverSilentOutcomeReason;
    output: string;
    errorMessage?: string;
};

const MAX_CAPTURED_OUTPUT_LENGTH = 2_000_000;

let running = false;
let outputChannel: vscode.OutputChannel | undefined;

export async function runMounRiverSilentBuild(
    project: ResolvedBuildProject,
    action: MounRiverSilentAction,
): Promise<MounRiverSilentOutcome> {
    if (running) {
        void vscode.window.showWarningMessage(t("warning.buildAlreadyRunning"));
        return { succeeded: false, reason: "busy", output: "" };
    }

    const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
    const executablePath = resolveMounRiverStudioExecutable(mounRiverStudioPath);
    if (!executablePath) {
        const message = t("setting.mounRiverStudioPathRequired");
        void vscode.window.showErrorMessage(message);
        return { succeeded: false, reason: "configuration", output: "", errorMessage: message };
    }
    if (!existsSync(executablePath)) {
        const message = t("error.mrs2ExecutableMissing", { filePath: executablePath });
        void vscode.window.showErrorMessage(message);
        return { succeeded: false, reason: "configuration", output: "", errorMessage: message };
    }

    const wvprojPath = project.model.identity.files.wvproj;
    if (!wvprojPath || !existsSync(wvprojPath)) {
        const message = t("error.wvprojMissing", { filePath: wvprojPath || "<empty>" });
        void vscode.window.showErrorMessage(message);
        return { succeeded: false, reason: "configuration", output: "", errorMessage: message };
    }

    const projectName = project.model.identity.name || project.model.identity.baseName;
    const title = action === "clean"
        ? t("progress.mrsCliClean", { projectName })
        : action === "rebuild"
        ? t("progress.mrsCliRebuild", { projectName })
        : t("progress.mrsCliBuild", { projectName });

    running = true;
    try {
        const outcome = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => executeSilentCommand(
                executablePath,
                wvprojPath,
                project.model.identity.folderPath,
                action,
                token,
            ),
        );
        reportOutcome(outcome);
        return outcome;
    } finally {
        running = false;
    }
}

function executeSilentCommand(
    executablePath: string,
    wvprojPath: string,
    cwd: string,
    action: MounRiverSilentAction,
    token: vscode.CancellationToken,
): Promise<MounRiverSilentOutcome> {
    const { promise, resolve } = Promise.withResolvers<MounRiverSilentOutcome>();
    const channel = getBuildOutputChannel();
    const args = [`--mrsSilentType=${action}`, `-m=${wvprojPath}`];
    channel.appendLine(`> "${executablePath}" ${args.join(" ")}`);

    let output = "";
    let settled = false;
    let canceled = false;
    const finish = (outcome: MounRiverSilentOutcome): void => {
        if (settled) {
            return;
        }
        settled = true;
        if (!outcome.succeeded) {
            channel.show(true);
        }
        resolve(outcome);
    };

    let child: ChildProcess;
    try {
        child = spawn(executablePath, args, {
            cwd,
            env: createMounRiverStudioEnvironment(),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        const message = asErrorMessage(error);
        channel.appendLine(message);
        finish({ succeeded: false, reason: "spawn-failed", output: "", errorMessage: message });
        return promise;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        output = appendCapturedOutput(output, chunk);
        channel.append(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
        channel.append(chunk);
    });

    child.on("error", (error) => {
        const message = asErrorMessage(error);
        channel.appendLine(message);
        finish({ succeeded: false, reason: "spawn-failed", output, errorMessage: message });
    });
    child.on("close", () => {
        if (canceled) {
            finish({ succeeded: false, reason: "canceled", output });
            return;
        }

        const parsed = parseMounRiverSilentOutput(output, action);
        if (parsed === "succeeded") {
            finish({ succeeded: true, reason: "succeeded", output });
            return;
        }
        if (parsed === "failed") {
            finish({ succeeded: false, reason: "failed", output });
            return;
        }
        finish({ succeeded: false, reason: "no-result", output });
    });

    token.onCancellationRequested(() => {
        canceled = true;
        killProcessTree(child);
    });

    return promise;
}

function reportOutcome(outcome: MounRiverSilentOutcome): void {
    if (outcome.reason === "no-result") {
        void vscode.window.showErrorMessage(t("error.mrsCliNoResult"));
        return;
    }
    if (outcome.reason === "spawn-failed") {
        void vscode.window.showErrorMessage(
            t("error.mrsCliSpawnFailed", { message: outcome.errorMessage ?? t("value.unknown") }),
        );
        return;
    }
    if (outcome.reason === "canceled") {
        void vscode.window.showInformationMessage(t("message.buildCanceled"));
    }
}

function getBuildOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel(t("build.outputChannel"));
    }
    return outputChannel;
}

function appendCapturedOutput(current: string, chunk: string): string {
    const next = current + chunk;
    return next.length > MAX_CAPTURED_OUTPUT_LENGTH
        ? next.slice(-MAX_CAPTURED_OUTPUT_LENGTH)
        : next;
}

function killProcessTree(child: ChildProcess): void {
    if (!child.pid) {
        return;
    }
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        return;
    }
    child.kill();
}

function asErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
