import { PDFDocument } from 'pdf-lib';

export interface PDFChunk { index: number; startPage: number; endPage: number; blob: Blob; sizeMB: number; }
export interface SplitProgress { phase: 'loading' | 'analyzing' | 'splitting' | 'complete'; progress: number; message: string; chunksCreated?: number; totalChunks?: number; }

const MAX_CHUNK_SIZE_MB = 40;
const MAX_PAGES_PER_CHUNK = 150;

export async function splitPDFInBrowser(
  file: File,
  onProgress: (progress: SplitProgress) => void,
  opts?: { maxChunkMB?: number; maxPagesPerChunk?: number },
): Promise<PDFChunk[]> {
  const maxChunkMB = opts?.maxChunkMB ?? MAX_CHUNK_SIZE_MB;
  const maxPages = opts?.maxPagesPerChunk ?? MAX_PAGES_PER_CHUNK;
  onProgress({ phase: 'loading', progress: 0, message: 'Loading PDF...' });
  const arrayBuffer = await file.arrayBuffer();
  onProgress({ phase: 'loading', progress: 5, message: 'Parsing PDF structure...' });
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true, updateMetadata: false });
  const totalPages = pdfDoc.getPageCount();
  const totalSizeMB = file.size / (1024 * 1024);
  onProgress({ phase: 'analyzing', progress: 10, message: `Analyzing ${totalPages} pages (${totalSizeMB.toFixed(1)} MB)` });

  if (totalSizeMB <= maxChunkMB && totalPages <= maxPages) {
    onProgress({ phase: 'complete', progress: 100, message: 'Ready to upload', chunksCreated: 1, totalChunks: 1 });
    return [{ index: 0, startPage: 1, endPage: totalPages, blob: file, sizeMB: totalSizeMB }];
  }

  const avgPageSizeMB = totalSizeMB / totalPages;
  const maxPagesForSize = Math.floor(maxChunkMB / avgPageSizeMB);
  const pagesPerChunk = Math.min(Math.max(1, maxPagesForSize), maxPages);
  const totalChunks = Math.ceil(totalPages / pagesPerChunk);
  onProgress({ phase: 'splitting', progress: 15, message: `Splitting into ${totalChunks} parts...`, totalChunks });

  const chunks: PDFChunk[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const startPage = i * pagesPerChunk;
    const endPage = Math.min(startPage + pagesPerChunk, totalPages);
    const chunkDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: endPage - startPage }, (_, j) => startPage + j);
    const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach(page => chunkDoc.addPage(page));
    const chunkBytes = await chunkDoc.save();
    const blob = new Blob([new Uint8Array(chunkBytes)], { type: 'application/pdf' });
    chunks.push({ index: i, startPage: startPage + 1, endPage, blob, sizeMB: chunkBytes.byteLength / (1024 * 1024) });
    const progress = 15 + Math.floor(((i + 1) / totalChunks) * 80);
    onProgress({ phase: 'splitting', progress, message: `Preparing part ${i + 1} of ${totalChunks}...`, chunksCreated: i + 1, totalChunks });
  }

  onProgress({ phase: 'complete', progress: 100, message: `Ready to upload ${chunks.length} parts`, chunksCreated: chunks.length, totalChunks: chunks.length });
  return chunks;
}

export function needsSplitting(file: File, maxChunkMB = MAX_CHUNK_SIZE_MB): boolean { return file.size / (1024 * 1024) > maxChunkMB; }
export function getFileSizeMB(file: File): number { return file.size / (1024 * 1024); }