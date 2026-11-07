import type { EditorPage, ExtractResponse, Overlay, TextBlock } from './types';

const configuredApi = import.meta.env.VITE_API_URL as string | undefined;

// Dev uses the separate FastAPI server; production defaults to same-origin
// so a single container can serve both the app and the API.
export const API = (
  configuredApi !== undefined
    ? configuredApi
    : import.meta.env.DEV
      ? 'http://localhost:8000'
      : ''
).replace(/\/+$/, '');

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    return data?.detail || fallback;
  } catch {
    return fallback;
  }
}

export async function extractPdf(file: File): Promise<ExtractResponse> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${API}/extract`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await readError(response, 'Could not read this PDF.'));
  return response.json();
}

export interface PdfExportPage {
  file: number;
  source: number | null;
  width: number;
  height: number;
  rotation: number;
  textEdits: Array<Pick<TextBlock, 'bbox' | 'text' | 'fontSize' | 'font' | 'color' | 'bold' | 'italic' | 'align'>>;
  overlays: Array<Omit<Overlay, 'id'>>;
}

export async function exportPdf(
  sources: File[],
  payload: { filename: string; pages: PdfExportPage[] }
): Promise<Blob> {
  const form = new FormData();
  sources.forEach((file) => form.append('files', file, file.name));
  form.append('payload', JSON.stringify(payload));
  const response = await fetch(`${API}/export/pdf`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await readError(response, 'PDF export failed.'));
  return response.blob();
}

export interface DocxPage {
  texts: Array<{ text: string; fontSize: number; bold: boolean; italic: boolean }>;
}

export async function exportDocx(payload: {
  filename: string;
  pages: DocxPage[];
}): Promise<Blob> {
  const response = await fetch(`${API}/export/docx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readError(response, 'Word export failed.'));
  return response.blob();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function buildEditorPages(
  result: ExtractResponse,
  fileIndex: number,
  idPrefix: string
): EditorPage[] {
  return result.pages.map((page) => ({
    id: `${idPrefix}-p${page.index}`,
    fileIndex,
    sourceIndex: page.index,
    width: page.width,
    height: page.height,
    baseWidth: page.width,
    baseHeight: page.height,
    baseRotation: page.rotation,
    rotation: page.rotation,
    background: page.background,
    textBlocks: page.textBlocks.map((block) => ({
      ...block,
      edited: false,
      originalFontSize: block.fontSize,
      originalColor: block.color,
      originalBold: block.bold,
      originalItalic: block.italic,
      originalAlign: block.align,
    })),
    overlays: [],
    hasText: page.hasText,
    hasImages: page.hasImages,
  }));
}
