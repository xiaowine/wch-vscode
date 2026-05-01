export type WchLinkedFolder = {
	name: string;
	location: string;
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
		optimizationLevel: string;
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
