"""DocuEase API — a structure-preserving PDF editor.

The editor never rebuilds a PDF from scratch. Uploaded pages are rendered as a
background and only the content the user actually changes (text blocks, added
text/images/shapes, page operations) is applied on top of the original page.
Anything the user leaves untouched — fonts, images, tables, vector artwork,
metadata and page size — is preserved pixel for pixel.
"""

from __future__ import annotations

import base64
import io
import os
import re
from html import escape as html_escape
from pathlib import Path
from typing import Annotated, Optional

import pymupdf as fitz  # PyMuPDF
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 300
MAX_FILES = 12
MAX_OVERLAYS = 500
MAX_TEXT = 200_000

# Render settings -----------------------------------------------------------
BASE_RENDER_SCALE = 1.7
MAX_RENDER_EDGE = 2400

app = FastAPI(
    title="DocuEase API",
    version="2.0.0",
    description="Edit PDFs while preserving their original structure and export to PDF or DOCX.",
)
origins = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[x.strip() for x in origins if x.strip()],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ExportRequest(BaseModel):
    """Legacy HTML export request (kept for backwards compatibility)."""

    html: str = Field(min_length=1, max_length=MAX_TEXT)
    filename: str = Field(default="docuease-document", max_length=120)


class TextEdit(BaseModel):
    bbox: list[float]
    text: str = ""
    fontSize: float = 12
    font: str = "Helvetica"
    color: str = "#000000"
    bold: bool = False
    italic: bool = False
    align: str = "left"


class Overlay(BaseModel):
    id: Optional[str] = None
    type: str
    bbox: Optional[list[float]] = None
    points: Optional[list[list[float]]] = None
    text: Optional[str] = None
    fontSize: Optional[float] = None
    font: Optional[str] = None
    color: Optional[str] = None
    fill: Optional[str] = None
    stroke: Optional[str] = None
    opacity: Optional[float] = None
    width: Optional[float] = None
    data: Optional[str] = None
    align: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None


class PagePayload(BaseModel):
    file: int = 0
    source: Optional[int] = None
    width: Optional[float] = None
    height: Optional[float] = None
    rotation: int = 0
    textEdits: list[TextEdit] = Field(default_factory=list)
    overlays: list[Overlay] = Field(default_factory=list)


class ExportPayload(BaseModel):
    filename: str = Field(default="docuease-document", max_length=160)
    pages: list[PagePayload] = Field(default_factory=list)


class DocxText(BaseModel):
    text: str = ""
    fontSize: float = 11
    bold: bool = False
    italic: bool = False


class DocxPage(BaseModel):
    texts: list[DocxText] = Field(default_factory=list)


class DocxRequest(BaseModel):
    filename: str = Field(default="docuease-document", max_length=160)
    pages: list[DocxPage] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def safe_filename(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(value).stem).strip("-._")
    return (name or "docuease-document")[:100]


def color_to_hex(value: int) -> str:
    return f"#{value & 0xFFFFFF:06x}"


def hex_to_rgb(value: Optional[str], fallback=(0.0, 0.0, 0.0)) -> tuple[float, ...]:
    if not value:
        return fallback
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    if len(value) != 6:
        return fallback
    try:
        return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return fallback


def align_value(value: Optional[str]) -> int:
    return {
        "left": fitz.TEXT_ALIGN_LEFT,
        "center": fitz.TEXT_ALIGN_CENTER,
        "right": fitz.TEXT_ALIGN_RIGHT,
        "justify": fitz.TEXT_ALIGN_JUSTIFY,
    }.get((value or "left").lower(), fitz.TEXT_ALIGN_LEFT)


def resolve_font(font: Optional[str], bold: bool = False, italic: bool = False) -> str:
    name = (font or "").lower()
    if "courier" in name or "mono" in name or "consol" in name:
        family = "co"
    elif "times" in name or "serif" in name or "georgia" in name or "garamond" in name:
        family = "ti"
    else:
        family = "he"
    if family == "co":
        return "cobi" if bold and italic else "cobo" if bold else "coit" if italic else "cour"
    if family == "ti":
        return "tibi" if bold and italic else "tibo" if bold else "tiit" if italic else "tiro"
    return "hebi" if bold and italic else "hebo" if bold else "heit" if italic else "helv"


