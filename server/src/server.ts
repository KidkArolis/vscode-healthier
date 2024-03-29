import * as async from 'async'
import * as deglob from 'deglob'
import * as fs from 'fs'
import * as path from 'path'
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DidChangeWorkspaceFoldersNotification,
  ErrorCodes,
  Files,
  Connection,
  IPCMessageReader,
  IPCMessageWriter,
  NotificationHandler,
  NotificationType,
  ProposedFeatures,
  RequestHandler,
  RequestType,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind
} from 'vscode-languageserver/node'
import {
  CancellationToken
} from 'vscode-languageserver-protocol'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'

import * as DirectoryItem from './utils/DirectoryItem'
import * as Is from './utils/Is'
import * as NoConfigRequest from './utils/NoConfigRequest'
import * as NoHealthierLibraryRequest from './utils/NoHealthierLibraryRequest'
import * as Request from './utils/Request'
import * as StatusNotification from './utils/StatusNotification'
import * as Thenable from './utils/Thenable'
import * as ValidateNotification from './utils/ValidateNotification'

type LinterValues = 'healthier' | 'ts-healthier'
type LinterNameValues =
  | 'Healthier'
  | 'Healthier TypeScript'

interface HealthierError extends Error {
  messageTemplate?: string
  messageData?: {
    pluginName?: string
  }
}

type RunValues = 'onType' | 'onSave'

interface TextDocumentSettings {
  validate: boolean
  engine: LinterValues
  usePackageJson: boolean
  options: any | undefined
  run: RunValues
  nodePath: string | undefined
  workspaceFolder: { name: string, uri: URI } | undefined
  workingDirectory: DirectoryItem.DirectoryItem | undefined
  library: HealthierModule | undefined
  treatErrorsAsWarnings: boolean
}

interface HealthierProblem {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: number
  ruleId?: string
  message: string
}

interface HealthierDocumentReport {
  filePath: string
  errorCount: number
  warningCount: number
  messages: HealthierProblem[]
  output?: string
}

interface HealthierReport {
  errorCount: number
  warningCount: number
  results: HealthierDocumentReport[]
}

interface CLIOptions {
  cwd: string
  ignore: string[]
  globals: string[]
  plugins: string[]
  envs: string[]
  parser: string
  filename: string
}

type HealthierModuleCallback = (error: Object, results: HealthierReport) => void
interface Opts {
  ignore?: string[]
  cwd?: string
  filename?: string
}
interface HealthierLegacyModule {
  lintText: (
    text: string,
    opts?: CLIOptions,
    cb?: HealthierModuleCallback
  ) => void
  parseOpts: (opts: Object) => Opts
}
interface Healthier17Module {
  lintText: (
    text: string,
    opts?: CLIOptions,
  ) => Promise<HealthierReport>
  resolveEslintConfig: (opts: Object) => Opts
}
type HealthierModule = HealthierLegacyModule | Healthier17Module

function isLegacyModule (module: HealthierModule): module is HealthierLegacyModule {
  return 'parseOpts' in module
}

function makeDiagnostic (
  problem: HealthierProblem,
  settings: TextDocumentSettings
): Diagnostic {
  const message =
    problem.ruleId != null
      ? `${problem.message} (${problem.ruleId})`
      : `${problem.message}`
  const startLine = Math.max(0, problem.line - 1)
  const startChar = Math.max(0, problem.column - 1)
  const endLine =
    problem.endLine != null ? Math.max(0, problem.endLine - 1) : startLine
  const endChar =
    problem.endColumn != null ? Math.max(0, problem.endColumn - 1) : startChar
  return {
    message,
    severity: settings.treatErrorsAsWarnings ? DiagnosticSeverity.Warning : convertSeverity(problem.severity),
    source: settings.engine,
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar }
    },
    code: problem.ruleId
  }
}

