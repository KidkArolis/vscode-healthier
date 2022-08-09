import { RequestType, TextDocumentIdentifier } from 'vscode-languageserver'

interface NoHealthierLibraryParams {
  source: TextDocumentIdentifier
}

export const type = new RequestType<NoHealthierLibraryParams, {}, void>(
  'healthier/noLibrary'
)
