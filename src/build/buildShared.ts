import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WchLinkedFolder, WchProjectModel } from '../models/WchProjectModel';

export const MOUN_RIVER_STUDIO_PATH_SETTING = 'mounRiverStudioPath';

const TOOLCHAIN_ROOT_SEGMENTS = [
	'resources',
	'app',
	'resources',
	'win32',
	'components',
	'WCH',
	'Toolchain',
] as const;

const MAKE_EXECUTABLE_SEGMENTS = [
	'resources',
	'app',
	'resources',
	'win32',
	'others',
	'Build_Tools',
	'Make',
	'bin',
	'make.exe',
] as const;

const OPENOCD_ROOT_SEGMENTS = [
	'resources',
	'app',
	'resources',
	'win32',
	'components',
	'WCH',
	'OpenOCD',
	'OpenOCD',
] as const;

const OPENOCD_BIN_SEGMENTS = [
	...OPENOCD_ROOT_SEGMENTS,
	'bin',
] as const;

export type ResolvedToolchainPaths = {
	rootPath: string;
	make: string;
	gcc: string;
	gpp: string;
	gdb: string;
	objcopy: string;
	objdump: string;
	size: string;
};

export type ResolvedOpenOcdPaths = {
	root: string;
	executable: string;
	config: string;
	scripts: string;
};

export function resolveMounRiverStudioExecutable(rootPath: string): string | undefined {
	if (!rootPath) {
		return undefined;
	}

	return path.join(rootPath, 'MounRiver Studio 2.exe');
}

export function getConfiguredMounRiverStudioPath(): string {
	return vscode.workspace
		.getConfiguration('wchVscode')
		.get<string>(MOUN_RIVER_STUDIO_PATH_SETTING, '')
		.trim();
}

export function resolveCompilerPathFromSetting(model: WchProjectModel): string | undefined {
	const rootPath = getConfiguredMounRiverStudioPath();
	return resolveToolchainPaths(rootPath, model)?.gcc;
}

export function resolveToolchainPaths(
	rootPath: string,
	model: WchProjectModel,
): ResolvedToolchainPaths | undefined {
	if (!rootPath) {
		return undefined;
	}

	const { resolvedToolchain } = model;
	if (!resolvedToolchain.directoryName) {
		return undefined;
	}

	const binPath = path.join(rootPath, ...TOOLCHAIN_ROOT_SEGMENTS, resolvedToolchain.directoryName, 'bin');
	return {
		rootPath,
		make: path.join(rootPath, ...MAKE_EXECUTABLE_SEGMENTS),
		gcc: path.join(binPath, resolvedToolchain.executables.gcc),
		gpp: path.join(binPath, resolvedToolchain.executables.gpp),
		gdb: path.join(binPath, `${resolvedToolchain.executablePrefix}gdb.exe`),
		objcopy: path.join(binPath, resolvedToolchain.executables.objcopy),
		objdump: path.join(binPath, resolvedToolchain.executables.objdump),
		size: path.join(binPath, resolvedToolchain.executables.size),
	};
}

export function resolveOpenOcdPaths(rootPath: string): ResolvedOpenOcdPaths | undefined {
	if (!rootPath) {
		return undefined;
	}

	const openOcdRootPath = path.join(rootPath, ...OPENOCD_ROOT_SEGMENTS);
	const binPath = path.join(rootPath, ...OPENOCD_BIN_SEGMENTS);
	return {
		root: openOcdRootPath,
		executable: path.join(binPath, 'openocd.exe'),
		config: path.join(binPath, 'wch-riscv.cfg'),
		scripts: path.join(openOcdRootPath, 'share', 'openocd', 'scripts'),
	};
}

export function resolveMounRiverOpenOcdExecutable(
	openOcdPaths: ResolvedOpenOcdPaths,
	configuredExecutable: string,
): string | undefined {
	const value = normalizeMounRiverArgument(configuredExecutable);
	if (!value || isWchOpenOcdDefaultVariable(value)) {
		return openOcdPaths.executable;
	}

	const variablePath = resolveWchOpenOcdVariablePath(value, openOcdPaths.root);
	if (variablePath) {
		return variablePath;
	}

	return path.isAbsolute(value) ? value : undefined;
}

export function resolveMounRiverOpenOcdValue(
	openOcdPaths: ResolvedOpenOcdPaths,
	value: string,
): string {
	const normalizedValue = normalizeMounRiverArgument(value);
	if (isWchOpenOcdDefaultVariable(normalizedValue)) {
		return openOcdPaths.root;
	}

	return resolveWchOpenOcdVariablePath(normalizedValue, openOcdPaths.root) ?? normalizedValue;
}

export function normalizeMounRiverArgument(value: string): string {
	const trimmedValue = value.trim();
	if (trimmedValue.length < 2) {
		return trimmedValue;
	}

	const firstChar = trimmedValue[0];
	const lastChar = trimmedValue[trimmedValue.length - 1];
	if ((firstChar === '"' && lastChar === '"') || (firstChar === "'" && lastChar === "'")) {
		return trimmedValue.slice(1, -1).trim();
	}

	return trimmedValue;
}

function isWchOpenOcdDefaultVariable(value: string): boolean {
	return /^\$\{WCH:OpenOCD:[^}]+}$/.test(value);
}

function resolveWchOpenOcdVariablePath(value: string, openOcdRootPath: string): string | undefined {
	const match = /^\$\{WCH:OpenOCD:[^}]+}[/\\](.+)$/.exec(value);
	if (!match) {
		return undefined;
	}

	return path.join(openOcdRootPath, match[1]);
}

export function resolveToolchainDirectoryName(gdbExecutable: string): string | undefined {
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

export function resolveCompilerExecutableName(gdbExecutable: string): string | undefined {
	const toolExecutablePrefix = resolveToolExecutablePrefix(gdbExecutable);
	return toolExecutablePrefix ? `${toolExecutablePrefix}gcc.exe` : undefined;
}

export function resolveGdbExecutableName(gdbExecutable: string): string | undefined {
	const toolExecutablePrefix = resolveToolExecutablePrefix(gdbExecutable);
	return toolExecutablePrefix ? `${toolExecutablePrefix}gdb.exe` : undefined;
}

export function resolveToolExecutablePrefix(gdbExecutable: string): string | undefined {
	const matchedToolchainName = /\$\{WCH:Toolchain:([^}]+)\}/.exec(gdbExecutable)?.[1]?.trim();
	if (!matchedToolchainName) {
		return undefined;
	}

	switch (matchedToolchainName.toUpperCase()) {
		case 'GCC':
		case 'GCC8':
			return 'riscv-none-embed-';
		case 'GCC12':
			return 'riscv-wch-elf-';
		case 'GCC15':
			return 'riscv32-wch-elf-';
		default:
			return undefined;
	}
}

export function buildMarch(model: WchProjectModel): string {
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

export function normalizeLinkedFolderLocation(value: string): string {
	const normalizedValue = value.replace(/\\/g, '/');
	if (isAbsoluteOrVariablePath(normalizedValue)) {
		return normalizedValue;
	}

	return `\${workspaceFolder}/${normalizedValue.replace(/^\/+/g, '')}`;
}

export function mapProjectVirtualPath(linkedFolders: WchLinkedFolder[], value: string): string | null {
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

export function isAbsoluteOrVariablePath(value: string): boolean {
	return /^[A-Za-z]:\//.test(value)
		|| value.startsWith('//')
		|| value.startsWith('/')
		|| value.startsWith('${');
}
