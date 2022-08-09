import * as vscode from 'vscode'

import { getDocUri, testDiagnostics } from '../helper'

const expectedDiagnosticsLintErrors: vscode.Diagnostic[] = [
  {
    message: '\'a\' is assigned a value but never used. (no-unused-vars)',
    range: new vscode.Range(
      new vscode.Position(0, 6),
      new vscode.Position(0, 7)
    ),
    severity: vscode.DiagnosticSeverity.Error
  },
  {
    message: '\'cnsole\' is not defined. (no-undef)',
    range: new vscode.Range(
      new vscode.Position(0, 16),
      new vscode.Position(0, 10)
    ),
    severity: vscode.DiagnosticSeverity.Error
  }
]

test('latest healthier', async () => {
  const noLintErrorsUri = getDocUri('latest', 'no-lint-errors.js')
  const lintErrorsUri = getDocUri('latest', 'lint-errors.js')
  await testDiagnostics(noLintErrorsUri, [])
  await testDiagnostics(lintErrorsUri, expectedDiagnosticsLintErrors)
})

test('latest healthier with brackets in filename and folders', async () => {
  const errorsFilenameBracketsUri = getDocUri('latest', '[errors].js')
  const errorsFolderBracketsUri = getDocUri('latest', '[errors]/errors.js')
  const errorsFilenameAndFolderBracketsUri = getDocUri('latest', '[errors]/[errors].js')
  const errorsFilenameAndFolderDeepBracketsUri = getDocUri('latest', '[errors]/[deep]/[errors].js')
  await testDiagnostics(errorsFilenameBracketsUri, expectedDiagnosticsLintErrors)
  await testDiagnostics(errorsFolderBracketsUri, expectedDiagnosticsLintErrors)
  await testDiagnostics(errorsFilenameAndFolderBracketsUri, expectedDiagnosticsLintErrors)
  await testDiagnostics(errorsFilenameAndFolderDeepBracketsUri, expectedDiagnosticsLintErrors)
})
