import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WchProjectModel } from '../models/WchProjectModel';
import { getWchProjectState } from '../projectState';
import { getConfiguredMounRiverStudioPath, resolveToolchainPaths, type ResolvedToolchainPaths } from './buildShared';

const IGNORED_DIRECTORY_NAMES = new Set([
	'.git',
	'.svn',
	'.vscode',
	'.mrs',
	'node_modules',
]);

type SourceLanguage = 'c' | 'cpp' | 'asm';

type BuildTarget = {
	workspaceFolder: vscode.WorkspaceFolder;
	model: WchProjectModel;
};

export type ResolvedSourceFile = {
	language: SourceLanguage;
	sourcePath: string;
	logicalPath: string;
	logicalDirectory: string;
	objectPath: string;
	dependencyPath: string;
	subdirMakefilePath: string;
};

export type ResolvedBuildProject = {
	workspaceFolder: vscode.WorkspaceFolder;
	model: WchProjectModel;
	outputDirectory: string;
	targetBaseName: string;
	elfPath: string;
	hexPath: string;
	lstPath: string;
	sizPath: string;
	mapFilePath?: string;
	linkerScriptPath: string;
	toolchainPaths: ResolvedToolchainPaths;
	sources: ResolvedSourceFile[];
	otherObjects: string[];
	hasCppSources: boolean;
};

export type BuildArtifactPaths = {
	outputDirectory: string;
	targetBaseName: string;
	elfPath: string;
	hexPath: string;
	lstPath: string;
	sizPath: string;
	mapFilePath?: string;
};

export type BuildTargetResolution = {
	target?: BuildTarget;
	error?: string;
};

export function resolveCurrentBuildTarget(
	editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): BuildTargetResolution {
	const targets = getBuildTargets();
	if (targets.length === 0) {
		const unsupportedProject = getSingleUnsupportedProjectMessage();
		return unsupportedProject ? { error: unsupportedProject } : { error: '当前未找到可编译的 WCH 工程' };
	}

	const activeFilePath = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;
	if (activeFilePath) {
		const matchedTargets = targets.filter((target) => isPathInsideModel(target.model, activeFilePath));
		if (matchedTargets.length === 1) {
			return { target: matchedTargets[0] };
		}
		if (matchedTargets.length > 1) {
			return { error: '当前文件命中了多个可编译工程，请打开目标工程中的唯一文件后重试' };
		}

		const unsupportedMessage = getUnsupportedProjectMessageForFile(activeFilePath);
		if (unsupportedMessage) {
			return { error: unsupportedMessage };
		}
	}

	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length === 1) {
		const singleFolderTargets = targets.filter(
			(target) => target.workspaceFolder.uri.fsPath === workspaceFolders[0].uri.fsPath,
		);
		if (singleFolderTargets.length === 1) {
			return { target: singleFolderTargets[0] };
		}
		const singleFolderProject = getWchProjectState().projects.find(
			(project) => project.folderPath === workspaceFolders[0].uri.fsPath,
		);
		if (singleFolderProject?.unsupportedReason) {
			return { error: singleFolderProject.unsupportedReason };
		}
	}

	if (targets.length === 1) {
		return { target: targets[0] };
	}

	return { error: '当前无法定位唯一的可编译 WCH 工程，请先打开目标工程中的文件' };
}

