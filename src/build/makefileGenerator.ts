import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WchProjectModel } from '../models/WchProjectModel';
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
			buildSubdirMk(project.model, sourceGroup.sources),
		);
	}
}

function buildMakefile(
	project: ResolvedBuildProject,
	subdirGroups: Map<string, { subdirMakefilePath: string; sources: ResolvedSourceFile[] }>,
): string {
	const mapFlag = project.mapFilePath
		? [`-Wl,-Map="${toToolPath(project.mapFilePath)}"`]
		: [];
	const linkerFlags = joinArgs([
		...project.model.linker.args,
		`-T"${toToolPath(project.linkerScriptPath)}"`,
		...project.model.linker.librarySearchPaths.map((value) =>
			`-L"${toToolPath(resolveProjectFileSystemPath(project.model, value))}"`,
		),
		...mapFlag,
	]);
	const libraries = joinArgs(project.model.linker.libraries.map((library) => `-l${library}`));
	const otherObjects = joinArgs(project.otherObjects.map((value) => `"${toToolPath(value)}"`));
	const flashFlags = joinArgs(project.model.postBuild.flashArgs);
	const listFlags = joinArgs(project.model.postBuild.listArgs);
	const sizeFlags = joinArgs(project.model.postBuild.sizeArgs);
	const includeLines = Array.from(subdirGroups.values())
		.map((group) => `-include ${escapeMakePath(group.subdirMakefilePath)}`)
		.join('\n');
	const allTargets = [
		'$(ELF)',
		project.model.postBuild.createFlash ? '$(HEX)' : '',
		project.model.postBuild.createList ? '$(LST)' : '',
		project.model.postBuild.printSize ? '$(SIZ)' : '',
	].filter((value) => value.length > 0);

	return [
		'SHELL := cmd',
		'.DELETE_ON_ERROR:',
		'.PHONY: all clean',
		'',
		`CC := ${toToolPath(project.toolchainPaths.gcc)}`,
		`CXX := ${toToolPath(project.toolchainPaths.gpp)}`,
		`OBJCOPY := ${toToolPath(project.toolchainPaths.objcopy)}`,
		`OBJDUMP := ${toToolPath(project.toolchainPaths.objdump)}`,
		`SIZE := ${toToolPath(project.toolchainPaths.size)}`,
		`LD := ${project.hasCppSources ? '$(CXX)' : '$(CC)'}`,
		`ELF := ${path.basename(project.elfPath)}`,
		`HEX := ${path.basename(project.hexPath)}`,
		`LST := ${path.basename(project.lstPath)}`,
		`SIZ := ${path.basename(project.sizPath)}`,
		`LDFLAGS := ${linkerFlags}`,
		`LIBS := ${libraries}`,
		`OTHER_OBJS := ${otherObjects}`,
		`FLASH_FLAGS := ${flashFlags}`,
		`LIST_FLAGS := ${listFlags}`,
		`SIZE_FLAGS := ${sizeFlags}`,
		'',
		'all: ' + allTargets.join(' '),
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
		project.model.postBuild.createFlash
			? [
				'$(HEX): $(ELF)',
				'\t@echo Creating flash image: $@',
				'\t"$(OBJCOPY)" $(FLASH_FLAGS) "$<" "$@"',
				'',
			].join('\n')
			: '',
		project.model.postBuild.createList
			? [
				'$(LST): $(ELF)',
				'\t@echo Creating list file: $@',
				'\t"$(OBJDUMP)" $(LIST_FLAGS) "$<" > "$@"',
				'',
			].join('\n')
			: '',
		project.model.postBuild.printSize
			? [
				'$(SIZ): $(ELF)',
				'\t@echo Printing size report: $@',
				'\t"$(SIZE)" $(SIZE_FLAGS) "$<" > "$@"',
				'',
			].join('\n')
			: '',
		'clean:',
		'\t@echo Cleaning build directory',
		'\t@for %D in (*) do @if exist "%D" @if /I not "%D"=="." rmdir /s /q "%D" 2>nul',
		'\t@for %F in (*.o *.d *.mk *.elf *.hex *.lst *.siz *.map) do @if exist "%F" del /f /q "%F"',
		'',
	].filter((value) => value.length > 0).join('\n');
}

