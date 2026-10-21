import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
    createMounRiverStudioEnvironment,
    getConfiguredMounRiverStudioPath,
    resolveMounRiverStudioExecutable,
} from "./buildShared";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
    MounRiverLineColorizer,
    MounRiverOutputFilter,
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
let buildTerminal: vscode.Terminal | undefined;

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
                title,
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
    title: string,
    token: vscode.CancellationToken,
): Promise<MounRiverSilentOutcome> {
    const { promise, resolve } = Promise.withResolvers<MounRiverSilentOutcome>();
    const write = createBuildTerminalWriter();
    const logFilter = new MounRiverOutputFilter();
    const colorizer = new MounRiverLineColorizer();
    const writeLog = (text: string): void => write(colorizer.push(text));
    // MRS 3 的安装目录带 data 时会自动使用 portable 模式，--user-data-dir 会被忽略。
    // 通过 VSCODE_PORTABLE 指定独立数据目录，避免复用用户已打开的 MRS 实例。
    const portableDataPath = getMounRiverSilentProfileDirectory();
    const args = [
        `--mrsSilentType=${action}`,
        `-m=${wvprojPath}`,
    ];
    // 每次构建使用新终端，旧日志自然清空。
    writeLog(`[${new Date().toLocaleString()}] ${title}\n`);
    writeLog(`> "${executablePath}" ${args.join(" ")}\n`);

    let output = "";
    let settled = false;
    let canceled = false;
    const finish = (outcome: MounRiverSilentOutcome): void => {
        if (settled) {
            return;
        }
        settled = true;
        writeLog(logFilter.flush());
        writeLog(
            `[${new Date().toLocaleTimeString()}] ${
                outcome.succeeded
                    ? t("build.outputSucceeded")
                    : outcome.reason === "canceled"
                    ? t("build.outputCanceled")
                    : outcome.reason === "no-result"
                    ? t("build.outputNoResult")
                    : t("build.outputFailed")
            }\n`,
        );
        resolve(outcome);
    };

    let child: ChildProcess;
    try {
        mkdirSync(portableDataPath, { recursive: true });
        child = spawn(executablePath, args, {
            cwd,
            env: createMounRiverStudioEnvironment(portableDataPath),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        const message = asErrorMessage(error);
        writeLog(`${message}\n`);
        finish({ succeeded: false, reason: "spawn-failed", output: "", errorMessage: message });
        return promise;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        output = appendCapturedOutput(output, chunk);
        writeLog(logFilter.push(chunk));
    });
    child.stderr?.on("data", (chunk: string) => {
        output = appendCapturedOutput(output, chunk);
        writeLog(logFilter.push(chunk));
    });

    child.on("error", (error) => {
        const message = asErrorMessage(error);
        writeLog(`${message}\n`);
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

function getMounRiverSilentProfileDirectory(): string {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
    return path.join(base, "wch-vscode", "mrs-cli-portable");
}

function createBuildTerminalWriter(): (text: string) => void {
    buildTerminal?.dispose();
    const writeEmitter = new vscode.EventEmitter<string>();
    buildTerminal = vscode.window.createTerminal({
        name: t("build.terminalName"),
        pty: {
            onDidWrite: writeEmitter.event,
            open: () => undefined,
            close: () => undefined,
            handleInput: () => undefined,
        },
    });
    buildTerminal.show(true);
    return (text) => writeEmitter.fire(text.replace(/\r?\n/g, "\r\n"));
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