function convertSeverity (severity: number): DiagnosticSeverity {
  switch (severity) {
    // Eslint 1 is warning
    case 1:
      return DiagnosticSeverity.Warning
    case 2:
      return DiagnosticSeverity.Error
    default:
      return DiagnosticSeverity.Error
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
function isUNC (path: string): boolean {
  if (process.platform !== 'win32') {
    // UNC is a windows concept
    return false
  }

  if (path.length === 0 || path.length < 5) {
    // at least \\a\b
    return false
  }

  let code = path.charCodeAt(0)
  if (code !== CharCode.Backslash) {
    return false
  }
  code = path.charCodeAt(1)
  if (code !== CharCode.Backslash) {
    return false
  }
  let pos = 2
  const start = pos
  for (; pos < path.length; pos++) {
    code = path.charCodeAt(pos)
    if (code === CharCode.Backslash) {
      break
    }
  }
  if (start === pos) {
    return false
  }
  code = path.charCodeAt(pos + 1)
  if (isNaN(code) || code === CharCode.Backslash) {
    return false
  }
  return true
}

function getFilePath (documentOrUri: string | URI): string {
  if (documentOrUri == null) {
    return ''
  }
  const uri = Is.string(documentOrUri)
    ? URI.parse(documentOrUri)
    : documentOrUri
  if (uri.scheme !== 'file') {
    return ''
  }
  return uri.fsPath
}

const exitCalled = new NotificationType<[number, string]>(
  'healthier/exitCalled'
)

const nodeExit = process.exit
process.on('SIGINT', () => {
  const stack = new Error('stack')
  connection.sendNotification(exitCalled, [0, stack.stack])
    .finally(() => {
      setTimeout(() => {
        nodeExit(0)
      }, 1000)
    })
})

const connection = createConnection(
  ProposedFeatures.all,
  new IPCMessageReader(process),
  new IPCMessageWriter(process)
)
const documents = new TextDocuments(TextDocument)

let globalNodePath: string | undefined

const path2Library: Map<string, HealthierModule> = new Map<
string,
HealthierModule
>()
const document2Settings: Map<string, Thenable<TextDocumentSettings>> = new Map<
string,
Thenable<TextDocumentSettings>
>()

async function resolveSettings (
  document: TextDocument
): Promise<TextDocumentSettings> {
  const uri = document.uri
  let resultPromise = document2Settings.get(uri)
  if (resultPromise != null) {
    return await resultPromise
  }
  resultPromise = connection.workspace
    .getConfiguration({ scopeUri: uri, section: '' })
    .then(async (settings: TextDocumentSettings) => {
      const uri = URI.parse(document.uri)
      const linterNames: { [linter: string]: LinterNameValues } = {
        healthier: 'Healthier',
        'ts-healthier': 'Healthier TypeScript'
      }
      let linter = settings.engine
      let linterName = linterNames[settings.engine]
      // when settings.usePackageJson is true
      // we need to do more
      const { usePackageJson } = settings
      // when we open single file not under project,
      // that workingspaceFolder would be undefined
      if (
        usePackageJson &&
        settings.workspaceFolder != null &&
        settings.workspaceFolder.uri != null
      ) {
        const pkgPath = path.join(
          getFilePath(settings.workspaceFolder.uri),
          'package.json'
        )
        const pkgExists = fs.existsSync(pkgPath)
        if (pkgExists) {
          const pkgStr = fs.readFileSync(pkgPath, 'utf8')
          const pkg = JSON.parse(pkgStr)
          if (pkg?.devDependencies?.healthier != null) {
            linter = 'healthier'
            linterName = 'Healthier'
          } else if (pkg?.devDependencies?.['ts-healthier'] != null) {
            linter = 'ts-healthier'
            linterName = 'Healthier TypeScript'
          }
          // if healthier, ts-healthier config presented in package.json
          if (
            pkg?.devDependencies?.healthier != null ||
            pkg?.devDependencies?.['ts-healthier'] != null
          ) {
            if (pkg[linter] != null) {
              // if [linter] presented in package.json combine the global one.
              settings.engine = linter
              settings.options = Object.assign(
                {},
                settings.options,
                pkg[linter]
              )
            } else {
              // default options to those in settings.json
            }
          } else {
            // no linter defined in package.json
            settings.validate = false
            connection.console.info(`no ${linter} in package.json`)
          }
        }
      }
      let promise: Thenable<string>
      if (uri.scheme === 'file') {
        const file = uri.fsPath
        const directory = path.dirname(file)
        if (settings.nodePath != null) {
          promise = Files.resolve(
            linter,
            settings.nodePath,
            settings.nodePath,
            trace
          ).then<string, string>(undefined, async () => {
            return await Files.resolve(linter, globalNodePath, directory, trace)
          })
        } else {
          promise = Files.resolve(linter, globalNodePath, directory, trace)
        }
      } else {
        promise = Files.resolve(
          linter,
          globalNodePath,
          settings.workspaceFolder != null
            ? settings.workspaceFolder.uri.toString()
            : undefined,
          trace
        )
      }
      return await promise.then(
        async path => {
          let library = path2Library.get(path)
          if (library == null) {
            // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
            library = (await Function(`return import('file://${path.replace(/\\/g, '\\\\')}')`)()).default
            if (library?.lintText == null) {
              settings.validate = false
              connection.console.error(
                `The ${linterName} library loaded from ${path} doesn't export a lintText.`
              )
            } else {
              connection.console.info(
                `${linterName} library loaded from: ${path}`
              )
              settings.library = library
            }
            if (library != null) {
              path2Library.set(path, library)
            }
          } else {
            settings.library = library
          }
          return settings
        },
        async () => {
          settings.validate = false
          await connection.sendRequest(NoHealthierLibraryRequest.type, {
            source: { uri: document.uri }
          })
          return settings
        }
      )
    })
  document2Settings.set(uri, resultPromise)
  return await resultPromise
}

interface Notifcation<P> {
  method: string
  params: P
  documentVersion: number
}

type Message<P, R> = Notifcation<P> | Request.Request<P, R>

type VersionProvider<P> = (params: P) => number

class BufferedMessageQueue {
  private readonly queue: Array<Message<any, any>>
  private readonly requestHandlers: Map<
  string,
  {
    handler: RequestHandler<any, any, any>
    versionProvider?: VersionProvider<any>
  }
  >

  private readonly notificationHandlers: Map<
  string,
  {
    handler: NotificationHandler<any>
    versionProvider?: VersionProvider<any>
  }
  >

  private timer: NodeJS.Immediate | undefined

  constructor (private readonly connection: Connection) {
    this.queue = []
    this.requestHandlers = new Map()
    this.notificationHandlers = new Map()
  }

  public registerRequest<P, R, RO> (
    type: RequestType<P, R, RO>,
    handler: RequestHandler<any, any, any>,
    versionProvider?: VersionProvider<P>
  ): void {
    this.connection.onRequest(type, async (params, token) => {
      return await new Promise<R>((resolve, reject) => {
        this.queue.push({
          method: type.method,
          params,
          documentVersion:
            versionProvider != null ? versionProvider(params) : undefined,
          resolve,
          reject,
          token
        })
        this.trigger()
      })
    })
    this.requestHandlers.set(type.method, { handler, versionProvider })
  }

  public registerNotification (
    type: any,
    handler: NotificationHandler<any>,
    versionProvider?: any
  ): void {
    connection.onNotification(type, (params: Notifcation<any>) => {
      this.queue.push({
        documentVersion:
          versionProvider != null ? versionProvider(params) : undefined,
        method: type.method,
        params
      })
      this.trigger()
    })
    this.notificationHandlers.set(type.method, { handler, versionProvider })
  }

  public addNotificationMessage<P> (
    type: NotificationType<P>,
    params: P,
    version: number
  ): void {
    this.queue.push({
      method: type.method,
      params,
      documentVersion: version
    })
    this.trigger()
  }

  public onNotification<P> (
    type: NotificationType<P>,
    handler: NotificationHandler<P>,
    versionProvider?: (params: P) => number
  ): void {
    this.notificationHandlers.set(type.method, { handler, versionProvider })
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

  private processQueue (): void {
    const message = this.queue.shift()
    if (message == null) {
      return undefined
    }
    if (Request.is(message)) {
      const requestMessage = message
      if (
        requestMessage?.token?.isCancellationRequested != null &&
        requestMessage.token.isCancellationRequested
      ) {
        requestMessage.reject(
          new ResponseError(
            ErrorCodes.InvalidRequest,
            'Request got cancelled'
          )
        )
        return undefined
      }
      const elem = this.requestHandlers.get(requestMessage.method)
      if (elem == null) {
        return undefined
      }
      if (
        elem.versionProvider != null &&
        requestMessage.documentVersion !== undefined &&
        requestMessage.documentVersion !==
          elem.versionProvider(requestMessage.params)
      ) {
        requestMessage.reject(
          new ResponseError(
            ErrorCodes.InvalidRequest,
            'Request got cancelled'
          )
        )
        return undefined
      }
      const result = elem.handler(
        requestMessage.params,
        requestMessage.token as CancellationToken
      )
      if (Thenable.is(result)) {
        result.then(
          value => {
            requestMessage.resolve(value)
          },
          error => {
            requestMessage.reject(error)
          }
        )
      } else {
        requestMessage.resolve(result)
      }
    } else {
      const notificationMessage = message
      const elem = this.notificationHandlers.get(notificationMessage.method)
      if (
        elem?.versionProvider != null &&
        notificationMessage?.documentVersion !==
          elem.versionProvider(notificationMessage.params)
      ) {
        return undefined
      }
      if (elem != null) {
        elem.handler(notificationMessage.params)
      }
    }
    this.trigger()
  }
}

const messageQueue: BufferedMessageQueue = new BufferedMessageQueue(connection)

messageQueue.onNotification(
  ValidateNotification.type,
  ((async (document: TextDocument) => {
    await validateSingle(document, true)
  }) as unknown) as () => void,
  (document): number => {
    return document.version
  }
)

// The documents manager listen for text document create, change and close on the connection
documents.listen(connection)
documents.onDidOpen(async event => {
  const settings = await resolveSettings(event.document)
  if (!settings.validate) {
    return undefined
  }
  if (settings.run === 'onSave') {
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      event.document,
      event.document.version
    )
  }
})

// A text document has changed. Validate the document according the run setting.
documents.onDidChangeContent(async event => {
  const settings = await resolveSettings(event.document)
  if (!settings.validate || settings.run !== 'onType') {
    return
  }
  messageQueue.addNotificationMessage(
    ValidateNotification.type,
    event.document,
    event.document.version
  )
})

// A text document has been saved. Validate the document according the run setting.
documents.onDidSave(async event => {
  const settings = await resolveSettings(event.document)
  if (!settings.validate || settings.run !== 'onSave') {
    return undefined
  }
  messageQueue.addNotificationMessage(
    ValidateNotification.type,
    event.document,
    event.document.version
  )
})

documents.onDidClose(async (event) => {
  const settings = await resolveSettings(event.document)
  const uri = event.document.uri
  document2Settings.delete(uri)
  if (settings.validate) {
    await connection.sendDiagnostics({ uri, diagnostics: [] })
  }
})

function environmentChanged (): void {
  document2Settings.clear()
  for (const document of documents.all()) {
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      document,
      document.version
    )
  }
}

function trace (message: string, verbose?: string): void {
  connection.tracer.log(message, verbose)
}

connection.onInitialize(_params => {
  globalNodePath = Files.resolveGlobalNodePath()
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
  }
})