def span_style(span: dict) -> dict:
    font = span.get("font", "") or ""
    flags = int(span.get("flags", 0) or 0)
    lower = font.lower()
    bold = bool(flags & 16) or any(k in lower for k in ("bold", "black", "heavy", "semibold", "demibold"))
    italic = bool(flags & 2) or any(k in lower for k in ("italic", "oblique"))
    return {
        "font": font or "Helvetica",
        "fontSize": round(float(span.get("size", 12) or 12), 2),
        "bold": bold,
        "italic": italic,
        "color": color_to_hex(int(span.get("color", 0) or 0)),
    }


def validate_pdf_bytes(data: bytes, filename: str) -> None:
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(415, "Please upload a PDF file.")
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"PDF must be {MAX_BYTES // (1024 * 1024)} MB or smaller.")
    if not data.lstrip().startswith(b"%PDF-"):
        raise HTTPException(415, "The file does not have a valid PDF signature.")


def render_scale(page_width: float, page_height: float, page_count: int) -> float:
    scale = BASE_RENDER_SCALE if page_count <= 20 else 1.4 if page_count <= 60 else 1.15
    longest = max(page_width, page_height, 1)
    return max(0.6, min(scale, MAX_RENDER_EDGE / longest))


def extract_blocks(page: "fitz.Page", page_index: int) -> list[dict]:
    """Return editable text blocks in *display* (rotated) coordinates."""
    rmat = page.rotation_matrix
    data = page.get_text("dict")
    blocks: list[dict] = []
    for block_index, block in enumerate(data.get("blocks", [])):
        if block.get("type") != 0:
            continue
        lines = block.get("lines", [])
        text_lines: list[str] = []
        spans: list[dict] = []
        for line in lines:
            span_list = line.get("spans", [])
            line_text = "".join(span.get("text", "") for span in span_list)
            if not line_text.strip() and not text_lines:
                continue
            text_lines.append(line_text.rstrip())
            for span in span_list:
                if span.get("text", "").strip():
                    spans.append(span)
        text = "\n".join(text_lines).strip()
        if not text:
            continue
        dominant = max(spans, key=lambda s: len(s.get("text", ""))) if spans else {}
        style = span_style(dominant) if dominant else {
            "font": "Helvetica",
            "fontSize": 12,
            "bold": False,
            "italic": False,
            "color": "#000000",
        }
        rect = fitz.Rect(block["bbox"]) * rmat
        blocks.append(
            {
                "id": f"p{page_index}-b{block_index}",
                "bbox": [
                    round(rect.x0, 2),
                    round(rect.y0, 2),
                    round(rect.x1, 2),
                    round(rect.y1, 2),
                ],
                "text": text,
                "originalText": text,
                **style,
            }
        )
    blocks.sort(key=lambda b: (round(b["bbox"][1], 1), round(b["bbox"][0], 1)))
    return blocks


def png_data_url(page: "fitz.Page", scale: float) -> str:
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")


# ---------------------------------------------------------------------------
# PDF insertion helpers
# ---------------------------------------------------------------------------


def to_unrotated(rect: fitz.Rect, page: "fitz.Page") -> fitz.Rect:
    out = fitz.Rect(rect) * page.derotation_matrix
    out.normalize()
    return out


def to_unrotated_point(point: list[float], page: "fitz.Page") -> tuple[float, float]:
    p = fitz.Point(point[0], point[1]) * page.derotation_matrix
    return (p.x, p.y)


def rgb_hex(color: tuple[float, ...]) -> str:
    return "#" + "".join(f"{int(max(0.0, min(1.0, c)) * 255):02x}" for c in color[:3])