export async function resolveBuildProjectForExecution(
	editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<ResolvedBuildProject> {
	const resolution = resolveCurrentBuildTarget(editor);
	if (!resolution.target) {
		throw new Error(resolution.error ?? '当前无法定位可编译工程');
	}

	const { workspaceFolder, model } = resolution.target;
	if (model.chip.toolchain.toUpperCase() !== 'RISC-V') {
		throw new Error('不支持，仅支持 RISC-V 工程');
	}

	const outputDirectoryName = model.build.configName.trim();
	if (!outputDirectoryName) {
		throw new Error('当前工程缺少 build.configName，无法生成构建目录');
	}

	const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
	if (!mounRiverStudioPath) {
		throw new Error('请先配置 wchVscode.mounRiverStudioPath');
	}

	const toolchainPaths = resolveToolchainPaths(mounRiverStudioPath, model);
	if (!toolchainPaths) {
		throw new Error('不支持当前工具链版本');
	}

	if (!await fileExists(toolchainPaths.make)) {
		throw new Error('MRS 安装路径无效，未找到 make.exe');
	}

	const linkerScriptValue = model.linker.linkerScript || model.build.linkerScript;
	if (!linkerScriptValue) {
		throw new Error('当前工程缺少链接脚本');
	}

	const linkerScriptPath = resolveProjectFileSystemPath(model, linkerScriptValue);
	if (!await fileExists(linkerScriptPath)) {
		throw new Error(`链接脚本不存在：${linkerScriptPath}`);
	}

	const outputDirectory = path.join(model.folderPath, outputDirectoryName);
	const sources = await discoverSourceFiles(model, outputDirectory);
	if (sources.length === 0) {
		throw new Error('未发现可编译源码');
	}

	const artifactPaths = resolveBuildArtifactPaths(model);
	const otherObjects = model.linker.otherObjects.map((value) => resolveProjectFileSystemPath(model, value));

	return {
		workspaceFolder,
		model,
		...artifactPaths,
		linkerScriptPath,
		toolchainPaths,
		sources,
		otherObjects,
		hasCppSources: sources.some((source) => source.language === 'cpp'),
	};
}

export function resolveBuildArtifactPaths(model: WchProjectModel): BuildArtifactPaths {
	const outputDirectoryName = model.build.configName.trim();
	if (!outputDirectoryName) {
		throw new Error('当前工程缺少 build.configName，无法生成构建目录');
	}

	const outputDirectory = path.join(model.folderPath, outputDirectoryName);
	const targetBaseName = resolveArtifactBaseName(model);
	return {
		outputDirectory,
		targetBaseName,
		elfPath: path.join(outputDirectory, `${targetBaseName}.elf`),
		hexPath: path.join(outputDirectory, `${targetBaseName}.hex`),
		lstPath: path.join(outputDirectory, `${targetBaseName}.lst`),
		sizPath: path.join(outputDirectory, `${targetBaseName}.siz`),
		mapFilePath: resolveMapFilePath(model, outputDirectory, targetBaseName),
	};
}

export function resolveProjectFileSystemPath(model: WchProjectModel, value: string): string {
	const normalizedValue = normalizeProjectPathValue(model, value);
	const mappedLinkedFolderPath = mapLinkedFolderFileSystemPath(model, normalizedValue);
	if (mappedLinkedFolderPath) {
		return mappedLinkedFolderPath;
	}

	if (path.isAbsolute(normalizedValue)) {
		return path.normalize(normalizedValue);
	}

	return path.resolve(model.folderPath, normalizedValue);
}

export function toLogicalProjectPath(model: WchProjectModel, fileSystemPath: string): string | null {
	const normalizedPath = path.resolve(fileSystemPath);
	for (const linkedFolder of model.linkedFolders) {
		const linkedFolderPath = path.resolve(model.folderPath, linkedFolder.location);
		if (!isPathInside(linkedFolderPath, normalizedPath)) {
			continue;
		}

		const relativePath = path.relative(linkedFolderPath, normalizedPath);
		return toLogicalPath(path.join(linkedFolder.name, relativePath));
	}

	if (!isPathInside(model.folderPath, normalizedPath)) {
		return null;
	}

	return toLogicalPath(path.relative(model.folderPath, normalizedPath));
}

function getBuildTargets(): BuildTarget[] {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	const folderMap = new Map(workspaceFolders.map((folder) => [folder.uri.fsPath, folder]));

	return getWchProjectState().projects.flatMap((project) => {
		const workspaceFolder = folderMap.get(project.folderPath);
		if (!workspaceFolder || project.models.length === 0) {
			return [];
		}

		return project.models.map((model) => ({ workspaceFolder, model }));
	});
}

function getSingleUnsupportedProjectMessage(): string | undefined {
	const projects = getWchProjectState().projects.filter((project) => project.unsupportedReason);
	if (projects.length === 1) {
		return projects[0].unsupportedReason;
	}

	return undefined;
}

function getUnsupportedProjectMessageForFile(filePath: string): string | undefined {
	const matchedProject = getWchProjectState().projects.find(
		(project) => project.unsupportedReason && isPathInside(project.folderPath, filePath),
	);
	return matchedProject?.unsupportedReason;
}

function isPathInsideModel(model: WchProjectModel, filePath: string): boolean {
	if (isPathInside(model.folderPath, filePath)) {
		return true;
	}

	return model.linkedFolders.some((linkedFolder) =>
		isPathInside(path.resolve(model.folderPath, linkedFolder.location), filePath),
	);
}

async function discoverSourceFiles(
	model: WchProjectModel,
	outputDirectory: string,
): Promise<ResolvedSourceFile[]> {
	const linkedFolderNames = new Set(model.linkedFolders.map((linkedFolder) => linkedFolder.name));
	const excludedPaths = buildExcludedLogicalPaths(model, outputDirectory);
	const sourceMap = new Map<string, ResolvedSourceFile>();

	await collectSourceFiles(
		vscode.Uri.file(model.folderPath),
		model,
		excludedPaths,
		sourceMap,
		linkedFolderNames,
	);

	for (const linkedFolder of model.linkedFolders) {
		await collectSourceFiles(
			vscode.Uri.file(path.resolve(model.folderPath, linkedFolder.location)),
			model,
			excludedPaths,
			sourceMap,
			undefined,
		);
	}

	return Array.from(sourceMap.values()).sort((left, right) =>
		left.logicalPath.localeCompare(right.logicalPath, 'en'),
	);
}

async function collectSourceFiles(
	directoryUri: vscode.Uri,
	model: WchProjectModel,
	excludedPaths: Set<string>,
	sourceMap: Map<string, ResolvedSourceFile>,
	excludedTopLevelNames?: Set<string>,
): Promise<void> {
	const stack = [directoryUri];

	while (stack.length > 0) {
		const currentDirectory = stack.pop();
		if (!currentDirectory) {
			continue;
		}

		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(currentDirectory);
		} catch {
			continue;
		}

		for (const [entryName, fileType] of entries) {
			if (excludedTopLevelNames?.has(entryName) && currentDirectory.fsPath === model.folderPath) {
				continue;
			}

			const entryUri = vscode.Uri.joinPath(currentDirectory, entryName);
			const logicalPath = toLogicalProjectPath(model, entryUri.fsPath);
			if (!logicalPath) {
				continue;
			}

			if ((fileType & vscode.FileType.Directory) !== 0) {
				if (shouldSkipDirectory(entryName, logicalPath, excludedPaths)) {
					continue;
				}

				stack.push(entryUri);
				continue;
			}

			const language = getSourceLanguage(entryName);
			if (!language || isExcludedPath(logicalPath, excludedPaths)) {
				continue;
			}

			const logicalDirectory = toLogicalPath(path.dirname(logicalPath));
			const objectPath = buildOutputFilePath(logicalDirectory, path.basename(entryName, path.extname(entryName)), '.o');
			const dependencyPath = buildOutputFilePath(logicalDirectory, path.basename(entryName, path.extname(entryName)), '.d');
			const subdirMakefilePath = logicalDirectory
				? toLogicalPath(path.join(logicalDirectory, 'subdir.mk'))
				: 'subdir.mk';

			sourceMap.set(logicalPath, {
				language,
				sourcePath: entryUri.fsPath,
				logicalPath,
				logicalDirectory,
				objectPath,
				dependencyPath,
				subdirMakefilePath,
			});
		}
	}
}

