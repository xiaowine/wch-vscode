export type WchLinkedFolder = {
	name: string;
	location: string;
};

export type WchProjectFiles = {
	cproject: string[];
	launch: string;
	wvproj: string;
};

export type WchProjectIdentity = {
	name: string;
	baseName: string;
	folderPath: string;
	folderName: string;
	files: WchProjectFiles;
};

export type WchToolchainModel = {
	directoryName: string;
	executablePrefix: string;
	executables: {
		gcc: string;
		gpp: string;
		gdb: string;
		objcopy: string;
		objdump: string;
		size: string;
	};
};

export type WchTargetModel = {
	architecture: string;
	toolchain: string;
	mcu: string;
	rtos: string;
	svdPath: string;
	debugLink: string;
	linkedFolders: WchLinkedFolder[];
};

export type WchCompileSettings = {
	standard: string;
	includePaths: string[];
	includeSystemPaths: string[];
	includeFiles: string[];
	definedSymbols: string[];
	undefinedSymbols: string[];
	doNotSearchSystemDirectories: boolean;
	doNotSearchSystemCppDirectories: boolean;
	preprocessOnly: boolean;
	generateAssemblerListing: boolean;
	saveTemporaryFiles: boolean;
	verbose: boolean;
	optimizationFlags: string[];
	warningFlags: string[];
	debuggingFlags: string[];
	otherCompilerFlags: string[];
	args: string[];
};

export type WchAssemblerSettings = {
	usePreprocessor: boolean;
	doNotSearchSystemDirectories: boolean;
	preprocessOnly: boolean;
	includePaths: string[];
	includeSystemPaths: string[];
	includeFiles: string[];
	definedSymbols: string[];
	undefinedSymbols: string[];
	assemblerFlags: string[];
	generateAssemblerListing: boolean;
	saveTemporaryFiles: boolean;
	verbose: boolean;
	otherAssemblerFlags: string[];
	warningFlags: string[];
	args: string[];
};

export type WchLinkerSettings = {
	script: string;
	libraries: string[];
	librarySearchPaths: string[];
	linkerFlags: string[];
	otherLinkerFlags: string[];
	otherObjects: string[];
	mapFile: string;
	args: string[];
};

export type WchPostBuildSettings = {
	createFlash: boolean;
	createBinary: boolean;
	flashArgs: string[];
	createList: boolean;
	listArgs: string[];
	printSize: boolean;
	sizeArgs: string[];
};

export type WchBuildArtifact = {
	name: string;
	extension: string;
	outputPrefix: string;
	outputFile: string;
};

export type WchBuildModel = {
	configName: string;
	parallelizationNumber: string;
	stopOnFirstBuildError: boolean;
	preScript: string;
	postScript: string;
	toolchainName: string;
	commandPrefix: string;
	compilerPath: string;
	toolchain: WchToolchainModel;
	artifact: WchBuildArtifact;
	targetArchitecture: string;
	targetAbi: string;
	riscvExtensions: string[];
	architectureArgs: string[];
	cStandard: string;
	cppStandard: string;
	includePaths: string[];
	includeSystemPaths: string[];
	includeFiles: string[];
	definedSymbols: string[];
	otherCompilerFlags: string[];
	sourceExcludes: string[];
	compile: {
		assembler: WchAssemblerSettings;
		c: WchCompileSettings;
		cpp: WchCompileSettings;
	};
	linker: WchLinkerSettings;
	postBuild: WchPostBuildSettings;
};

export type WchDebugModel = {
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

export type WchFlashModel = {
	mcuType: string;
	targetPath: string;
	address: string;
	erase: boolean;
	program: boolean;
	verify: boolean;
	reset: boolean;
};

export type WchProjectModel = {
	identity: WchProjectIdentity;
	target: WchTargetModel;
	build: WchBuildModel;
	debug: WchDebugModel;
	flash: WchFlashModel;
};