def insert_unicode_text(
    page: "fitz.Page",
    rect: fitz.Rect,
    text: str,
    fontsize: float,
    fontname: str,
    color: tuple[float, ...],
    align: int,
) -> None:
    """Use MuPDF's rich-text engine so non-Latin text keeps its glyphs."""
    rect = fitz.Rect(rect)
    rect.normalize()
    bottom_limit = max(rect.y0 + fontsize, page.mediabox.height - 2)
    needed = fontsize * (text.count("\n") + 2) * 1.3
    rect.y1 = min(bottom_limit, max(rect.y1, rect.y0 + needed))
    if rect.y1 <= rect.y0:
        rect.y1 = rect.y0 + fontsize * 1.4
    family = {
        "he": "Helvetica, Arial, sans-serif",
        "ti": "Times New Roman, Times, serif",
        "co": "Courier New, Courier, monospace",
    }[fontname[:2] if fontname[:2] in ("he", "ti", "co") else "he"]
    bold = fontname in {"hebo", "hebi", "tibo", "tibi", "cobo", "cobi"}
    italic = fontname in {"heit", "hebi", "tiit", "tibi", "coit", "cobi"}
    align_css = {0: "left", 1: "center", 2: "right", 3: "justify"}.get(align, "left")
    css = (
        f"* {{ font-family: {family}; font-size: {fontsize}px; "
        f"font-weight: {'bold' if bold else 'normal'}; "
        f"font-style: {'italic' if italic else 'normal'}; "
        f"color: {rgb_hex(color)}; text-align: {align_css}; "
        f"line-height: 1.2; white-space: pre-wrap; }}"
    )
    content = "<br/>".join(html_escape(line, quote=False) for line in text.split("\n"))
    try:
        page.insert_htmlbox(rect, content, css=css)
    except Exception:
        page.insert_textbox(
            rect, text, fontsize=fontsize, fontname=fontname, color=color, align=align, overlay=True
        )


def insert_text_block(
    page: "fitz.Page",
    rect: fitz.Rect,
    text: str,
    fontsize: float,
    fontname: str,
    color: tuple[float, ...],
    align: int,
) -> None:
    if not text or not text.strip():
        return
    fontsize = max(4.0, min(float(fontsize or 12), 200.0))
    if any(ord(char) > 0xFF for char in text):
        insert_unicode_text(page, fitz.Rect(rect), text, fontsize, fontname, color, align)
        return
    rect = fitz.Rect(rect)
    rect.normalize()
    bottom_limit = page.mediabox.height
    trial = fitz.Rect(rect)
    for _ in range(8):
        trial.y1 = min(max(trial.y1, trial.y0 + fontsize), bottom_limit)
        rc = page.insert_textbox(
            trial,
            text,
            fontsize=fontsize,
            fontname=fontname,
            color=color,
            align=align,
            lineheight=1.2,
            overlay=True,
        )
        if rc >= 0:
            return
        trial.y1 = min(bottom_limit, trial.y1 + max(fontsize * 1.6, (trial.y1 - rect.y0) * 0.6))
        if trial.y1 >= bottom_limit:
            break
    page.insert_text(
        (rect.x0, min(bottom_limit - 1, rect.y0 + fontsize)),
        text,
        fontsize=fontsize,
        fontname=fontname,
        color=color,
        overlay=True,
    )


def apply_text_edits(page: "fitz.Page", edits: list[TextEdit]) -> None:
    valid = [e for e in edits if e.bbox and len(e.bbox) == 4]
    if not valid:
        return
    redacted = False
    for edit in valid:
        rect = to_unrotated(fitz.Rect(edit.bbox), page)
        if rect.is_empty or rect.is_infinite:
            continue
        page.add_redact_annot(rect, fill=False)
        redacted = True
    if redacted:
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
    for edit in valid:
        rect = to_unrotated(fitz.Rect(edit.bbox), page)
        insert_text_block(
            page,
            rect,
            edit.text,
            edit.fontSize,
            resolve_font(edit.font, edit.bold, edit.italic),
            hex_to_rgb(edit.color),
            align_value(edit.align),
        )