function shouldSkipDirectory(
	entryName: string,
	logicalPath: string,
	excludedPaths: Set<string>,
): boolean {
	return IGNORED_DIRECTORY_NAMES.has(entryName) || isExcludedPath(logicalPath, excludedPaths);
}

function buildExcludedLogicalPaths(model: WchProjectModel, outputDirectory: string): Set<string> {
	const excludedPaths = new Set<string>();
	for (const sourceExclude of model.build.sourceExcludes) {
		const excludePath = toLogicalPath(
			toLogicalProjectPath(model, resolveProjectFileSystemPath(model, sourceExclude)) ?? sourceExclude,
		);
		if (excludePath) {
			excludedPaths.add(excludePath);
		}
	}

	const outputRelativePath = toLogicalProjectPath(model, outputDirectory);
	if (outputRelativePath) {
		excludedPaths.add(outputRelativePath);
	}

	return excludedPaths;
}

function buildOutputFilePath(logicalDirectory: string, fileBaseName: string, extension: string): string {
	const fileName = `${fileBaseName}${extension}`;
	return logicalDirectory ? toLogicalPath(path.join(logicalDirectory, fileName)) : fileName;
}

function getSourceLanguage(fileName: string): SourceLanguage | null {
	const extension = path.extname(fileName).toLowerCase();
	switch (extension) {
		case '.c':
			return 'c';
		case '.cpp':
		case '.cc':
		case '.cxx':
			return 'cpp';
		case '.s':
			return 'asm';
		default:
			return path.extname(fileName) === '.S' ? 'asm' : null;
	}
}

