import * as path from 'path'
import * as fs from 'fs'
import {
  CodeActionContext,
  commands as Commands,
  Diagnostic,
  Disposable,
  ExtensionContext,
  languages as Languages,
  QuickPickItem,
  StatusBarAlignment,
  TextDocument,
  TextEditor,
  window as Window,
  workspace as Workspace,
  WorkspaceConfiguration,
  WorkspaceFolder as VWorkspaceFolder
} from 'vscode'
import {
  CloseAction,
  CloseHandlerResult,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentFilter,
  ErrorHandler,
  ErrorHandlerResult,
  LanguageClient,
  LanguageClientOptions,
  NotificationType,
  RevealOutputChannelOn,
  ServerOptions,
  State as ClientState,
  TransportKind
} from 'vscode-languageclient/node'
import { URI } from 'vscode-uri'

import * as DirectoryItem from './utils/DirectoryItem'
import * as Is from './utils/Is'
import * as NoHealthierLibraryRequest from './utils/NoHealthierLibraryRequest'
import * as StatusNotification from './utils/StatusNotification'
import * as ValidateItem from './utils/ValidateItem'
import { linterValues } from './linterValues'

type LinterValues = typeof linterValues[number]
type LinterNameValues =
  | 'Healthier'
  | 'Healthier TypeScript'
let linterName: LinterNameValues

type RunValues = 'onType' | 'onSave'

interface TextDocumentSettings {
  validate: boolean
  engine: LinterValues
  usePackageJson: boolean
  options: any | undefined
  run: RunValues
  nodePath: string | undefined
  workspaceFolder: VWorkspaceFolder | undefined
  workingDirectory: DirectoryItem.DirectoryItem | undefined
  library: undefined
  treatErrorsAsWarnings: boolean
}

interface NoHealthierState {
  global?: boolean
  workspaces?: { [key: string]: boolean }
}

const exitCalled = new NotificationType<[number, string]>('healthier/exitCalled')

interface WorkspaceFolderItem extends QuickPickItem {
  folder: VWorkspaceFolder
}
function getLinterName (): LinterNameValues {
  const configuration = Workspace.getConfiguration('healthier')
  const linterNames: { [linter: string]: LinterNameValues } = {
    healthier: 'Healthier',
    'ts-healthier': 'Healthier TypeScript'
  }
  return linterNames[configuration.get<LinterValues>('engine', 'healthier')]
}
function pickFolder (
  folders: VWorkspaceFolder[],
  placeHolder: string
): Thenable<VWorkspaceFolder | undefined> {
  if (folders.length === 1) {
    return Promise.resolve(folders[0])
  }
  return Window.showQuickPick(
    folders.map<WorkspaceFolderItem>((folder) => {
      return {
        label: folder.name,
        description: folder.uri.fsPath,
        folder: folder
      }
    }),
    { placeHolder: placeHolder }
  ).then((selected) => {
    if (selected == null) {
      return undefined
    }
    return selected.folder
  })
}

async function enable (): Promise<void> {
  const folders = Workspace.workspaceFolders
  if (folders == null) {
    await Window.showWarningMessage(
      `${linterName} can only be enabled if VS Code is opened on a workspace folder.`
    )
    return undefined
  }
  const disabledFolders = folders.filter(
    (folder) =>
      !Workspace.getConfiguration('healthier', folder.uri).get('enable', true)
  )
  if (disabledFolders.length === 0) {
    if (folders.length === 1) {
      await Window.showInformationMessage(
        `${linterName} is already enabled in the workspace.`
      )
    } else {
      await Window.showInformationMessage(
        `${linterName} is already enabled on all workspace folders.`
      )
    }
    return
  }
  const folder = await pickFolder(
    disabledFolders,
    `Select a workspace folder to enable ${linterName} for`
  )
  if (folder == null) {
    return undefined
  }
  await Workspace.getConfiguration('healthier', folder.uri).update(
    'enable',
    true
  )
}