def apply_overlay(page: "fitz.Page", overlay: Overlay) -> None:
    bbox = overlay.bbox
    rect = None
    if bbox and len(bbox) == 4:
        rect = to_unrotated(fitz.Rect(bbox), page)
        if rect.is_empty:
            rect = None
    stroke = hex_to_rgb(overlay.stroke or overlay.color, (0.1, 0.1, 0.15))
    fill = hex_to_rgb(overlay.fill, None) if overlay.fill else None
    width = max(0.3, min(float(overlay.width or 1.5), 40))
    opacity = max(0.0, min(float(overlay.opacity if overlay.opacity is not None else 1.0), 1.0))

    kind = (overlay.type or "").lower()
    try:
        if kind == "text":
            if rect is None:
                return
            insert_text_block(
                page,
                rect,
                overlay.text or "",
                overlay.fontSize or 14,
                resolve_font(overlay.font, bool(overlay.bold), bool(overlay.italic)),
                hex_to_rgb(overlay.color, (0.1, 0.1, 0.15)),
                align_value(overlay.align),
            )
        elif kind == "image" and overlay.data and rect is not None:
            raw = overlay.data.split(",", 1)[-1]
            try:
                image_bytes = base64.b64decode(raw, validate=False)
            except Exception:
                return
            if len(image_bytes) > 20 * 1024 * 1024:
                return
            page.insert_image(rect, stream=image_bytes, keep_proportion=True, overlay=True)
        elif kind == "whiteout" and rect is not None:
            page.draw_rect(rect, fill=fill or (1, 1, 1), color=None, overlay=True)
        elif kind == "rect" and rect is not None:
            page.draw_rect(
                rect,
                color=stroke,
                fill=fill,
                width=width,
                stroke_opacity=opacity,
                fill_opacity=opacity if fill else 1,
                overlay=True,
            )
        elif kind in ("ellipse", "oval") and rect is not None:
            page.draw_oval(
                rect,
                color=stroke,
                fill=fill,
                width=width,
                stroke_opacity=opacity,
                fill_opacity=opacity if fill else 1,
                overlay=True,
            )
        elif kind == "line":
            points = overlay.points
            if points and len(points) >= 2:
                p1 = to_unrotated_point(points[0], page)
                p2 = to_unrotated_point(points[1], page)
            elif rect is not None:
                p1 = (rect.x0, rect.y0)
                p2 = (rect.x1, rect.y1)
            else:
                return
            page.draw_line(
                p1,
                p2,
                color=stroke,
                width=width,
                stroke_opacity=opacity,
                overlay=True,
                lineCap=1,
            )
        elif kind in ("draw", "freehand", "ink"):
            points = overlay.points or []
            mapped = [to_unrotated_point(p, page) for p in points if len(p) >= 2]
            if len(mapped) >= 2:
                page.draw_polyline(
                    mapped,
                    color=stroke,
                    width=width,
                    stroke_opacity=opacity,
                    lineCap=1,
                    lineJoin=1,
                    overlay=True,
                )
        elif kind == "highlight" and rect is not None:
            annot = page.add_highlight_annot(rect)
            annot.set_colors(stroke=hex_to_rgb(overlay.color, (1.0, 0.86, 0.25)))
            annot.set_opacity(min(0.65, max(0.15, opacity)))
            annot.update()
        elif kind == "underline" and rect is not None:
            annot = page.add_underline_annot(rect)
            annot.set_colors(stroke=stroke)
            annot.update()
        elif kind == "strikeout" and rect is not None:
            annot = page.add_strikeout_annot(rect)
            annot.set_colors(stroke=stroke)
            annot.update()
        elif kind == "note" and rect is not None:
            annot = page.add_text_annot((rect.x0, rect.y0), overlay.text or "")
            annot.set_info(content=overlay.text or "")
            annot.update()
    except Exception:
        # A single malformed overlay should never fail the whole export.
        return


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    return {"status": "ok", "service": "docuease-api", "version": app.version}


