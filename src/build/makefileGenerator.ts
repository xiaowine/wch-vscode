import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ResolvedBuildProject, ResolvedSourceFile } from './buildProjectResolver';
import { buildMarch } from './buildShared';
import { resolveProjectFileSystemPath } from './buildProjectResolver';

const textEncoder = new TextEncoder();

export async function generateBuildFiles(project: ResolvedBuildProject): Promise<void> {
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(project.outputDirectory));

	const subdirGroups = groupSourcesBySubdirectory(project.sources);
	for (const sourceGroup of subdirGroups.values()) {
		const subdirPath = path.dirname(path.join(project.outputDirectory, sourceGroup.subdirMakefilePath));
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(subdirPath));
	}

	await writeBuildFile(project.outputDirectory, 'makefile', buildMakefile(project, subdirGroups));
	await writeBuildFile(project.outputDirectory, 'sources.mk', buildSourcesMk(project, subdirGroups));
	await writeBuildFile(project.outputDirectory, 'objects.mk', buildObjectsMk(project));

	for (const sourceGroup of subdirGroups.values()) {
		await writeBuildFile(
			project.outputDirectory,
			sourceGroup.subdirMakefilePath,
			buildSubdirMk(project, sourceGroup.sources),
		);
	}
}

function buildMakefile(
	project: ResolvedBuildProject,
	subdirGroups: Map<string, { subdirMakefilePath: string; sources: ResolvedSourceFile[] }>,
): string {
	const mapFlag = project.mapFilePath
		? [`-Wl,-Map="${toBuildPath(project, project.mapFilePath)}"`]
		: [];
	const linkerFlags = joinArgs([
		...project.model.build.linker.args,
		`-T"${toBuildPath(project, project.linkerScriptPath)}"`,
		...project.model.build.linker.librarySearchPaths.map((value) =>
			`-L"${toBuildPath(project, resolveProjectFileSystemPath(project.model, value))}"`,
		),
		...mapFlag,
	]);
	const libraries = joinArgs(project.model.build.linker.libraries.map((library) => `-l${library}`));
	const otherObjects = joinArgs(project.otherObjects.map((value) => `"${toBuildPath(project, value)}"`));
	const flashFlags = joinArgs(project.model.build.postBuild.flashArgs);
	const listFlags = joinArgs(project.model.build.postBuild.listArgs);
	const sizeFlags = joinArgs(project.model.build.postBuild.sizeArgs);
	const includeLines = Array.from(subdirGroups.values())
		.map((group) => `-include ${escapeMakePath(group.subdirMakefilePath)}`)
		.join('\n');
	const allTargets = [
		'$(ELF)',
		project.model.build.postBuild.createFlash ? '$(HEX)' : '',
		project.model.build.postBuild.createBinary ? '$(BIN)' : '',
		project.model.build.postBuild.createList ? '$(LST)' : '',
		project.model.build.postBuild.printSize ? 'size-report' : '',
	].filter((value) => value.length > 0);
	const buildTargets = allTargets.join(' ');
	const preBuildCommand = resolveBuildHookCommand(project, project.model.build.preScript);
	const postBuildCommand = resolveBuildHookCommand(project, project.model.build.postScript);
	const cleanCommands = buildCleanCommands(project);

	return [
		'SHELL := cmd',
		'.DELETE_ON_ERROR:',
		'.PHONY: all build-main pre-build post-build clean size-report',
		'',
		`CC := ${toBuildPath(project, project.toolchainPaths.gcc)}`,
		`CXX := ${toBuildPath(project, project.toolchainPaths.gpp)}`,
		`OBJCOPY := ${toBuildPath(project, project.toolchainPaths.objcopy)}`,
		`OBJDUMP := ${toBuildPath(project, project.toolchainPaths.objdump)}`,
		`SIZE := ${toBuildPath(project, project.toolchainPaths.size)}`,
		`LD := ${project.hasCppSources ? '$(CXX)' : '$(CC)'}`,
		`ELF := ${path.basename(project.elfPath)}`,
		`HEX := ${path.basename(project.hexPath)}`,
		`BIN := ${path.basename(project.binPath)}`,
		`LST := ${path.basename(project.lstPath)}`,
		`LDFLAGS := ${linkerFlags}`,
		`LIBS := ${libraries}`,
		`OTHER_OBJS := ${otherObjects}`,
		`FLASH_FLAGS := ${flashFlags}`,
		`LIST_FLAGS := ${listFlags}`,
		`SIZE_FLAGS := ${sizeFlags}`,
		'',
		'all: post-build',
		'',
		'build-main: pre-build' + (buildTargets ? ` ${buildTargets}` : ''),
		'',
		'pre-build:',
		...(preBuildCommand
			? [
				'\t@echo Running pre-build script',
				`\t${preBuildCommand}`,
			]
			: ['\t@echo Pre-build step skipped']),
		'',
		'post-build: build-main',
		...(postBuildCommand
			? [
				'\t@echo Running post-build script',
				`\t${postBuildCommand}`,
			]
			: ['\t@echo Post-build step skipped']),
		'',
		'include sources.mk',
		'include objects.mk',
		includeLines,
		'-include $(DEPS)',
		'',
		'$(ELF): $(OBJS)',
		'\t@echo Linking target: $@',
		'\t"$(LD)" -o "$@" $(OBJS) $(OTHER_OBJS) $(LDFLAGS) $(LIBS)',
		'\t@echo Finished building target: $@',
		'',
		project.model.build.postBuild.createFlash
			? [
				'$(HEX): $(ELF)',
				'\t@echo Creating flash image: $@',
				'\t"$(OBJCOPY)" $(FLASH_FLAGS) "$<" "$@"',
				'',
			].join('\n')
			: '',
		project.model.build.postBuild.createBinary
			? [
				'$(BIN): $(ELF)',
				'\t@echo Creating binary image: $@',
				'\t"$(OBJCOPY)" -O binary "$<" "$@"',
				'',
			].join('\n')
			: '',
		project.model.build.postBuild.createList
			? [
				'$(LST): $(ELF)',
				'\t@echo Creating list file: $@',
				'\t"$(OBJDUMP)" $(LIST_FLAGS) "$<" > "$@"',
				'',
			].join('\n')
			: '',
		project.model.build.postBuild.printSize
			? [
				'size-report: $(ELF)',
				'\t@echo Printing size report',
				'\t"$(SIZE)" $(SIZE_FLAGS) "$<"',
				'',
			].join('\n')
			: '',
		'clean:',
		'\t@echo Cleaning build directory',
		...cleanCommands,
		'',
	].filter((value) => value.length > 0).join('\n');
}

