import * as vscode from "vscode";
import {
    OPEN_IN_MOUN_RIVER_STUDIO_COMMAND,
    resolveCurrentMrsProject,
    type CurrentMrsProjectResolution,
} from "../mounRiverStudioLauncher";
import { getConfiguredMounRiverStudioPath } from "../build/buildShared";
import { getBuildMethod } from "../build/buildMethod";
import {
    getPowerOffDelayMs,
    getPowerOutput,
    getResetMode,
} from "../build/powerOffReset";
import { t } from "../i18n";

export const OPEN_MOUN_RIVER_STUDIO_PATH_SETTING_COMMAND =
    "wchVscode.openMounRiverStudioPathSetting";
export const OPEN_BUILD_METHOD_SETTING_COMMAND =
    "wchVscode.openBuildMethodSetting";
export const OPEN_RESET_MODE_SETTING_COMMAND =
    "wchVscode.openResetModeSetting";
export const OPEN_POWER_OFF_DELAY_SETTING_COMMAND =
    "wchVscode.openPowerOffDelaySetting";
export const OPEN_POWER_OUTPUT_SETTING_COMMAND =
    "wchVscode.openPowerOutputSetting";

// 设置与工具视图：集中放置设置入口和 MRS 打开动作。
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
        const resetMode = getResetMode();
        const powerOffDelayMs = getPowerOffDelayMs();
        const powerOutput = getPowerOutput();

        const items: vscode.TreeItem[] = [
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
            this.createSettingItem(
                t("tools.resetModeSetting"),
                resetMode === "powerOff"
                    ? t("tools.resetModePowerOff")
                    : t("tools.resetModeNrst"),
                OPEN_RESET_MODE_SETTING_COMMAND,
                `${t("tools.resetModeSettingTooltip")}\n${resetMode}`,
            ),
        ];

        // 普通复位不需要复位电压和重新上电等待时间，只有掉电复位才显示。
        if (resetMode === "powerOff") {
            items.push(
                this.createSettingItem(
                    t("tools.powerOutputSetting"),
                    powerOutput === "5v"
                        ? t("tools.powerOutput5v")
                        : t("tools.powerOutput3v3"),
                    OPEN_POWER_OUTPUT_SETTING_COMMAND,
                    `${t("tools.powerOutputSettingTooltip")}\n${powerOutput}`,
                ),
                this.createSettingItem(
                    t("tools.powerOffDelaySetting"),
                    `${powerOffDelayMs} ms`,
                    OPEN_POWER_OFF_DELAY_SETTING_COMMAND,
                    `${t("tools.powerOffDelaySettingTooltip")}\n${powerOffDelayMs} ms`,
                ),
            );
        }

        items.push(this.createOpenProjectItem(resolveCurrentMrsProject()));
        return items;
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