function resolveArtifactBaseName(model: WchProjectModel): string {
	const projectName = model.project.name || model.baseName;
	const rawArtifactName = model.project.artifact.name || path.basename(model.project.artifact.outputFile || '');
	const normalizedArtifactName = replaceBuildVariables(rawArtifactName, projectName, projectName)
		.replace(/\.[^/.]+$/, '')
		.trim();
	if (!normalizedArtifactName) {
		return projectName;
	}

	const outputPrefix = replaceBuildVariables(model.project.artifact.outputPrefix, projectName, normalizedArtifactName);
	return `${outputPrefix}${normalizedArtifactName}`;
}

function resolveMapFilePath(
	model: WchProjectModel,
	outputDirectory: string,
	targetBaseName: string,
): string | undefined {
	if (!model.linker.generateMap) {
		return undefined;
	}

	const resolvedValue = replaceBuildVariables(model.linker.generateMap, model.project.name || model.baseName, targetBaseName)
		.replace(/^"+|"+$/g, '')
		.trim();
	if (!resolvedValue) {
		return undefined;
	}

	return path.isAbsolute(resolvedValue)
		? path.normalize(resolvedValue)
		: path.join(outputDirectory, resolvedValue);
}

function replaceBuildVariables(value: string, projectName: string, artifactBaseName: string): string {
	return value
		.replace(/\$\{ProjName\}/g, projectName)
		.replace(/\$\{BuildArtifactFileBaseName\}/g, artifactBaseName)
		.replace(/\$\{BuildArtifactFileName\}/g, `${artifactBaseName}.elf`);
}

function normalizeProjectPathValue(model: WchProjectModel, value: string): string {
	const normalizedValue = value
		.replace(/\\/g, '/')
		.replace(/\$\{workspace_loc:\/\$\{ProjName\}/g, model.folderPath.replace(/\\/g, '/'))
		.trim();

	return replaceBuildVariables(
		normalizedValue.replace(/\$\{project\}/g, model.folderPath.replace(/\\/g, '/')),
		model.project.name || model.baseName,
		resolveArtifactBaseName(model),
	);
}

function mapLinkedFolderFileSystemPath(model: WchProjectModel, value: string): string | null {
	if (!value.startsWith(model.folderPath.replace(/\\/g, '/'))) {
		return null;
	}

	const relativePath = value.slice(model.folderPath.replace(/\\/g, '/').length).replace(/^\/+/g, '');
	for (const linkedFolder of model.linkedFolders) {
		const folderName = linkedFolder.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!folderName) {
			continue;
		}

		if (relativePath === folderName || relativePath.startsWith(`${folderName}/`)) {
			const suffix = relativePath.slice(folderName.length).replace(/^\/+/g, '');
			return path.resolve(model.folderPath, linkedFolder.location, suffix);
		}
	}

	return null;
}

function isExcludedPath(logicalPath: string, excludedPaths: Set<string>): boolean {
	for (const excludedPath of excludedPaths) {
		if (logicalPath === excludedPath || logicalPath.startsWith(`${excludedPath}/`)) {
			return true;
		}
	}

	return false;
}

function isPathInside(parentPath: string, childPath: string): boolean {
	const normalizedParent = path.resolve(parentPath);
	const normalizedChild = path.resolve(childPath);
	const relativePath = path.relative(normalizedParent, normalizedChild);
	return relativePath === ''
		|| (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toLogicalPath(value: string): string {
	if (!value || value === '.') {
		return '';
	}

	return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
		return true;
	} catch {
		return false;
	}
}
