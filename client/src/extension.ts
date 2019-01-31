/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
"use strict";

import * as path from "path";
import {
  workspace as Workspace,
  window as Window,
  commands as Commands,
  languages as Languages,
  Disposable,
  ExtensionContext,
  Uri,
  StatusBarAlignment,
  TextDocument,
  CodeActionContext,
  Diagnostic,
  ProviderResult,
  Command,
  QuickPickItem,
  WorkspaceFolder as VWorkspaceFolder,
  CodeAction
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  RequestType,
  TransportKind,
  NotificationType,
  ErrorHandler,
  ErrorAction,
  CloseAction,
  State as ClientState,
  RevealOutputChannelOn,
  ServerOptions,
  DocumentFilter,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  WorkspaceFolder
} from "vscode-languageclient";

import { TaskProvider } from "./tasks";

namespace Is {
  const toString = Object.prototype.toString;

  export function boolean(value: any): value is boolean {
    return value === true || value === false;
  }

  export function string(value: any): value is string {
    return toString.call(value) === "[object String]";
  }
}

interface ValidateItem {
  language: string;
}

namespace ValidateItem {
  export function is(item: any): item is ValidateItem {
    let candidate = item as ValidateItem;
    return candidate && Is.string(candidate.language);
  }
}

interface DirectoryItem {
  directory: string;
  changeProcessCWD?: boolean;
}

namespace DirectoryItem {
  export function is(item: any): item is DirectoryItem {
    let candidate = item as DirectoryItem;
    return (
      candidate &&
      Is.string(candidate.directory) &&
      (Is.boolean(candidate.changeProcessCWD) ||
        candidate.changeProcessCWD === void 0)
    );
  }
}

type RunValues = "onType" | "onSave";

interface TextDocumentSettings {
  validate: boolean;
  options: any | undefined;
  run: RunValues;
  workspaceFolder: WorkspaceFolder | undefined;
  workingDirectory: DirectoryItem | undefined;
  library: undefined;
}

enum Status {
  ok = 1,
  warn = 2,
  error = 3
}

interface StatusParams {
  state: Status;
}

namespace StatusNotification {
  export const type = new NotificationType<StatusParams, void>(
    "healthier/status"
  );
}

interface OpenESLintDocParams {
  url: string;
}

interface OpenESLintDocResult {}

namespace OpenESLintDocRequest {
  export const type = new RequestType<
    OpenESLintDocParams,
    OpenESLintDocResult,
    void,
    void
  >("healthier/openDoc");
}

const exitCalled = new NotificationType<[number, string], void>(
  "healthier/exitCalled"
);

interface WorkspaceFolderItem extends QuickPickItem {
  folder: VWorkspaceFolder;
}

function pickFolder(
  folders: VWorkspaceFolder[],
  placeHolder: string
): Thenable<VWorkspaceFolder> {
  if (folders.length === 1) {
    return Promise.resolve(folders[0]);
  }
  return Window.showQuickPick(
    folders.map<WorkspaceFolderItem>(folder => {
      return {
        label: folder.name,
        description: folder.uri.fsPath,
        folder: folder
      };
    }),
    { placeHolder: placeHolder }
  ).then(selected => {
    if (!selected) {
      return undefined;
    }
    return selected.folder;
  });
}

function enable() {
  let folders = Workspace.workspaceFolders;
  if (!folders) {
    Window.showWarningMessage(
      "Healthier can only be enabled if VS Code is opened on a workspace folder."
    );
    return;
  }
  let disabledFolders = folders.filter(
    folder =>
      !Workspace.getConfiguration("healthier", folder.uri).get("enable", true)
  );
  if (disabledFolders.length === 0) {
    if (folders.length === 1) {
      Window.showInformationMessage(
        "Healthier is already enabled in the workspace."
      );
    } else {
      Window.showInformationMessage(
        "Healthier is already enabled on all workspace folders."
      );
    }
    return;
  }
  pickFolder(
    disabledFolders,
    "Select a workspace folder to enable Healthier for"
  ).then(folder => {
    if (!folder) {
      return;
    }
    Workspace.getConfiguration("healthier", folder.uri).update("enable", true);
  });
}