function buildSourcesMk(
	project: ResolvedBuildProject,
	subdirGroups: Map<string, { subdirMakefilePath: string; sources: ResolvedSourceFile[] }>,
): string {
	const cSources = project.sources
		.filter((source) => source.language === 'c')
		.map((source) => escapeMakePath(toToolPath(source.sourcePath)));
	const cppSources = project.sources
		.filter((source) => source.language === 'cpp')
		.map((source) => escapeMakePath(toToolPath(source.sourcePath)));
	const asmSources = project.sources
		.filter((source) => source.language === 'asm')
		.map((source) => escapeMakePath(toToolPath(source.sourcePath)));
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

function buildSubdirMk(model: WchProjectModel, sources: ResolvedSourceFile[]): string {
	return [
		...sources.map((source) => buildSourceRule(model, source)),
		'',
	].join('\n');
}

function buildSourceRule(model: WchProjectModel, source: ResolvedSourceFile): string {
	const sourcePath = escapeMakePath(toToolPath(source.sourcePath));
	const objectPath = escapeMakePath(source.objectPath);
	const dependencyPath = toToolPath(source.dependencyPath);
	const compileTool = source.language === 'cpp' ? '$(CXX)' : '$(CC)';
	const compileFlags = joinArgs(buildCompileArgs(model, source.language));

	return [
		`${objectPath}: ${sourcePath}`,
		`\t@echo Building file: ${source.logicalPath}`,
		`\t"${compileTool}" ${compileFlags} -MMD -MP -MF"${dependencyPath}" -MT"${toToolPath(source.objectPath)}" -c -o "${toToolPath(source.objectPath)}" "${toToolPath(source.sourcePath)}"`,
		`\t@echo Finished building: ${source.logicalPath}`,
		'',
	].join('\n');
}

function buildCompileArgs(model: WchProjectModel, language: ResolvedSourceFile['language']): string[] {
	if (language === 'asm') {
		return uniqueStrings([
			...model.assembler.args,
			...buildIncludeArgs(model, model.assembler.includePaths, model.assembler.includeSystemPaths),
			...buildForcedIncludeArgs(model, model.assembler.includeFiles),
			...buildDefineArgs(model.assembler.definedSymbols),
		]);
	}

	const compiler = language === 'cpp' ? model.cpp : model.c;
	const commonIncludePaths = uniqueStrings([...model.build.includePaths, ...compiler.includePaths]);
	const commonSystemIncludePaths = uniqueStrings([
		...model.build.includeSystemPaths,
		...compiler.includeSystemPaths,
	]);
	const commonIncludeFiles = uniqueStrings([...model.build.includeFiles, ...compiler.includeFiles]);
	const commonDefines = uniqueStrings([...model.build.definedSymbols, ...compiler.definedSymbols]);

	return uniqueStrings([
		...compiler.args,
		...buildIncludeArgs(model, commonIncludePaths, commonSystemIncludePaths),
		...buildForcedIncludeArgs(model, commonIncludeFiles),
		...buildDefineArgs(commonDefines),
	]);
}

function buildIncludeArgs(model: WchProjectModel, includePaths: string[], includeSystemPaths: string[]): string[] {
	return [
		...uniqueStrings(includePaths).map((value) =>
			`-I"${toToolPath(resolveProjectFileSystemPath(model, value))}"`,
		),
		...uniqueStrings(includeSystemPaths).map((value) =>
			`-isystem "${toToolPath(resolveProjectFileSystemPath(model, value))}"`,
		),
	];
}

function buildForcedIncludeArgs(model: WchProjectModel, includeFiles: string[]): string[] {
	return uniqueStrings(includeFiles).flatMap((value) => [
		'-include',
		`"${toToolPath(resolveProjectFileSystemPath(model, value))}"`,
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
