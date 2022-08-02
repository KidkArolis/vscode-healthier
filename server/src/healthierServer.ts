/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
"use strict";

import {
  createConnection,
  Connection,
  IPCMessageReader,
  IPCMessageWriter,
  ResponseError,
  RequestType,
  NotificationType,
  ProposedFeatures,
  ErrorCodes,
  RequestHandler,
  NotificationHandler,
  Diagnostic,
  DiagnosticSeverity,
  Files,
  CancellationToken,
  TextDocuments,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  DidChangeConfigurationNotification,
  WorkspaceFolder,
  DidChangeWorkspaceFoldersNotification
} from "vscode-languageserver/node";
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import * as path from "path";

namespace Is {
  const toString = Object.prototype.toString;

  export function boolean(value: any): value is boolean {
    return value === true || value === false;
  }

  export function string(value: any): value is string {
    return toString.call(value) === "[object String]";
  }
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
  export const type = new NotificationType<StatusParams>(
    "healthier/status"
  );
}

type RunValues = "onType" | "onSave";

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
        candidate.changeProcessCWD === undefined)
    );
  }
}

interface TextDocumentSettings {
  validate: boolean;
  run: RunValues;
  workspaceFolder: WorkspaceFolder | undefined;
  workingDirectory: DirectoryItem | undefined;
  library: CLIEngine | undefined;
}

interface ESLintProblem {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: number;
  ruleId: string;
  message: string;
}

interface ESLintDocumentReport {
  filePath: string;
  errorCount: number;
  warningCount: number;
  messages: ESLintProblem[];
  output?: string;
}

interface ESLintReport {
  errorCount: number;
  warningCount: number;
  results: ESLintDocumentReport[];
}

interface CLIOptions {
  filename: string;
  cwd?: string;
}

interface CLIEngine {
  lintText(content: string, opts?: any): Promise<ESLintReport>;
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
  let message = problem.message;
  let startLine = Math.max(0, problem.line - 1);
  let startChar = Math.max(0, problem.column - 1);
  let endLine =
    problem.endLine != null ? Math.max(0, problem.endLine - 1) : startLine;
  let endChar =
    problem.endColumn != null ? Math.max(0, problem.endColumn - 1) : startChar;
  return {
    message: message,
    severity: convertSeverity(problem.severity),
    source: "healthier",
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar }
    },
    code: problem.ruleId
  };
}

interface FixableProblem {
  label: string;
  documentVersion: number;
  ruleId: string;
  line: number;
}

let codeActions: Map<string, Map<string, FixableProblem>> = new Map<
  string,
  Map<string, FixableProblem>
>();

function convertSeverity(severity: number): DiagnosticSeverity {
  switch (severity) {
    // Eslint 1 is warning
    case 1:
      return DiagnosticSeverity.Warning;
    case 2:
      return DiagnosticSeverity.Error;
    default:
      return DiagnosticSeverity.Error;
  }
}

const enum CharCode {
  /**
   * The `\` character.
   */
  Backslash = 92
}

/**
 * Check if the path follows this pattern: `\\hostname\sharename`.
 *
 * @see https://msdn.microsoft.com/en-us/library/gg465305.aspx
 * @return A boolean indication if the path is a UNC path, on none-windows
 * always false.
 */
function isUNC(path: string): boolean {
  if (process.platform !== "win32") {
    // UNC is a windows concept
    return false;
  }

  if (!path || path.length < 5) {
    // at least \\a\b
    return false;
  }

  let code = path.charCodeAt(0);
  if (code !== CharCode.Backslash) {
    return false;
  }
  code = path.charCodeAt(1);
  if (code !== CharCode.Backslash) {
    return false;
  }
  let pos = 2;
  let start = pos;
  for (; pos < path.length; pos++) {
    code = path.charCodeAt(pos);
    if (code === CharCode.Backslash) {
      break;
    }
  }
  if (start === pos) {
    return false;
  }
  code = path.charCodeAt(pos + 1);
  if (isNaN(code) || code === CharCode.Backslash) {
    return false;
  }
  return true;
}