function disable() {
  let folders = Workspace.workspaceFolders;
  if (!folders) {
    Window.showErrorMessage(
      "Healthier can only be disabled if VS Code is opened on a workspace folder."
    );
    return;
  }
  let enabledFolders = folders.filter(folder =>
    Workspace.getConfiguration("healthier", folder.uri).get("enable", true)
  );
  if (enabledFolders.length === 0) {
    if (folders.length === 1) {
      Window.showInformationMessage(
        "Healthier is already disabled in the workspace."
      );
    } else {
      Window.showInformationMessage(
        "Healthier is already disabled on all workspace folders."
      );
    }
    return;
  }
  pickFolder(
    enabledFolders,
    "Select a workspace folder to disable Healthier for"
  ).then(folder => {
    if (!folder) {
      return;
    }
    Workspace.getConfiguration("healthier", folder.uri).update("enable", false);
  });
}

let dummyCommands: Disposable[];

let defaultLanguages = ["javascript", "javascriptreact"];
function shouldBeValidated(textDocument: TextDocument): boolean {
  let config = Workspace.getConfiguration("healthier", textDocument.uri);
  if (!config.get("enable", true)) {
    return false;
  }
  let validate = config.get<(ValidateItem | string)[]>(
    "validate",
    defaultLanguages
  );
  for (let item of validate) {
    if (Is.string(item) && item === textDocument.languageId) {
      return true;
    } else if (
      ValidateItem.is(item) &&
      item.language === textDocument.languageId
    ) {
      return true;
    }
  }
  return false;
}

let taskProvider: TaskProvider;
export function activate(context: ExtensionContext) {
  let activated: boolean;
  let openListener: Disposable;
  let configurationListener: Disposable;
  function didOpenTextDocument(textDocument: TextDocument) {
    if (activated) {
      return;
    }
    if (shouldBeValidated(textDocument)) {
      openListener.dispose();
      configurationListener.dispose();
      activated = true;
      realActivate(context);
    }
  }
  function configurationChanged() {
    if (activated) {
      return;
    }
    for (let textDocument of Workspace.textDocuments) {
      if (shouldBeValidated(textDocument)) {
        openListener.dispose();
        configurationListener.dispose();
        activated = true;
        realActivate(context);
        return;
      }
    }
  }
  openListener = Workspace.onDidOpenTextDocument(didOpenTextDocument);
  configurationListener = Workspace.onDidChangeConfiguration(
    configurationChanged
  );

  let notValidating = () =>
    Window.showInformationMessage("Healthier is not validating any files yet.");
  dummyCommands = [
    Commands.registerCommand("healthier.showOutputChannel", notValidating)
  ];

  context.subscriptions.push(
    Commands.registerCommand("healthier.enable", enable),
    Commands.registerCommand("healthier.disable", disable)
  );
  taskProvider = new TaskProvider();
  taskProvider.start();
  configurationChanged();
}

