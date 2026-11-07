import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eraser,
  Pencil,
  RotateCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import type { EditorPage, Overlay, Selection, TextBlock } from '../types';

interface InspectorProps {
  page: EditorPage | null;
  pageNumber: number;
  totalPages: number;
  selection: Selection | null;
  onCommitPage: (pageId: string, updater: (page: EditorPage) => EditorPage) => void;
  onStartEdit: (pageId: string, kind: 'block' | 'overlay', id: string) => void;
  onRotatePage: (pageId: string, direction: 1 | -1) => void;
  onDuplicatePage: (pageId: string) => void;
  onDeletePage: (pageId: string) => void;
}

function TextField({
  value,
  onCommit,
  placeholder,
  rows = 4,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="field-textarea"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          if (draft !== value) onCommit(draft);
        }
      }}
    />
  );
}

export default function Inspector(props: InspectorProps) {
  const {
    page,
    pageNumber,
    totalPages,
    selection,
    onCommitPage,
    onStartEdit,
    onRotatePage,
    onDuplicatePage,
    onDeletePage,
  } = props;

  if (!page) {
    return (
      <aside className="inspector">
        <div className="inspector-empty">
          <strong>No page selected</strong>
          <p>Open a PDF and pick a page to start editing.</p>
        </div>
      </aside>
    );
  }

  const block =
    selection?.pageId === page.id && selection.kind === 'block'
      ? page.textBlocks.find((item) => item.id === selection.id) || null
      : null;
  const overlay =
    selection?.pageId === page.id && selection.kind === 'overlay'
      ? page.overlays.find((item) => item.id === selection.id) || null
      : null;

  const updateBlock = (patch: Partial<TextBlock>) => {
    if (!block) return;
    onCommitPage(page.id, (current) => ({
      ...current,
      textBlocks: current.textBlocks.map((item) =>
        item.id === block.id ? { ...item, ...patch, edited: true } : item
      ),
    }));
  };

  const updateOverlay = (patch: Partial<Overlay>) => {
    if (!overlay) return;
    onCommitPage(page.id, (current) => ({
      ...current,
      overlays: current.overlays.map((item) =>
        item.id === overlay.id ? { ...item, ...patch } : item
      ),
    }));
  };

  const deleteOverlay = () => {
    if (!overlay) return;
    onCommitPage(page.id, (current) => ({
      ...current,
      overlays: current.overlays.filter((item) => item.id !== overlay.id),
    }));
  };

  const moveOverlay = (direction: -1 | 1) => {
    if (!overlay) return;
    onCommitPage(page.id, (current) => {
      const overlays = [...current.overlays];
      const index = overlays.findIndex((item) => item.id === overlay.id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= overlays.length) return current;
      const [item] = overlays.splice(index, 1);
      overlays.splice(next, 0, item);
      return { ...current, overlays };
    });
  };

  const pagePanel = (
    <>
      <div className="inspector-title">
        <div>
          <span className="inspector-kicker">Page</span>
          <h3>
            {pageNumber} of {totalPages}
          </h3>
        </div>
        <span className="inspector-badge">{page.rotation}°</span>
      </div>
      <div className="inspector-grid">
        <div>
          <span>Width</span>
          <strong>{Math.round(page.width)} pt</strong>
        </div>
        <div>
          <span>Height</span>
          <strong>{Math.round(page.height)} pt</strong>
        </div>
        <div>
          <span>Text runs</span>
          <strong>{page.textBlocks.length}</strong>
        </div>
        <div>
          <span>Annotations</span>
          <strong>{page.overlays.length}</strong>
        </div>
      </div>
      <div className="inspector-actions">
        <button className="inspector-button" onClick={() => onRotatePage(page.id, -1)}>
          <RotateCcw size={15} /> Rotate left
        </button>
        <button className="inspector-button" onClick={() => onRotatePage(page.id, 1)}>
          <RotateCw size={15} /> Rotate right
        </button>
        <button className="inspector-button" onClick={() => onDuplicatePage(page.id)}>
          <Copy size={15} /> Duplicate
        </button>
        <button className="inspector-button danger" onClick={() => onDeletePage(page.id)} disabled={totalPages <= 1}>
          <Trash2 size={15} /> Delete
        </button>
      </div>
      <div className="inspector-tip">
        <strong>Original structure preserved</strong>
        <p>
          Untouched fonts, images, tables and vector art stay exactly as they were. Only the text you
          edit or the annotations you add are written on top of the original page.
        </p>
      </div>
    </>
  );

  if (block) {
    return (
      <aside className="inspector">
        <div className="inspector-title">
          <div>
            <span className="inspector-kicker">Text block</span>
            <h3>Edit or restyle</h3>
          </div>
          <button className="mini-button primary" title="Edit inline" onClick={() => onStartEdit(page.id, 'block', block.id)}>
            <Pencil size={14} />
          </button>
        </div>
        <label className="field-label">Content</label>
        <TextField
          value={block.text}
          onCommit={(value) =>
            onCommitPage(page.id, (current) => ({
              ...current,
              textBlocks: current.textBlocks.map((item) =>
                item.id === block.id
                  ? { ...item, text: value, edited: item.edited || value !== item.originalText }
                  : item
              ),
            }))
          }
          placeholder="Type the replacement text…"
          rows={5}
        />
        <div className="field-row">
          <label className="field-label">Font size</label>
          <input
            className="field-number"
            type="number"
            min={4}
            max={200}
            step={0.5}
            value={Number(block.fontSize.toFixed(2))}
            onChange={(event) => updateBlock({ fontSize: Number(event.target.value) || block.fontSize })}
          />
        </div>
        <div className="field-row">
          <label className="field-label">Color</label>
          <input
            className="field-color"
            type="color"
            value={block.color}
            onChange={(event) => updateBlock({ color: event.target.value })}
          />
        </div>
        <div className="field-row">
          <label className="field-label">Style</label>
          <div className="toggle-group">
            <button className={`toggle ${block.bold ? 'on' : ''}`} onClick={() => updateBlock({ bold: !block.bold })} aria-pressed={block.bold}>
              <b>B</b>
            </button>
            <button className={`toggle ${block.italic ? 'on' : ''}`} onClick={() => updateBlock({ italic: !block.italic })} aria-pressed={block.italic}>
              <i>I</i>
            </button>
          </div>
        </div>
        <div className="field-row">
          <label className="field-label">Align</label>
          <select
            className="field-select"
            value={block.align || 'left'}
            onChange={(event) => updateBlock({ align: event.target.value })}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
            <option value="justify">Justify</option>
          </select>
        </div>
        <div className="inspector-actions two">
          <button
            className="inspector-button"
            onClick={() =>
              onCommitPage(page.id, (current) => ({
                ...current,
                textBlocks: current.textBlocks.map((item) =>
                  item.id === block.id
                    ? {
                        ...item,
                        text: item.originalText,
                        fontSize: item.originalFontSize ?? item.fontSize,
                        color: item.originalColor ?? item.color,
                        bold: item.originalBold ?? item.bold,
                        italic: item.originalItalic ?? item.italic,
                        align: item.originalAlign ?? item.align,
                        edited: false,
                      }
                    : item
                ),
              }))
            }
          >
            Restore
          </button>
          <button
            className="inspector-button danger"
            onClick={() =>
              onCommitPage(page.id, (current) => ({
                ...current,
                textBlocks: current.textBlocks.map((item) =>
                  item.id === block.id ? { ...item, text: '', edited: true } : item
                ),
              }))
            }
          >
            <Eraser size={15} /> Remove text
          </button>
        </div>
        <div className="inspector-tip">
          <strong>Tip</strong>
          <p>Double-click any text on the page to edit it in place. Removed text can be restored at any time.</p>
        </div>
      </aside>
    );
  }

  if (overlay) {
    const isText = overlay.type === 'text' || overlay.type === 'note';
    const isShape = ['rect', 'ellipse', 'line', 'draw', 'highlight', 'whiteout'].includes(overlay.type);
    return (
      <aside className="inspector">
        <div className="inspector-title">
          <div>
            <span className="inspector-kicker">{overlay.type} annotation</span>
            <h3>Style &amp; placement</h3>
          </div>
          <button className="mini-button danger" title="Delete annotation" onClick={deleteOverlay}>
            <Trash2 size={14} />
          </button>
        </div>
        {isText && (
          <>
            <label className="field-label">Content</label>
            <TextField value={overlay.text || ''} onCommit={(value) => updateOverlay({ text: value })} rows={4} />
            <div className="field-row">
              <label className="field-label">Font size</label>
              <input
                className="field-number"
                type="number"
                min={4}
                max={160}
                step={0.5}
                value={overlay.fontSize || 14}
                onChange={(event) => updateOverlay({ fontSize: Number(event.target.value) || 14 })}
              />
            </div>
            <div className="field-row">
              <label className="field-label">Color</label>
              <input
                className="field-color"
                type="color"
                value={overlay.color || (overlay.type === 'note' ? '#f59e0b' : '#111827')}
                onChange={(event) => updateOverlay({ color: event.target.value })}
              />
            </div>
            {overlay.type === 'text' && (
              <>
                <div className="field-row">
                  <label className="field-label">Style</label>
                  <div className="toggle-group">
                    <button className={`toggle ${overlay.bold ? 'on' : ''}`} onClick={() => updateOverlay({ bold: !overlay.bold })}>
                      <b>B</b>
                    </button>
                    <button className={`toggle ${overlay.italic ? 'on' : ''}`} onClick={() => updateOverlay({ italic: !overlay.italic })}>
                      <i>I</i>
                    </button>
                  </div>
                </div>
                <div className="field-row">
                  <label className="field-label">Align</label>
                  <select
                    className="field-select"
                    value={overlay.align || 'left'}
                    onChange={(event) => updateOverlay({ align: event.target.value })}
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                    <option value="justify">Justify</option>
                  </select>
                </div>
              </>
            )}
          </>
        )}
        {isShape && (
          <>
            {overlay.type !== 'whiteout' && (
              <div className="field-row">
                <label className="field-label">Stroke</label>
                <input
                  className="field-color"
                  type="color"
                  value={overlay.stroke || '#2563eb'}
                  onChange={(event) => updateOverlay({ stroke: event.target.value })}
                />
              </div>
            )}
            {overlay.type !== 'line' && overlay.type !== 'draw' && (
              <div className="field-row">
                <label className="field-label">Fill</label>
                <div className="fill-control">
                  <input
                    className="field-color"
                    type="color"
                    value={overlay.fill || '#ffffff'}
                    onChange={(event) => updateOverlay({ fill: event.target.value })}
                  />
                  <button
                    className={`toggle ${overlay.fill ? 'on' : ''}`}
                    onClick={() => updateOverlay({ fill: overlay.fill ? null : '#ffffff' })}
                    title={overlay.fill ? 'Remove fill' : 'Add fill'}
                  >
                    {overlay.fill ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
            )}
            {overlay.type !== 'highlight' && overlay.type !== 'whiteout' && (
              <div className="field-row">
                <label className="field-label">Line width</label>
                <input
                  className="field-number"
                  type="number"
                  min={0.5}
                  max={40}
                  step={0.5}
                  value={overlay.width || 2}
                  onChange={(event) => updateOverlay({ width: Number(event.target.value) || 1 })}
                />
              </div>
            )}
            <div className="field-row">
              <label className="field-label">Opacity</label>
              <input
                className="field-range"
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={overlay.opacity ?? 1}
                onChange={(event) => updateOverlay({ opacity: Number(event.target.value) })}
              />
              <span className="range-value">{Math.round((overlay.opacity ?? 1) * 100)}%</span>
            </div>
          </>
        )}
        <div className="inspector-actions two">
          <button className="inspector-button" onClick={() => moveOverlay(1)}>
            <ArrowUp size={15} /> Forward
          </button>
          <button className="inspector-button" onClick={() => moveOverlay(-1)}>
            <ArrowDown size={15} /> Backward
          </button>
        </div>
        <div className="inspector-tip">
          <strong>Move &amp; resize</strong>
          <p>Drag the annotation to move it. Use the corner handle to resize it. Press Delete to remove it.</p>
        </div>
      </aside>
    );
  }

  return <aside className="inspector">{pagePanel}</aside>;
}
