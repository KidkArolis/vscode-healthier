import { RequestType, TextDocumentIdentifier } from 'vscode-languageclient'

interface NoHealthierLibraryParams {
  source: TextDocumentIdentifier
}

export const type = new RequestType<NoHealthierLibraryParams, {}, void>(
  'healthier/noLibrary'
)