function buildSourcesMk(
	project: ResolvedBuildProject,
	subdirGroups: Map<string, { subdirMakefilePath: string; sources: ResolvedSourceFile[] }>,
): string {
	const cSources = project.sources
		.filter((source) => source.language === 'c')
		.map((source) => escapeMakePath(toBuildPath(project, source.sourcePath)));
	const cppSources = project.sources
		.filter((source) => source.language === 'cpp')
		.map((source) => escapeMakePath(toBuildPath(project, source.sourcePath)));
	const asmSources = project.sources
		.filter((source) => source.language === 'asm')
		.map((source) => escapeMakePath(toBuildPath(project, source.sourcePath)));
	const subdirectories = Array.from(subdirGroups.keys()).sort((left, right) => left.localeCompare(right, 'en'));

	return [
		`C_SRCS :=${formatMakeList(cSources)}`,
		`CPP_SRCS :=${formatMakeList(cppSources)}`,
		`ASM_SRCS :=${formatMakeList(asmSources)}`,
		`SUBDIRS :=${formatMakeList(subdirectories.map((value) => escapeMakePath(value)))}`,
		'',
	].join('\n');
}

function buildObjectsMk(project: ResolvedBuildProject): string {
	const objects = project.sources.map((source) => escapeMakePath(source.objectPath));
	const dependencies = project.sources.map((source) => escapeMakePath(source.dependencyPath));
	return [
		`OBJS :=${formatMakeList(objects)}`,
		`DEPS :=${formatMakeList(dependencies)}`,
		'',
	].join('\n');
}

