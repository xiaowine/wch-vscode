import * as vscode from 'vscode';
import { setWchProjectState } from './projectState';
import type { ParsedProjectFile } from './projectState';
import { parseCprojectFile, parseMatchedProjectFiles, parseWvprojFile } from './xmlParser';

// 统一约束可刷新的树视图提供器，便于一次刷新多个视图。
type RefreshableTreeProvider = {
	setResults(): void;
};

// 缓存每个工作区文件夹的项目检测结果，供侧栏直接读取。
export type ProjectDetectionValidationError = {
	filePath: string;
	fileName: string;
	message: string;
};

export type ProjectDetectionResult = {
	folder: vscode.WorkspaceFolder;
	cprojectCount: number;
	launchCount: number;
	wvprojCount: number;
	cprojectFiles: vscode.Uri[];
	launchFiles: vscode.Uri[];
	wvprojFiles: vscode.Uri[];
	matchingBaseNames: string[];
	unconfiguredWvprojFiles: vscode.Uri[];
	validationErrors: ProjectDetectionValidationError[];
	isTargetProject: boolean;
};

// 扫描当前所有工作区文件夹，并生成检测结果列表。
export async function detectProjects(): Promise<ProjectDetectionResult[]> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	return Promise.all(workspaceFolders.map(async (folder) => detectProjectInFolder(folder)));
}

// 刷新项目状态后，统一通知多个视图重新渲染。
export async function refreshProjectDetectionViews(providers: RefreshableTreeProvider[]): Promise<void> {
	await refreshWchProjectState();
	for (const provider of providers) {
		provider.setResults();
	}
}

// 刷新项目检测和解析结果，并写入全局状态缓存。
export async function refreshWchProjectState(): Promise<void> {
	const results = await detectProjects();
	const projects = await Promise.all(
		results
			.filter((result) => result.isTargetProject)
			.map((result) =>
				parseMatchedProjectFiles(
					result.folder,
					result.cprojectFiles,
					result.launchFiles,
					result.wvprojFiles,
					result.matchingBaseNames,
					result.unconfiguredWvprojFiles,
				),
			),
	);
	setWchProjectState(results, projects);
}

// 监听相关文件和工作区变化，发生变化后重新计算缓存结果。
export function registerWorkspaceRefresh(
	providers: RefreshableTreeProvider[],
	context: vscode.ExtensionContext,
	afterRefresh?: () => void | Promise<void>,
): void {
	const watchers = [
		vscode.workspace.createFileSystemWatcher('**/.cproject'),
		vscode.workspace.createFileSystemWatcher('**/*.launch'),
		vscode.workspace.createFileSystemWatcher('**/*.wvproj'),
	];
	const refresh = async () => {
		await refreshProjectDetectionViews(providers);
		await afterRefresh?.();
	};

	for (const watcher of watchers) {
		watcher.onDidCreate(() => void refresh());
		watcher.onDidDelete(() => void refresh());
		watcher.onDidChange(() => void refresh());
		context.subscriptions.push(watcher);
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
	);
}

// 按规则检测单个工作区文件夹是否为目标项目。
async function detectProjectInFolder(folder: vscode.WorkspaceFolder): Promise<ProjectDetectionResult> {
	const cprojectFiles = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/.cproject'),
		'**/node_modules/**',
	);
	const launchFiles = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/*.launch'),
		'**/node_modules/**',
	);
	const wvprojFiles = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/*.wvproj'),
		'**/node_modules/**',
	);
	const cprojectResults = await Promise.all(cprojectFiles.map((file) => parseCprojectFile(file)));
	const wvprojResults = await Promise.all(wvprojFiles.map((file) => parseWvprojFile(file)));
	const validCprojectFiles = filterValidFiles(cprojectFiles, cprojectResults);
	const validWvprojFiles = filterValidFiles(wvprojFiles, wvprojResults);
	const validationErrors = [
		...collectValidationErrors(cprojectResults),
		...collectValidationErrors(wvprojResults),
	];

	const launchBaseNames = new Set(launchFiles.map((file) => getBaseName(file, '.launch')));
	const wvprojBaseNames = new Set(validWvprojFiles.map((file) => getBaseName(file, '.wvproj')));
	const matchingBaseNames = Array.from(
		new Set(
			validWvprojFiles
				.map((file) => getBaseName(file, '.wvproj'))
				.filter((name) => launchBaseNames.has(name)),
		),
	).sort();
	const unconfiguredWvprojFiles = validWvprojFiles
		.filter((file) => !launchBaseNames.has(getBaseName(file, '.wvproj')))
		.sort((left, right) => left.fsPath.localeCompare(right.fsPath, 'en'));

	return {
		folder,
		cprojectCount: cprojectFiles.length,
		launchCount: launchFiles.length,
		wvprojCount: wvprojFiles.length,
		cprojectFiles: validCprojectFiles,
		launchFiles,
		wvprojFiles: validWvprojFiles,
		matchingBaseNames,
		unconfiguredWvprojFiles,
		validationErrors,
		isTargetProject: validCprojectFiles.length > 0 && wvprojBaseNames.size > 0,
	};
}

function filterValidFiles(files: vscode.Uri[], results: ParsedProjectFile[]): vscode.Uri[] {
	const validPaths = new Set(
		results
			.filter((result) => !result.parseError)
			.map((result) => result.filePath),
	);
	return files.filter((file) => validPaths.has(file.fsPath));
}

function collectValidationErrors(results: ParsedProjectFile[]): ProjectDetectionValidationError[] {
	return results
		.filter((result) => result.parseError)
		.map((result) => ({
			filePath: result.filePath,
			fileName: result.fileName,
			message: result.parseError ?? '',
		}));
}

// 取文件去掉指定后缀后的基名，用于匹配 .launch 和 .wvproj。
function getBaseName(file: vscode.Uri, suffix: string): string {
	const name = file.path.split('/').pop() ?? file.fsPath;
	return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}
