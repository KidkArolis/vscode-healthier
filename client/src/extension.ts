import * as path from "path";
import { workspace, window, commands, ExtensionContext } from "vscode";
import {
	LanguageClient,
	LanguageClientOptions,
	SettingMonitor,
	RequestType,
	TransportKind,
	TextDocumentIdentifier,
	TextEdit
} from "vscode-languageclient";

interface AllFixesParams {
	textDocument: TextDocumentIdentifier;
}

interface AllFixesResult {
	documentVersion: number;
	edits: TextEdit[];
}

namespace AllFixesRequest {
	export const type = new RequestType<AllFixesParams, AllFixesResult, void, void>("textDocument/healthier/allFixes");
}

export function activate(context: ExtensionContext) {
	const serverModule = context.asAbsolutePath(path.join("server", "out", "server.js"));
	const debugOptions = { execArgv: ["--nolazy", "--inspect=6004"], cwd: process.cwd() };
	const serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc, options: { cwd: process.cwd() } },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
		synchronize: {
			configurationSection: "healthier",
			fileEvents: [workspace.createFileSystemWatcher("**/package.json")]
		}
	};

	const client = new LanguageClient("Healthier Linter", serverOptions, clientOptions);

	function applyTextEdits(uri: string, documentVersion: number, edits: TextEdit[]) {
		const textEditor = window.activeTextEditor;
		if (textEditor && textEditor.document.uri.toString() === uri) {
			// tslint:disable-line:early-exit
			if (textEditor.document.version !== documentVersion) {
				window.showInformationMessage("Healthier fixes are outdated and can't be applied to the document.");
			}

			textEditor
				.edit(mutator => {
					for (const edit of edits) {
						mutator.replace(client.protocol2CodeConverter.asRange(edit.range), edit.newText);
					}
				})
				.then(success => {
					if (!success) {
						window.showErrorMessage(
							"Failed to apply Healthier fixes to the document. Please consider opening an issue with steps to reproduce."
						);
					}
				});
		}
	}

	function fixAllProblems() {
		const textEditor = window.activeTextEditor;
		if (!textEditor) {
			return;
		}

		const uri = textEditor.document.uri.toString();
		client.sendRequest(AllFixesRequest.type, { textDocument: { uri } }).then(
			result => {
				if (result) {
					applyTextEdits(uri, result.documentVersion, result.edits);
				}
			},
			() => {
				window.showErrorMessage(
					"Failed to apply Healthier fixes to the document. Please consider opening an issue with steps to reproduce."
				);
			}
		);
	}

	context.subscriptions.push(
		new SettingMonitor(client, "healthier.enable").start(),
		commands.registerCommand("healthier.fix", fixAllProblems)
	);
}
