# The brain trainer's image: `docker build -t lair-brain-trainer:1 brain-trainer/`
# Build needs the network once (pip); a training run uses --network none and a read-only root.
FROM python:3.12.7-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OMP_NUM_THREADS=1 \
    HOME=/tmp

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY train.py /app/train.py

USER 65534:65534
ENTRYPOINT ["python", "/app/train.py"]
