export type MounRiverSilentAction = "build" | "rebuild" | "clean";

export type MounRiverSilentParseResult = "succeeded" | "failed" | "no-result";

// MRS 的日志文本是唯一可靠的成败信号，退出码恒为 0。
const SUCCESS_MARKERS = ["编译完成", "Build Finished."];
const FAILURE_MARKERS = ["编译失败", "Build Failed."];

export function parseMounRiverSilentOutput(
    output: string,
    action: MounRiverSilentAction,
): MounRiverSilentParseResult {
    const successIndex = lastMarkerIndex(output, SUCCESS_MARKERS);
    const failureIndex = lastMarkerIndex(output, FAILURE_MARKERS);

    if (failureIndex >= 0 && failureIndex >= successIndex) {
        return "failed";
    }
    if (successIndex >= 0) {
        return "succeeded";
    }
    // clean 不输出成功标记，只要没有失败标记就视为成功。
    return action === "clean" ? "succeeded" : "no-result";
}

function lastMarkerIndex(output: string, markers: readonly string[]): number {
    let lastIndex = -1;
    for (const marker of markers) {
        lastIndex = Math.max(lastIndex, output.lastIndexOf(marker));
    }
    return lastIndex;
}

// MRS/Electron 启动时会向 stdout 打无关内容，过滤后再写入输出面板。
const IGNORED_LINE_PATTERNS = [
    /\bjump_list\.cc\(\d+\)\]/,
    /^\[main [^\]]+\]\s*$/,
];

const ENVIRONMENT_DUMP_MARKERS = ["VSCODE_IPC_HOOK", "VSCODE_NLS_CONFIG"];

type PendingBlockKind = "none" | "undefined" | "object";

export class MounRiverOutputFilter {
    private buffer = "";
    private pendingLines: string[] = [];
    private pendingKind: PendingBlockKind = "none";

    push(chunk: string): string {
        this.buffer += chunk;
        let result = "";
        let newlineIndex = this.buffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            result += this.filterLine(line);
            newlineIndex = this.buffer.indexOf("\n");
        }
        return result;
    }

    flush(): string {
        let result = "";
        if (this.buffer) {
            result += this.filterLine(this.buffer);
            this.buffer = "";
        }
        if (this.pendingKind === "undefined") {
            result += "undefined\n";
        } else if (this.pendingKind === "object") {
            result += `${this.pendingLines.join("\n")}\n`;
        }
        this.pendingKind = "none";
        this.pendingLines = [];
        return result;
    }

    private filterLine(rawLine: string): string {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (this.pendingKind === "object") {
            this.pendingLines.push(line);
            if (line.trim() === "}") {
                const block = this.pendingLines.join("\n");
                this.pendingKind = "none";
                this.pendingLines = [];
                return ENVIRONMENT_DUMP_MARKERS.some((marker) => block.includes(marker))
                    ? ""
                    : `${block}\n`;
            }
            return "";
        }

        if (this.pendingKind === "undefined") {
            this.pendingKind = "none";
            if (line.trim().startsWith("{")) {
                this.pendingKind = "object";
                this.pendingLines = [line];
                return "";
            }
            return `undefined\n${this.filterLine(line)}`;
        }

        const trimmed = line.trim();
        if (trimmed === "undefined") {
            this.pendingKind = "undefined";
            return "";
        }
        if (trimmed === "{") {
            this.pendingKind = "object";
            this.pendingLines = [line];
            return "";
        }
        if (IGNORED_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
            return "";
        }
        return `${line}\n`;
    }
}

const ANSI_RESET = "\x1b[0m";
const ANSI_ERROR = "\x1b[1;31m";
const ANSI_ERROR_CONTEXT = "\x1b[31m";
const ANSI_WARNING = "\x1b[33m";
const ANSI_NOTE = "\x1b[34m";
const ANSI_SUCCESS = "\x1b[32m";

type DiagnosticSeverity = "error" | "warning" | "note";

const DIAGNOSTIC_PATTERN = /^(.+?:\d+:\d+:\s+)(error|warning|note):(.*)$/;
const DIAGNOSTIC_CONTEXT_PATTERN = /^\s*(?:\d+\s*)?\|/;
const DIAGNOSTIC_CARET_PATTERN = /^\s*\|\s*\^/;
const SUCCESS_PATTERN = /编译完成|Build Finished\./;
const FAILURE_PATTERN = /编译失败|Build Failed\./;
const MAKE_ERROR_PATTERN = /\bmake(?:\[\d+\])?: \*\*\*/;
const SUCCESS_STATUS_PATTERN = /^\[\d{1,2}:\d{2}:\d{2}\] (成功|Succeeded)$/;
const FAILURE_STATUS_PATTERN = /^\[\d{1,2}:\d{2}:\d{2}\] (失败|Failed|未识别到结果|No result detected)$/;
const CANCELED_STATUS_PATTERN = /^\[\d{1,2}:\d{2}:\d{2}\] (已取消|Canceled)$/;

const SEVERITY_COLORS: Record<DiagnosticSeverity, string> = {
    error: ANSI_ERROR,
    warning: ANSI_WARNING,
    note: ANSI_NOTE,
};

const SEVERITY_CONTEXT_COLORS: Record<DiagnosticSeverity, string> = {
    error: ANSI_ERROR_CONTEXT,
    warning: ANSI_WARNING,
    note: ANSI_NOTE,
};

// 诊断、warning、note 整行着色，caret 行延续上一条诊断的颜色。
export class MounRiverLineColorizer {
    private severity: DiagnosticSeverity | undefined;

    push(text: string): string {
        if (!text) {
            return text;
        }
        return text
            .split("\n")
            .map((line) => this.colorizeLine(line))
            .join("\n");
    }

    private colorizeLine(line: string): string {
        const diagnostic = DIAGNOSTIC_PATTERN.exec(line);
        if (diagnostic) {
            const severity = diagnostic[2] as DiagnosticSeverity;
            this.severity = severity;
            return `${SEVERITY_COLORS[severity]}${line}${ANSI_RESET}`;
        }

        if (this.severity && DIAGNOSTIC_CONTEXT_PATTERN.test(line)) {
            if (DIAGNOSTIC_CARET_PATTERN.test(line)) {
                return `${SEVERITY_CONTEXT_COLORS[this.severity]}${line}${ANSI_RESET}`;
            }
            return line;
        }

        this.severity = undefined;

        if (MAKE_ERROR_PATTERN.test(line) || FAILURE_PATTERN.test(line) || FAILURE_STATUS_PATTERN.test(line)) {
            return `${ANSI_ERROR_CONTEXT}${line}${ANSI_RESET}`;
        }
        if (SUCCESS_PATTERN.test(line) || SUCCESS_STATUS_PATTERN.test(line)) {
            return `${ANSI_SUCCESS}${line}${ANSI_RESET}`;
        }
        if (CANCELED_STATUS_PATTERN.test(line)) {
            return `${ANSI_WARNING}${line}${ANSI_RESET}`;
        }
        return line;
    }
}