function getFileSystemPath(uri: URI): string {
  let result = uri.fsPath;
  if (process.platform === "win32" && result.length >= 2 && result[1] === ":") {
    // Node by default uses an upper case drive letter and ESLint uses
    // === to compare paths which results in the equal check failing
    // if the drive letter is lower case in th URI. Ensure upper case.
    return result[0].toUpperCase() + result.substr(1);
  } else {
    return result;
  }
}

function getFilePath(documentOrUri: string | TextDocument): string {
  if (!documentOrUri) {
    return undefined;
  }
  let uri = Is.string(documentOrUri)
    ? URI.parse(documentOrUri)
    : URI.parse(documentOrUri.uri);
  if (uri.scheme !== "file") {
    return undefined;
  }
  return getFileSystemPath(uri);
}

const exitCalled = new NotificationType<[number, string]>(
  "healthier/exitCalled"
);

const nodeExit = process.exit;
process.exit = ((code?: number): void => {
  let stack = new Error("stack");
  connection.sendNotification(exitCalled, [code ? code : 0, stack.stack]);
  setTimeout(() => {
    nodeExit(code);
  }, 1000);
}) as any;
process.on("uncaughtException", (error: any) => {
  let message: string;
  if (error) {
    if (typeof error.stack === "string") {
      message = error.stack;
    } else if (typeof error.message === "string") {
      message = error.message;
    } else if (typeof error === "string") {
      message = error;
    }
    if (!message) {
      try {
        message = JSON.stringify(error, undefined, 4);
      } catch (e) {
        // Should not happen.
      }
    }
  }
  console.error("Uncaught exception received.");
  if (message) {
    console.error(message);
  }
});

let connection = createConnection(ProposedFeatures.all,
  new IPCMessageReader(process),
  new IPCMessageWriter(process));
connection.console.info(`Healthier server running in node ${process.version}`);
const documents = new TextDocuments(TextDocument);
// const documents = new TextDocuments(TextDocument)
let path2Library: Map<string, CLIEngine> = new Map<string, CLIEngine>();
let document2Settings: Map<string, Promise<TextDocumentSettings>> = new Map<
  string,
  Promise<TextDocumentSettings>
>();

async function resolveSettings(
  document: TextDocument
): Promise<TextDocumentSettings> {
  let uri = document.uri;
  let resultPromise = document2Settings.get(uri)
  if (resultPromise != null) {
    return await resultPromise
  }
  resultPromise = connection.workspace
    .getConfiguration({ scopeUri: uri, section: "" })
    .then((settings: TextDocumentSettings) => {
      let uri = URI.parse(document.uri);
      let promise: Thenable<string>;
      if (uri.scheme === "file") {
        let file = uri.fsPath;
        let directory = path.dirname(file);
        promise = Files.resolve("healthier", undefined, directory, trace);
      } else {
        promise = Files.resolve(
          "healthier",
          undefined,
          settings.workspaceFolder ? settings.workspaceFolder.uri : undefined,
          trace
        );
      }
      return promise.then(
        path => {
          let library = path2Library.get(path);
          if (!library) {
            try {
              let library = require(path);
              connection.console.info(`Healthier library loaded from: ${path}`);
              settings.library = library;
            } catch (err) {
              connection.console.info(`Healthier library was not found`);
              settings.validate = false;
            }
            path2Library.set(path, library);
          } else {
            settings.library = library;
          }
          return settings;
        },
        () => {
          settings.validate = false;
          return settings;
        }
      );
    });
  document2Settings.set(uri, resultPromise);
  return resultPromise;
}

interface Request<P, R> {
  method: string;
  params: P;
  documentVersion: number | undefined;
  resolve: (value: R | Thenable<R>) => void | undefined;
  reject: (error: any) => void | undefined;
  token: CancellationToken | undefined;
}

namespace Request {
  export function is(value: any): value is Request<any, any> {
    let candidate: Request<any, any> = value;
    return (
      candidate &&
      !!candidate.token &&
      !!candidate.resolve &&
      !!candidate.reject
    );
  }
}

interface Notification<P> {
  method: string;
  params: P;
  documentVersion: number;
}

