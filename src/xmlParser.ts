import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { buildWchProjectModels, getUnsupportedProjectReason } from './projectModelBuilder';
import type { ParsedProjectPair, ParsedProjectFile, ParsedWchProject } from './projectState';
import { t } from './i18n';

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
});

const textDecoder = new TextDecoder('utf-8');

// 解析命中项目对应的全部 XML 文件内容，并整理成统一结构。
export async function parseMatchedProjectFiles(
	folder: vscode.WorkspaceFolder,
	cprojectFiles: vscode.Uri[],
	launchFiles: vscode.Uri[],
	wvprojFiles: vscode.Uri[],
	matchingBaseNames: string[],
	unconfiguredWvprojFiles: vscode.Uri[],
): Promise<ParsedWchProject> {
	const cprojectResults = await Promise.all(cprojectFiles.map((file) => parseXmlFile(file)));
	const launchMap = await createLaunchFileMap(launchFiles);
	const wvprojMap = await createWvprojFileMap(wvprojFiles);
	const projectPairs: ParsedProjectPair[] = [];

	for (const baseName of matchingBaseNames) {
		const launch = launchMap.get(baseName);
		const wvproj = wvprojMap.get(baseName);

		if (!launch || !wvproj) {
			continue;
		}

		projectPairs.push({
			baseName,
			launch,
			wvproj,
		});
	}

	const project: ParsedWchProject = {
		folderPath: folder.uri.fsPath,
		folderName: folder.name,
		cprojectFiles: cprojectResults,
		projectPairs,
		models: [],
	};

	project.models = buildWchProjectModels(project);
	project.unsupportedReason = getUnsupportedProjectReason(project);
	if (project.models.length === 0 && project.projectPairs.length === 0 && unconfiguredWvprojFiles.length > 0) {
		project.unsupportedReason = t('error.projectDownloadNotConfigured');
		project.configurationWvprojPath = unconfiguredWvprojFiles[0].fsPath;
	}
	return project;
}

// 将 .launch 文件解析后按去后缀基名建立索引。
async function createLaunchFileMap(files: vscode.Uri[]): Promise<Map<string, ParsedProjectFile>> {
	const entries = await Promise.all(
		files.map(async (file) => [getBaseName(file, '.launch'), await parseLaunchFile(file)] as const),
	);

	return new Map(entries);
}

// 将 .wvproj 文件按 JSON 解析后按去后缀基名建立索引。
async function createWvprojFileMap(files: vscode.Uri[]): Promise<Map<string, ParsedProjectFile>> {
	const entries = await Promise.all(
		files.map(async (file) => [getBaseName(file, '.wvproj'), await parseWvprojFile(file)] as const),
	);

	return new Map(entries);
}

// 读取并解析 .cproject XML 文件。
async function parseXmlFile(file: vscode.Uri): Promise<ParsedProjectFile> {
	const content = await vscode.workspace.fs.readFile(file);
	const xmlContent = textDecoder.decode(content);

	try {
		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'cproject-xml',
			data: xmlParser.parse(xmlContent, true),
		};
	} catch (error) {
		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'cproject-xml',
			data: null,
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
}

// 读取并解析 .launch XML 文件。
async function parseLaunchFile(file: vscode.Uri): Promise<ParsedProjectFile> {
	const content = await vscode.workspace.fs.readFile(file);
	const xmlContent = textDecoder.decode(content);

	try {
		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'launch-xml',
			data: xmlParser.parse(xmlContent, true),
		};
	} catch (error) {
		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'launch-xml',
			data: null,
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
}

// 读取并解析 .wvproj JSON 文件。
async function parseWvprojFile(file: vscode.Uri): Promise<ParsedProjectFile> {
	const content = await vscode.workspace.fs.readFile(file);
	const jsonContent = textDecoder.decode(content);

	try {
		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'wvproj-json',
			data: JSON.parse(jsonContent),
		};
	} catch (error) {
		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'wvproj-json',
			data: null,
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
}

// 取文件名，用于展示和调试。
function getFileName(file: vscode.Uri): string {
	return file.path.split('/').pop() ?? file.fsPath;
}

// 取文件去掉指定后缀后的基名，用于匹配 .launch 和 .wvproj。
function getBaseName(file: vscode.Uri, suffix: string): string {
	const name = getFileName(file);
	return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}