export function realActivate(context: ExtensionContext) {
  let statusBarItem = Window.createStatusBarItem(StatusBarAlignment.Right, 0);
  let healthierStatus: Status = Status.ok;
  let serverRunning: boolean = false;

  statusBarItem.text = "Healthier";
  statusBarItem.command = "healthier.showOutputChannel";

  function showStatusBarItem(show: boolean): void {
    if (show) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  }

  function updateStatus(status: Status) {
    healthierStatus = status;
    switch (status) {
      case Status.ok:
        statusBarItem.text = "Healthier";
        break;
      case Status.warn:
        statusBarItem.text = "$(alert) Healthier";
        break;
      case Status.error:
        statusBarItem.text = "$(issue-opened) Healthier";
        break;
      default:
        statusBarItem.text = "Healthier";
    }
    updateStatusBarVisibility();
  }

  function updateStatusBarVisibility(): void {
    showStatusBarItem(serverRunning && healthierStatus !== Status.ok);
  }

  // We need to go one level up since an extension compile the js code into
  // the output folder.
  // serverModule
  let serverModule = context.asAbsolutePath(
    path.join("server", "out", "healthierServer.js")
  );
  let runtime = Workspace.getConfiguration("healthier").get("runtime", null);
  let serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
      runtime,
      options: { cwd: process.cwd() }
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      runtime,
      options: { execArgv: ["--nolazy", "--inspect=6010"], cwd: process.cwd() }
    }
  };

  let defaultErrorHandler: ErrorHandler;
  let serverCalledProcessExit: boolean = false;

  let packageJsonFilter: DocumentFilter = {
    scheme: "file",
    pattern: "**/package.json"
  };
  let configFileFilter: DocumentFilter = {
    scheme: "file",
    pattern: "**/.eslintr{c.js,c.yaml,c.yml,c,c.json}"
  };
  let syncedDocuments: Map<string, TextDocument> = new Map<
    string,
    TextDocument
  >();

  Workspace.onDidChangeConfiguration(() => {
    for (let textDocument of syncedDocuments.values()) {
      if (!shouldBeValidated(textDocument)) {
        syncedDocuments.delete(textDocument.uri.toString());
        client.sendNotification(
          DidCloseTextDocumentNotification.type,
          client.code2ProtocolConverter.asCloseTextDocumentParams(textDocument)
        );
      }
    }
    for (let textDocument of Workspace.textDocuments) {
      if (
        !syncedDocuments.has(textDocument.uri.toString()) &&
        shouldBeValidated(textDocument)
      ) {
        client.sendNotification(
          DidOpenTextDocumentNotification.type,
          client.code2ProtocolConverter.asOpenTextDocumentParams(textDocument)
        );
        syncedDocuments.set(textDocument.uri.toString(), textDocument);
      }
    }
  });
  let clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file" }, { scheme: "untitled" }],
    diagnosticCollectionName: "healthier",
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    synchronize: {
      // configurationSection: 'healthier',
      fileEvents: [
        Workspace.createFileSystemWatcher(
          "**/.eslintr{c.js,c.yaml,c.yml,c,c.json}"
        ),
        Workspace.createFileSystemWatcher("**/.eslintignore"),
        Workspace.createFileSystemWatcher("**/.prettierignore"),
        Workspace.createFileSystemWatcher("**/package.json")
      ]
    },
    initializationFailedHandler: error => {
      client.error("Server initialization failed.", error);
      client.outputChannel.show(true);
      return false;
    },
    errorHandler: {
      error: (error, message, count): ErrorAction => {
        return defaultErrorHandler.error(error, message, count);
      },
      closed: (): CloseAction => {
        if (serverCalledProcessExit) {
          return CloseAction.DoNotRestart;
        }
        return defaultErrorHandler.closed();
      }
    },
    middleware: {
      didOpen: (document, next) => {
        if (
          Languages.match(packageJsonFilter, document) ||
          Languages.match(configFileFilter, document) ||
          shouldBeValidated(document)
        ) {
          next(document);
          syncedDocuments.set(document.uri.toString(), document);
          return;
        }
      },
      didChange: (event, next) => {
        if (syncedDocuments.has(event.document.uri.toString())) {
          next(event);
        }
      },
      willSave: (event, next) => {
        if (syncedDocuments.has(event.document.uri.toString())) {
          next(event);
        }
      },
      willSaveWaitUntil: (event, next) => {
        if (syncedDocuments.has(event.document.uri.toString())) {
          return next(event);
        } else {
          return Promise.resolve([]);
        }
      },
      didSave: (document, next) => {
        if (syncedDocuments.has(document.uri.toString())) {
          next(document);
        }
      },
      didClose: (document, next) => {
        let uri = document.uri.toString();
        if (syncedDocuments.has(uri)) {
          syncedDocuments.delete(uri);
          next(document);
        }
      },
      provideCodeActions: (
        document,
        range,
        context,
        token,
        next
      ): ProviderResult<(Command | CodeAction)[]> => {
        if (
          !syncedDocuments.has(document.uri.toString()) ||
          !context.diagnostics ||
          context.diagnostics.length === 0
        ) {
          return [];
        }
        let eslintDiagnostics: Diagnostic[] = [];
        for (let diagnostic of context.diagnostics) {
          if (diagnostic.source === "healthier") {
            eslintDiagnostics.push(diagnostic);
          }
        }
        if (eslintDiagnostics.length === 0) {
          return [];
        }
        let newContext: CodeActionContext = Object.assign({}, context, {
          diagnostics: eslintDiagnostics
        } as CodeActionContext);
        return next(document, range, newContext, token);
      },
      workspace: {
        configuration: (params, _token, _next): any[] => {
          if (!params.items) {
            return null;
          }
          let result: (TextDocumentSettings | null)[] = [];
          for (let item of params.items) {
            if (item.section || !item.scopeUri) {
              result.push(null);
              continue;
            }
            let resource = client.protocol2CodeConverter.asUri(item.scopeUri);
            let config = Workspace.getConfiguration("healthier", resource);
            let settings: TextDocumentSettings = {
              validate: false,
              options: config.get("options", {}),
              run: config.get("run", "onType"),
              workingDirectory: undefined,
              workspaceFolder: undefined,
              library: undefined
            };
            let document: TextDocument = syncedDocuments.get(item.scopeUri);
            if (!document) {
              result.push(settings);
              continue;
            }
            if (config.get("enabled", true)) {
              let validateItems = config.get<(ValidateItem | string)[]>(
                "validate",
                ["javascript", "javascriptreact"]
              );
              for (let item of validateItems) {
                if (Is.string(item) && item === document.languageId) {
                  settings.validate = true;
                  break;
                } else if (
                  ValidateItem.is(item) &&
                  item.language === document.languageId
                ) {
                  settings.validate = true;
                  break;
                }
              }
            }
            let workspaceFolder = Workspace.getWorkspaceFolder(resource);
            if (workspaceFolder) {
              settings.workspaceFolder = {
                name: workspaceFolder.name,
                uri: client.code2ProtocolConverter.asUri(workspaceFolder.uri)
              };
            }
            result.push(settings);
          }
          return result;
        }
      }
    }
  };

  let client = new LanguageClient("Healthier", serverOptions, clientOptions);
  client.registerProposedFeatures();
  defaultErrorHandler = client.createDefaultErrorHandler();
  const running = "Healthier server is running.";
  const stopped = "Healthier server stopped.";
  client.onDidChangeState(event => {
    if (event.newState === ClientState.Running) {
      client.info(running);
      statusBarItem.tooltip = running;
      serverRunning = true;
    } else {
      client.info(stopped);
      statusBarItem.tooltip = stopped;
      serverRunning = false;
    }
    updateStatusBarVisibility();
  });
  client.onReady().then(() => {
    client.onNotification(StatusNotification.type, params => {
      updateStatus(params.state);
    });

    client.onNotification(exitCalled, params => {
      serverCalledProcessExit = true;
      client.error(
        `Server process exited with code ${
          params[0]
        }. This usually indicates a misconfigured Healthier setup.`,
        params[1]
      );
      Window.showErrorMessage(
        `Healthier server shut down itself. See 'Healthier' output channel for details.`
      );
    });

    client.onRequest(OpenESLintDocRequest.type, params => {
      Commands.executeCommand("vscode.open", Uri.parse(params.url));
      return {};
    });
  });

  if (dummyCommands) {
    dummyCommands.forEach(command => command.dispose());
    dummyCommands = undefined;
  }

  updateStatusBarVisibility();

  context.subscriptions.push(
    client.start(),
    Commands.registerCommand("healthier.showOutputChannel", () => {
      client.outputChannel.show();
    }),
    statusBarItem
  );
}

export function deactivate() {
  if (dummyCommands) {
    dummyCommands.forEach(command => command.dispose());
  }

  if (taskProvider) {
    taskProvider.dispose();
  }
}