type Message<P, R> = Notification<P> | Request<P, R>;

interface VersionProvider<P> {
  (params: P): number;
}

namespace Thenable {
  export function is<T>(value: any): value is Thenable<T> {
    let candidate: Thenable<T> = value;
    return candidate && typeof candidate.then === "function";
  }
}

class BufferedMessageQueue {
  private queue: Message<any, any>[];
  private requestHandlers: Map<
    string,
    {
      handler: RequestHandler<any, any, any>;
      versionProvider?: VersionProvider<any>;
    }
  >;
  private notificationHandlers: Map<
    string,
    {
      handler: NotificationHandler<any>;
      versionProvider?: VersionProvider<any>;
    }
  >;

  private timer: NodeJS.Immediate | undefined

  constructor(private connection: Connection) {
    this.queue = [];
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
  }

  public registerRequest<P, R, E>(
    type: RequestType<P, R, E>,
    handler: RequestHandler<P, R, E>,
    versionProvider?: VersionProvider<P>
  ): void {
    this.connection.onRequest(type, (params, token) => {
      return new Promise<R>((resolve, reject) => {
        this.queue.push({
          method: type.method,
          params: params,
          documentVersion: versionProvider
            ? versionProvider(params)
            : undefined,
          resolve: resolve,
          reject: reject,
          token: token
        });
        this.trigger();
      });
    });
    this.requestHandlers.set(type.method, { handler, versionProvider });
  }

  public registerNotification<P>(
    type: NotificationType<P>,
    handler: NotificationHandler<P>,
    versionProvider?: (params: P) => number
  ): void {
    connection.onNotification(type, params => {
      this.queue.push({
        method: type.method,
        params: params,
        documentVersion: versionProvider ? versionProvider(params) : undefined
      });
      this.trigger();
    });
    this.notificationHandlers.set(type.method, { handler, versionProvider });
  }

  public addNotificationMessage<P>(
    type: NotificationType<P>,
    params: P,
    version: number
  ) {
    this.queue.push({
      method: type.method,
      params,
      documentVersion: version
    });
    this.trigger();
  }

  public onNotification<P>(
    type: NotificationType<P>,
    handler: NotificationHandler<P>,
    versionProvider?: (params: P) => number
  ): void {
    this.notificationHandlers.set(type.method, { handler, versionProvider });
  }

  private trigger (): void {
    if (this.timer != null || this.queue.length === 0) {
      return
    }
    this.timer = setImmediate(() => {
      this.timer = undefined
      this.processQueue()
    })
  }

  private processQueue(): void {
    let message = this.queue.shift();
    if (!message) {
      return;
    }
    if (Request.is(message)) {
      let requestMessage = message;
      if (requestMessage.token.isCancellationRequested) {
        requestMessage.reject(
          new ResponseError(
            ErrorCodes.InvalidRequest,
            "Request got cancelled"
          )
        );
        return;
      }
      let elem = this.requestHandlers.get(requestMessage.method);
      if (
        elem.versionProvider &&
        requestMessage.documentVersion !== undefined &&
        requestMessage.documentVersion !==
          elem.versionProvider(requestMessage.params)
      ) {
        requestMessage.reject(
          new ResponseError(
            ErrorCodes.InvalidRequest,
            "Request got cancelled"
          )
        );
        return;
      }
      let result = elem.handler(requestMessage.params, requestMessage.token);
      if (Thenable.is(result)) {
        result.then(
          value => {
            requestMessage.resolve(value);
          },
          error => {
            requestMessage.reject(error);
          }
        );
      } else {
        requestMessage.resolve(result);
      }
    } else {
      let notificationMessage = message;
      let elem = this.notificationHandlers.get(notificationMessage.method);
      if (
        elem.versionProvider &&
        notificationMessage.documentVersion !== undefined &&
        notificationMessage.documentVersion !==
          elem.versionProvider(notificationMessage.params)
      ) {
        return;
      }
      elem.handler(notificationMessage.params);
    }
    this.trigger();
  }
}

let messageQueue: BufferedMessageQueue = new BufferedMessageQueue(connection);

