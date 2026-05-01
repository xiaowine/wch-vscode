import * as vscode from 'vscode';
import * as path from 'node:path';
import type { WchLinkedFolder, WchProjectModel } from './models/WchProjectModel';

export const GENERATE_CPPTOOLS_CONFIG_COMMAND = 'wchVscode.generateCppToolsConfig';
const CPPTOOLS_CONFIG_FILE_NAME = 'c_cpp_properties.json';
const MOUN_RIVER_STUDIO_PATH_SETTING = 'mounRiverStudioPath';

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
	const linkedFolderPaths = model.linkedFolders.map((value) => normalizeLinkedFolderLocation(value.location));
	const linkedFolderBrowsePaths = linkedFolderPaths.map((value) => appendRecursiveGlob(value));
	const includePath = uniqueStrings([
		'${workspaceFolder}/**',
		...model.build.includePaths.map((value) => normalizeWorkspacePath(model, value)),
		...model.build.includeSystemPaths.map((value) => normalizeWorkspacePath(model, value)),
		...linkedFolderBrowsePaths,
	]);
	const forcedInclude = uniqueStrings(
		model.build.includeFiles.map((value) => normalizeWorkspacePath(model, value)),
	);
	const compilerArgs = uniqueStrings([
		...buildArchitectureArgs(model),
		...model.build.otherCompilerFlags,
	]);
	const compilerPath = resolveCompilerPathFromSetting(model);

	return {
		name: model.project.name || model.baseName,
		compilerPath,
		compilerArgs: compilerArgs.length > 0 ? compilerArgs : undefined,
		cStandard: model.build.cStandard || undefined,
		cppStandard: model.build.cppStandard || undefined,
		includePath,
		defines: uniqueStrings(model.build.definedSymbols),
		forcedInclude: forcedInclude.length > 0 ? forcedInclude : undefined,
		browse: {
			path: uniqueStrings(['${workspaceFolder}', ...includePath, ...linkedFolderPaths]),
			limitSymbolsToIncludedHeaders: true,
		},
	};
}

// 为交叉编译器补齐常用架构参数，提升 Intellisense 准确度。
function buildArchitectureArgs(model: WchProjectModel): string[] {
	const args: string[] = [];

	if (model.build.targetArchitecture) {
		args.push(`-march=${buildMarch(model)}`);
	}

	if (model.build.targetAbi) {
		args.push(`-mabi=${model.build.targetAbi}`);
	}

	return args;
}

// 根据基础架构和扩展组合出 RISC-V march 参数。
function buildMarch(model: WchProjectModel): string {
	const extensions = model.build.riscvExtensions
		.map((item) => item.toLowerCase())
		.filter((item) => item !== 'zmmul');
	const suffix = extensions.join('');
	const base = model.build.targetArchitecture || 'rv32i';

	if (model.build.riscvExtensions.includes('Zmmul')) {
		return suffix ? `${base}${suffix}_zmmul` : `${base}_zmmul`;
	}

	return `${base}${suffix}`;
}

// 将项目变量路径转成 cpptools 能直接识别的 workspace 路径。
function normalizeWorkspacePath(model: WchProjectModel, value: string): string {
	const normalizedValue = value
		.replace(/\\/g, '/')
		.replace(/\$\{workspace_loc:\/\$\{ProjName\}/g, '${workspaceFolder}');

	const mappedProjectPath = mapProjectVirtualPath(model.linkedFolders, normalizedValue);
	if (mappedProjectPath) {
		return mappedProjectPath;
	}

	const replacedProjectName = normalizedValue.replace(/\$\{ProjName\}/g, model.folderName);
	const replacedProjectPath = replacedProjectName.replace(/\$\{project\}/g, '${workspaceFolder}');

	if (isAbsoluteOrVariablePath(replacedProjectPath)) {
		return replacedProjectPath;
	}

	return `\${workspaceFolder}/${replacedProjectPath.replace(/^\/+/g, '')}`;
}

// 为目录补齐递归通配，便于 cpptools 处理 linkedFolders 里的子目录头文件。
function appendRecursiveGlob(value: string): string {
	if (!value || value.endsWith('/**')) {
		return value;
	}

	return `${value.replace(/\/+$/g, '')}/**`;
}

// linkedFolders 的 location 本身就是实际物理目录，生成 cpptools 时直接按工作区相对路径展开。
function normalizeLinkedFolderLocation(value: string): string {
	const normalizedValue = value.replace(/\\/g, '/');
	if (isAbsoluteOrVariablePath(normalizedValue)) {
		return normalizedValue;
	}

	return `\${workspaceFolder}/${normalizedValue.replace(/^\/+/g, '')}`;
}

// 将 ${project}/逻辑目录映射到 linkedFolders 指向的真实目录。
function mapProjectVirtualPath(linkedFolders: WchLinkedFolder[], value: string): string | null {
	if (!value.startsWith('${project}/')) {
		return null;
	}

	const relativePath = value.slice('${project}/'.length);
	for (const linkedFolder of linkedFolders) {
		const folderName = linkedFolder.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!folderName) {
			continue;
		}

		if (relativePath === folderName || relativePath.startsWith(`${folderName}/`)) {
			const suffix = relativePath.slice(folderName.length).replace(/^\/+/g, '');
			const basePath = normalizeLinkedFolderLocation(linkedFolder.location).replace(/\/+$/g, '');
			return suffix ? `${basePath}/${suffix}` : basePath;
		}
	}

	return null;
}

function isAbsoluteOrVariablePath(value: string): boolean {
	return /^[A-Za-z]:\//.test(value)
		|| value.startsWith('//')
		|| value.startsWith('/')
		|| value.startsWith('${');
}

// 从扩展设置读取 MounRiver Studio 根目录，并按工程声明的工具链版本拼接 gcc 路径。
function resolveCompilerPathFromSetting(model: WchProjectModel): string | undefined {
	const rootPath = vscode.workspace
		.getConfiguration('wchVscode')
		.get<string>(MOUN_RIVER_STUDIO_PATH_SETTING, '')
		.trim();

	if (!rootPath) {
		return undefined;
	}

	const toolchainDirectoryName = resolveToolchainDirectoryName(model.debug.gdbExecutable);
	if (!toolchainDirectoryName) {
		return undefined;
	}

	return path.join(
		rootPath,
		'resources',
		'app',
		'resources',
		'win32',
		'components',
		'WCH',
		'Toolchain',
		toolchainDirectoryName,
		'bin',
		'riscv-none-embed-gcc.exe',
	);
}

// 从 ${WCH:Toolchain:GCC*} 占位符解析对应的工具链目录名。
function resolveToolchainDirectoryName(gdbExecutable: string): string | undefined {
	const matchedToolchainName = /\$\{WCH:Toolchain:([^}]+)\}/.exec(gdbExecutable)?.[1]?.trim();
	if (!matchedToolchainName) {
		return undefined;
	}

	switch (matchedToolchainName.toUpperCase()) {
		case 'GCC':
		case 'GCC8':
			return 'RISC-V Embedded GCC';
		case 'GCC12':
			return 'RISC-V Embedded GCC12';
		case 'GCC15':
			return 'RISC-V Embedded GCC15';
		default:
			return undefined;
	}
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}
