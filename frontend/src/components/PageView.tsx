import {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  RotateCw,
  RotateCcw,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import type { EditTarget, EditorPage, Overlay, Point, Rect, Selection, Tool } from '../types';
import {
  backgroundStyle,
  bboxFromPoints,
  clamp,
  cssFontFamily,
  hexToRgba,
  normalizeRect,
  uid,
} from '../utils';

interface PageViewProps {
  page: EditorPage;
  pageNumber: number;
  totalPages: number;
  zoom: number;
  tool: Tool;
  selection: Selection | null;
  editing: EditTarget | null;
  onSelect: (selection: Selection) => void;
  onClearSelection: () => void;
  onStartEdit: (target: EditTarget) => void;
  onStopEdit: () => void;
  onCommitPage: (pageId: string, updater: (page: EditorPage) => EditorPage) => void;
  onLivePage: (pageId: string, updater: (page: EditorPage) => EditorPage) => void;
  onBegin: () => void;
  onEnd: (record: boolean) => void;
  onRotate: (pageId: string, direction: 1 | -1) => void;
  onDeletePage: (pageId: string) => void;
  onDuplicatePage: (pageId: string) => void;
  onMovePage: (pageId: string, direction: -1 | 1) => void;
  registerRef: (pageId: string, element: HTMLDivElement | null) => void;
}

const SHAPE_TOOLS: Tool[] = ['highlight', 'rect', 'ellipse', 'line', 'whiteout', 'draw'];

function draftOverlay(tool: Tool, start: Point, end: Point, points: Point[]): Overlay | null {
  if (tool === 'draw') {
    const all = points.length ? points : [start, end];
    return {
      id: uid('ov'),
      type: 'draw',
      bbox: bboxFromPoints(all),
      points: all,
      stroke: '#1f2937',
      width: 2,
      opacity: 1,
    };
  }
  const bbox = normalizeRect(start, end);
  if (tool === 'line') {
    return {
      id: uid('ov'),
      type: 'line',
      bbox,
      points: [start, end],
      stroke: '#2563eb',
      width: 2,
      opacity: 1,
    };
  }
  if (tool === 'highlight') {
    return { id: uid('ov'), type: 'highlight', bbox, color: '#ffe066', opacity: 0.45 };
  }
  if (tool === 'whiteout') {
    return { id: uid('ov'), type: 'whiteout', bbox, fill: '#ffffff' };
  }
  if (tool === 'ellipse') {
    return { id: uid('ov'), type: 'ellipse', bbox, stroke: '#2563eb', fill: null, width: 2, opacity: 1 };
  }
  if (tool === 'rect') {
    return { id: uid('ov'), type: 'rect', bbox, stroke: '#2563eb', fill: null, width: 2, opacity: 1 };
  }
  return null;
}

export default function PageView(props: PageViewProps) {
  const {
    page,
    pageNumber,
    totalPages,
    zoom,
    tool,
    selection,
    editing,
    onSelect,
    onClearSelection,
    onStartEdit,
    onStopEdit,
    onCommitPage,
    onLivePage,
    onBegin,
    onEnd,
    onRotate,
    onDeletePage,
    onDuplicatePage,
    onMovePage,
    registerRef,
  } = props;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingImagePoint = useRef<Point>([24, 24]);
  const createRef = useRef<{ tool: Tool; start: Point; last: Point; points: Point[] } | null>(null);
  const [draft, setDraft] = useState<Overlay | null>(null);
  const editingTarget = editing && editing.pageId === page.id ? editing : null;
  const [draftText, setDraftText] = useState('');
  const committedRef = useRef<string | null>(null);

  const selectedBlockId =
    selection?.pageId === page.id && selection.kind === 'block' ? selection.id : null;
  const selectedOverlayId =
    selection?.pageId === page.id && selection.kind === 'overlay' ? selection.id : null;

  const editingItem = useMemo(() => {
    if (!editingTarget) return null;
    if (editingTarget.kind === 'block') {
      const block = page.textBlocks.find((b) => b.id === editingTarget.id);
      return block
        ? { text: block.text, bbox: block.bbox, fontSize: block.fontSize, font: block.font, color: block.color, bold: block.bold, italic: block.italic, align: block.align }
        : null;
    }
    const overlay = page.overlays.find((o) => o.id === editingTarget.id);
    return overlay
      ? {
          text: overlay.text || '',
          bbox: overlay.bbox,
          fontSize: overlay.fontSize || 14,
          font: overlay.font || 'Helvetica',
          color: overlay.color || '#111827',
          bold: !!overlay.bold,
          italic: !!overlay.italic,
          align: overlay.align || 'left',
        }
      : null;
  }, [editingTarget, page.textBlocks, page.overlays]);

  useEffect(() => {
    committedRef.current = null;
    if (!editingTarget) return;
    if (editingItem) setDraftText(editingItem.text);
    // Focus after the creating click finishes, otherwise the click's focus
    // change blurs the empty textarea and deletes a brand-new text box.
    const handle = window.setTimeout(() => editorRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTarget?.id, editingTarget?.kind]);

  useEffect(() => {
    registerRef(page.id, cardRef.current);
    return () => registerRef(page.id, null);
  }, [page.id, registerRef]);

  const px = (value: number) => value * zoom;

  const pointFromClient = (clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [(clientX - rect.left) / zoom, (clientY - rect.top) / zoom];
  };

  const cancelEdit = () => {
    if (editingTarget?.kind === 'overlay') {
      const overlay = page.overlays.find((item) => item.id === editingTarget.id);
      if (overlay?.type === 'text' && !(overlay.text || '').trim()) {
        onCommitPage(page.id, (current) => ({
          ...current,
          overlays: current.overlays.filter((item) => item.id !== overlay.id),
        }));
        onSelect({ pageId: page.id, kind: 'page' });
      }
    }
    onStopEdit();
  };

  const commitEdit = () => {
    if (!editingTarget) return;
    const guardKey = `${editingTarget.pageId}:${editingTarget.kind}:${editingTarget.id}`;
    if (committedRef.current === guardKey) return;
    committedRef.current = guardKey;
    const value = draftText;
    if (editingTarget.kind === 'overlay') {
      const overlay = page.overlays.find((item) => item.id === editingTarget.id);
      if (overlay?.type === 'text' && !value.trim()) {
        onCommitPage(page.id, (current) => ({
          ...current,
          overlays: current.overlays.filter((item) => item.id !== overlay.id),
        }));
        onSelect({ pageId: page.id, kind: 'page' });
        onStopEdit();
        return;
      }
    }
    if (editingItem && value === editingItem.text) {
      onStopEdit();
      return;
    }
    if (editingTarget.kind === 'block') {
      onCommitPage(page.id, (current) => ({
        ...current,
        textBlocks: current.textBlocks.map((block) =>
          block.id === editingTarget.id
            ? { ...block, text: value, edited: block.edited || value !== block.originalText }
            : block
        ),
      }));
    } else {
      onCommitPage(page.id, (current) => ({
        ...current,
        overlays: current.overlays.map((overlay) =>
          overlay.id === editingTarget.id ? { ...overlay, text: value } : overlay
        ),
      }));
    }
    onStopEdit();
  };

  const startMove = (event: ReactPointerEvent, overlay: Overlay) => {
    event.stopPropagation();
    if (editingTarget) commitEdit();
    onSelect({ pageId: page.id, kind: 'overlay', id: overlay.id });
    if (tool !== 'select') return;
    const start = pointFromClient(event.clientX, event.clientY);
    const original: Overlay = {
      ...overlay,
      bbox: [...overlay.bbox] as Rect,
      points: overlay.points?.map((point) => [...point] as Point),
    };
    onBegin();
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      const current = pointFromClient(moveEvent.clientX, moveEvent.clientY);
      const dx = current[0] - start[0];
      const dy = current[1] - start[1];
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.6) return;
      moved = true;
      onLivePage(page.id, (currentPage) => ({
        ...currentPage,
        overlays: currentPage.overlays.map((item) =>
          item.id !== overlay.id
            ? item
            : {
                ...item,
                bbox: [
                  original.bbox[0] + dx,
                  original.bbox[1] + dy,
                  original.bbox[2] + dx,
                  original.bbox[3] + dy,
                ],
                points: original.points?.map((point) => [point[0] + dx, point[1] + dy] as Point),
              }
        ),
      }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd(moved);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startResize = (event: ReactPointerEvent, overlay: Overlay) => {
    event.stopPropagation();
    if (tool !== 'select') return;
    const start = pointFromClient(event.clientX, event.clientY);
    const original: Overlay = { ...overlay, bbox: [...overlay.bbox] as Rect };
    onBegin();
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      const current = pointFromClient(moveEvent.clientX, moveEvent.clientY);
      const dx = current[0] - start[0];
      const dy = current[1] - start[1];
      const x1 = clamp(original.bbox[2] + dx, original.bbox[0] + 6, page.width);
      const y1 = clamp(original.bbox[3] + dy, original.bbox[1] + 6, page.height);
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.6) return;
      moved = true;
      onLivePage(page.id, (currentPage) => ({
        ...currentPage,
        overlays: currentPage.overlays.map((item) =>
          item.id !== overlay.id ? item : { ...item, bbox: [original.bbox[0], original.bbox[1], x1, y1] }
        ),
      }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd(moved);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const createTextAt = (point: Point) => {
    const fontSize = 14;
    const width = Math.min(260, Math.max(80, page.width - point[0] - 8));
    const height = Math.max(24, fontSize * 1.5);
    const bbox: Rect = [
      clamp(point[0], 2, Math.max(2, page.width - width - 2)),
      clamp(point[1], 2, Math.max(2, page.height - height - 2)),
      clamp(point[0], 2, Math.max(2, page.width - width - 2)) + width,
      clamp(point[1], 2, Math.max(2, page.height - height - 2)) + height,
    ];
    const overlay: Overlay = {
      id: uid('ov'),
      type: 'text',
      bbox,
      text: '',
      fontSize,
      font: 'Helvetica',
      color: '#111827',
      bold: false,
      italic: false,
      align: 'left',
    };
    onCommitPage(page.id, (current) => ({ ...current, overlays: [...current.overlays, overlay] }));
    onSelect({ pageId: page.id, kind: 'overlay', id: overlay.id });
    onStartEdit({ pageId: page.id, kind: 'overlay', id: overlay.id });
  };

  const createNoteAt = (point: Point) => {
    const overlay: Overlay = {
      id: uid('ov'),
      type: 'note',
      bbox: [clamp(point[0], 2, page.width - 20), clamp(point[1], 2, page.height - 20), clamp(point[0], 2, page.width - 20) + 20, clamp(point[1], 2, page.height - 20) + 20],
      text: '',
      color: '#f59e0b',
    };
    onCommitPage(page.id, (current) => ({ ...current, overlays: [...current.overlays, overlay] }));
    onSelect({ pageId: page.id, kind: 'overlay', id: overlay.id });
    onStartEdit({ pageId: page.id, kind: 'overlay', id: overlay.id });
  };

  const handleImageFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      const image = new Image();
      image.onload = () => {
        const point = pendingImagePoint.current;
        const maxWidth = Math.min(page.width * 0.5, 340);
        let width = Math.min(maxWidth, Math.max(40, (image.naturalWidth || 200) * 0.75));
        let height = width * ((image.naturalHeight || 200) / (image.naturalWidth || 200));
        const maxHeight = page.height * 0.7;
        if (height > maxHeight) {
          height = maxHeight;
          width = height * ((image.naturalWidth || 200) / (image.naturalHeight || 200));
        }
        const x = clamp(point[0] - width / 2, 0, Math.max(0, page.width - width));
        const y = clamp(point[1] - height / 2, 0, Math.max(0, page.height - height));
        const overlay: Overlay = {
          id: uid('ov'),
          type: 'image',
          bbox: [x, y, x + width, y + height],
          data,
        };
        onCommitPage(page.id, (current) => ({ ...current, overlays: [...current.overlays, overlay] }));
        onSelect({ pageId: page.id, kind: 'overlay', id: overlay.id });
      };
      image.src = data;
    };
    reader.readAsDataURL(file);
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (tool === 'select') {
      if (editingTarget) commitEdit();
      onClearSelection();
      return;
    }
    const point = pointFromClient(event.clientX, event.clientY);
    if (tool === 'text') {
      createTextAt(point);
      return;
    }
    if (tool === 'note') {
      createNoteAt(point);
      return;
    }
    if (tool === 'image') {
      pendingImagePoint.current = point;
      imageInputRef.current?.click();
      return;
    }
    if (!SHAPE_TOOLS.includes(tool)) return;
    createRef.current = { tool, start: point, last: point, points: [point] };
    setDraft(draftOverlay(tool, point, point, [point]));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = createRef.current;
    if (!current) return;
    const point = pointFromClient(event.clientX, event.clientY);
    current.last = point;
    if (current.tool === 'draw') {
      const last = current.points[current.points.length - 1];
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= 1.5) {
        current.points.push(point);
      }
      setDraft(draftOverlay('draw', current.start, point, [...current.points]));
    } else {
      setDraft(draftOverlay(current.tool, current.start, point, [current.start, point]));
    }
  };

  const onStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = createRef.current;
    if (!current) return;
    createRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    const final = draftOverlay(current.tool, current.start, current.last, current.points);
    setDraft(null);
    if (!final) return;
    const bbox = final.bbox;
    const tiny = Math.abs(bbox[2] - bbox[0]) < 1.5 && Math.abs(bbox[3] - bbox[1]) < 1.5;
    if (final.type === 'draw') {
      if ((final.points?.length || 0) < 2) return;
    } else if (tiny) {
      return;
    }
    onCommitPage(page.id, (currentPage) => ({
      ...currentPage,
      overlays: [...currentPage.overlays, final],
    }));
    onSelect({ pageId: page.id, kind: 'overlay', id: final.id });
  };

  const renderOverlay = (overlay: Overlay) => {
    const [x0, y0, x1, y1] = overlay.bbox;
    const selected = selectedOverlayId === overlay.id;
    const isEditing = editingTarget?.kind === 'overlay' && editingTarget.id === overlay.id;
    if (isEditing) return null;
    const commonStyle: CSSProperties = {
      left: px(x0),
      top: px(y0),
      width: Math.max(3, px(x1 - x0)),
      height: Math.max(3, px(y1 - y0)),
    };
    const wrapper = (children: ReactNode, extraClass = '', showResize = true) => (
      <div
        key={overlay.id}
        className={`ov ${extraClass} ${selected ? 'selected' : ''}`}
        style={commonStyle}
        onPointerDown={(event) => startMove(event, overlay)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (overlay.type === 'text' || overlay.type === 'note') {
            onStartEdit({ pageId: page.id, kind: 'overlay', id: overlay.id });
          }
        }}
      >
        {children}
        {selected && showResize && (
          <span
            className="resize-handle"
            onPointerDown={(event) => startResize(event, overlay)}
            aria-hidden="true"
          />
        )}
      </div>
    );

    if (overlay.type === 'text') {
      return wrapper(
        <span
          style={{
            fontFamily: cssFontFamily(overlay.font),
            fontSize: px(overlay.fontSize || 14),
            fontWeight: overlay.bold ? 700 : 400,
            fontStyle: overlay.italic ? 'italic' : 'normal',
            color: overlay.color || '#111827',
            textAlign: (overlay.align as CSSProperties['textAlign']) || 'left',
            lineHeight: 1.25,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            width: '100%',
            height: '100%',
            display: 'block',
            opacity: overlay.opacity ?? 1,
          }}
        >
          {overlay.text || ' '}
        </span>,
        'ov-text'
      );
    }
    if (overlay.type === 'image') {
      return wrapper(
        <img
          src={overlay.data}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: overlay.opacity ?? 1 }}
        />
      );
    }
    if (overlay.type === 'highlight') {
      return wrapper(
        <span
          className="ov-fill"
          style={{ background: hexToRgba(overlay.color || '#ffe066', overlay.opacity ?? 0.45) }}
        />,
        'ov-highlight'
      );
    }
    if (overlay.type === 'whiteout') {
      return wrapper(
        <span className="ov-fill" style={{ background: overlay.fill || '#ffffff' }} />,
        'ov-whiteout'
      );
    }
    if (overlay.type === 'rect') {
      return wrapper(
        <span
          className="ov-fill"
          style={{
            border: `${Math.max(1, px(overlay.width || 2))}px solid ${overlay.stroke || '#2563eb'}`,
            background: overlay.fill ? hexToRgba(overlay.fill, overlay.opacity ?? 1) : 'transparent',
            borderRadius: 2,
          }}
        />
      );
    }
    if (overlay.type === 'ellipse') {
      return wrapper(
        <span
          className="ov-fill"
          style={{
            border: `${Math.max(1, px(overlay.width || 2))}px solid ${overlay.stroke || '#2563eb'}`,
            background: overlay.fill ? hexToRgba(overlay.fill, overlay.opacity ?? 1) : 'transparent',
            borderRadius: '50%',
          }}
        />
      );
    }
    if (overlay.type === 'note') {
      return wrapper(
        <span className="ov-note" style={{ background: overlay.color || '#f59e0b' }}>
          <StickyNote size={Math.max(10, px(20))} color="#7a4a00" />
        </span>,
        'ov-note-wrap',
        false
      );
    }
    const points = overlay.points || [];
    const [bx0, by0, bx1, by1] = overlay.bbox;
    const vbWidth = Math.max(0.01, bx1 - bx0);
    const vbHeight = Math.max(0.01, by1 - by0);
    if (overlay.type === 'line') {
      const p1 = points[0] || [bx0, by0];
      const p2 = points[1] || [bx1, by1];
      return wrapper(
        <svg
          width="100%"
          height="100%"
          viewBox={`${bx0} ${by0} ${vbWidth} ${vbHeight}`}
          preserveAspectRatio="none"
          style={{ overflow: 'visible', display: 'block' }}
        >
          <line
            x1={p1[0]}
            y1={p1[1]}
            x2={p2[0]}
            y2={p2[1]}
            stroke={overlay.stroke || '#2563eb'}
            strokeWidth={overlay.width || 2}
            strokeLinecap="round"
            opacity={overlay.opacity ?? 1}
          />
        </svg>,
        '',
        false
      );
    }
    if (overlay.type === 'draw') {
      return wrapper(
        <svg
          width="100%"
          height="100%"
          viewBox={`${bx0} ${by0} ${vbWidth} ${vbHeight}`}
          preserveAspectRatio="none"
          style={{ overflow: 'visible', display: 'block' }}
        >
          <polyline
            points={points.map((point) => `${point[0]},${point[1]}`).join(' ')}
            fill="none"
            stroke={overlay.stroke || '#1f2937'}
            strokeWidth={overlay.width || 2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={overlay.opacity ?? 1}
          />
        </svg>,
        '',
        false
      );
    }
    return null;
  };

  return (
    <div className="page-card" ref={cardRef}>
      <div className="page-card-head">
        <span className="page-label">
          <GripVertical size={14} /> Page {pageNumber}
          {page.blank ? ' · blank' : ''}
        </span>
        <span className="page-dims">
          {Math.round(page.width)} × {Math.round(page.height)} pt
          {page.rotation ? ` · ${page.rotation}°` : ''}
        </span>
        <span className="page-actions">
          <button className="mini-button" title="Move up" onClick={() => onMovePage(page.id, -1)} disabled={pageNumber <= 1}>
            <ChevronUp size={15} />
          </button>
          <button className="mini-button" title="Move down" onClick={() => onMovePage(page.id, 1)} disabled={pageNumber >= totalPages}>
            <ChevronDown size={15} />
          </button>
          <button className="mini-button" title="Rotate left" onClick={() => onRotate(page.id, -1)}>
            <RotateCcw size={15} />
          </button>
          <button className="mini-button" title="Rotate right" onClick={() => onRotate(page.id, 1)}>
            <RotateCw size={15} />
          </button>
          <button className="mini-button" title="Duplicate page" onClick={() => onDuplicatePage(page.id)}>
            <Copy size={15} />
          </button>
          <button className="mini-button danger" title="Delete page" onClick={() => onDeletePage(page.id)}>
            <Trash2 size={15} />
          </button>
        </span>
      </div>
      <div className="page-stage-wrap">
        <div
          ref={stageRef}
          className={`page-stage tool-${tool}`}
          style={{ width: px(page.width), height: px(page.height) }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
        >
          {page.background ? (
            <img className="page-bg" src={page.background} alt="" draggable={false} loading="lazy" decoding="async" style={backgroundStyle(page, zoom)} />
          ) : (
            <div className="page-stage-blank" />
          )}

          {page.textBlocks.map((block) => {
            const [x0, y0, x1, y1] = block.bbox;
            const selected = selectedBlockId === block.id;
            const isEditing = editingTarget?.kind === 'block' && editingTarget.id === block.id;
            const empty = !block.text.trim();
            return (
              <div
                key={block.id}
                className={`tb ${selected ? 'selected' : ''} ${block.edited ? 'edited' : ''} ${empty ? 'empty' : ''} ${isEditing ? 'hidden-for-edit' : ''}`}
                style={{
                  left: px(x0),
                  top: px(y0),
                  width: Math.max(3, px(x1 - x0)),
                  minHeight: Math.max(3, px(y1 - y0)),
                  fontSize: px(block.fontSize),
                  fontFamily: cssFontFamily(block.font),
                  fontWeight: block.bold ? 700 : 400,
                  fontStyle: block.italic ? 'italic' : 'normal',
                  textAlign: (block.align as CSSProperties['textAlign']) || 'left',
                  lineHeight: 1.2,
                  color: block.edited && !empty ? block.color : undefined,
                  background: block.edited || empty ? '#ffffff' : undefined,
                }}
                title={empty ? 'Text removed — click to restore' : block.text}
                onPointerDown={(event) => {
                  if (tool !== 'select') return;
                  event.stopPropagation();
                  if (editingTarget && editingTarget.id !== block.id) commitEdit();
                  onSelect({ pageId: page.id, kind: 'block', id: block.id });
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (tool !== 'select') return;
                  onStartEdit({ pageId: page.id, kind: 'block', id: block.id });
                }}
              >
                {empty ? <span className="tb-empty-mark">removed</span> : block.text}
              </div>
            );
          })}

          {page.overlays.map(renderOverlay)}

          {draft && (
            <div
              className="ov draft"
              style={{
                left: px(draft.bbox[0]),
                top: px(draft.bbox[1]),
                width: Math.max(2, px(draft.bbox[2] - draft.bbox[0])),
                height: Math.max(2, px(draft.bbox[3] - draft.bbox[1])),
              }}
            >
              {draft.type === 'draw' && draft.points && (
                <svg width="100%" height="100%" viewBox={`${draft.bbox[0]} ${draft.bbox[1]} ${Math.max(0.01, draft.bbox[2] - draft.bbox[0])} ${Math.max(0.01, draft.bbox[3] - draft.bbox[1])}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                  <polyline
                    points={draft.points.map((point) => `${point[0]},${point[1]}`).join(' ')}
                    fill="none"
                    stroke={draft.stroke || '#1f2937'}
                    strokeWidth={draft.width || 2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {draft.type === 'line' && draft.points && (
                <svg width="100%" height="100%" viewBox={`${draft.bbox[0]} ${draft.bbox[1]} ${Math.max(0.01, draft.bbox[2] - draft.bbox[0])} ${Math.max(0.01, draft.bbox[3] - draft.bbox[1])}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                  <line x1={draft.points[0][0]} y1={draft.points[0][1]} x2={draft.points[1][0]} y2={draft.points[1][1]} stroke={draft.stroke || '#2563eb'} strokeWidth={draft.width || 2} strokeLinecap="round" />
                </svg>
              )}
              {draft.type !== 'draw' && draft.type !== 'line' && (
                <span
                  className="ov-fill"
                  style={{
                    background: draft.type === 'highlight' ? hexToRgba(draft.color, draft.opacity ?? 0.45) : draft.type === 'whiteout' ? '#fff' : 'transparent',
                    border: draft.type === 'highlight' || draft.type === 'whiteout' ? '1px dashed #2563eb' : '1px dashed #2563eb',
                  }}
                />
              )}
            </div>
          )}

          {editingItem && editingTarget && (
            <div
              className="inline-editor"
              style={{
                left: px(editingItem.bbox[0]),
                top: px(editingItem.bbox[1]),
                width: Math.max(120, px(editingItem.bbox[2] - editingItem.bbox[0])),
                minHeight: Math.max(40, px(editingItem.bbox[3] - editingItem.bbox[1])),
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <textarea
                ref={editorRef}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                onBlur={() => {
                  if (committedRef.current) return;
                  commitEdit();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    committedRef.current = `${editingTarget.pageId}:${editingTarget.kind}:${editingTarget.id}`;
                    cancelEdit();
                  } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    commitEdit();
                  }
                }}
                style={{
                  fontFamily: cssFontFamily(editingItem.font),
                  fontSize: Math.max(12, px(editingItem.fontSize)),
                  fontWeight: editingItem.bold ? 700 : 400,
                  fontStyle: editingItem.italic ? 'italic' : 'normal',
                  color: editingItem.color,
                  textAlign: (editingItem.align as CSSProperties['textAlign']) || 'left',
                }}
                aria-label="Edit text"
              />
              <div className="inline-editor-actions">
                <span>⌘/Ctrl + Enter to save</span>
                <button
                  className="mini-button"
                  title="Cancel"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    committedRef.current = `${editingTarget.pageId}:${editingTarget.kind}:${editingTarget.id}`;
                    cancelEdit();
                  }}
                >
                  <X size={14} />
                </button>
                <button className="mini-button primary" title="Save" onClick={commitEdit}>
                  <Check size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={handleImageFile} />
    </div>
  );
}
