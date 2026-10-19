import * as vscode from "vscode";
import {
    OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
    resolveCurrentMrsProject,
    type CurrentMrsProjectResolution,
} from "../mounRiverStudioLauncher";
import { getConfiguredMounRiverStudioPath } from "../build/buildShared";
import { getBuildMethod } from "../build/buildMethod";
import { t } from "../i18n";

export const OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND =
    "wchVscode.openMounRiverStudioPathSetting";
export const OPEN_BUILD_METHOD_SETTING_COMMAND =
    "wchVscode.openBuildMethodSetting";

// 设置与工具视图：集中放置设置入口和 MRS2 打开动作。
export class WchToolsSidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<
        vscode.TreeItem | undefined | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setResults(): void {
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element) {
            return [];
        }

        const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
        const buildMethod = getBuildMethod();

        return [
            this.createSettingItem(
                t("tools.mrsPathSetting"),
                mounRiverStudioPath || t("tools.valueNotConfigured"),
                OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND,
                mounRiverStudioPath
                    ? `${t("tools.mrsPathSettingTooltip")}\n${mounRiverStudioPath}`
                    : t("tools.mrsPathSettingTooltip"),
            ),
            this.createSettingItem(
                t("tools.buildMethodSetting"),
                buildMethod === "mrs-cli"
                    ? t("tools.buildMethodMrsCli")
                    : t("tools.buildMethodMake"),
                OPEN_BUILD_METHOD_SETTING_COMMAND,
                `${t("tools.buildMethodSettingTooltip")}\n${buildMethod}`,
            ),
            this.createOpenProjectItem(resolveCurrentMrsProject()),
        ];
    }

    private createSettingItem(
        label: string,
        description: string,
        command: string,
        tooltip: string,
    ): vscode.TreeItem {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = description;
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon("settings-gear");
        item.command = {
            command,
            title: label,
        };
        return item;
    }

    private createOpenProjectItem(
        resolution: CurrentMrsProjectResolution,
    ): vscode.TreeItem {
        const item = new vscode.TreeItem(
            t("tools.openInMrs2"),
            vscode.TreeItemCollapsibleState.None,
        );
        item.description = getOpenProjectDescription(resolution);
        item.tooltip = resolution.status === "found"
            ? `${t("tools.openInMrs2Tooltip")}\n${resolution.wvprojPath}`
            : getOpenProjectDescription(resolution);
        item.iconPath = new vscode.ThemeIcon("window");
        item.command = {
            command: OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
            title: t("tools.openInMrs2"),
        };
        return item;
    }
}

function getOpenProjectDescription(resolution: CurrentMrsProjectResolution): string {
    switch (resolution.status) {
        case "found":
            return resolution.projectName;
        case "no-folder":
            return t("tools.openInMrs2NoFolder");
        case "ambiguous":
            return t("tools.openInMrs2Ambiguous");
        case "not-mrs":
            return t("tools.openInMrs2NotMrs");
    }
}