connection.onInitialized(((async () => {
  await connection.client.register(
    DidChangeConfigurationNotification.type,
    undefined
  )
  await connection.client.register(
    DidChangeWorkspaceFoldersNotification.type,
    undefined
  )
}) as unknown) as () => void)

messageQueue.registerNotification(
  DidChangeConfigurationNotification.type,
  _params => {
    environmentChanged()
  }
)

messageQueue.registerNotification(
  DidChangeWorkspaceFoldersNotification.type,
  _params => {
    environmentChanged()
  }
)

const singleErrorHandlers: Array<(
  error: any,
  document: TextDocument,
  library: HealthierModule | undefined
) => StatusNotification.Status | undefined> = [
  tryHandleNoConfig,
  tryHandleConfigError,
  tryHandleMissingModule,
  showErrorMessage
]

function validateSingle (
  document: TextDocument,
  publishDiagnostics: boolean = true
): Thenable<void> {
  // We validate document in a queue but open / close documents directly. So we need to deal with the fact that a document might be gone from the server.
  if (documents.get(document.uri) == null) {
    return Promise.resolve(undefined)
  }
  return resolveSettings(document).then(async (settings) => {
    if (!settings.validate) {
      return
    }
    try {
      validate(document, settings, publishDiagnostics)
      await connection.sendNotification(StatusNotification.type, {
        state: StatusNotification.Status.ok
      })
    } catch (err) {
      let status
      for (const handler of singleErrorHandlers) {
        status = handler(err, document, settings.library)
        if (status != null) {
          break
        }
      }
      status = status ?? StatusNotification.Status.error
      await connection.sendNotification(StatusNotification.type, { state: status })
    }
  })
}