async function disable (): Promise<void> {
  const folders = Workspace.workspaceFolders
  if (folders == null) {
    await Window.showErrorMessage(
      `${linterName} can only be disabled if VS Code is opened on a workspace folder.`
    )
    return undefined
  }
  const enabledFolders = folders.filter((folder) =>
    Workspace.getConfiguration('healthier', folder.uri).get('enable', true)
  )
  if (enabledFolders.length === 0) {
    if (folders.length === 1) {
      await Window.showInformationMessage(
        `${linterName} is already disabled in the workspace.`
      )
    } else {
      await Window.showInformationMessage(
        `${linterName} is already disabled on all workspace folders.`
      )
    }
    return
  }
  const folder = await pickFolder(
    enabledFolders,
    `Select a workspace folder to disable ${linterName} for`
  )
  if (folder == null) {
    return undefined
  }
  await Workspace.getConfiguration('healthier', folder.uri).update(
    'enable',
    false
  )
}

let dummyCommands: Disposable[] | null

const defaultLanguages = [
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact'
]
function shouldBeValidatedLanguage (
  config: WorkspaceConfiguration,
  textDocument: TextDocument
): boolean {
  const validate = config.get<Array<ValidateItem.ValidateItem | string>>(
    'validate',
    defaultLanguages
  )
  for (const item of validate) {
    if (Is.string(item) && item === textDocument.languageId) {
      return true
    } else if (
      ValidateItem.is(item) &&
      item.language === textDocument.languageId
    ) {
      return true
    }
  }
  return false
}

function shouldBeValidated (textDocument: TextDocument): boolean {
  const config = Workspace.getConfiguration('healthier', textDocument.uri)
  const usePackageJson = config.get('usePackageJson', true)
  const isEnabled = config.get('enable', true)
  const isEnabledGlobally = config.get('enableGlobally', true)
  if (!isEnabled) {
    return false
  }
  if (
    !isEnabledGlobally &&
    usePackageJson &&
    Workspace.workspaceFolders?.length === 1
  ) {
    const workspacePath = Workspace.workspaceFolders[0].uri.fsPath
    const packageJsonPath = path.join(workspacePath, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath).toString()
      )
      if (packageJson.devDependencies != null) {
        const devDependencies = Object.keys(packageJson.devDependencies)
        const hasHealthierEngineInstalled = linterValues.some((engine) => {
          return devDependencies.includes(engine)
        })
        if (hasHealthierEngineInstalled) {
          return shouldBeValidatedLanguage(config, textDocument)
        }
        return false
      }
    }
  }
  if (isEnabledGlobally) {
    return shouldBeValidatedLanguage(config, textDocument)
  }
  return false
}

export async function activate (context: ExtensionContext): Promise<void> {
  let activated: boolean = false
  let openListener: Disposable | null = null
  let configurationListener: Disposable | null = null
  function didOpenTextDocument (textDocument: TextDocument): void {
    if (activated) {
      return
    }
    if (shouldBeValidated(textDocument)) {
      openListener?.dispose()
      configurationListener?.dispose()
      activated = true
      realActivate(context)
    }
  }
  async function configurationChanged (): Promise<void> {
    if (!activated) {
      for (const textDocument of Workspace.textDocuments) {
        if (shouldBeValidated(textDocument)) {
          openListener?.dispose()
          configurationListener?.dispose()
          activated = true
          realActivate(context)
          break
        }
      }
    }
    await Commands.executeCommand('setContext', 'healthierEnabled', activated)
  }
  openListener = Workspace.onDidOpenTextDocument(didOpenTextDocument)
  configurationListener =
    Workspace.onDidChangeConfiguration(configurationChanged)

  const notValidating = async (): Promise<Thenable<string | undefined>> => {
    return await Window.showInformationMessage(
      `${linterName} is not validating any files yet.`
    )
  }
  dummyCommands = [
    Commands.registerCommand('healthier.showOutputChannel', notValidating)
  ]

  context.subscriptions.push(
    Commands.registerCommand('healthier.enable', enable),
    Commands.registerCommand('healthier.disable', disable)
  )
  await configurationChanged()
}