namespace ValidateNotification {
  export const type: NotificationType<
    TextDocument
  > = new NotificationType<TextDocument>("healthier/validate");
}

messageQueue.onNotification(
  ValidateNotification.type,
  async document => {
    await validateSingle(document, true);
  },
  (document): number => {
    return document.version;
  }
);

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
documents.onDidOpen(async event => {
  await resolveSettings(event.document).then(settings => {
    if (!settings.validate) {
      return;
    }
    if (settings.run === "onSave") {
      messageQueue.addNotificationMessage(
        ValidateNotification.type,
        event.document,
        event.document.version
      );
    }
  });
});

// A text document has changed. Validate the document according the run setting.
documents.onDidChangeContent(async event => {
  await resolveSettings(event.document).then(settings => {
    if (!settings.validate || settings.run !== "onType") {
      return;
    }
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      event.document,
      event.document.version
    );
  });
});

// A text document has been saved. Validate the document according the run setting.
documents.onDidSave(async event => {
  await resolveSettings(event.document).then(settings => {
    if (!settings.validate || settings.run !== "onSave") {
      return;
    }
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      event.document,
      event.document.version
    );
  });
});

documents.onDidClose(async event => {
  await resolveSettings(event.document).then(async settings => {
    let uri = event.document.uri;
    document2Settings.delete(uri);
    codeActions.delete(uri);
    if (settings.validate) {
      await connection.sendDiagnostics({ uri: uri, diagnostics: [] });
    }
  });
});

function environmentChanged() {
  document2Settings.clear();
  for (let document of documents.all()) {
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      document,
      document.version
    );
  }
}

function trace(message: string, verbose?: string): void {
  connection.tracer.log(message, verbose);
}

connection.onInitialize(_params => {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        willSaveWaitUntil: true,
        save: {
          includeText: false
        }
      }
    }
  };
});

connection.onInitialized(async () => {
  await connection.client.register(
    DidChangeConfigurationNotification.type,
    undefined
  );
  await connection.client.register(
    DidChangeWorkspaceFoldersNotification.type,
    undefined
  );
});

messageQueue.registerNotification(
  DidChangeConfigurationNotification.type,
  _params => {
    environmentChanged();
  }
);

messageQueue.registerNotification(
  DidChangeWorkspaceFoldersNotification.type,
  _params => {
    environmentChanged();
  }
);

const singleErrorHandlers: ((
  error: any,
  document: TextDocument,
  library: CLIEngine
) => Status)[] = [tryHandleConfigError, showErrorMessage];

function validateSingle(
  document: TextDocument,
  publishDiagnostics: boolean = true
): Thenable<void> {
  // We validate document in a queue but open / close documents directly. So we need to deal with the
  // fact that a document might be gone from the server.
  if (!documents.get(document.uri)) {
    return Promise.resolve(undefined);
  }
  return resolveSettings(document).then(async settings => {
    if (!settings.validate) {
      return;
    }
    try {
      validate(document, settings, publishDiagnostics);
      await connection.sendNotification(StatusNotification.type, {
        state: Status.ok
      });
    } catch (err) {
      let status = undefined;
      for (let handler of singleErrorHandlers) {
        status = handler(err, document, settings.library);
        if (status) {
          break;
        }
      }
      status = status || Status.error;
      await connection.sendNotification(StatusNotification.type, { state: status });
    }
  });
}

function validateMany(documents: TextDocument[]): void {
  documents.forEach(document => {
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      document,
      document.version
    );
  });
}

function getMessage(err: any, document: TextDocument): string {
  let result: string = null;
  if (typeof err.message === "string" || err.message instanceof String) {
    result = <string>err.message;
    result = result.replace(/\r?\n/g, " ");
    if (/^CLI: /.test(result)) {
      result = result.substr(5);
    }
  } else {
    result = `An unknown error occurred while validating document: ${
      document.uri
    }`;
  }
  return result;
}