function getMessage (err: any, document: TextDocument): string {
  let result: string | null = null
  if (typeof err.message === 'string' || err.message instanceof String) {
    result = err.message as string
    result = result.replace(/\r?\n/g, ' ')
    if (/^CLI: /.test(result)) {
      result = result.substr(5)
    }
  } else {
    result = `An unknown error occured while validating document: ${document.uri}`
  }
  return result
}

function validate (
  document: TextDocument,
  settings: TextDocumentSettings,
  publishDiagnostics: boolean = true
): void {
  const uri = document.uri
  // filename is needed,
  // or eslint processText will fail to load the plugins
  const newOptions: CLIOptions = Object.assign(
    Object.create(null),
    { filename: uri },
    settings.options
  )
  const content = document.getText()
  let file = getFilePath(uri)
  const cwd = process.cwd()
  try {
    if (file != null) {
      if (settings.workingDirectory != null) {
        newOptions.cwd = settings.workingDirectory.directory
        if (
          settings.workingDirectory.changeProcessCWD != null &&
          settings.workingDirectory.changeProcessCWD
        ) {
          process.chdir(settings.workingDirectory.directory)
        }
      } else if (settings.workspaceFolder != null) {
        const workspaceFolderUri = settings.workspaceFolder.uri
        if (workspaceFolderUri.scheme === 'file') {
          newOptions.cwd = workspaceFolderUri.fsPath
          process.chdir(workspaceFolderUri.fsPath)
        }
      } else if (settings.workspaceFolder == null && !isUNC(file)) {
        const directory = path.dirname(file)
        if (directory.length > 0) {
          if (path.isAbsolute(directory)) {
            newOptions.cwd = directory
          }
        }
      }
    }
    let deglobOpts: any = {}
    let opts: any = {}
    if (settings.library != null) {
      newOptions.filename = file
      opts = isLegacyModule(settings.library)
        ? settings.library.parseOpts(newOptions)
        : settings.library.resolveEslintConfig(newOptions)

      deglobOpts = {
        ignore: opts.ignore,
        cwd: opts.cwd,
        configKey: settings.engine
      }
    }

    // Detect brackets in filename and folders.
    file = file.replace(/[[(.)\]]/ig, (match) => {
      if (match === '[') {
        return '[[]'
      } else if (match === ']') {
        return '[]]'
      } else {
        return match
      }
    })

    async.waterfall(
      [
        function (next: (err?: any) => void) {
          if (typeof file === 'undefined') {
            return next(null)
          }
          deglob([file], deglobOpts, function (err: any, files: any) {
            if (err != null) {
              return next(err)
            }
            if (files.length === 1) {
              // got a file
              return next(null)
            } else {
              // no file actually it's not an error, just need to stop the later.
              return next(`${file} ignored.`)
            }
          })
        },
        function (callback: any) {
          if (settings.library != null) {
            if (!isLegacyModule(settings.library)) {
              settings.library.lintText(content, newOptions)
                .then(report => callback(null, report))
                .catch(error => {
                  tryHandleMissingModule(error, document, settings.library)
                  callback(error)
                })
              return
            }

            settings.library.lintText(content, newOptions, function (
              error,
              report
            ) {
              if (error != null) {
                tryHandleMissingModule(error, document, settings.library)
                return callback(error)
              }
              return callback(null, report)
            })
          }
        },
        function (report: HealthierReport | HealthierDocumentReport[], callback: any) {
          const diagnostics: Diagnostic[] = []
          if (report != null) {
            const results = Array.isArray(report) ? report : report.results
            if (
              Array.isArray(results) &&
              results.length > 0
            ) {
              const docReport = results[0]
              if (
                docReport.messages != null &&
                Array.isArray(docReport.messages)
              ) {
                docReport.messages.forEach(problem => {
                  if (problem != null) {
                    const diagnostic = makeDiagnostic(problem, settings)
                    diagnostics.push(diagnostic)
                  }
                })
              }
            }
          }

          if (publishDiagnostics) {
            connection.sendDiagnostics({ uri, diagnostics }).then(() => callback(null)).catch(callback)
          } else {
            callback(null)
          }
        }
      ],
      function (err: any) {
        if (cwd !== process.cwd()) {
          process.chdir(cwd)
        }
        if (err != null) {
          return console.log(err)
        }
      }
    )
  } catch {}
}