function buildSubdirMk(project: ResolvedBuildProject, sources: ResolvedSourceFile[]): string {
	return [
		...sources.map((source) => buildSourceRule(project, source)),
		'',
	].join('\n');
}

function buildSourceRule(project: ResolvedBuildProject, source: ResolvedSourceFile): string {
	const sourcePath = escapeMakePath(toBuildPath(project, source.sourcePath));
	const objectPath = escapeMakePath(source.objectPath);
	const dependencyPath = toToolPath(source.dependencyPath);
	const compileTool = source.language === 'cpp' ? '$(CXX)' : '$(CC)';
	const compileFlags = joinArgs(buildCompileArgs(project, source.language));

	return [
		`${objectPath}: ${sourcePath}`,
		`\t@echo Building file: ${source.logicalPath}`,
		`\t"${compileTool}" ${compileFlags} -MMD -MP -MF"${dependencyPath}" -MT"${toToolPath(source.objectPath)}" -c -o "${toToolPath(source.objectPath)}" "${toBuildPath(project, source.sourcePath)}"`,
		`\t@echo Finished building: ${source.logicalPath}`,
		'',
	].join('\n');
}

function buildCompileArgs(project: ResolvedBuildProject, language: ResolvedSourceFile['language']): string[] {
	const model = project.model;
	if (language === 'asm') {
		const commonIncludePaths = uniqueStrings([...model.build.includePaths, ...model.build.compile.assembler.includePaths]);
		const commonSystemIncludePaths = uniqueStrings([
			...model.build.includeSystemPaths,
			...model.build.compile.assembler.includeSystemPaths,
		]);
		const commonIncludeFiles = uniqueStrings([...model.build.includeFiles, ...model.build.compile.assembler.includeFiles]);
		const commonDefines = uniqueStrings([...model.build.definedSymbols, ...model.build.compile.assembler.definedSymbols]);

		return uniqueStrings([
			...model.build.compile.assembler.args,
			...buildIncludeArgs(project, commonIncludePaths, commonSystemIncludePaths),
			...buildForcedIncludeArgs(project, commonIncludeFiles),
			...buildDefineArgs(commonDefines),
		]);
	}

	const compiler = language === 'cpp' ? model.build.compile.cpp : model.build.compile.c;
	const commonIncludePaths = uniqueStrings([...model.build.includePaths, ...compiler.includePaths]);
	const commonSystemIncludePaths = uniqueStrings([
		...model.build.includeSystemPaths,
		...compiler.includeSystemPaths,
	]);
	const commonIncludeFiles = uniqueStrings([...model.build.includeFiles, ...compiler.includeFiles]);
	const commonDefines = uniqueStrings([...model.build.definedSymbols, ...compiler.definedSymbols]);

	return uniqueStrings([
		...compiler.args,
		...buildIncludeArgs(project, commonIncludePaths, commonSystemIncludePaths),
		...buildForcedIncludeArgs(project, commonIncludeFiles),
		...buildDefineArgs(commonDefines),
	]);
}

function buildIncludeArgs(project: ResolvedBuildProject, includePaths: string[], includeSystemPaths: string[]): string[] {
	return [
		...uniqueStrings(includePaths).map((value) =>
			`-I"${toBuildPath(project, resolveProjectFileSystemPath(project.model, value))}"`,
		),
		...uniqueStrings(includeSystemPaths).map((value) =>
			`-isystem "${toBuildPath(project, resolveProjectFileSystemPath(project.model, value))}"`,
		),
	];
}

function buildForcedIncludeArgs(project: ResolvedBuildProject, includeFiles: string[]): string[] {
	return uniqueStrings(includeFiles).flatMap((value) => [
		'-include',
		`"${toBuildPath(project, resolveProjectFileSystemPath(project.model, value))}"`,
	]);
}

function buildDefineArgs(defines: string[]): string[] {
	return uniqueStrings(defines).map((value) => `-D${value}`);
}

function groupSourcesBySubdirectory(
	sources: ResolvedSourceFile[],
): Map<string, { subdirMakefilePath: string; sources: ResolvedSourceFile[] }> {
	const groups = new Map<string, { subdirMakefilePath: string; sources: ResolvedSourceFile[] }>();

	for (const source of sources) {
		const groupKey = source.subdirMakefilePath;
		const existingGroup = groups.get(groupKey);
		if (existingGroup) {
			existingGroup.sources.push(source);
			continue;
		}

		groups.set(groupKey, {
			subdirMakefilePath: source.subdirMakefilePath,
			sources: [source],
		});
	}

	return groups;
}