@app.post("/extract")
async def extract_pdf(
    file: Annotated[UploadFile, File(description="Text-based PDF, up to 25 MB")]
):
    filename = file.filename or "document.pdf"
    data = await file.read(MAX_BYTES + 1)
    validate_pdf_bytes(data, filename)
    try:
        with fitz.open(stream=data, filetype="pdf") as pdf:
            if pdf.needs_pass or pdf.is_encrypted:
                raise HTTPException(422, "This PDF is password-protected. Remove its password before uploading.")
            if len(pdf) > MAX_PAGES:
                raise HTTPException(413, f"PDFs are limited to {MAX_PAGES} pages in this version.")
            page_count = len(pdf)
            pages: list[dict] = []
            total_text = 0
            for index, page in enumerate(pdf):
                scale = render_scale(page.rect.width, page.rect.height, page_count)
                blocks = extract_blocks(page, index)
                total_text += len(blocks)
                pages.append(
                    {
                        "index": index,
                        "width": round(page.rect.width, 2),
                        "height": round(page.rect.height, 2),
                        "rotation": int(page.rotation or 0) % 360,
                        "background": png_data_url(page, scale),
                        "textBlocks": blocks,
                        "hasText": bool(blocks),
                        "hasImages": bool(page.get_images(full=True)),
                    }
                )
            if total_text == 0 and not any(p["hasImages"] for p in pages):
                raise HTTPException(
                    422,
                    "No selectable text or images were found. This may be an empty or unsupported PDF.",
                )
            metadata = {k: v for k, v in (pdf.metadata or {}).items() if v}
            return {
                "filename": filename,
                "pageCount": page_count,
                "pages": pages,
                "metadata": metadata,
                "hasSelectableText": total_text > 0,
            }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "Could not read this PDF. It may be corrupted or unsupported.") from exc


def build_pdf(files: list[bytes], payload: ExportPayload) -> bytes:
    if not payload.pages:
        raise HTTPException(400, "There are no pages to export.")
    if len(payload.pages) > MAX_PAGES:
        raise HTTPException(413, f"Documents are limited to {MAX_PAGES} pages.")
    sources: list["fitz.Document"] = []
    try:
        for data in files:
            sources.append(fitz.open(stream=data, filetype="pdf"))
        out = fitz.open()
        for spec in payload.pages:
            if len(spec.overlays) > MAX_OVERLAYS:
                raise HTTPException(413, "Too many annotations on a single page.")
            if spec.source is None:
                width = float(spec.width or 595.28)
                height = float(spec.height or 841.89)
                page = out.new_page(width=max(1, width), height=max(1, height))
            else:
                if spec.file < 0 or spec.file >= len(sources):
                    raise HTTPException(400, "Page references an unknown source document.")
                src = sources[spec.file]
                if spec.source < 0 or spec.source >= len(src):
                    raise HTTPException(400, "Page references an unknown source page.")
                out.insert_pdf(src, from_page=spec.source, to_page=spec.source)
                page = out[-1]
            rotation = int(spec.rotation or 0)
            if rotation % 90 != 0:
                rotation = 0
            page.set_rotation(rotation % 360)
            apply_text_edits(page, spec.textEdits)
            for overlay in spec.overlays:
                apply_overlay(page, overlay)
        out.set_metadata(
            {
                "title": safe_filename(payload.filename),
                "producer": "DocuEase",
                "creator": "DocuEase PDF Editor",
            }
        )
        buf = io.BytesIO()
        out.save(buf, garbage=4, deflate=True, clean=True)
        return buf.getvalue()
    finally:
        for source in sources:
            try:
                source.close()
            except Exception:
                pass


@app.post("/export/pdf")
async def export_pdf(
    payload: Annotated[str, Form(description="JSON document model")],
    files: Annotated[list[UploadFile], File(description="Original PDF(s)")] = [],
):
    """Apply edits/overlays/page operations to the original PDF(s)."""
    try:
        model = ExportPayload.model_validate_json(payload)
    except Exception as exc:
        raise HTTPException(400, "The document model is not valid JSON.") from exc
    if len(files) > MAX_FILES:
        raise HTTPException(413, f"At most {MAX_FILES} source PDFs can be merged at once.")
    datas: list[bytes] = []
    for upload in files:
        data = await upload.read(MAX_BYTES + 1)
        validate_pdf_bytes(data, upload.filename or "source.pdf")
        datas.append(data)
    try:
        content = build_pdf(datas, model)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, "PDF export failed. Please try again.") from exc
    name = safe_filename(model.filename) + ".pdf"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


