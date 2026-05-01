import type { ProjectDetectionResult } from './projectDetection';
import type { WchProjectModel } from './models/WchProjectModel';

// 保存单个已解析项目文件的基础信息和解析结果。
export type ParsedProjectFile = {
	filePath: string;
	fileName: string;
	format: 'cproject-xml' | 'launch-xml' | 'wvproj-json';
	data: unknown | null;
	parseError?: string;
};

// 保存一组同名的 .launch 和 .wvproj 解析结果。
export type ParsedProjectPair = {
	baseName: string;
	launch: ParsedProjectFile;
	wvproj: ParsedProjectFile;
};

// 保存单个工作区文件夹命中后的完整项目数据。
export type ParsedWchProject = {
	folderPath: string;
	folderName: string;
	cprojectFiles: ParsedProjectFile[];
	projectPairs: ParsedProjectPair[];
	models: WchProjectModel[];
	unsupportedReason?: string;
};

// 统一保存检测结果和解析结果，供扩展内其他模块直接读取。
export type WchProjectState = {
	results: ProjectDetectionResult[];
	projects: ParsedWchProject[];
	updatedAt: number;
};

let state: WchProjectState = {
	results: [],
	projects: [],
	updatedAt: 0,
};

// 更新全局项目状态缓存。
export function setWchProjectState(results: ProjectDetectionResult[], projects: ParsedWchProject[]): void {
	state = {
		results,
		projects,
		updatedAt: Date.now(),
	};
}

// 读取当前全局项目状态缓存。
export function getWchProjectState(): WchProjectState {
	return state;
}

// 只读取当前已命中的项目解析结果。
export function getParsedWchProjects(): ParsedWchProject[] {
	return state.projects;
}

// 只读取精简后的项目模型，供业务逻辑直接消费。
export function getWchProjectModels(): WchProjectModel[] {
	return state.projects.flatMap((project) => project.models);
}
