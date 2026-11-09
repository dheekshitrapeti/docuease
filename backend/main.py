"""DocuEase API — a structure-preserving PDF editor.

The editor never rebuilds a PDF from scratch. Uploaded pages are rendered as a
background and only the content the user actually changes (text blocks, added
text/images/shapes, page operations) is applied on top of the original page.
Anything the user leaves untouched — fonts, images, tables, vector artwork,
metadata and page size — is preserved pixel for pixel.
"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import shutil
import subprocess
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


# ---------------------------------------------------------------------------
# Original-font resolution
#
# Replacing text with a Base-14 font makes edited runs look different from the
# rest of the page. These helpers find the font the original run actually used
# and re-embed it: the exact embedded font when the PDF carries a full copy,
# otherwise a system font with the same family. Only when neither is available
# do we fall back to the closest Base-14 font.
# ---------------------------------------------------------------------------

_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")
_STYLE_WORDS = {
    "bold",
    "black",
    "heavy",
    "semibold",
    "demibold",
    "demi",
    "italic",
    "oblique",
    "regular",
    "book",
    "roman",
    "light",
    "medium",
    "normal",
    "mt",
    "psmt",
    "boldmt",
    "italicmt",
    "bolditalicmt",
}
_SYSTEM_FONT_CACHE: dict[tuple[str, bool, bool], Optional[str]] = {}

# Metric-compatible open substitutes commonly shipped on Linux/Docker. This
# keeps Word/Office PDFs looking right when the proprietary font is not
# installed on the server.
_FAMILY_ALIASES = {
    "arial": {"liberationsans", "nimbussans", "helvetica"},
    "helvetica": {"liberationsans", "nimbussans", "arial"},
    "times": {"liberationserif", "nimbusroman", "timesnewroman"},
    "timesnewroman": {"liberationserif", "nimbusroman", "times"},
    "courier": {"liberationmono", "nimbusmono", "couriernew"},
    "couriernew": {"liberationmono", "nimbusmono", "courier"},
    "calibri": {"carlito"},
    "aptos": {"carlito", "liberationsans"},
    "cambria": {"caladea"},
}


def _strip_subset(name: Optional[str]) -> str:
    return _SUBSET_PREFIX.sub("", name or "")


def _normalize_font_name(name: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", "", _strip_subset(name).lower())


def _style_from_name(name: Optional[str]) -> tuple[bool, bool]:
    lower = _strip_subset(name).lower()
    bold = any(k in lower for k in ("bold", "black", "heavy", "semibold", "demibold", "demi"))
    italic = any(k in lower for k in ("italic", "oblique"))
    return bold, italic


def _split_family_style(name: Optional[str]) -> tuple[str, bool, bool]:
    clean = _strip_subset(name).replace("_", " ")
    bold, italic = _style_from_name(clean)
    kept: list[str] = []
    for part in re.split(r"[\s,\-]+", clean):
        token = re.sub(r"[^a-z]", "", part.lower())
        if not token or token in _STYLE_WORDS:
            continue
        kept.append(part)
    family = " ".join(kept).strip() or clean
    return family, bold, italic


def _family_query(family: str) -> str:
    family = re.sub(r"(?i)(psmt|mt)$", "", family)
    family = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", family)
    return re.sub(r"\s+", " ", family).strip()


def _font_matches_family(path: str, family: str) -> bool:
    wanted = _normalize_font_name(family)
    if not wanted:
        return False
    try:
        got = _normalize_font_name(fitz.Font(fontfile=path).name or "")
    except Exception:
        return False
    if not got:
        return False
    if wanted in got or got in wanted:
        return True
    aliases = _FAMILY_ALIASES.get(wanted, set())
    return got in aliases or any(alias in got or got in alias for alias in aliases)


def _fc_match(query: str, bold: bool, italic: bool) -> Optional[str]:
    key = (query, bold, italic)
    if key in _SYSTEM_FONT_CACHE:
        return _SYSTEM_FONT_CACHE[key]
    path: Optional[str] = None
    executable = shutil.which("fc-match")
    if executable and query:
        pattern = query + (":bold" if bold else "") + (":italic" if italic else "")
        try:
            result = subprocess.run(
                [executable, "-f", "%{file}", pattern],
                capture_output=True,
                text=True,
                timeout=2,
            )
            candidate = (result.stdout or "").strip().splitlines()
            if candidate and os.path.isfile(candidate[0]):
                path = candidate[0]
        except Exception:
            path = None
    _SYSTEM_FONT_CACHE[key] = path
    return path


def _system_font_path(basefont: str, extra_bold: bool, extra_italic: bool) -> Optional[str]:
    family, name_bold, name_italic = _split_family_style(basefont)
    bold = name_bold or extra_bold
    italic = name_italic or extra_italic
    queries: list[str] = []
    for candidate in (_family_query(family), family, _family_query(family).replace(" ", "")):
        if candidate and candidate not in queries:
            queries.append(candidate)
    for query in queries:
        path = _fc_match(query, bold, italic)
        if path and _font_matches_family(path, family):
            return path
    return None


def _page_fonts(page: "fitz.Page") -> list[dict]:
    """Fonts referenced by *page*, with their embedded bytes when available."""
    fonts: list[dict] = []
    document = page.parent
    try:
        entries = page.get_fonts(full=True)
    except Exception:
        entries = []
    for entry in entries:
        if len(entry) < 5:
            continue
        xref, ext, ftype, basefont, resname = (
            entry[0],
            entry[1] or "",
            entry[2] or "",
            entry[3] or "",
            entry[4] or "",
        )
        buffer = b""
        if xref and ext.lower() not in ("", "n/a"):
            try:
                buffer = document.extract_font(xref)[3] or b""
            except Exception:
                buffer = b""
        fonts.append(
            {
                "xref": xref,
                "ext": ext,
                "type": ftype,
                "basefont": basefont,
                "resname": resname,
                "buffer": buffer,
            }
        )
    return fonts


def _match_font(fonts: list[dict], name: Optional[str], bold: bool, italic: bool) -> Optional[dict]:
    wanted = _normalize_font_name(name)
    if not wanted:
        return None
    best: Optional[dict] = None
    best_score = 0.0
    for info in fonts:
        score = 0.0
        for label in (_normalize_font_name(info["basefont"]), _normalize_font_name(info["resname"])):
            if not label:
                continue
            if label == wanted:
                score = max(score, 3.0)
            elif wanted in label or label in wanted:
                score = max(score, 2.0)
        if score <= 0:
            continue
        font_bold, font_italic = _style_from_name(info["basefont"] or info["resname"])
        if font_bold == bool(bold):
            score += 0.4
        if font_italic == bool(italic):
            score += 0.2
        if score > best_score:
            best_score, best = score, info
    return best


def _text_supported(font: "fitz.Font", text: str) -> bool:
    for char in text:
        if char in "\r\n\t":
            continue
        code = ord(char)
        if code < 32:
            continue
        try:
            if not font.has_glyph(code):
                return False
        except Exception:
            return False
    return True


def _font_supports_char(font: "fitz.Font", char: str) -> bool:
    if char in "\r\n\t":
        return True
    code = ord(char)
    if code < 32:
        return True
    try:
        return bool(font.has_glyph(code))
    except Exception:
        return False


def _font_style_matches(font: "fitz.Font", bold: bool, italic: bool) -> bool:
    lower = (font.name or "").lower()
    font_bold = any(k in lower for k in ("bold", "black", "heavy", "semibold", "demibold", "demi"))
    font_italic = any(k in lower for k in ("italic", "oblique"))
    return font_bold == bool(bold) and font_italic == bool(italic)


_FALLBACK_QUERIES = (
    "Arial Unicode MS",
    "DejaVu Sans",
    "Noto Sans",
    "Noto Sans Symbols 2",
    "Segoe UI Symbol",
    "Apple Symbols",
)


def _fallback_selections(text: str, bold: bool, italic: bool) -> list[dict]:
    """Fonts that can render characters the primary font is missing."""
    selections: list[dict] = []
    seen: set[str] = set()
    for query in _FALLBACK_QUERIES:
        path = _fc_match(query, bold, italic)
        if not path or path in seen:
            continue
        seen.add(path)
        try:
            font = fitz.Font(fontfile=path)
        except Exception:
            continue
        if _text_supported(font, text):
            selections.append({"key": f"file:{path}", "font": font, "path": path})
    return selections


def _choose_font(
    fonts: list[dict], name: Optional[str], bold: bool, italic: bool
) -> Optional[dict]:
    info = _match_font(fonts, name, bold, italic)
    if not info:
        return None
    basefont = info["basefont"] or name or ""
    is_subset = bool(_SUBSET_PREFIX.match(info["basefont"] or ""))
    if info["buffer"] and not is_subset:
        try:
            font = fitz.Font(fontbuffer=info["buffer"])
            if _font_style_matches(font, bold, italic):
                return {"key": f"buf:{info['xref']}", "font": font, "buffer": info["buffer"]}
        except Exception:
            pass
    path = _system_font_path(basefont, bold, italic)
    if path:
        try:
            font = fitz.Font(fontfile=path)
            if _font_style_matches(font, bold, italic):
                return {"key": f"file:{path}", "font": font, "path": path}
        except Exception:
            pass
    return None


def _register_font(page: "fitz.Page", selection: dict, cache: dict[str, str]) -> Optional[str]:
    key = selection["key"]
    if key in cache:
        return cache[key]
    try:
        existing = {entry[4] for entry in page.get_fonts(full=True) if len(entry) > 4}
    except Exception:
        existing = set()
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    name = f"DE{digest}"
    suffix = 1
    while name in existing:
        name = f"DE{digest}_{suffix}"
        suffix += 1
    try:
        if "buffer" in selection:
            page.insert_font(fontname=name, fontbuffer=selection["buffer"])
        else:
            page.insert_font(fontname=name, fontfile=selection["path"])
    except Exception:
        return None
    cache[key] = name
    return name


def _original_text_metrics(
    page: "fitz.Page", rect: fitz.Rect, data: Optional[dict] = None
) -> tuple[Optional[str], Optional[float], Optional[float], Optional[float]]:
    """Return (dominant font, first baseline, line step, font size) for *rect*."""
    lines: list[tuple[float, float]] = []
    font_lengths: dict[str, int] = {}
    font_sizes: dict[str, float] = {}
    if data is None:
        try:
            data = page.get_text("dict")
        except Exception:
            return None, None, None, None
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            line_box = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
            if line_box.is_empty or not line_box.intersects(rect):
                continue
            spans = line.get("spans", [])
            origins = [span.get("origin") for span in spans if span.get("origin")]
            if not origins:
                continue
            lines.append((line_box.y0, float(origins[0][1])))
            for span in spans:
                text = (span.get("text") or "").strip()
                if not text:
                    continue
                font = span.get("font") or ""
                font_lengths[font] = font_lengths.get(font, 0) + len(text)
                font_sizes.setdefault(font, float(span.get("size") or 12))
    if not lines:
        return None, None, None, None
    lines.sort(key=lambda item: item[0])
    baseline = lines[0][1]
    step = lines[1][1] - lines[0][1] if len(lines) > 1 else None
    if step is not None and step <= 0:
        step = None
    if not font_lengths:
        return None, baseline, step, None
    dominant = max(font_lengths, key=font_lengths.get)
    return dominant, baseline, step, font_sizes.get(dominant)


def _split_runs(
    line: str,
    primary: tuple[str, "fitz.Font"],
    fallbacks: list[tuple[str, "fitz.Font"]],
) -> list[tuple[str, str, "fitz.Font"]]:
    """Split a line into consecutive runs that each use the best available font."""
    runs: list[tuple[str, str, "fitz.Font"]] = []
    current: Optional[tuple[str, "fitz.Font"]] = None
    buffer: list[str] = []

    def pick(char: str) -> tuple[str, "fitz.Font"]:
        if _font_supports_char(primary[1], char):
            return primary
        for fallback in fallbacks:
            if _font_supports_char(fallback[1], char):
                return fallback
        return primary

    for char in line:
        chosen = pick(char)
        if current is None or chosen[0] != current[0]:
            if current is not None and buffer:
                runs.append(("".join(buffer), current[0], current[1]))
            current = chosen
            buffer = [char]
        else:
            buffer.append(char)
    if current is not None and buffer:
        runs.append(("".join(buffer), current[0], current[1]))
    return runs


def _draw_text_runs(
    page: "fitz.Page",
    rect: fitz.Rect,
    text: str,
    fontsize: float,
    primary: tuple[str, "fitz.Font"],
    fallbacks: list[tuple[str, "fitz.Font"]],
    color: tuple[float, ...],
    align: int,
    baseline: Optional[float],
    line_step: Optional[float],
) -> None:
    rect = fitz.Rect(rect)
    rect.normalize()
    if baseline is None:
        baseline = rect.y0 + fontsize * 1.075
    step = line_step if line_step and line_step > 0 else fontsize * 1.2
    limit = page.mediabox.height
    for index, line in enumerate(text.split("\n")):
        if not line.strip():
            continue
        y = baseline + index * step
        if y > limit + fontsize:
            break
        runs = _split_runs(line, primary, fallbacks)
        widths = []
        for run, _name, font in runs:
            try:
                widths.append(font.text_length(run, fontsize=fontsize))
            except Exception:
                widths.append(0.0)
        total = sum(widths)
        if align == fitz.TEXT_ALIGN_CENTER:
            x = rect.x0 + max(0.0, (rect.width - total) / 2)
        elif align == fitz.TEXT_ALIGN_RIGHT:
            x = rect.x1 - total
        else:
            x = rect.x0
        for (run, name, _font), width in zip(runs, widths):
            if run.strip():
                try:
                    page.insert_text(
                        (x, y),
                        run,
                        fontname=name,
                        fontsize=fontsize,
                        color=color,
                        overlay=True,
                    )
                except Exception:
                    pass
            x += width


def infer_alignment(lines: list[dict], block_rect: fitz.Rect, matrix: fitz.Matrix) -> str:
    """Best-effort alignment from the relative position of each line."""
    boxes: list[fitz.Rect] = []
    for line in lines:
        text = "".join(span.get("text", "") for span in line.get("spans", []))
        if not text.strip():
            continue
        box = fitz.Rect(line.get("bbox", (0, 0, 0, 0))) * matrix
        if not box.is_empty:
            boxes.append(box)
    if len(boxes) < 2 or block_rect.width <= 0:
        return "left"

    def spread(values: list[float]) -> float:
        return max(values) - min(values)

    tolerance = max(2.0, block_rect.width * 0.03)
    lefts = [box.x0 - block_rect.x0 for box in boxes]
    rights = [block_rect.x1 - box.x1 for box in boxes]
    if spread(lefts) <= tolerance:
        return "left"
    if spread(rights) <= tolerance:
        return "right"
    centers = [((box.x0 + box.x1) - (block_rect.x0 + block_rect.x1)) / 2 for box in boxes]
    if spread(centers) <= tolerance:
        return "center"
    return "left"


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


def line_style_key(line: dict) -> Optional[tuple]:
    spans = [span for span in line.get("spans", []) if (span.get("text") or "").strip()]
    if not spans:
        return None
    dominant = max(spans, key=lambda span: len(span.get("text", "")))
    style = span_style(dominant)
    font = _strip_subset(style["font"]).lower()
    return (font, style["bold"], style["italic"], round(style["fontSize"], 1), style["color"])


def group_block_lines(lines: list[dict]) -> list[list[dict]]:
    """Split one PDF text block into editable runs.

    MuPDF groups text by proximity, so a table row often arrives as several
    horizontally separated lines inside one block. Joining those with newlines
    would stack them vertically on export and destroy the layout. Lines that
    share a baseline become individual runs; vertically stacked, aligned lines
    with the same style stay together as a paragraph.
    """
    entries: list[tuple[fitz.Rect, dict, Optional[tuple]]] = []
    for line in lines:
        text = "".join(span.get("text", "") for span in line.get("spans", []))
        if not text.strip():
            continue
        box = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
        if box.is_empty:
            continue
        entries.append((box, line, line_style_key(line)))
    entries.sort(key=lambda item: (round(item[0].y0, 1), item[0].x0))

    groups: list[list[tuple[fitz.Rect, dict, Optional[tuple]]]] = []
    for box, line, style_key in entries:
        if not groups:
            groups.append([(box, line, style_key)])
            continue
        group = groups[-1]
        last_box = group[-1][0]
        same_style = group[0][2] == style_key
        row_tolerance = max(2.0, last_box.height * 0.5)
        same_row = abs(box.y0 - last_box.y0) <= row_tolerance
        gap = box.y0 - last_box.y1
        too_far = gap > max(last_box.height, box.height) * 2.5
        group_x0 = min(item[0].x0 for item in group)
        group_x1 = max(item[0].x1 for item in group)
        group_width = group_x1 - group_x0
        x_tolerance = max(3.0, group_width * 0.08)
        aligned = (
            abs(box.x0 - group_x0) <= x_tolerance
            or abs(box.x1 - group_x1) <= x_tolerance
            or abs((box.x0 + box.x1) - (group_x0 + group_x1)) / 2 <= x_tolerance
            or (box.x0 >= group_x0 - x_tolerance and box.x1 <= group_x1 + x_tolerance)
        )
        if same_style and not same_row and not too_far and gap > -row_tolerance and aligned:
            group.append((box, line, style_key))
        else:
            groups.append([(box, line, style_key)])
    return [[line for _box, line, _style in group] for group in groups]


def extract_blocks(page: "fitz.Page", page_index: int) -> list[dict]:
    """Return editable text blocks in *display* (rotated) coordinates."""
    rmat = page.rotation_matrix
    data = page.get_text("dict")
    blocks: list[dict] = []
    for block_index, block in enumerate(data.get("blocks", [])):
        if block.get("type") != 0:
            continue
        groups = group_block_lines(block.get("lines", []))
        for group_index, group in enumerate(groups):
            text_lines: list[str] = []
            spans: list[dict] = []
            union: Optional[fitz.Rect] = None
            for line in group:
                line_text = "".join(span.get("text", "") for span in line.get("spans", []))
                text_lines.append(line_text.rstrip())
                for span in line.get("spans", []):
                    if span.get("text", "").strip():
                        spans.append(span)
                box = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
                if union is None:
                    union = box
                else:
                    union.include_rect(box)
            text = "\n".join(text_lines).strip()
            if not text or union is None:
                continue
            dominant = max(spans, key=lambda s: len(s.get("text", ""))) if spans else {}
            style = span_style(dominant) if dominant else {
                "font": "Helvetica",
                "fontSize": 12,
                "bold": False,
                "italic": False,
                "color": "#000000",
            }
            rect = union * rmat
            style["align"] = infer_alignment(group, rect, rmat)
            block_id = f"p{page_index}-b{block_index}"
            if len(groups) > 1:
                block_id += f"-{group_index}"
            blocks.append(
                {
                    "id": block_id,
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
    # Capture the original fonts and line geometry before redaction destroys them.
    fonts = _page_fonts(page)
    try:
        text_data = page.get_text("dict")
    except Exception:
        text_data = None
    prepared: list[dict] = []
    for edit in valid:
        rect = to_unrotated(fitz.Rect(edit.bbox), page)
        if rect.is_empty or rect.is_infinite:
            continue
        rect.normalize()
        span_font, baseline, step, original_size = _original_text_metrics(page, rect, text_data)
        prepared.append(
            {
                "edit": edit,
                "rect": rect,
                "font": span_font or edit.font,
                "baseline": baseline,
                "step": step,
                "original_size": original_size,
            }
        )
    if not prepared:
        return
    for item in prepared:
        page.add_redact_annot(item["rect"], fill=False)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_NONE,
        graphics=fitz.PDF_REDACT_LINE_ART_NONE,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )
    registered: dict[str, str] = {}
    for item in prepared:
        edit = item["edit"]
        rect = item["rect"]
        text = edit.text or ""
        if not text.strip():
            continue
        fontsize = max(4.0, min(float(edit.fontSize or 12), 200.0))
        color = hex_to_rgb(edit.color)
        align = align_value(edit.align)
        step = item["step"]
        if step and item["original_size"]:
            step = step * (fontsize / item["original_size"])
        bold = bool(edit.bold)
        italic = bool(edit.italic)
        selection = _choose_font(fonts, item["font"], bold, italic)
        primary: Optional[tuple[str, "fitz.Font"]] = None
        if selection:
            registered_name = _register_font(page, selection, registered)
            if registered_name:
                primary = (registered_name, selection["font"])
        fontname = resolve_font(item["font"], bold, italic)
        if primary is None:
            try:
                primary = (fontname, fitz.Font(fontname))
            except Exception:
                primary = None
        if primary is None:
            insert_text_block(page, rect, text, fontsize, fontname, color, align)
            continue
        missing = "".join(char for char in text if not _font_supports_char(primary[1], char))
        fallbacks: list[tuple[str, "fitz.Font"]] = []
        if missing.strip():
            for fallback in _fallback_selections(missing, bold, italic):
                name = _register_font(page, fallback, registered)
                if name:
                    fallbacks.append((name, fallback["font"]))
        _draw_text_runs(
            page,
            rect,
            text,
            fontsize,
            primary,
            fallbacks,
            color,
            align,
            item["baseline"],
            step,
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
        metadata: dict[str, str] = {}
        for source in sources:
            try:
                source_meta = source.metadata or {}
            except Exception:
                source_meta = {}
            if source_meta:
                allowed = {
                    "title",
                    "author",
                    "subject",
                    "keywords",
                    "creator",
                    "producer",
                    "creationDate",
                    "modDate",
                    "trapped",
                }
                metadata = {k: v for k, v in source_meta.items() if k in allowed and v}
                break
        metadata.setdefault("title", safe_filename(payload.filename))
        metadata.setdefault("producer", "DocuEase")
        metadata.setdefault("creator", "DocuEase PDF Editor")
        out.set_metadata(metadata)
        buf = io.BytesIO()
        # clean=False keeps untouched content streams byte-for-byte identical to
        # the source; only the objects we actually changed are rewritten.
        out.save(buf, garbage=4, deflate=True, clean=False)
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
