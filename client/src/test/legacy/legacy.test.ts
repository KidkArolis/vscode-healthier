import * as vscode from 'vscode'

import { getDocUri, testDiagnostics } from '../helper'

test('legacy', async () => {
  const noLintErrorsUri = getDocUri('legacy', 'no-lint-errors.js')
  const lintErrorsUri = getDocUri('legacy', 'lint-errors.js')
  await testDiagnostics(noLintErrorsUri, [])
  await testDiagnostics(lintErrorsUri, [
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
  ])
})