const noConfigReported: Map<string, HealthierModule | undefined> = new Map<
string,
HealthierModule
>()

function isNoConfigFoundError (error: any): boolean {
  const candidate = error as HealthierError
  return (
    candidate.messageTemplate === 'no-config-found' ||
    candidate.message === 'No ESLint configuration found.'
  )
}

function tryHandleNoConfig (
  error: any,
  document: TextDocument,
  library: HealthierModule | undefined
): StatusNotification.Status | undefined {
  if (!isNoConfigFoundError(error)) {
    return undefined
  }
  if (!noConfigReported.has(document.uri)) {
    connection
      .sendRequest(NoConfigRequest.type, {
        message: getMessage(error, document),
        document: {
          uri: document.uri
        }
      })
      .then(undefined, () => {})
    noConfigReported.set(document.uri, library)
  }
  return StatusNotification.Status.warn
}

const configErrorReported: Map<string, HealthierModule | undefined> = new Map<
string,
HealthierModule
>()

function tryHandleConfigError (
  error: any,
  document: TextDocument,
  library: HealthierModule | undefined
): StatusNotification.Status | undefined {
  if (error.message == null) {
    return undefined
  }

  function handleFileName (filename: string): StatusNotification.Status {
    if (!configErrorReported.has(filename)) {
      connection.console.error(getMessage(error, document))
      if (documents.get(URI.file(filename).toString()) == null) {
        connection.window.showInformationMessage(getMessage(error, document))
      }
      configErrorReported.set(filename, library)
    }
    return StatusNotification.Status.warn
  }

  let matches = /Cannot read config file:\s+(.*)\nError:\s+(.*)/.exec(
    error.message
  )
  if (matches != null && matches.length === 3) {
    return handleFileName(matches[1])
  }

  matches = /(.*):\n\s*Configuration for rule "(.*)" is /.exec(error.message)
  if (matches != null && matches.length === 3) {
    return handleFileName(matches[1])
  }

  matches = /Cannot find module '([^']*)'\nReferenced from:\s+(.*)/.exec(
    error.message
  )
  if (matches != null && matches.length === 3) {
    return handleFileName(matches[2])
  }

  return undefined
}

