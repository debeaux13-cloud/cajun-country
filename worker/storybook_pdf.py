"""Customer storybook: a book version of the exact finished MCS movie."""
from __future__ import annotations

from pathlib import Path
from PIL import Image
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


def _wrapped_lines(text: str, font: str, size: float, max_width: float) -> list[str]:
    words, lines, current = str(text or '').split(), [], ''
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and stringWidth(candidate, font, size) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def build_storybook_pdf(manifest: dict, image_paths: list[str], destination: str) -> str:
    """Build the PDF from the exact movie scene artwork and narration.

    Customer contract:
    - one book page per movie scene
    - exact rendered scene artwork, never the uploaded reference photo
    - exact narration for that same scene
    - no internal Scene 1/2/3 labels or planner headings
    """
    scenes = list(manifest.get('scenes') or [])
    if not scenes:
        raise ValueError('Storybook requires the finished movie scene manifest.')
    if len(image_paths) != len(scenes):
        raise ValueError(
            f'Storybook must match the movie exactly: {len(scenes)} scenes but {len(image_paths)} rendered images.'
        )
    if len(scenes) not in {18, 30}:
        raise ValueError(f'Storybook scene count must match a complete movie, not {len(scenes)} scenes.')

    title = str(manifest.get('title') or 'A Main Character Story').strip()
    subtitle = str(manifest.get('subtitle') or '').strip()
    width, height = landscape(letter)
    pdf = canvas.Canvas(destination, pagesize=(width, height))

    for scene, image_path in zip(scenes, image_paths):
        image_file = Path(image_path)
        if not image_file.exists() or image_file.stat().st_size < 1024:
            raise ValueError('Storybook is missing one of the movie scene artworks.')

        with Image.open(image_file) as image:
            frame = image.convert('RGB')
            frame.thumbnail((width - 44, height * 0.68), Image.Resampling.LANCZOS)
            iw, ih = frame.size
            pdf.drawImage(
                ImageReader(frame),
                (width - iw) / 2,
                height - ih - 22,
                iw,
                ih,
                preserveAspectRatio=True,
                mask='auto',
            )

        pdf.setFillColorRGB(.16, .08, .20)
        pdf.setFont('Helvetica-Bold', 12)
        pdf.drawString(36, 124, title)
        if subtitle:
            pdf.setFillColorRGB(.39, .33, .43)
            pdf.setFont('Helvetica', 9.5)
            pdf.drawRightString(width - 36, 124, subtitle[:95])

        narration = str(scene.get('narration') or '').strip()
        if not narration:
            raise ValueError('Every storybook page requires the narration from its matching movie scene.')
        pdf.setFillColorRGB(.08, .12, .22)
        pdf.setFont('Times-Roman', 15)
        y = 98
        for line in _wrapped_lines(narration, 'Times-Roman', 15, width - 72)[:5]:
            pdf.drawString(36, y, line)
            y -= 19
        pdf.showPage()

    pdf.save()
    return destination
