FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mcs
COPY worker/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY worker/audio_polish.py worker/handler.py worker/narration_adapter.py worker/pipeline_steps.py worker/runway_adapter.py worker/sitecustomize.py worker/storybook_pdf.py ./

CMD ["python", "-u", "handler.py"]
