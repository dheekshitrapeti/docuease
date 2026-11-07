import {
  ChangeEvent,
  DragEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Copy,
  Eraser,
  FileDown,
  FilePlus2,
  FileText,
  FileType2,
  Highlighter,
  ImagePlus,
  Images,
  LoaderCircle,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  ScanText,
  ShieldCheck,
  Sparkles,
  Square,
  StickyNote,
  Type,
  Undo2,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import PageView from './components/PageView';
import Inspector from './components/Inspector';
import {
  API,
  buildEditorPages,
  downloadBlob,
  exportDocx,
  exportPdf,
  extractPdf,
} from './api';
import type { EditTarget, EditorPage, Selection, Tool } from './types';
import {
  baseName,
  clamp,
  cloneOverlays,
  rotatePage as rotatePageModel,
  uid,
} from './utils';

const MAX_BYTES = 25 * 1024 * 1024;

type Notice = { kind: 'error' | 'success' | 'info'; text: string };

interface ToolDef {
  id: Tool;
  label: string;
  shortcut: string;
  icon: ReactNode;
}

const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: <MousePointer2 size={17} /> },
  { id: 'text', label: 'Add text', shortcut: 'T', icon: <Type size={17} /> },
  { id: 'image', label: 'Add image', shortcut: 'I', icon: <ImagePlus size={17} /> },
  { id: 'highlight', label: 'Highlight', shortcut: 'H', icon: <Highlighter size={17} /> },
  { id: 'rect', label: 'Rectangle', shortcut: 'R', icon: <Square size={17} /> },
  { id: 'ellipse', label: 'Ellipse', shortcut: 'O', icon: <Circle size={17} /> },
  { id: 'line', label: 'Line', shortcut: 'L', icon: <Minus size={17} /> },
  { id: 'draw', label: 'Draw', shortcut: 'P', icon: <Pencil size={17} /> },
  { id: 'whiteout', label: 'Erase area', shortcut: 'E', icon: <Eraser size={17} /> },
  { id: 'note', label: 'Sticky note', shortcut: 'N', icon: <StickyNote size={17} /> },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function validatePdf(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.pdf')) return 'That file is not a PDF. Please choose a file ending in .pdf.';
  if (file.size === 0) return 'This file is empty. Please choose another PDF.';
  if (file.size > MAX_BYTES) return 'This PDF is larger than 25 MB. Choose a smaller file.';
  return null;
}

