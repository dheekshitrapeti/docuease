import type { CSSProperties } from 'react';
import type { EditorPage, Overlay, Point, Rect } from './types';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRect(a: Point, b: Point): Rect {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
}

export function bboxFromPoints(points: Point[]): Rect {
  if (!points.length) return [0, 0, 0, 0];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

export function rotateRectCW(rect: Rect, _width: number, height: number): Rect {
  return [height - rect[3], rect[0], height - rect[1], rect[2]];
}

export function rotatePointCW(point: Point, _width: number, height: number): Point {
  return [height - point[1], point[0]];
}

export function rotateRectCCW(rect: Rect, width: number, _height: number): Rect {
  return [rect[1], width - rect[2], rect[3], width - rect[0]];
}

export function rotatePointCCW(point: Point, width: number, _height: number): Point {
  return [point[1], width - point[0]];
}

export function rotatePage(page: EditorPage, direction: 1 | -1): EditorPage {
  const w = page.width;
  const h = page.height;
  const nextRotation = (page.rotation + (direction === 1 ? 90 : 270)) % 360;
  const rectFn = direction === 1 ? rotateRectCW : rotateRectCCW;
  const pointFn = direction === 1 ? rotatePointCW : rotatePointCCW;
  const textBlocks = page.textBlocks.map((block) => ({
    ...block,
    bbox: rectFn(block.bbox, w, h),
  }));
  const overlays = page.overlays.map((overlay) => ({
    ...overlay,
    bbox: rectFn(overlay.bbox, w, h),
    points: overlay.points?.map((point) => pointFn(point, w, h)),
  }));
  return { ...page, width: h, height: w, rotation: nextRotation, textBlocks, overlays };
}

export function cssFontFamily(font?: string): string {
  const f = (font || '').toLowerCase();
  if (f.includes('courier') || f.includes('mono') || f.includes('consol')) {
    return '"Courier New", Courier, monospace';
  }
  if (f.includes('times') || f.includes('serif') || f.includes('georgia') || f.includes('garamond')) {
    return 'Georgia, "Times New Roman", serif';
  }
  return 'Arial, Helvetica, sans-serif';
}

export function hexToRgba(hex: string | undefined, alpha = 1): string {
  const fallback = `rgba(0,0,0,${alpha})`;
  if (!hex) return fallback;
  let value = hex.trim().replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length !== 6) return fallback;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return fallback;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[\\/]+/g, '-') || 'docuease-document';
}

export function cloneOverlays(overlays: Overlay[]): Overlay[] {
  return overlays.map((overlay) => ({
    ...overlay,
    id: uid('ov'),
    bbox: [...overlay.bbox] as Rect,
    points: overlay.points?.map((point) => [...point] as Point),
  }));
}


export function backgroundStyle(page: EditorPage, scale: number): CSSProperties {
  const delta = ((page.rotation - page.baseRotation) % 360 + 360) % 360;
  const width = page.baseWidth * scale;
  const height = page.baseHeight * scale;
  const base: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height,
    transformOrigin: 'top left',
    userSelect: 'none',
    pointerEvents: 'none',
  };
  if (delta === 90) return { ...base, transform: `translate(${height}px, 0) rotate(90deg)` };
  if (delta === 180) return { ...base, transform: `translate(${width}px, ${height}px) rotate(180deg)` };
  if (delta === 270) return { ...base, transform: `translate(0, ${width}px) rotate(270deg)` };
  return base;
}