const missingModuleReported: Map<string, HealthierModule> = new Map<
string,
HealthierModule
>()

function tryHandleMissingModule (
  error: any,
  document: TextDocument,
  library: HealthierModule | undefined
): StatusNotification.Status | undefined {
  if (error.message == null) {
    return undefined
  }

  function handleMissingModule (
    plugin: string,
    module: string,
    error: HealthierError
  ): StatusNotification.Status {
    if (!missingModuleReported.has(plugin)) {
      const fsPath = getFilePath(document.uri)
      missingModuleReported.set(plugin, library as HealthierModule)
      if (error.messageTemplate === 'plugin-missing') {
        connection.console.error(
          [
            '',
            `${error.message.toString()}`,
            `Happend while validating ${fsPath ?? document.uri}`,
            'This can happen for a couple of reasons:',
            '1. The plugin name is spelled incorrectly in Healthier configuration.',
            `2. If Healthier is installed globally, then make sure ${module} is installed globally as well.`,
            `3. If Healthier is installed locally, then ${module} isn't installed correctly.`
          ].join('\n')
        )
      } else {
        connection.console.error(
          [
            `${error.message.toString()}`,
            `Happend while validating ${fsPath ?? document.uri}`
          ].join('\n')
        )
      }
    }
    return StatusNotification.Status.warn
  }

  const matches = /Failed to load plugin (.*): Cannot find module (.*)/.exec(
    error.message
  )
  if (matches != null && matches.length === 3) {
    return handleMissingModule(matches[1], matches[2], error)
  }

  return undefined
}

function showErrorMessage (
  error: any,
  document: TextDocument
): StatusNotification.Status {
  connection.window.showErrorMessage(getMessage(error, document))
  return StatusNotification.Status.error
}

connection.listen()
