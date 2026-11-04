import {prepareDocumentExport, type DocumentExportOptions, type NotionExportResult} from './notionExport'

export const GOOGLE_DOCS_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Ordinary editable OOXML, packaged on this device for Google Docs import. */
export async function buildGoogleDocsExport(options: DocumentExportOptions): Promise<NotionExportResult & {mimeType: string}> {
  const prepared = await prepareDocumentExport(options)
  options.signal?.throwIfAborted()
  options.onProgress?.('Preparing the Google Docs document')
  const {htmlToDocx} = await import('./htmlToDocx')
  const bytes = await htmlToDocx(prepared, options.signal)
  options.signal?.throwIfAborted()
  return {bytes, filename: `${prepared.filenameStem}-google-docs.docx`, mimeType: GOOGLE_DOCS_MIME,
    documentCount: prepared.documentCount, assetCount: prepared.assetCount, diagnostics: prepared.diagnostics}
}