def build_docx(model: DocxRequest) -> bytes:
    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    empty = True
    for page_index, page in enumerate(model.pages):
        texts = [t for t in page.texts if t.text and t.text.strip()]
        if not texts:
            continue
        if not empty:
            doc.add_page_break()
        empty = False
        for item in texts:
            size = max(6.0, min(float(item.fontSize or 11), 72.0))
            if size >= 20:
                paragraph = doc.add_paragraph(style="Heading 1")
            elif size >= 15:
                paragraph = doc.add_paragraph(style="Heading 2")
            elif size >= 12.5 and item.bold:
                paragraph = doc.add_paragraph(style="Heading 3")
            else:
                paragraph = doc.add_paragraph()
            for line_index, line in enumerate(item.text.split("\n")):
                if line_index:
                    paragraph.add_run().add_break()
                run = paragraph.add_run(line)
                run.font.size = Pt(size)
                run.bold = bool(item.bold)
                run.italic = bool(item.italic)
                run.font.color.rgb = RGBColor(0x22, 0x2B, 0x3A)
    if empty:
        doc.add_paragraph("(Empty document)")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


@app.post("/export/docx")
def export_docx(request: DocxRequest):
    try:
        content = build_docx(request)
    except Exception as exc:
        raise HTTPException(500, "Word export failed. Please try again.") from exc
    name = safe_filename(request.filename) + ".docx"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---------------------------------------------------------------------------
# Legacy HTML export (kept so old clients keep working)
# ---------------------------------------------------------------------------


def clean_soup(html: str):
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for bad in soup(["script", "style", "iframe", "object", "embed", "svg", "img", "video", "audio"]):
        bad.decompose()
    for tag in soup.find_all(True):
        tag.attrs = {}
    return soup


def body_text(soup) -> list[str]:
    from bs4 import NavigableString, Tag

    def inline(node) -> str:
        if isinstance(node, NavigableString):
            return str(node)
        if not isinstance(node, Tag):
            return ""
        content = "".join(inline(c) for c in node.children)
        return content

    lines: list[str] = []
    for child in soup.contents:
        if isinstance(child, Tag):
            text = inline(child).strip()
            if text:
                lines.append(text)
        elif isinstance(child, NavigableString):
            text = str(child).strip()
            if text:
                lines.append(text)
    return lines


@app.post("/export/html/pdf")
def export_html_pdf(request: ExportRequest):
    try:
        lines = body_text(clean_soup(request.html))
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        rect = fitz.Rect(56, 56, 539, 786)
        insert_text_block(page, rect, "\n\n".join(lines), 11, "helv", (0.1, 0.1, 0.15), 0)
        buf = io.BytesIO()
        doc.save(buf)
        content = buf.getvalue()
    except Exception as exc:
        raise HTTPException(500, "PDF export failed.") from exc
    name = safe_filename(request.filename) + ".pdf"
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---------------------------------------------------------------------------
# Optional: serve the built frontend from the same origin.
# This is what makes a single-URL deployment (Render/Railway/Fly/Docker) work.
# ---------------------------------------------------------------------------
_frontend_env = os.getenv("FRONTEND_DIR")
FRONTEND_DIR = (
    Path(_frontend_env).expanduser()
    if _frontend_env
    else Path(__file__).resolve().parent.parent / "frontend" / "dist"
)

if FRONTEND_DIR.is_dir() and (FRONTEND_DIR / "index.html").is_file():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:

    @app.get("/")
    def root():
        return {
            "status": "ok",
            "service": "docuease-api",
            "docs": "/docs",
            "frontend": "not built (run `npm run build` in frontend/)",
        }
