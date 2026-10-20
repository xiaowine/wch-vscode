import * as vscode from "vscode";

export const BUILD_METHOD_SETTING = "buildMethod";

export type BuildMethod = "make" | "mrs-cli";

// 读取当前编译方式：make 由插件解析参数，mrs-cli 由 MRS 解析参数。
export function getBuildMethod(): BuildMethod {
    const value = vscode.workspace
        .getConfiguration("wchVscode")
        .get<string>(BUILD_METHOD_SETTING, "make");
    return value === "mrs-cli" ? "mrs-cli" : "make";
}
