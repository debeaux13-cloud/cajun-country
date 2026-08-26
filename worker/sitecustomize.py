"""Runtime patches loaded automatically before the RunPod handler.

Music is intentionally not patched into ``build_movie`` here.  The handler must
first persist the preview's raw vibe-matched stem, then mix that exact stem into
both preview and paid movies.  An automatic hook would double-mix music and
break preview-to-paid continuity.
"""

try:
    import runway_adapter
    import pipeline_steps as _pipeline_steps

    _original_animate = runway_adapter.RunwayGen4Turbo.animate

    def _animate_with_motion_retry(self, source, destination, prompt, *, existing_task_id=None, on_task_created=None):
        result = _original_animate(
            self,
            source,
            destination,
            prompt,
            existing_task_id=existing_task_id,
            on_task_created=on_task_created,
        )
        try:
            _pipeline_steps.verify_obvious_clip_motion(destination)
            return result
        except Exception:
            stronger = (
                "STRONG PRINCIPAL CHARACTER MOTION REQUIRED. The main character must visibly travel across the frame and physically perform the narrated action from beginning to completion. "
                "Show clear limb, paw, head, torso, and body-position changes every few seconds; include weight shifts, blinking, breathing, expression changes, and direct interaction with the named prop or environment. "
                "Camera and scenery movement are secondary and may not substitute for body movement. No frozen pose, no hovering, no pan-only or zoom-only shot. "
                + str(prompt or "")
            )
            retry_result = _original_animate(
                self,
                source,
                destination,
                stronger,
                existing_task_id=None,
                on_task_created=on_task_created,
            )
            _pipeline_steps.verify_obvious_clip_motion(destination)
            return retry_result

    runway_adapter.RunwayGen4Turbo.animate = _animate_with_motion_retry
except Exception:
    pass

try:
    from pathlib import Path
    from PIL import Image
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.pdfgen import canvas
    import pipeline_steps as _pdf_steps

    def _wrapped_story_lines(text, font, size, max_width):
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

    def _mcs_build_pdf(manifest, image_paths, destination):
        scenes = list(manifest.get('scenes') or [])
        if len(scenes) not in {18, 30}:
            raise ValueError(f"Storybook must be built from the complete movie scene manifest, not {len(scenes)} scenes.")
        if len(image_paths) != len(scenes):
            raise ValueError(
                f"Storybook must match the movie exactly: {len(scenes)} scenes but {len(image_paths)} rendered scene images."
            )

        title = str(manifest.get('title') or 'A Main Character Story').strip()
        subtitle = str(manifest.get('subtitle') or '').strip()
        width, height = landscape(letter)
        pdf = canvas.Canvas(destination, pagesize=(width, height))

        for scene, image_path in zip(scenes, image_paths):
            image_file = Path(image_path)
            if not image_file.exists() or image_file.stat().st_size < 1024:
                raise ValueError('Storybook is missing artwork from one of the finished movie scenes.')
            with Image.open(image_file) as source:
                image = source.convert('RGB')
                image.thumbnail((width - 44, height * 0.68), Image.Resampling.LANCZOS)
                iw, ih = image.size
                pdf.drawImage(
                    ImageReader(image),
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
            for line in _wrapped_story_lines(narration, 'Times-Roman', 15, width - 72)[:5]:
                pdf.drawString(36, y, line)
                y -= 19
            pdf.showPage()

        pdf.save()
        return destination

    _pdf_steps.build_pdf = _mcs_build_pdf
except Exception:
    pass