export default function App() {
  const [sources, setSources] = useState<File[]>([]);
  const sourcesRef = useRef<File[]>([]);
  const [pages, setPages] = useState<EditorPage[]>([]);
  const pagesRef = useRef<EditorPage[]>([]);
  const undoRef = useRef<EditorPage[][]>([]);
  const redoRef = useRef<EditorPage[][]>([]);
  const pendingRef = useRef<EditorPage[] | null>(null);
  const [, forceRender] = useReducer((value: number) => value + 1, 0);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [zoom, setZoom] = useState(1.05);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [filename, setFilename] = useState('docuease-document');
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const pageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const setPresent = useCallback((next: EditorPage[]) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  const pushHistory = useCallback((snapshot: EditorPage[]) => {
    undoRef.current.push(snapshot);
    if (undoRef.current.length > 80) undoRef.current.shift();
    redoRef.current = [];
    forceRender();
  }, []);

  const commitPages = useCallback(
    (next: EditorPage[]) => {
      if (next === pagesRef.current) return;
      pushHistory(pagesRef.current);
      setPresent(next);
    },
    [pushHistory, setPresent]
  );

  const commitPage = useCallback(
    (pageId: string, updater: (page: EditorPage) => EditorPage) => {
      let changed = false;
      const next = pagesRef.current.map((page) => {
        if (page.id !== pageId) return page;
        const updated = updater(page);
        if (updated !== page) changed = true;
        return updated;
      });
      if (!changed) return;
      pushHistory(pagesRef.current);
      setPresent(next);
    },
    [pushHistory, setPresent]
  );

  const livePage = useCallback(
    (pageId: string, updater: (page: EditorPage) => EditorPage) => {
      const next = pagesRef.current.map((page) => (page.id === pageId ? updater(page) : page));
      setPresent(next);
    },
    [setPresent]
  );

  const beginTransaction = useCallback(() => {
    pendingRef.current = pagesRef.current;
  }, []);

  const endTransaction = useCallback(
    (record: boolean) => {
      const snapshot = pendingRef.current;
      pendingRef.current = null;
      if (!record || !snapshot || snapshot === pagesRef.current) return;
      pushHistory(snapshot);
    },
    [pushHistory]
  );

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(pagesRef.current);
    setPresent(previous);
    forceRender();
  }, [setPresent]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(pagesRef.current);
    setPresent(next);
    forceRender();
  }, [setPresent]);

  const registerRef = useCallback((pageId: string, element: HTMLDivElement | null) => {
    if (element) pageRefs.current.set(pageId, element);
    else pageRefs.current.delete(pageId);
  }, []);

  const openFile = useCallback(
    async (file: File, mode: 'replace' | 'append') => {
      const problem = validatePdf(file);
      if (problem) {
        setNotice({ kind: 'error', text: problem });
        return;
      }
      setBusy(true);
      setProgress(mode === 'replace' ? 'Reading PDF and preserving its layout…' : 'Adding pages from PDF…');
      setNotice({ kind: 'info', text: mode === 'replace' ? 'Opening your PDF…' : 'Adding pages…' });
      try {
        const result = await extractPdf(file);
        const prefix = uid('doc');
        if (mode === 'replace') {
          const created = buildEditorPages(result, 0, prefix);
          sourcesRef.current = [file];
          setSources([file]);
          undoRef.current = [];
          redoRef.current = [];
          pendingRef.current = null;
          setPresent(created);
          setFilename(baseName(file.name));
          setSelection({ pageId: created[0].id, kind: 'page' });
          setEditing(null);
          setTool('select');
          setZoom(1.05);
          forceRender();
          setNotice({
            kind: 'success',
            text: result.hasSelectableText
              ? `Opened ${result.pageCount} page${result.pageCount === 1 ? '' : 's'} with editable text. Double-click any text to edit it.`
              : `Opened ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}. No selectable text was found, but you can annotate, add text, images and shapes on top of the original pages.`,
          });
        } else {
          const fileIndex = sourcesRef.current.length;
          const created = buildEditorPages(result, fileIndex, prefix);
          const before = pagesRef.current;
          sourcesRef.current = [...sourcesRef.current, file];
          setSources(sourcesRef.current);
          const next = [...before, ...created];
          pushHistory(before);
          setPresent(next);
          setSelection({ pageId: created[0].id, kind: 'page' });
          setNotice({
            kind: 'success',
            text: `Added ${created.length} page${created.length === 1 ? '' : 's'} from ${file.name}.`,
          });
        }
      } catch (error) {
        setNotice({
          kind: 'error',
          text:
            error instanceof Error
              ? `${error.message} Check that the FastAPI backend is running at ${API}.`
              : 'Something went wrong while reading the PDF.',
        });
      } finally {
        setBusy(false);
        setProgress('');
      }
    },
    [pushHistory, setPresent]
  );

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void openFile(file, 'replace');
  };

  const onAddInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void openFile(file, 'append');
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void openFile(file, pagesRef.current.length ? 'append' : 'replace');
  };

  const newDocument = () => {
    sourcesRef.current = [];
    setSources([]);
    undoRef.current = [];
    redoRef.current = [];
    pendingRef.current = null;
    setPresent([]);
    setSelection(null);
    setEditing(null);
    setNotice(null);
    setFilename('docuease-document');
    setTool('select');
  };

  const addBlankPage = () => {
    const last = pagesRef.current[pagesRef.current.length - 1];
    const width = last ? last.width : 595.28;
    const height = last ? last.height : 841.89;
    const page: EditorPage = {
      id: uid('blank'),
      fileIndex: 0,
      sourceIndex: null,
      width,
      height,
      baseWidth: width,
      baseHeight: height,
      baseRotation: 0,
      rotation: 0,
      background: null,
      textBlocks: [],
      overlays: [],
      hasText: false,
      hasImages: false,
      blank: true,
    };
    commitPages([...pagesRef.current, page]);
    setSelection({ pageId: page.id, kind: 'page' });
    setTool('select');
  };

  const rotatePageById = (pageId: string, direction: 1 | -1) => {
    commitPage(pageId, (page) => rotatePageModel(page, direction));
  };

  const deletePage = (pageId: string) => {
    if (pagesRef.current.length <= 1) {
      setNotice({ kind: 'error', text: 'A document needs at least one page.' });
      return;
    }
    const next = pagesRef.current.filter((page) => page.id !== pageId);
    commitPages(next);
    if (selection?.pageId === pageId) setSelection(next[0] ? { pageId: next[0].id, kind: 'page' } : null);
    if (editing?.pageId === pageId) setEditing(null);
  };

  const duplicatePage = (pageId: string) => {
    const index = pagesRef.current.findIndex((page) => page.id === pageId);
    if (index < 0) return;
    const source = pagesRef.current[index];
    const clone: EditorPage = {
      ...source,
      id: uid('page'),
      textBlocks: source.textBlocks.map((block) => ({ ...block, id: uid('tb') })),
      overlays: cloneOverlays(source.overlays),
    };
    const next = [...pagesRef.current];
    next.splice(index + 1, 0, clone);
    commitPages(next);
    setSelection({ pageId: clone.id, kind: 'page' });
  };

  const movePage = (pageId: string, direction: -1 | 1) => {
    const index = pagesRef.current.findIndex((page) => page.id === pageId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= pagesRef.current.length) return;
    const next = [...pagesRef.current];
    const [page] = next.splice(index, 1);
    next.splice(target, 0, page);
    commitPages(next);
  };

  const deleteSelectedOverlay = useCallback(() => {
    if (!selection || selection.kind !== 'overlay') return;
    const page = pagesRef.current.find((item) => item.id === selection.pageId);
    if (!page) return;
    commitPage(page.id, (current) => ({
      ...current,
      overlays: current.overlays.filter((overlay) => overlay.id !== selection.id),
    }));
    setSelection({ pageId: page.id, kind: 'page' });
  }, [commitPage, selection]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection?.kind === 'overlay') {
          event.preventDefault();
          deleteSelectedOverlay();
        }
        return;
      }
      if (event.key === 'Escape') {
        if (editing) setEditing(null);
        else if (selection) setSelection(null);
        else setTool('select');
        return;
      }
      const map: Record<string, Tool> = {
        v: 'select',
        t: 'text',
        i: 'image',
        h: 'highlight',
        r: 'rect',
        o: 'ellipse',
        l: 'line',
        p: 'draw',
        e: 'whiteout',
        n: 'note',
      };
      const nextTool = map[event.key.toLowerCase()];
      if (nextTool && !meta) {
        setTool(nextTool);
        setEditing(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [deleteSelectedOverlay, editing, redo, selection, undo]);

  useEffect(() => {
    if (!selection) return;
    const page = pages.find((item) => item.id === selection.pageId);
    if (!page) {
      setSelection(null);
      return;
    }
    if (selection.kind === 'block' && !page.textBlocks.some((block) => block.id === selection.id)) {
      setSelection({ pageId: page.id, kind: 'page' });
    }
    if (selection.kind === 'overlay' && !page.overlays.some((overlay) => overlay.id === selection.id)) {
      setSelection({ pageId: page.id, kind: 'page' });
    }
  }, [pages, selection]);

  useEffect(() => {
    if (!editing) return;
    const page = pages.find((item) => item.id === editing.pageId);
    const exists =
      page &&
      (editing.kind === 'block'
        ? page.textBlocks.some((block) => block.id === editing.id)
        : page.overlays.some((overlay) => overlay.id === editing.id));
    if (!exists) setEditing(null);
  }, [pages, editing]);

  const doExport = async (format: 'pdf' | 'docx') => {
    if (!pagesRef.current.length || exporting) return;
    setExporting(format);
    setNotice({ kind: 'info', text: `Preparing your ${format.toUpperCase()}…` });
    try {
      if (format === 'pdf') {
        const payload = {
          filename: filename || 'docuease-document',
          pages: pagesRef.current.map((page) => ({
            file: page.fileIndex,
            source: page.sourceIndex,
            width: page.width,
            height: page.height,
            rotation: page.rotation,
            textEdits: page.textBlocks
              .filter((block) => block.edited || block.text !== block.originalText)
              .map((block) => ({
                bbox: block.bbox,
                text: block.text,
                fontSize: block.fontSize,
                font: block.font,
                color: block.color,
                bold: block.bold,
                italic: block.italic,
                align: block.align,
              })),
            overlays: page.overlays.map(({ id: _id, ...overlay }) => overlay),
          })),
        };
        const blob = await exportPdf(sourcesRef.current, payload);
        downloadBlob(blob, `${filename || 'docuease-document'}.pdf`);
      } else {
        const payload = {
          filename: filename || 'docuease-document',
          pages: pagesRef.current.map((page) => ({
            texts: [
              ...page.textBlocks.map((block) => ({
                y: block.bbox[1],
                x: block.bbox[0],
                text: block.text,
                fontSize: block.fontSize,
                bold: block.bold,
                italic: block.italic,
              })),
              ...page.overlays
                .filter((overlay) => overlay.type === 'text' && (overlay.text || '').trim())
                .map((overlay) => ({
                  y: overlay.bbox[1],
                  x: overlay.bbox[0],
                  text: overlay.text || '',
                  fontSize: overlay.fontSize ?? 14,
                  bold: !!overlay.bold,
                  italic: !!overlay.italic,
                })),
            ]
              .sort((a, b) => a.y - b.y || a.x - b.x)
              .map(({ y: _y, x: _x, ...text }) => text),
          })),
        };
        const blob = await exportDocx(payload);
        downloadBlob(blob, `${filename || 'docuease-document'}.docx`);
      }
      setNotice({
        kind: 'success',
        text: `${format.toUpperCase()} downloaded. Untouched content kept its original layout.`,
      });
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : `${format.toUpperCase()} export failed.`,
      });
    } finally {
      setExporting(null);
    }
  };

  const activePage =
    pages.find((page) => page.id === (selection?.pageId || editing?.pageId)) ||
    pages.find((page) => page.id === selection?.pageId) ||
    pages[0] ||
    null;
  const activePageNumber = activePage ? pages.findIndex((page) => page.id === activePage.id) + 1 : 0;
  const totalTextRuns = useMemo(
    () => pages.reduce((sum, page) => sum + page.textBlocks.length, 0),
    [pages]
  );
  const totalOverlays = useMemo(
    () => pages.reduce((sum, page) => sum + page.overlays.length, 0),
    [pages]
  );
  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  const hasDocument = pages.length > 0;

  const jumpToPage = (pageId: string) => {
    setSelection({ pageId, kind: 'page' });
    setEditing(null);
    pageRefs.current.get(pageId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openPicker = () => inputRef.current?.click();

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="DocuEase home">
          <span className="brand-icon"><FileText size={21} /></span>
          <span>docu<span className="brand-accent">ease</span></span>
          <span className="brand-tag">PDF editor</span>
        </a>
        <div className="topbar-right">
          {hasDocument ? (
            <>
              <input
                className="filename-input"
                value={filename}
                aria-label="Export file name"
                onChange={(event) => setFilename(event.target.value)}
                onBlur={() => setFilename((value) => value.trim() || 'docuease-document')}
              />
              <div className="history-controls">
                <button className="tool" title="Undo (⌘/Ctrl+Z)" onClick={undo} disabled={!canUndo}>
                  <Undo2 size={17} />
                </button>
                <button className="tool" title="Redo (⌘/Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
                  <Redo2 size={17} />
                </button>
              </div>
              <button className="button button-outline" onClick={() => addInputRef.current?.click()} disabled={busy}>
                <FilePlus2 size={16} /> Add PDF
              </button>
              <button className="button button-outline" onClick={() => void doExport('docx')} disabled={!!exporting}>
                {exporting === 'docx' ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />} Word
              </button>
              <button className="button button-primary" onClick={() => void doExport('pdf')} disabled={!!exporting}>
                {exporting === 'pdf' ? <LoaderCircle className="spin" size={16} /> : <FileDown size={16} />} Export PDF
              </button>
              <button className="tool" title="Close document" onClick={newDocument}>
                <X size={17} />
              </button>
            </>
          ) : (
            <>
              <span className="privacy-pill"><ShieldCheck size={15} /> Files stay yours</span>
              <span className="avatar">D</span>
            </>
          )}
        </div>
      </header>

      <input ref={inputRef} type="file" accept=".pdf,application/pdf" onChange={onInput} hidden />
      <input ref={addInputRef} type="file" accept=".pdf,application/pdf" onChange={onAddInput} hidden />

      {!hasDocument ? (
        <main id="top" className="landing">
          <section className="intro">
            <div className="eyebrow"><Sparkles size={14} /> TRUE PDF EDITOR</div>
            <h1>Edit PDFs without <span>breaking the layout.</span></h1>
            <p>
              Open a PDF and change it in place. Text, fonts, images, tables and vector art stay
              exactly where they belong — only what you edit gets rewritten.
            </p>
          </section>

          <section className="steps" aria-label="Workflow">
            <div className="step done"><span className="step-number">1</span><span>Open PDF</span></div>
            <span className="step-line" />
            <div className={`step current`}><span className="step-number">2</span><span>Edit in place</span></div>
            <span className="step-line" />
            <div className="step"><span className="step-number">3</span><span>Export PDF or Word</span></div>
          </section>

          <div
            className={`dropzone hero-dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <div className="upload-icon"><UploadCloud size={28} /></div>
            <h3>Drop your PDF here</h3>
            <p>or browse from your device. Your original file is never rebuilt from scratch.</p>
            <button className="button button-primary browse-button" onClick={openPicker} disabled={busy}>
              {busy ? <><LoaderCircle className="spin" size={16} /> {progress || 'Opening…'}</> : <>Browse files</>}
            </button>
            <div className="file-rules"><span>PDF only</span><i /><span>Up to 25 MB</span></div>
            {notice && (
              <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`notice ${notice.kind}`}>
                <span className="notice-icon">
                  {notice.kind === 'error' ? <AlertCircle size={17} /> : notice.kind === 'success' ? <CheckCircle2 size={17} /> : <LoaderCircle className="spin" size={17} />}
                </span>
                <span>{notice.text}</span>
              </div>
            )}
          </div>

          <section className="feature-grid">
            <article>
              <ScanText size={20} />
              <strong>Edit real text</strong>
              <span>Double-click any text run to change it. Original fonts and positions are preserved.</span>
            </article>
            <article>
              <Images size={20} />
              <strong>Keep images & tables</strong>
              <span>Everything you don't edit remains pixel-identical to the source PDF.</span>
            </article>
            <article>
              <Highlighter size={20} />
              <strong>Annotate anything</strong>
              <span>Add text, images, highlights, shapes, freehand ink and sticky notes.</span>
            </article>
            <article>
              <Copy size={20} />
              <strong>Manage pages</strong>
              <span>Reorder, rotate, duplicate, delete, insert blank pages or merge PDFs.</span>
            </article>
          </section>
        </main>
      ) : (
        <div className="editor-shell">
          <aside className="sidebar-editor">
            <div className="side-section">
              <div className="side-heading">
                <span><FileText size={16} /> Document</span>
                <span className="count-pill">{pages.length}</span>
              </div>
              <div className="source-summary">
                <FileType2 size={18} />
                <div>
                  <strong title={sources[0]?.name}>{sources[0]?.name || 'New document'}</strong>
                  <span>
                    {pages.length} page{pages.length === 1 ? '' : 's'} · {totalTextRuns} text runs · {totalOverlays} annotations
                  </span>
                </div>
              </div>
              <div className="side-buttons">
                <button className="button button-outline" onClick={() => addInputRef.current?.click()} disabled={busy}>
                  <FilePlus2 size={15} /> Add PDF
                </button>
                <button className="button button-outline" onClick={addBlankPage}>
                  <Plus size={15} /> Blank page
                </button>
              </div>
              {notice && (
                <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`notice compact ${notice.kind}`}>
                  <span className="notice-icon">
                    {notice.kind === 'error' ? <AlertCircle size={16} /> : notice.kind === 'success' ? <CheckCircle2 size={16} /> : <LoaderCircle className={(busy || exporting) ? 'spin' : ''} size={16} />}
                  </span>
                  <span>{notice.text}</span>
                </div>
              )}
            </div>

            <div className="thumb-scroll">
              {pages.map((page, index) => {
                const delta = ((page.rotation - page.baseRotation) % 360 + 360) % 360;
                const active = activePage?.id === page.id;
                return (
                  <button
                    key={page.id}
                    className={`thumb ${active ? 'active' : ''}`}
                    onClick={() => jumpToPage(page.id)}
                    title={`Go to page ${index + 1}`}
                  >
                    <span className="thumb-stage">
                      {page.background ? (
                        <img
                          src={page.background}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            transformOrigin: 'center',
                            transform: `rotate(${delta}deg)`,
                          }}
                        />
                      ) : (
                        <span className="thumb-blank">Blank</span>
                      )}
                      {page.overlays.length > 0 && <span className="thumb-badge">{page.overlays.length}</span>}
                    </span>
                    <span className="thumb-label">{index + 1}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="canvas-area">
            <div className="tool-dock" role="toolbar" aria-label="Editor tools">
              <div className="tool-group">
                {TOOLS.map((item) => (
                  <button
                    key={item.id}
                    className={`tool ${tool === item.id ? 'active' : ''}`}
                    title={`${item.label} (${item.shortcut})`}
                    aria-label={item.label}
                    aria-pressed={tool === item.id}
                    onClick={() => {
                      setTool(item.id);
                      setEditing(null);
                    }}
                  >
                    {item.icon}
                  </button>
                ))}
              </div>
              <span className="toolbar-divider" />
              <div className="tool-group">
                <button className="tool" title="Undo" onClick={undo} disabled={!canUndo}><Undo2 size={17} /></button>
                <button className="tool" title="Redo" onClick={redo} disabled={!canRedo}><Redo2 size={17} /></button>
              </div>
              <span className="toolbar-spacer" />
              <div className="zoom-group">
                <button className="tool" title="Zoom out" onClick={() => setZoom((value) => clamp(value - 0.1, 0.4, 2.6))}><ZoomOut size={16} /></button>
                <button className="zoom-value" onClick={() => setZoom(1.05)} title="Reset zoom">{Math.round(zoom * 100)}%</button>
                <button className="tool" title="Zoom in" onClick={() => setZoom((value) => clamp(value + 0.1, 0.4, 2.6))}><ZoomIn size={16} /></button>
              </div>
            </div>

            <div className="pages-scroll">
              <div className="pages-inner">
                {pages.map((page, index) => (
                  <PageView
                    key={page.id}
                    page={page}
                    pageNumber={index + 1}
                    totalPages={pages.length}
                    zoom={zoom}
                    tool={tool}
                    selection={selection}
                    editing={editing}
                    onSelect={setSelection}
                    onClearSelection={() => setSelection(null)}
                    onStartEdit={setEditing}
                    onStopEdit={() => setEditing(null)}
                    onCommitPage={commitPage}
                    onLivePage={livePage}
                    onBegin={beginTransaction}
                    onEnd={endTransaction}
                    onRotate={rotatePageById}
                    onDeletePage={deletePage}
                    onDuplicatePage={duplicatePage}
                    onMovePage={movePage}
                    registerRef={registerRef}
                  />
                ))}
              </div>
            </div>

            <div className="statusbar">
              <span className="status-chip">{tool === 'select' ? 'Select tool' : `${TOOLS.find((t) => t.id === tool)?.label} tool`}</span>
              <span>Page {activePageNumber || 1} of {pages.length}</span>
              <span>{totalTextRuns} text runs</span>
              <span>{totalOverlays} annotations</span>
              <span className="status-grow" />
              <span className="preserve-pill"><ShieldCheck size={13} /> Original layout preserved</span>
            </div>
          </main>

          <Inspector
            page={activePage}
            pageNumber={activePageNumber}
            totalPages={pages.length}
            selection={selection}
            onCommitPage={commitPage}
            onStartEdit={(pageId, kind, id) => setEditing({ pageId, kind, id })}
            onRotatePage={rotatePageById}
            onDuplicatePage={duplicatePage}
            onDeletePage={deletePage}
          />
        </div>
      )}

      {!hasDocument && (
        <footer className="page-footer">
          <span>© 2026 DocuEase</span>
          <span>Edit in place. Preserve everything else.</span>
        </footer>
      )}
    </div>
  );
}
