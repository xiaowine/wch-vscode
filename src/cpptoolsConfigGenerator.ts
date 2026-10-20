import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WchProjectModel } from './models/WchProjectModel';
import { isAbsoluteOrVariablePath, resolveCompilerPathFromSetting } from './build/buildShared';

export const GENERATE_CPPTOOLS_CONFIG_COMMAND = 'wchVscode.generateCppToolsConfig';
const CPPTOOLS_CONFIG_FILE_NAME = 'c_cpp_properties.json';

type CppToolsConfiguration = {
	name: string;
	compilerPath?: string;
	compilerArgs?: string[];
	cStandard?: string;
	cppStandard?: string;
	includePath: string[];
	defines: string[];
	forcedInclude?: string[];
	browse: {
		path: string[];
		limitSymbolsToIncludedHeaders: boolean;
	};
};

// 根据项目模型生成 cpptools 的 c_cpp_properties.json 内容。
export async function generateCppToolsConfigFile(
	workspaceFolder: vscode.WorkspaceFolder,
	models: WchProjectModel[],
): Promise<vscode.Uri> {
	const vscodeFolder = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
	const configFile = vscode.Uri.joinPath(vscodeFolder, CPPTOOLS_CONFIG_FILE_NAME);
	const content = {
		configurations: await Promise.all(models.map((model) => buildCppToolsConfiguration(model))),
		version: 4,
	};

	await vscode.workspace.fs.createDirectory(vscodeFolder);
	await vscode.workspace.fs.writeFile(
		configFile,
		new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`),
	);

	return configFile;
}

// 仅在配置文件不存在时自动生成，避免覆盖用户已经调整过的配置。
export async function ensureCppToolsConfigFileIfMissing(
	workspaceFolder: vscode.WorkspaceFolder,
	models: WchProjectModel[],
): Promise<vscode.Uri | null> {
	const configFile = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', CPPTOOLS_CONFIG_FILE_NAME);

	try {
		await vscode.workspace.fs.stat(configFile);
		return null;
	} catch {
		return generateCppToolsConfigFile(workspaceFolder, models);
	}
}

// 生成单个项目对应的 cpptools 配置。
async function buildCppToolsConfiguration(model: WchProjectModel): Promise<CppToolsConfiguration> {
	const projectPrefix = toWorkspacePath(model, model.identity.folderPath);
	const linkedFolderPaths = model.target.linkedFolders.map((value) => resolveLinkedFolderPath(model, value.location));
	const linkedFolderBrowsePaths = linkedFolderPaths.map((value) => appendRecursiveGlob(value));
	const includePath = uniqueStrings([
		`${projectPrefix}/**`,
		...model.build.includePaths.map((value) => normalizeWorkspacePath(model, value)),
		...model.build.includeSystemPaths.map((value) => normalizeWorkspacePath(model, value)),
		...linkedFolderBrowsePaths,
	]);
	const forcedInclude = uniqueStrings(
		model.build.includeFiles.map((value) => normalizeWorkspacePath(model, value)),
	);
	const compilerArgs = uniqueStrings([
		...model.build.architectureArgs,
		...model.build.otherCompilerFlags,
	]);
	const compilerPath = resolveCompilerPathFromSetting(model);

	return {
		name: model.identity.name || model.identity.baseName,
		compilerPath,
		compilerArgs: compilerArgs.length > 0 ? compilerArgs : undefined,
		cStandard: model.build.cStandard || undefined,
		cppStandard: model.build.cppStandard || undefined,
		includePath,
		defines: uniqueStrings(model.build.definedSymbols),
		forcedInclude: forcedInclude.length > 0 ? forcedInclude : undefined,
		browse: {
			path: uniqueStrings([projectPrefix, ...includePath, ...linkedFolderPaths]),
			limitSymbolsToIncludedHeaders: true,
		},
	};
}

// 将项目变量路径转成 cpptools 能直接识别的 workspace 路径。
function normalizeWorkspacePath(model: WchProjectModel, value: string): string {
	const projectPrefix = toWorkspacePath(model, model.identity.folderPath);
	const normalizedValue = value
		.replace(/\\/g, '/')
		.replace(/\$\{workspace_loc:\/\$\{ProjName\}/g, projectPrefix);

	const mappedProjectPath = mapProjectLinkedFolderPath(model, normalizedValue);
	if (mappedProjectPath) {
		return mappedProjectPath;
	}

	const replacedProjectName = normalizedValue.replace(/\$\{ProjName\}/g, model.identity.name || model.identity.baseName);
	const replacedProjectPath = replacedProjectName.replace(/\$\{project\}/g, projectPrefix);

	if (isAbsoluteOrVariablePath(replacedProjectPath)) {
		return replacedProjectPath;
	}

	return `${projectPrefix}/${replacedProjectPath.replace(/^\/+/g, '')}`;
}

// linkedFolders 的 location 以工程目录为基准，需要按 ${project} 虚拟路径映射。
function mapProjectLinkedFolderPath(model: WchProjectModel, value: string): string | null {
	if (!value.startsWith('${project}/')) {
		return null;
	}

	const relativePath = value.slice('${project}/'.length);
	for (const linkedFolder of model.target.linkedFolders) {
		const folderName = linkedFolder.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!folderName) {
			continue;
		}

		if (relativePath === folderName || relativePath.startsWith(`${folderName}/`)) {
			const suffix = relativePath.slice(folderName.length).replace(/^\/+/g, '');
			const basePath = resolveLinkedFolderPath(model, linkedFolder.location).replace(/\/+$/g, '');
			return suffix ? `${basePath}/${suffix}` : basePath;
		}
	}

	return null;
}

function resolveLinkedFolderPath(model: WchProjectModel, location: string): string {
	const trimmedLocation = location.trim();
	if (trimmedLocation.startsWith('${')) {
		return normalizeWorkspacePath(model, trimmedLocation);
	}

	return toWorkspacePath(
		model,
		path.isAbsolute(trimmedLocation)
			? path.normalize(trimmedLocation)
			: path.resolve(model.identity.folderPath, trimmedLocation),
	);
}

// 工程可能位于工作区子目录，cpptools 的 ${workspaceFolder} 需要补上工程相对路径。
function toWorkspacePath(model: WchProjectModel, fileSystemPath: string): string {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(
		vscode.Uri.file(model.identity.folderPath),
	);
	if (workspaceFolder) {
		const relativePath = path.relative(workspaceFolder.uri.fsPath, fileSystemPath)
			.replace(/\\/g, '/');
		if (relativePath === '') {
			return '${workspaceFolder}';
		}
		if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
			return `\${workspaceFolder}/${relativePath}`;
		}
	}

	return fileSystemPath.replace(/\\/g, '/');
}

// 为目录补齐递归通配，便于 cpptools 处理 linkedFolders 里的子目录头文件。
function appendRecursiveGlob(value: string): string {
	if (!value || value.endsWith('/**')) {
		return value;
	}

	return `${value.replace(/\/+$/g, '')}/**`;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}
