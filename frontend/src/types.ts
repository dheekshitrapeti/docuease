export type Rect = [number, number, number, number];
export type Point = [number, number];

export interface TextBlock {
  id: string;
  bbox: Rect;
  text: string;
  originalText: string;
  fontSize: number;
  font: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: string;
  edited?: boolean;
  originalFontSize?: number;
  originalColor?: string;
  originalBold?: boolean;
  originalItalic?: boolean;
  originalAlign?: string;
}

export type OverlayType =
  | 'text'
  | 'image'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'draw'
  | 'whiteout'
  | 'note';

export interface Overlay {
  id: string;
  type: OverlayType;
  bbox: Rect;
  points?: Point[];
  text?: string;
  fontSize?: number;
  font?: string;
  color?: string;
  fill?: string | null;
  stroke?: string;
  opacity?: number;
  width?: number;
  data?: string;
  align?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface EditorPage {
  id: string;
  fileIndex: number;
  sourceIndex: number | null;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
  baseRotation: number;
  rotation: number;
  background: string | null;
  textBlocks: TextBlock[];
  overlays: Overlay[];
  hasText: boolean;
  hasImages: boolean;
  blank?: boolean;
}

export interface ExtractedPage {
  index: number;
  width: number;
  height: number;
  rotation: number;
  background: string;
  textBlocks: Omit<TextBlock, 'edited'>[];
  hasText: boolean;
  hasImages: boolean;
}

export interface ExtractResponse {
  filename: string;
  pageCount: number;
  pages: ExtractedPage[];
  metadata: Record<string, string>;
  hasSelectableText: boolean;
}

export type Tool =
  | 'select'
  | 'text'
  | 'image'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'draw'
  | 'whiteout'
  | 'note';

export type Selection =
  | { pageId: string; kind: 'page' }
  | { pageId: string; kind: 'block'; id: string }
  | { pageId: string; kind: 'overlay'; id: string };

export type EditTarget = { pageId: string; kind: 'block' | 'overlay'; id: string };

export interface ExportOverlay {
  type: OverlayType;
  bbox: Rect;
  points?: Point[];
  text?: string;
  fontSize?: number;
  font?: string;
  color?: string;
  fill?: string | null;
  stroke?: string;
  opacity?: number;
  width?: number;
  data?: string;
  align?: string;
  bold?: boolean;
  italic?: boolean;
}
