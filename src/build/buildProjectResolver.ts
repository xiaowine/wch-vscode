import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WchProjectModel } from '../models/WchProjectModel';
import { t } from '../i18n';
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

export type BuildTarget = {
	workspaceFolder: vscode.WorkspaceFolder;
	model: WchProjectModel;
};

export type BuildProjectSelector = {
	folderPath?: string;
	projectPath?: string;
	wvprojPath?: string;
	projectName?: string;
	baseName?: string;
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
		const unsupportedMessage = getSingleUnsupportedProjectMessage();
		return unsupportedMessage ? { error: unsupportedMessage } : { error: t('error.noBuildableWchProject') };
	}

	const activeFilePath = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;
	if (activeFilePath) {
		const matchedTargets = targets.filter((target) => isPathInsideModel(target.model, activeFilePath));
		if (matchedTargets.length === 1) {
			return { target: matchedTargets[0] };
		}
		if (matchedTargets.length > 1) {
			return { error: t('error.currentFileMatchesMultipleProjects') };
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

	return { error: t('error.cannotLocateUniqueBuildProject') };
}

export async function resolveBuildProjectForExecution(
	editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<ResolvedBuildProject> {
	const resolution = resolveCurrentBuildTarget(editor);
	if (!resolution.target) {
		throw new Error(resolution.error ?? t('error.cannotLocateBuildProject'));
	}

	return resolveBuildTargetForExecution(resolution.target);
}

export async function resolveBuildProjectForExecutionBySelector(
	selector: BuildProjectSelector,
): Promise<ResolvedBuildProject> {
	const resolution = resolveBuildTargetBySelector(selector);
	if (!resolution.target) {
		throw new Error(resolution.error ?? t('error.cannotLocateBuildProject'));
	}

	return resolveBuildTargetForExecution(resolution.target);
}

function resolveBuildTargetBySelector(selector: BuildProjectSelector): BuildTargetResolution {
	const targets = getBuildTargets();
	if (targets.length === 0) {
		const unsupportedMessage = getSingleUnsupportedProjectMessage();
		return unsupportedMessage ? { error: unsupportedMessage } : { error: t('error.noBuildableWchProject') };
	}

	const folderPath = selector.folderPath ?? selector.projectPath;
	const wvprojPath = selector.wvprojPath;
	const projectName = selector.projectName;
	const baseName = selector.baseName;
	const matchedTargets = targets.filter((target) => {
		if (folderPath && path.resolve(target.model.identity.folderPath) !== path.resolve(folderPath)) {
			return false;
		}
		if (wvprojPath && path.resolve(target.model.identity.files.wvproj) !== path.resolve(wvprojPath)) {
			return false;
		}
		if (projectName && target.model.identity.name !== projectName) {
			return false;
		}
		if (baseName && target.model.identity.baseName !== baseName) {
			return false;
		}
		return true;
	});

	if (matchedTargets.length === 1) {
		return { target: matchedTargets[0] };
	}
	if (matchedTargets.length === 0) {
		return { error: t('error.noMatchingBuildProject') };
	}

	return { error: t('error.selectorMatchesMultipleProjects') };
}

async function resolveBuildTargetForExecution(
	target: BuildTarget,
): Promise<ResolvedBuildProject> {
	const { workspaceFolder, model } = target;
	if (model.target.toolchain.toUpperCase() !== 'RISC-V') {
		throw new Error(t('error.unsupportedRiscvOnly'));
	}

	const outputDirectoryName = model.build.configName.trim();
	if (!outputDirectoryName) {
		throw new Error(t('error.missingBuildConfigNameForBuildDirectory'));
	}

	const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
	if (!mounRiverStudioPath) {
		throw new Error(t('setting.mounRiverStudioPathRequired'));
	}

	const toolchainPaths = resolveToolchainPaths(mounRiverStudioPath, model);
	if (!toolchainPaths) {
		throw new Error(t('error.toolchainVersionUnsupported'));
	}

	if (!await fileExists(toolchainPaths.make)) {
		throw new Error(t('error.makeMissing'));
	}

	const linkerScriptValue = model.build.linker.script;
	if (!linkerScriptValue) {
		throw new Error(t('error.linkerScriptMissing'));
	}

	const linkerScriptPath = resolveProjectFileSystemPath(model, linkerScriptValue);
	if (!await fileExists(linkerScriptPath)) {
		throw new Error(t('error.linkerScriptNotFound', { filePath: linkerScriptPath }));
	}

	const outputDirectory = path.join(model.identity.folderPath, outputDirectoryName);
	const sources = await discoverSourceFiles(model, outputDirectory);
	if (sources.length === 0) {
		throw new Error(t('error.noSourceFiles'));
	}

	const artifactPaths = resolveBuildArtifactPaths(model);
	const otherObjects = model.build.linker.otherObjects.map((value) => resolveProjectFileSystemPath(model, value));

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
		throw new Error(t('error.missingBuildConfigNameForBuildDirectory'));
	}

	const outputDirectory = path.join(model.identity.folderPath, outputDirectoryName);
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

	return path.resolve(model.identity.folderPath, normalizedValue);
}

export function toLogicalProjectPath(model: WchProjectModel, fileSystemPath: string): string | null {
	const normalizedPath = path.resolve(fileSystemPath);
	for (const linkedFolder of model.target.linkedFolders) {
		const linkedFolderPath = path.resolve(model.identity.folderPath, linkedFolder.location);
		if (!isPathInside(linkedFolderPath, normalizedPath)) {
			continue;
		}

		const relativePath = path.relative(linkedFolderPath, normalizedPath);
		return toLogicalPath(path.join(linkedFolder.name, relativePath));
	}

	if (!isPathInside(model.identity.folderPath, normalizedPath)) {
		return null;
	}

	return toLogicalPath(path.relative(model.identity.folderPath, normalizedPath));
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
	if (isPathInside(model.identity.folderPath, filePath)) {
		return true;
	}

	return model.target.linkedFolders.some((linkedFolder) =>
		isPathInside(path.resolve(model.identity.folderPath, linkedFolder.location), filePath),
	);
}

async function discoverSourceFiles(
	model: WchProjectModel,
	outputDirectory: string,
): Promise<ResolvedSourceFile[]> {
	const linkedFolderNames = new Set(model.target.linkedFolders.map((linkedFolder) => linkedFolder.name));
	const excludedPaths = buildExcludedLogicalPaths(model, outputDirectory);
	const sourceMap = new Map<string, ResolvedSourceFile>();

	await collectSourceFiles(
		vscode.Uri.file(model.identity.folderPath),
		model,
		excludedPaths,
		sourceMap,
		linkedFolderNames,
	);

	for (const linkedFolder of model.target.linkedFolders) {
		await collectSourceFiles(
			vscode.Uri.file(path.resolve(model.identity.folderPath, linkedFolder.location)),
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
			if (excludedTopLevelNames?.has(entryName) && currentDirectory.fsPath === model.identity.folderPath) {
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
	const projectName = model.identity.name || model.identity.baseName;
	const rawArtifactName = model.build.artifact.name || path.basename(model.build.artifact.outputFile || '');
	const normalizedArtifactName = replaceBuildVariables(rawArtifactName, projectName, projectName)
		.replace(/\.[^/.]+$/, '')
		.trim();
	if (!normalizedArtifactName) {
		return projectName;
	}

	const outputPrefix = replaceBuildVariables(model.build.artifact.outputPrefix, projectName, normalizedArtifactName);
	return `${outputPrefix}${normalizedArtifactName}`;
}

function resolveMapFilePath(
	model: WchProjectModel,
	outputDirectory: string,
	targetBaseName: string,
): string | undefined {
	if (!model.build.linker.mapFile) {
		return undefined;
	}

	const resolvedValue = replaceBuildVariables(model.build.linker.mapFile, model.identity.name || model.identity.baseName, targetBaseName)
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
		.replace(/\$\{workspace_loc:\/\$\{ProjName\}/g, model.identity.folderPath.replace(/\\/g, '/'))
		.trim();

	return replaceBuildVariables(
		normalizedValue.replace(/\$\{project\}/g, model.identity.folderPath.replace(/\\/g, '/')),
		model.identity.name || model.identity.baseName,
		resolveArtifactBaseName(model),
	);
}

function mapLinkedFolderFileSystemPath(model: WchProjectModel, value: string): string | null {
	if (!value.startsWith(model.identity.folderPath.replace(/\\/g, '/'))) {
		return null;
	}

	const relativePath = value.slice(model.identity.folderPath.replace(/\\/g, '/').length).replace(/^\/+/g, '');
	for (const linkedFolder of model.target.linkedFolders) {
		const folderName = linkedFolder.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!folderName) {
			continue;
		}

		if (relativePath === folderName || relativePath.startsWith(`${folderName}/`)) {
			const suffix = relativePath.slice(folderName.length).replace(/^\/+/g, '');
			return path.resolve(model.identity.folderPath, linkedFolder.location, suffix);
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
