import {
	HOVER_WAIT_CHUNK_TIME,
	MAX_HOVER_WAIT_TIME,
	NO_CANCEL_OPERATIONS,
	TREE_FETCHER_FILE,
} from '../../../shared/constants';
import type {
	Hover,
	HoverParams,
	ServerRequestHandler,
} from 'vscode-languageserver';
import { toCheckablePromise, waitPeriodical } from '../../../shared/util';
import type { PHPStanCheckManager } from './phpstan/manager';
import type { CheckConfig } from './phpstan/configManager';
import { Disposable } from 'vscode-languageserver';
import * as tmp from 'tmp-promise';
import * as fs from 'fs/promises';
import { URI } from 'vscode-uri';
import * as path from 'path';

interface VariableData {
	typeDescription: string;
	name: string;
	pos: {
		start: {
			line: number;
			char: number;
		};
		end: {
			line: number;
			char: number;
		};
	};
}

export interface FileReport {
	timestamp: number;
	data: VariableData[];
}

export type ReporterFile = Record<string, FileReport>;

export function createHoverProvider(
	phpstan: PHPStanCheckManager,
	getWorkspaceFolder: () => string | null
): ServerRequestHandler<HoverParams, Hover | undefined | null, never, void> {
	return async (hoverParams, cancelToken) => {
		const workspaceFolder = getWorkspaceFolder();
		if (
			!workspaceFolder ||
			(!NO_CANCEL_OPERATIONS && cancelToken.isCancellationRequested)
		) {
			return null;
		}

		// Ensure the file has been checked
		const promise = toCheckablePromise(
			phpstan.checkFileFromURI(hoverParams.textDocument.uri)
		);

		// Check if the file is currently being checked. If so, wait for that to end.
		const result = await waitPeriodical<'cancel' | 'checkDone'>(
			MAX_HOVER_WAIT_TIME,
			HOVER_WAIT_CHUNK_TIME,
			() => {
				if (
					!NO_CANCEL_OPERATIONS &&
					cancelToken.isCancellationRequested
				) {
					return 'cancel';
				}
				if (promise.done) {
					return 'checkDone';
				}
				return null;
			}
		);

		// Either timed out or was canceled
		if (result !== 'checkDone') {
			return null;
		}

		// Read reporter file
		const reporterFile: ReporterFile = JSON.parse(
			await fs.readFile(path.join(workspaceFolder, 'reported.json'), {
				encoding: 'utf8',
			})
		);

		if (!NO_CANCEL_OPERATIONS && cancelToken.isCancellationRequested) {
			return null;
		}

		// Look for it
		for (const type of reporterFile[
			URI.parse(hoverParams.textDocument.uri).fsPath
		]?.data ?? []) {
			if (
				type.pos.start.line === hoverParams.position.line &&
				type.pos.start.char < hoverParams.position.character &&
				type.pos.end.char > hoverParams.position.character
			) {
				return {
					contents: [
						`PHPStan: \`${type.typeDescription} $${type.name}\``,
					],
				};
			}
		}

		return null;
	};
}

export class HoverProviderCheckHooks {
	private static _operationMap: Map<
		string,
		{
			reportPath: string;
			sourceFilePath: string;
		}
	> = new Map();
	private static _reports: Map<string, FileReport | null> = new Map();

	private static async _getFileReport(
		uri: string
	): Promise<FileReport | null> {
		// TODO: this should happen at the responsible spot, not here
		if (!this._operationMap.has(uri)) {
			return null;
		}
		const match = this._operationMap.get(uri)!;
		this._operationMap.delete(uri);
		try {
			const file = await fs.readFile(match.reportPath, {
				encoding: 'utf-8',
			});
			const parsed = JSON.parse(file) as ReporterFile;
			return parsed[match.sourceFilePath];
		} catch (e) {
			return null;
		}
	}

	private static async _getAutoloadFile(
		uri: string,
		filePath: string,
		userAutoloadFile: string | null,
		disposables: Disposable[]
	): Promise<string> {
		const tmpDir = await tmp.dir();
		const treeFetcherTmpFilePath = path.join(
			tmpDir.path,
			'TreeFetcher.php'
		);
		const treeFetcherReportedFilePath = path.join(
			tmpDir.path,
			'reported.json'
		);
		const autoloadFilePath = path.join(tmpDir.path, 'autoload.php');

		const treeFetcherContent = (
			await fs.readFile(TREE_FETCHER_FILE, {
				encoding: 'utf-8',
			})
		).replace('reported.json', treeFetcherReportedFilePath);
		await fs.writeFile(treeFetcherTmpFilePath, treeFetcherContent, {
			encoding: 'utf-8',
		});

		let autoloadFileContent = '<?php\n';
		if (userAutoloadFile) {
			autoloadFileContent += `chdir('${path.dirname(
				userAutoloadFile
			)}');\n`;
			autoloadFileContent += `require_once "${userAutoloadFile}";\n`;
		}
		autoloadFileContent += `require_once "${treeFetcherTmpFilePath}";`;
		await fs.writeFile(autoloadFilePath, autoloadFileContent, {
			encoding: 'utf-8',
		});

		disposables.push(Disposable.create(() => void tmpDir.cleanup()));

		this._operationMap.set(uri, {
			reportPath: treeFetcherReportedFilePath,
			sourceFilePath: filePath,
		});

		return autoloadFilePath;
	}

	public static async transformArgs(
		config: CheckConfig,
		args: string[],
		uri: string,
		filePath: string,
		disposables: Disposable[]
	): Promise<string[]> {
		let userAutoloadFile: string | null = null;
		for (let i = 0; i < config.args.length; i++) {
			if (config.args[i] === '-a') {
				userAutoloadFile = config.args[i + 1];
			} else if (config.args[i].startsWith('--autoload-file')) {
				if (config.args[i]['--autoload-file'.length] === '=') {
					userAutoloadFile = config.args[i].slice(
						'--autoload-file'.length + 1
					);
				} else {
					userAutoloadFile = config.args[i + 1];
				}
			}
		}

		const autoloadFile = await this._getAutoloadFile(
			uri,
			filePath,
			userAutoloadFile,
			disposables
		);
		args.push('-a', autoloadFile);
		return args;
	}

	public static async onCheckDone(uri: string): Promise<void> {
		this._reports.set(uri, await this._getFileReport(uri));
	}
}
