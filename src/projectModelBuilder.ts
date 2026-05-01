import type { WchLinkedFolder, WchProjectModel } from './models/WchProjectModel';
import type { ParsedProjectPair, ParsedProjectFile, ParsedWchProject } from './projectState';

// 从已解析的项目文件中提炼出精简后的业务模型。
export function buildWchProjectModels(project: ParsedWchProject): WchProjectModel[] {
	return project.projectPairs
		.map((pair) => buildWchProjectModel(project, pair))
		.filter((model): model is WchProjectModel => model !== null);
}

// 当前仅支持 RISC-V 工程，其他工具链直接标记为不支持。
export function getUnsupportedProjectReason(project: ParsedWchProject): string | undefined {
	for (const pair of project.projectPairs) {
		const wvproj = asRecord(pair.wvproj.data);
		const basic = asRecord(wvproj?.basic);
		const chipInfo = asRecord(basic?.chipInfo);
		const toolchain = getString(chipInfo?.toolchain)?.trim();

		if (toolchain && toolchain.toUpperCase() !== 'RISC-V') {
			return `暂不支持 ${toolchain} 工程，仅支持 RISC-V 工程`;
		}
	}

	return undefined;
}

// 组合 .wvproj、.launch、.cproject 中有效字段，生成单个项目模型。
function buildWchProjectModel(project: ParsedWchProject, pair: ParsedProjectPair): WchProjectModel | null {
	const wvproj = asRecord(pair.wvproj.data);
	if (!wvproj) {
		return null;
	}

	const launchAttributes = createLaunchAttributeMaps(pair.launch.data);
	const cprojectInfo = extractCprojectInfo(project.cprojectFiles);
	const basic = asRecord(wvproj.basic);
	const chipInfo = asRecord(basic?.chipInfo);
	const toolchain = getString(chipInfo?.toolchain)?.trim();
	if (toolchain && toolchain.toUpperCase() !== 'RISC-V') {
		return null;
	}

	const buildConfiguration = getFirstConfiguration(wvproj);
	const buildArtifact = asRecord(buildConfiguration?.buildArtifact);
	const ccompiler = asRecord(buildConfiguration?.ccompiler);
	const cIncludes = asRecord(ccompiler?.includes);
	const cPreprocessor = asRecord(ccompiler?.preprocessor);
	const cCompilerOptimization = asRecord(ccompiler?.optimization);
	const cCompilerMisc = asRecord(ccompiler?.miscellaneous);
	const cppcompiler = asRecord(buildConfiguration?.cppcompiler);
	const cppCompilerOptimization = asRecord(cppcompiler?.optimization);
	const cLinker = asRecord(buildConfiguration?.clinker);
	const cLinkerGeneral = asRecord(cLinker?.general);
	const cLinkerLibraries = asRecord(cLinker?.libraries);
	const optimization = asRecord(buildConfiguration?.optimization);
	const riscvTarget = asRecord(buildConfiguration?.riscvTargetProcessor);
	const debugConfigurations = asRecord(wvproj.debugConfigurations);
	const openOcdCfg = asRecord(debugConfigurations?.openOCDCfg);
	const gdbCfg = asRecord(debugConfigurations?.gdbCfg);
	const startup = asRecord(debugConfigurations?.startup);
	const runCommands = asRecord(startup?.runCommands);
	const initCommands = asRecord(startup?.initCommands);
	const flashConfig = asRecord(wvproj.flashConfig);

	return {
		baseName: pair.baseName,
		folderPath: project.folderPath,
		folderName: project.folderName,
		// linkedFolders 表示 MRS 工程里额外挂进来的目录，后续会用于补充 VS Code 的索引路径。
		linkedFolders: extractLinkedFolders(basic?.linkedFolders),
		files: {
			cproject: project.cprojectFiles.map((file) => file.filePath),
			launch: pair.launch.filePath,
			wvproj: pair.wvproj.filePath,
		},
		project: {
			name: getString(basic?.projectName) ?? pair.baseName,
			projectType: getString(basic?.projectType) ?? '',
			architecture: getString(basic?.architecture) ?? '',
			artifact: {
				name: getString(buildArtifact?.artifact_name) ?? '',
				extension: getString(buildArtifact?.artifact_extension) ?? '',
				outputPrefix: getString(buildArtifact?.output_prefix) ?? '',
				outputFile: getString(launchAttributes.strings.get('org.eclipse.cdt.launch.PROGRAM_NAME'))
					?? getString(debugConfigurations?.reserve && asRecord(debugConfigurations.reserve)?.PROGRAM_NAME)
					?? '',
			},
		},
		chip: {
			vendor: getString(chipInfo?.vendor) ?? '',
			series: getString(chipInfo?.series) ?? '',
			mcu: getString(chipInfo?.mcu) ?? '',
			rtos: getString(chipInfo?.rtos) ?? '',
			toolchain: toolchain ?? '',
			debugLink: getString(chipInfo?.link) ?? '',
			svdPath: getString(debugConfigurations?.svdpath)
				?? getString(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.svdPath'))
				?? '',
		},
		build: {
			configName: getString(buildConfiguration?.name) ?? '',
			toolchainName: cprojectInfo.toolchainName,
			commandPrefix: cprojectInfo.commandPrefix,
			compilerPath: buildCompilerPath(cprojectInfo.commandPrefix),
			targetArchitecture: cprojectInfo.targetArchitecture || getString(riscvTarget?.architecture) || '',
			targetAbi: cprojectInfo.targetAbi || getString(riscvTarget?.integer_ABI) || '',
			riscvExtensions: collectRiscvExtensions(riscvTarget),
			optimizationLevel: getString(optimization?.level) ?? '',
			cStandard: normalizeCStandard(getString(cCompilerOptimization?.language_standard)),
			cppStandard: normalizeCppStandard(getString(cppCompilerOptimization?.cpp_language_standard)),
			includePaths: getStringArray(cIncludes?.include_paths),
			includeSystemPaths: getStringArray(cIncludes?.include_system_paths),
			includeFiles: getStringArray(cIncludes?.include_files),
			definedSymbols: getStringArray(cPreprocessor?.defined_symbols),
			otherCompilerFlags: splitSpaceFlags(getString(cCompilerMisc?.other_compiler_flags)),
			linkerScript: getFirstString(cLinkerGeneral?.scriptFiles),
			libraries: getStringArray(cLinkerLibraries?.libraries),
			librarySearchPaths: getStringArray(cLinkerLibraries?.library_search_path),
			sourceExcludes: cprojectInfo.sourceExcludes.length > 0
				? cprojectInfo.sourceExcludes
				: getStringArray(buildConfiguration?.excludeResources),
		},
		debug: {
			programName: getString(launchAttributes.strings.get('org.eclipse.cdt.launch.PROGRAM_NAME'))
				?? getString(asRecord(debugConfigurations?.reserve)?.PROGRAM_NAME)
				?? '',
			gdbExecutable: getString(asRecord(gdbCfg)?.executable)
				?? getString(launchAttributes.strings.get('org.eclipse.cdt.dsf.gdb.DEBUG_NAME'))
				?? '',
			openOcdExecutable: getString(openOcdCfg?.executable)
				?? getString(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.openocd.gdbServerExecutable'))
				?? '',
			openOcdConfigOptions: getStringArray(openOcdCfg?.configOptions).length > 0
				? getStringArray(openOcdCfg?.configOptions)
				: getLaunchCommands(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.openocd.gdbServerOther')),
			host: getString(openOcdCfg?.host)
				?? getString(launchAttributes.strings.get('org.eclipse.cdt.debug.gdbjtag.core.ipAddress'))
				?? 'localhost',
			gdbPort: getNumber(openOcdCfg?.gdbport)
				?? getNumber(launchAttributes.ints.get('com.mounriver.debug.gdbjtag.openocd.gdbServerGdbPortNumber'))
				?? 0,
			telnetPort: getNumber(openOcdCfg?.telnetport)
				?? getNumber(launchAttributes.ints.get('com.mounriver.debug.gdbjtag.openocd.gdbServerTelnetPortNumber'))
				?? 0,
			tclPort: getNumber(openOcdCfg?.tclport)
				?? getNumber(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.openocd.gdbServerTclPortNumber'))
				?? 0,
			startupCommands: getStringArray(gdbCfg?.commands).length > 0
				? getStringArray(gdbCfg?.commands)
				: getLaunchCommands(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.openocd.gdbClientOtherCommands')),
			stopAt: getString(runCommands?.setBreakAt)
				?? getString(launchAttributes.strings.get('org.eclipse.cdt.debug.gdbjtag.core.stopAt'))
				?? '',
			firstResetType: getString(initCommands?.initResetType)
				?? getString(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.openocd.firstResetType'))
				?? '',
			secondResetType: getString(runCommands?.runResetType)
				?? getString(launchAttributes.strings.get('com.mounriver.debug.gdbjtag.openocd.secondResetType'))
				?? '',
		},
		flash: {
			targetPath: getString(flashConfig?.target_path) ?? '',
			address: getString(flashConfig?.address) ?? '',
			erase: getBoolean(flashConfig?.erase) ?? false,
			program: getBoolean(flashConfig?.program) ?? false,
			verify: getBoolean(flashConfig?.verify) ?? false,
			reset: getBoolean(flashConfig?.reset) ?? false,
		},
	};
}

// 提取 .launch 中的键值属性，便于按 key 读取。
function createLaunchAttributeMaps(data: unknown): {
	strings: Map<string, string>;
	ints: Map<string, number>;
} {
	const strings = new Map<string, string>();
	const ints = new Map<string, number>();
	const root = asRecord(data);
	const launchConfiguration = asRecord(root?.launchConfiguration);

	for (const item of asArray(launchConfiguration?.stringAttribute)) {
		const attribute = asRecord(item);
		const key = getString(attribute?.['@_key']);
		const value = getString(attribute?.['@_value']);

		if (key && value !== null) {
			strings.set(key, value);
		}
	}

	for (const item of asArray(launchConfiguration?.intAttribute)) {
		const attribute = asRecord(item);
		const key = getString(attribute?.['@_key']);
		const value = getNumber(attribute?.['@_value']);

		if (key && value !== null) {
			ints.set(key, value);
		}
	}

	return { strings, ints };
}

// 从 .cproject 中抽取少量 .wvproj 没有或不够直观的构建信息。
function extractCprojectInfo(cprojectFiles: ParsedProjectFile[]): {
	toolchainName: string;
	commandPrefix: string;
	targetArchitecture: string;
	targetAbi: string;
	sourceExcludes: string[];
} {
	for (const file of cprojectFiles) {
		const root = asRecord(file.data);
		const cproject = asRecord(root?.cproject);
		const storageModules = asArray(cproject?.storageModule).map(asRecord).filter(isRecord);
		const settingsModule = storageModules.find((item) => item?.['@_moduleId'] === 'org.eclipse.cdt.core.settings');
		const cconfiguration = asRecord(settingsModule?.cconfiguration);
		const cconfigurationModules = asArray(cconfiguration?.storageModule).map(asRecord).filter(isRecord);
		const buildModule = cconfigurationModules.find((item) => item?.['@_moduleId'] === 'cdtBuildSystem');
		const configuration = asRecord(buildModule?.configuration);
		const folderInfo = asRecord(configuration?.folderInfo);
		const toolChain = asRecord(folderInfo?.toolChain);
		const options = asArray(toolChain?.option).map(asRecord).filter(isRecord);

		const toolchainName = getOptionValue(options, 'option.toolchain.name');
		const commandPrefix = getOptionValue(options, 'option.command.prefix');
		const targetArchitecture = trimOptionEnumValue(getOptionValue(options, 'option.target.isa.base'));
		const targetAbi = trimOptionEnumValue(getOptionValue(options, 'option.target.abi.integer'));
		const sourceEntry = asRecord(asRecord(configuration?.sourceEntries)?.entry);
		const sourceExcludes = splitPipeList(getString(sourceEntry?.['@_excluding']));

		return {
			toolchainName: toolchainName ?? '',
			commandPrefix: commandPrefix ?? '',
			targetArchitecture: targetArchitecture ?? '',
			targetAbi: targetAbi ?? '',
			sourceExcludes,
		};
	}

	return {
		toolchainName: '',
		commandPrefix: '',
		targetArchitecture: '',
		targetAbi: '',
		sourceExcludes: [],
	};
}

// 取第一个构建配置，当前样例只有一个 obj 配置。
function getFirstConfiguration(wvproj: Record<string, unknown>): Record<string, unknown> | null {
	const buildConfig = asRecord(wvproj.buildConfig);
	const configurations = asArray(buildConfig?.configurations);
	return asRecord(configurations[0]);
}

// 汇总 RISC-V 扩展开关，方便后续直接展示或生成参数。
function collectRiscvExtensions(target: Record<string, unknown> | null): string[] {
	if (!target) {
		return [];
	}

	const extensions: string[] = [];
	if (getBoolean(target.multiply_extension)) {
		extensions.push('M');
	}
	if (getBoolean(target.atomic_extension)) {
		extensions.push('A');
	}
	if (getBoolean(target.compressed_extension)) {
		extensions.push('C');
	}
	if (getBoolean(target.extra_compressed_extension)) {
		extensions.push('XW');
	}
	if (getBoolean(target.bit_extension)) {
		extensions.push('B');
	}
	if (getBoolean(target.multiplication_subset_of_the_M_extension)) {
		extensions.push('Zmmul');
	}

	return extensions;
}

function buildCompilerPath(commandPrefix: string): string {
	if (!commandPrefix) {
		return '';
	}

	return `${commandPrefix}gcc`;
}

function normalizeCStandard(value: string | null): string {
	if (!value) {
		return '';
	}

	return value.replace(/^gnu(\d+)/, 'gnu$1');
}

function normalizeCppStandard(value: string | null): string {
	if (!value) {
		return '';
	}

	const match = /^gnu(?:cpp|\+\+)?(\d+)$/.exec(value);
	if (match) {
		return `gnu++${match[1]}`;
	}

	const cppMatch = /^c(?:pp|\+\+)?(\d+)$/.exec(value);
	if (cppMatch) {
		return `c++${cppMatch[1]}`;
	}

	return value;
}

function getOptionValue(options: Record<string, unknown>[], superClassSuffix: string): string | null {
	const option = options.find((item) => getString(item['@_superClass'])?.includes(superClassSuffix));
	return getString(option?.['@_value']);
}

function trimOptionEnumValue(value: string | null): string | null {
	if (!value) {
		return null;
	}

	const parts = value.split('.');
	return parts[parts.length - 1] ?? value;
}

function getLaunchCommands(value: unknown): string[] {
	const text = getString(value);
	if (!text) {
		return [];
	}

	return text
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function splitPipeList(value: string | null): string[] {
	if (!value) {
		return [];
	}

	return value
		.split('|')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function splitSpaceFlags(value: string | null): string[] {
	if (!value) {
		return [];
	}

	return value
		.split(/\s+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function getFirstString(value: unknown): string {
	return getString(asArray(value)[0]) ?? '';
}

function getStringArray(value: unknown): string[] {
	return asArray(value)
		.map((item) => getString(item))
		.filter((item): item is string => item !== null && item.length > 0);
}

// 从 .wvproj 的 linkedFolders 中提取有效目录路径。
function extractLinkedFolders(value: unknown): WchLinkedFolder[] {
	return asArray(value)
		.map((item) => {
			const textValue = getString(item);
			if (textValue) {
				return {
					name: textValue.split('/').filter((segment) => segment.length > 0).pop() ?? textValue,
					location: textValue,
				};
			}

			const record = asRecord(item);
			if (!record) {
				return null;
			}

			const location = getString(record.path)
				?? getString(record.folderPath)
				?? getString(record.location)
				?? getString(record.targetPath);
			if (!location) {
				return null;
			}

			return {
				name: getString(record.name)
					?? location.split('/').filter((segment) => segment.length > 0).pop()
					?? location,
				location,
			};
		})
		.filter((item): item is WchLinkedFolder => item !== null && item.location.length > 0);
}

function asArray(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}

	if (value === undefined || value === null) {
		return [];
	}

	return [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}

	return value as Record<string, unknown>;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
	return value !== null;
}

function getString(value: unknown): string | null {
	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	return null;
}

function getBoolean(value: unknown): boolean | null {
	if (typeof value === 'boolean') {
		return value;
	}

	if (value === 'true') {
		return true;
	}

	if (value === 'false') {
		return false;
	}

	return null;
}

function getNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}
