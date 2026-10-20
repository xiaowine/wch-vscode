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