export function realActivate (context: ExtensionContext): void {
  linterName = getLinterName()

  const statusBarItem = Window.createStatusBarItem(StatusBarAlignment.Right, 0)
  let healthierStatus: StatusNotification.Status = StatusNotification.Status.ok
  let serverRunning: boolean = false

  statusBarItem.text = linterName
  statusBarItem.command = 'healthier.showOutputChannel'

  function showStatusBarItem (show: boolean): void {
    if (show) {
      statusBarItem.show()
    } else {
      statusBarItem.hide()
    }
  }

  function updateStatus (status: StatusNotification.Status): void {
    switch (status) {
      case StatusNotification.Status.ok:
        statusBarItem.color = undefined
        break
      case StatusNotification.Status.warn:
        statusBarItem.color = 'yellow'
        break
      case StatusNotification.Status.error:
        statusBarItem.color = 'darkred'
        break
    }
    healthierStatus = status
    updateStatusBarVisibility(Window.activeTextEditor)
  }

  function updateStatusBarVisibility (editor: TextEditor | undefined): void {
    statusBarItem.text =
      healthierStatus === StatusNotification.Status.ok
        ? linterName
        : `${linterName}!`
    showStatusBarItem(
      serverRunning &&
        (healthierStatus !== StatusNotification.Status.ok ||
          (editor != null &&
            defaultLanguages.includes(editor.document.languageId)))
    )
  }

  Window.onDidChangeActiveTextEditor(updateStatusBarVisibility)
  updateStatusBarVisibility(Window.activeTextEditor)

  // We need to go one level up since an extension compile the js code into the output folder.
  const serverModule = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  )
  const debugOptions = {
    execArgv: ['--nolazy', '--inspect=6023'],
    cwd: process.cwd()
  }
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { cwd: process.cwd() }
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  }

  let defaultErrorHandler: ErrorHandler | null = null
  let serverCalledProcessExit: boolean = false

  const packageJsonFilter: DocumentFilter = {
    scheme: 'file',
    pattern: '**/package.json'
  }
  const syncedDocuments: Map<string, TextDocument> = new Map<
  string,
  TextDocument
  >()

  Workspace.onDidChangeConfiguration(async () => {
    for (const textDocument of syncedDocuments.values()) {
      if (!shouldBeValidated(textDocument)) {
        syncedDocuments.delete(textDocument.uri.toString())
        await client.sendNotification(
          DidCloseTextDocumentNotification.type,
          client.code2ProtocolConverter.asCloseTextDocumentParams(textDocument)
        )
      }
    }
    for (const textDocument of Workspace.textDocuments) {
      if (
        !syncedDocuments.has(textDocument.uri.toString()) &&
        shouldBeValidated(textDocument)
      ) {
        await client.sendNotification(
          DidOpenTextDocumentNotification.type,
          client.code2ProtocolConverter.asOpenTextDocumentParams(textDocument)
        )
        syncedDocuments.set(textDocument.uri.toString(), textDocument)
      }
    }
  })
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
    diagnosticCollectionName: 'healthier',
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    synchronize: {
      // configurationSection: 'healthier',
      fileEvents: [Workspace.createFileSystemWatcher('**/package.json')]
    },
    initializationOptions: () => {
      const configuration = Workspace.getConfiguration('healthier')
      const folders = Workspace.workspaceFolders
      return {
        nodePath:
          configuration != null
            ? configuration.get('nodePath', undefined)
            : undefined,
        languageIds:
          configuration != null
            ? configuration.get('validate', defaultLanguages)
            : defaultLanguages,
        workspaceFolders:
          folders != null ? folders.map((folder) => folder.name) : []
      }
    },
    initializationFailedHandler: (error) => {
      client.error('Server initialization failed.', error)
      client.outputChannel.show(true)
      return false
    },
    errorHandler: {
      error: (error, message, count): ErrorHandlerResult => {
        return defaultErrorHandler?.error(error, message, count) as ErrorHandlerResult
      },
      closed: (): CloseHandlerResult => {
        if (serverCalledProcessExit) {
          return {
            action: CloseAction.DoNotRestart
          }
        }
        return defaultErrorHandler?.closed() as CloseHandlerResult
      }
    },
    middleware: {
      didOpen: async (document, next) => {
        if (
          Languages.match(packageJsonFilter, document) >= 0 ||
          shouldBeValidated(document)
        ) {
          await next(document)
          syncedDocuments.set(document.uri.toString(), document)
        }
      },
      didChange: async (event, next) => {
        if (syncedDocuments.has(event.document.uri.toString())) {
          await next(event)
        }
      },
      willSave: async (event, next) => {
        if (syncedDocuments.has(event.document.uri.toString())) {
          await next(event)
        }
      },
      willSaveWaitUntil: (event, next) => {
        if (syncedDocuments.has(event.document.uri.toString())) {
          return next(event)
        } else {
          return Promise.resolve([])
        }
      },
      didSave: async (document, next) => {
        if (syncedDocuments.has(document.uri.toString())) {
          await next(document)
        }
      },
      didClose: async (document, next) => {
        const uri = document.uri.toString()
        if (syncedDocuments.has(uri)) {
          syncedDocuments.delete(uri)
          await next(document)
        }
      },
      provideCodeActions: (document, range, context, token, next) => {
        if (
          !syncedDocuments.has(document.uri.toString()) ||
          context.diagnostics == null ||
          context.diagnostics.length === 0
        ) {
          return []
        }
        const healthierDiagnostics: Diagnostic[] = []
        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === 'healthier') {
            healthierDiagnostics.push(diagnostic)
          }
        }
        if (healthierDiagnostics.length === 0) {
          return []
        }
        const newContext: CodeActionContext = Object.assign({}, context, {
          diagnostics: healthierDiagnostics
        })
        return next(document, range, newContext, token)
      },
      workspace: {
        configuration: (params, _token, _next) => {
          if (params.items == null) {
            return []
          }
          const result: Array<TextDocumentSettings | null> = []
          for (const item of params.items) {
            if (
              (item?.section != null && item.section.length > 0) ||
              item.scopeUri?.length === 0
            ) {
              result.push(null)
              continue
            }
            const resource = client.protocol2CodeConverter.asUri(
              item.scopeUri as string
            )
            const config = Workspace.getConfiguration('healthier', resource)
            const settings: TextDocumentSettings = {
              validate: false,
              engine: config.get('engine', 'healthier'),
              usePackageJson: config.get('usePackageJson', false),
              options: config.get('options', {}),
              run: config.get('run', 'onType'),
              nodePath: config.get('nodePath', undefined),
              workingDirectory: undefined,
              workspaceFolder: undefined,
              library: undefined,
              treatErrorsAsWarnings: config.get('treatErrorsAsWarnings', false)
            }
            const document = syncedDocuments.get(item.scopeUri as string)
            if (document == null) {
              result.push(settings)
              continue
            }
            if (config.get('enabled', true)) {
              const validateItems = config.get<
              Array<ValidateItem.ValidateItem | string>
              >('validate', defaultLanguages)
              for (const item of validateItems) {
                if (Is.string(item) && item === document.languageId) {
                  settings.validate = true
                  break
                } else if (
                  ValidateItem.is(item) &&
                  item.language === document.languageId
                ) {
                  settings.validate = true
                  break
                }
              }
            }
            const workspaceFolder = Workspace.getWorkspaceFolder(resource)
            if (workspaceFolder != null) {
              settings.workspaceFolder = {
                name: workspaceFolder.name,
                uri: workspaceFolder.uri,
                index: workspaceFolder.index
              }
            }
            const workingDirectories =
              config.get<Array<string | DirectoryItem.DirectoryItem>>(
                'workingDirectories'
              )
            if (Array.isArray(workingDirectories)) {
              let workingDirectory
              const workspaceFolderPath =
                workspaceFolder != null && workspaceFolder.uri.scheme === 'file'
                  ? workspaceFolder.uri.fsPath
                  : undefined
              for (const entry of workingDirectories) {
                let directory
                let changeProcessCWD = false
                if (Is.string(entry)) {
                  directory = entry
                } else if (DirectoryItem.is(entry)) {
                  directory = entry.directory
                  changeProcessCWD =
                    entry.changeProcessCWD != null ? changeProcessCWD : false
                }
                if (directory != null) {
                  if (
                    !path.isAbsolute(directory) &&
                    workspaceFolderPath != null &&
                    directory != null
                  ) {
                    directory = path.join(workspaceFolderPath, directory)
                  } else if (!path.isAbsolute(directory)) {
                    directory = undefined
                  }
                  const filePath =
                    document.uri.scheme === 'file'
                      ? document.uri.fsPath
                      : undefined
                  if (
                    filePath != null &&
                    directory != null &&
                    filePath.startsWith(directory)
                  ) {
                    if (workingDirectory != null) {
                      if (
                        workingDirectory.directory.length < directory.length
                      ) {
                        workingDirectory.directory = directory
                        workingDirectory.changeProcessCWD = changeProcessCWD
                      }
                    } else {
                      workingDirectory = { directory, changeProcessCWD }
                    }
                  }
                }
              }
              settings.workingDirectory = workingDirectory
            }
            result.push(settings)
          }
          return result
        }
      }
    }
  }
  const client = new LanguageClient(linterName, serverOptions, clientOptions)
  client.registerProposedFeatures()
  defaultErrorHandler = client.createDefaultErrorHandler()
  const running = `${linterName} server is running.`
  const stopped = `${linterName} server stopped.`
  client.onDidChangeState((event) => {
    if (event.newState === ClientState.Running) {
      client.info(running)
      statusBarItem.tooltip = running
      serverRunning = true
    } else {
      client.info(stopped)
      statusBarItem.tooltip = stopped
      serverRunning = false
    }
    updateStatusBarVisibility(Window.activeTextEditor)
  })
  client
    .start()
    .then(() => {
      client.onNotification(StatusNotification.type, (params) => {
        updateStatus(params.state)
      })

      client.onNotification(exitCalled, (async (params: any) => {
        serverCalledProcessExit = true
        client.error(
          `Server process exited with code ${
            params[0] as string
          }. This usually indicates a misconfigured ${linterName} setup.`,
          params[1]
        )
        await Window.showErrorMessage(
          `${linterName} server shut down itself. See '${linterName}' output channel for details.`
        )
      }) as unknown as () => void)

      client.onRequest(NoHealthierLibraryRequest.type, async (params) => {
        const key = 'noHealthierMessageShown'
        const state = context.globalState.get<NoHealthierState>(key, {})
        const uri = URI.parse(params.source.uri)
        const workspaceFolder = Workspace.getWorkspaceFolder(uri)
        const config = Workspace.getConfiguration('healthier')
        const linter = config.get('engine', 'healthier')
        if (workspaceFolder != null) {
          client.info(
            [
              '',
              `Failed to load the ${linterName} library for the document ${uri.fsPath}`,
              '',
              `To use ${linterName} please install ${linterName} by running 'npm install ${linter}' in the workspace folder ${workspaceFolder.name}`,
              `or globally using 'npm install -g ${linter}'. You need to reopen the workspace after installing ${linterName}.`,
              '',
              `Alternatively you can disable ${linterName} for the workspace folder ${workspaceFolder.name} by executing the 'Disable Healthier' command.`
            ].join('\n')
          )
          if (state.workspaces == null) {
            state.workspaces = Object.create(null)
          }
          if (
            state.workspaces != null &&
            !state.workspaces[workspaceFolder.uri.toString()]
          ) {
            state.workspaces[workspaceFolder.uri.toString()] = true
            client.outputChannel.show(true)
            await context.globalState.update(key, state)
          }
        } else {
          client.info(
            [
              `Failed to load the ${linterName} library for the document ${uri.fsPath}`,
              `To use ${linterName} for single JavaScript file install healthier globally using 'npm install -g ${linter}'.`,
              `You need to reopen VS Code after installing ${linter}.`
            ].join('\n')
          )
          if (state.global != null && !state.global) {
            state.global = true
            client.outputChannel.show(true)
            await context.globalState.update(key, state)
          }
        }
        return {}
      })
    })
    .catch(() => {})

  if (dummyCommands != null) {
    dummyCommands.forEach((command) => command.dispose())
    dummyCommands = null
  }
  context.subscriptions.push(
    Commands.registerCommand('healthier.showOutputChannel', () => {
      client.outputChannel.show()
    }),
    statusBarItem
  )
}

export function deactivate (): void {
  if (dummyCommands != null) {
    dummyCommands.forEach((command) => command.dispose())
  }
}