function formatMakeList(values: string[]): string {
	if (values.length === 0) {
		return '';
	}

	return ` \\\n\t${values.join(' \\\n\t')}`;
}

function joinArgs(values: string[]): string {
	return values.filter((value) => value.length > 0).join(' ');
}

function buildCleanCommands(project: ResolvedBuildProject): string[] {
	const generatedFiles = uniqueStrings([
		'sources.mk',
		'objects.mk',
		...project.sources.map((source) => source.objectPath),
		...project.sources.map((source) => source.dependencyPath),
		...project.sources.map((source) => source.subdirMakefilePath),
		path.basename(project.elfPath),
		project.model.build.postBuild.createFlash ? path.basename(project.hexPath) : '',
		project.model.build.postBuild.createBinary ? path.basename(project.binPath) : '',
		project.model.build.postBuild.createList ? path.basename(project.lstPath) : '',
		project.mapFilePath ? path.basename(project.mapFilePath) : '',
	]);
	const generatedDirectories = uniqueStrings(project.sources
		.flatMap((source) => {
			const directories: string[] = [];
			for (const filePath of [source.objectPath, source.dependencyPath, source.subdirMakefilePath]) {
				let directory = path.dirname(filePath);
				while (directory && directory !== '.' && directory !== path.sep) {
					directories.push(directory);
					directory = path.dirname(directory);
				}
			}
			return directories;
		}))
		.sort((left, right) => right.localeCompare(left, 'en'));

	return [
		...generatedFiles.map((value) => `\t@if exist "${toCmdPath(value)}" del /f /q "${toCmdPath(value)}"`),
		...generatedDirectories.map((value) => `\t@if exist "${toCmdPath(value)}" rmdir /s /q "${toCmdPath(value)}"`),
	];
}

function toCmdPath(value: string): string {
	// cmd 的 del/rmdir 会把正斜杠解析成参数，clean 命令必须使用反斜杠。
	return value.replace(/\//g, '\\');
}

function resolveBuildHookCommand(project: ResolvedBuildProject, script: string): string {
	const trimmed = script.trim();
	if (!trimmed) {
		return '';
	}

	const replacedProjectPath = trimmed.replaceAll('${project}', toBuildPath(project, project.model.identity.folderPath));
	if (/[|&<>]/.test(replacedProjectPath) || replacedProjectPath.startsWith('"')) {
		return replacedProjectPath;
	}

	const commandPath = path.isAbsolute(replacedProjectPath)
		? toBuildPath(project, replacedProjectPath)
		: replacedProjectPath.startsWith('.')
			? replacedProjectPath
			: toBuildPath(project, path.resolve(project.model.identity.folderPath, replacedProjectPath));
	return `"${toToolPath(commandPath)}"`;
}

function toBuildPath(project: ResolvedBuildProject, fileSystemPath: string): string {
	// GNU make 在 Windows 上通过 ANSI 接口访问文件，无法正确读取 UTF-8 中文路径。
	// 构建目录与工程通常共享同一前缀，改用相对路径即可让工具链只看到 ASCII 字符。
	const relativePath = path.relative(project.outputDirectory, fileSystemPath);
	if (relativePath && !path.isAbsolute(relativePath) && !/[^\x20-\x7E]/.test(relativePath)) {
		return relativePath.replace(/\\/g, '/');
	}

	return toToolPath(fileSystemPath);
}

function toToolPath(value: string): string {
	return value.replace(/\\/g, '/');
}

function escapeMakePath(value: string): string {
	return value.replace(/([ #])/g, '\\$1');
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

async function writeBuildFile(outputDirectory: string, relativePath: string, content: string): Promise<void> {
	const fileUri = vscode.Uri.file(path.join(outputDirectory, relativePath));
	await vscode.workspace.fs.writeFile(fileUri, textEncoder.encode(`${content.trimEnd()}\n`));
}
