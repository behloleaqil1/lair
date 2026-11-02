# The brain trainer's image. Build it once and name it by its content id in data/server.yaml:
#   docker build -q brain-trainer/          # prints sha256:<64 hex>: that is brain_trainer.image
# Build needs the network once (pip); a training run uses --network none and a read-only root.
# The base is pinned by digest (python:3.12.7-slim, multi-arch index) and every dependency by hash.
FROM python:3.12.7-slim@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OMP_NUM_THREADS=1 \
    HOME=/tmp

COPY requirements.txt /app/requirements.txt
RUN pip install --require-hashes --no-deps --only-binary=:all: -r /app/requirements.txt

COPY train.py /app/train.py

# Lair starts it with --user <its own non-root uid>:<gid>; this is only the default and is never root
USER 65534:65534
ENTRYPOINT ["python", "/app/train.py"]
