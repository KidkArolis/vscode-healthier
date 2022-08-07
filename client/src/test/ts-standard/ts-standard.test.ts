import * as vscode from 'vscode'

import { getDocUri, testDiagnostics } from '../helper'

test('ts-healthier', async () => {
  const noLintErrorsUri = getDocUri('ts-healthier/src', 'no-lint-errors.ts')
  const lintErrorsUri = getDocUri('ts-healthier/src', 'lint-errors.ts')
  await testDiagnostics(noLintErrorsUri, [])
  await testDiagnostics(lintErrorsUri, [
    {
      message: 'Strings must use singlequote. (@typescript-eslint/quotes)',
      range: new vscode.Range(
        new vscode.Position(0, 12),
        new vscode.Position(0, 27)
      ),
      severity: vscode.DiagnosticSeverity.Error
    },
    {
      message: 'Extra semicolon. (@typescript-eslint/semi)',
      range: new vscode.Range(
        new vscode.Position(0, 28),
        new vscode.Position(0, 29)
      ),
      severity: vscode.DiagnosticSeverity.Error
    }
  ])
})
