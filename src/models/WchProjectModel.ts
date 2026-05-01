export type WchLinkedFolder = {
	name: string;
	location: string;
};

export type WchCompilerSettings = {
	standard: string;
	includePaths: string[];
	includeSystemPaths: string[];
	includeFiles: string[];
	definedSymbols: string[];
	optimizationFlags: string[];
	warningFlags: string[];
	otherCompilerFlags: string[];
	args: string[];
};

export type WchAssemblerSettings = {
	includePaths: string[];
	includeSystemPaths: string[];
	includeFiles: string[];
	definedSymbols: string[];
	otherAssemblerFlags: string[];
	warningFlags: string[];
	args: string[];
};

export type WchLinkerSettings = {
	linkerScript: string;
	libraries: string[];
	librarySearchPaths: string[];
	linkerFlags: string[];
	otherLinkerFlags: string[];
	otherObjects: string[];
	generateMap: string;
	doNotUseStandardStartFiles: boolean;
	doNotUseDefaultLibraries: boolean;
	noStartupOrDefaultLibs: boolean;
	removeUnusedSections: boolean;
	printRemovedSections: boolean;
	omitAllSymbolInformation: boolean;
	useNewlibNano: boolean;
	useFloatWithNanoPrintf: boolean;
	useFloatWithNanoScanf: boolean;
	doNotUseSyscalls: boolean;
	args: string[];
};

export type WchPostBuildSettings = {
	createFlash: boolean;
	flashOutputFormat: string;
	flashFlags: string[];
	flashArgs: string[];
	createList: boolean;
	listFlags: string[];
	listArgs: string[];
	listOptions: {
		displaySource: boolean;
		displayAllHeaders: boolean;
		demangleNames: boolean;
		displayDebugInfo: boolean;
		disassemble: boolean;
		displayFileHeaders: boolean;
		displayLineNumbers: boolean;
		displayRelocationInfo: boolean;
		displaySymbols: boolean;
		wideLines: boolean;
	};
	printSize: boolean;
	sizeFormat: string;
	sizeFlags: string[];
	sizeArgs: string[];
	sizeOptions: {
		hex: boolean;
		showTotals: boolean;
	};
};

// 汇总后的项目模型，只保留扩展后续真正会用到的核心信息。
export type WchProjectModel = {
	baseName: string;
	folderPath: string;
	folderName: string;
	linkedFolders: WchLinkedFolder[];
	files: {
		cproject: string[];
		launch: string;
		wvproj: string;
	};
	project: {
		name: string;
		projectType: string;
		architecture: string;
		artifact: {
			name: string;
			extension: string;
			outputPrefix: string;
			outputFile: string;
		};
	};
	chip: {
		vendor: string;
		series: string;
		mcu: string;
		rtos: string;
		toolchain: string;
		debugLink: string;
		svdPath: string;
	};
	build: {
		configName: string;
		toolchainName: string;
		commandPrefix: string;
		compilerPath: string;
		targetArchitecture: string;
		targetAbi: string;
		riscvExtensions: string[];
		architectureArgs: string[];
		optimizationLevel: string;
		functionSections: boolean;
		dataSections: boolean;
		cStandard: string;
		cppStandard: string;
		includePaths: string[];
		includeSystemPaths: string[];
		includeFiles: string[];
		definedSymbols: string[];
		otherCompilerFlags: string[];
		linkerScript: string;
		libraries: string[];
		librarySearchPaths: string[];
		sourceExcludes: string[];
	};
	assembler: WchAssemblerSettings;
	c: WchCompilerSettings;
	cpp: WchCompilerSettings;
	linker: WchLinkerSettings;
	postBuild: WchPostBuildSettings;
	debug: {
		programName: string;
		gdbExecutable: string;
		openOcdExecutable: string;
		openOcdConfigOptions: string[];
		host: string;
		gdbPort: number;
		telnetPort: number;
		tclPort: number;
		startupCommands: string[];
		stopAt: string;
		firstResetType: string;
		secondResetType: string;
	};
	flash: {
		targetPath: string;
		address: string;
		erase: boolean;
		program: boolean;
		verify: boolean;
		reset: boolean;
	};
};