async function validate(
  document: TextDocument,
  settings: TextDocumentSettings,
  publishDiagnostics: boolean = true
): Promise<void> {
  let content = document.getText();
  let uri = document.uri;
  let file = getFilePath(document);
  let cwd = process.cwd();
  let cliOptions: CLIOptions = { filename: file };

  try {
    if (file) {
      if (settings.workingDirectory) {
        cliOptions.cwd = settings.workingDirectory.directory;
        if (settings.workingDirectory.changeProcessCWD) {
          process.chdir(settings.workingDirectory.directory);
        }
      } else if (settings.workspaceFolder) {
        let workspaceFolderUri = URI.parse(settings.workspaceFolder.uri);
        if (workspaceFolderUri.scheme === "file") {
          const fsPath = getFileSystemPath(workspaceFolderUri);
          cliOptions.cwd = fsPath;
          process.chdir(fsPath);
        }
      } else if (!settings.workspaceFolder && !isUNC(file)) {
        let directory = path.dirname(file);
        if (directory) {
          if (path.isAbsolute(directory)) {
            cliOptions.cwd = directory;
          }
        }
      }
    }

    let cli = settings.library;
    // Clean previously computed code actions.
    codeActions.delete(uri);
    let report: ESLintReport = await cli.lintText(content, cliOptions);
    let diagnostics: Diagnostic[] = [];
    if (
      report &&
      report.results &&
      Array.isArray(report.results) &&
      report.results.length > 0
    ) {
      let docReport = report.results[0];
      if (docReport.messages && Array.isArray(docReport.messages)) {
        docReport.messages.forEach(problem => {
          if (problem) {
            let diagnostic = makeDiagnostic(problem);
            diagnostics.push(diagnostic);
          }
        });
      }
    }
    if (publishDiagnostics) {
      await connection.sendDiagnostics({ uri, diagnostics });
    }
  } finally {
    if (cwd !== process.cwd()) {
      process.chdir(cwd);
    }
  }
}

let configErrorReported: Map<string, CLIEngine> = new Map<string, CLIEngine>();

function tryHandleConfigError(
  error: any,
  document: TextDocument,
  library: CLIEngine
): Status {
  if (!error.message) {
    return undefined;
  }

  function handleFileName(filename: string): Status {
    if (!configErrorReported.has(filename)) {
      connection.console.error(getMessage(error, document));
      if (!documents.get(URI.file(filename).toString())) {
        connection.window.showInformationMessage(getMessage(error, document));
      }
      configErrorReported.set(filename, library);
    }
    return Status.warn;
  }

  let matches = /Cannot read config file:\s+(.*)\nError:\s+(.*)/.exec(
    error.message
  );
  if (matches && matches.length === 3) {
    return handleFileName(matches[1]);
  }

  matches = /(.*):\n\s*Configuration for rule \"(.*)\" is /.exec(error.message);
  if (matches && matches.length === 3) {
    return handleFileName(matches[1]);
  }

  matches = /Cannot find module '([^']*)'\nReferenced from:\s+(.*)/.exec(
    error.message
  );
  if (matches && matches.length === 3) {
    return handleFileName(matches[2]);
  }

  return undefined;
}

function showErrorMessage(error: any, document: TextDocument): Status {
  connection.window.showErrorMessage(
    `Healthier: ${getMessage(
      error,
      document
    )}. Please see the 'Healthier' output channel for details.`
  );
  if (Is.string(error.stack)) {
    connection.console.error("Healthier stack trace:");
    connection.console.error(error.stack);
  }
  return Status.error;
}

messageQueue.registerNotification(
  DidChangeWatchedFilesNotification.type,
  async (params: any) => {
    // A .eslintrc has change. No smartness here.
    // Simply revalidate all files.
    for (const change of params.changes) {
      let fsPath = getFilePath(change.uri);
      if (!fsPath || isUNC(fsPath)) {
        return;
      }
      let dirname = path.dirname(fsPath);
      if (dirname) {
        let library = configErrorReported.get(fsPath);
        if (library) {
          let cli = library;
          try {
            await cli.lintText("", {
              filename: path.join(dirname, "___test___.js")
            });
            configErrorReported.delete(fsPath);
          } catch (error) {}
        }
      }
    }
    validateMany(documents.all());
  }
);

connection.tracer.connection.listen();
