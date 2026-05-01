import * as vscode from 'vscode';
import { ensureCppToolsConfigFileIfMissing, generateCppToolsConfigFile, GENERATE_CPPTOOLS_CONFIG_COMMAND } from './cpptoolsConfigGenerator';
import { refreshProjectDetectionViews, registerWorkspaceRefresh } from './projectDetection';
import { getWchProjectState } from './projectState';
import { COPY_SIDEBAR_VALUE_COMMAND, WchVscodeSidebarProvider } from './sidebar/WchVscodeSidebarProvider';
import { WchProjectFilesProvider } from './sidebar/WchProjectFilesProvider';
import type { WchProjectModel } from './models/WchProjectModel';

export function activate(context: vscode.ExtensionContext) {
	// 扩展入口只负责组装侧栏和项目检测服务。
	const sidebarProvider = new WchVscodeSidebarProvider();
	const projectFilesProvider = new WchProjectFilesProvider();
	const providers = [sidebarProvider, projectFilesProvider];
	registerWorkspaceRefresh(providers, context);
	// 扩展激活时先做一次项目检测，并在缺少 cpptools 配置时自动补齐。
	void initializeProjectState(providers);
	// 注册侧栏刷新命令，供标题栏按钮触发重新检测和解析。
	const refreshProjectsCommand = vscode.commands.registerCommand('wchVscode.refreshProjects', async () => {
		await refreshProjectDetectionViews(providers);
	});
	// 注册侧栏复制命令，点击叶子节点时将对应值写入剪贴板。
	const copySidebarValueCommand = vscode.commands.registerCommand(COPY_SIDEBAR_VALUE_COMMAND, async (label: string, value: string) => {
		await vscode.env.clipboard.writeText(value);
		void vscode.window.showInformationMessage(`已复制 ${label}`);
	});
	// 注册 cpptools 配置生成命令，基于当前工作区项目模型写入 c_cpp_properties.json。
	const generateCppToolsConfigCommand = vscode.commands.registerCommand(
		GENERATE_CPPTOOLS_CONFIG_COMMAND,
		async (folder: vscode.WorkspaceFolder, models: WchProjectModel[]) => {
			const file = await generateCppToolsConfigFile(folder, models);
			const document = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(document, { preview: false });
			void vscode.window.showInformationMessage('已生成 C/C++ 配置文件');
		},
	);

	context.subscriptions.push(
		copySidebarValueCommand,
		generateCppToolsConfigCommand,
		refreshProjectsCommand,
		vscode.window.registerTreeDataProvider('wchVscodeSidebarView', sidebarProvider),
		vscode.window.registerTreeDataProvider('wchVscodeProjectFilesView', projectFilesProvider),
	);
}

export function deactivate() {}

// 初始化项目状态，并为命中的工作区自动生成缺失的 cpptools 配置文件。
async function initializeProjectState(
	providers: Array<{ setResults(): void }>,
): Promise<void> {
	await refreshProjectDetectionViews(providers);

	for (const project of getWchProjectState().projects) {
		const folder = vscode.workspace.workspaceFolders?.find(
			(item) => item.uri.fsPath === project.folderPath,
		);

		if (!folder || project.models.length === 0) {
			continue;
		}

		await ensureCppToolsConfigFileIfMissing(folder, project.models);
	}
}
