# Shared image for generator / simulator / pipeline / api (one Python project, different commands).
FROM python:3.11-slim
RUN pip install --no-cache-dir uv && apt-get update && apt-get install -y --no-install-recommends default-mysql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY shared shared
COPY generator generator
COPY simulator simulator
COPY pipeline pipeline
COPY ml ml
COPY api api
ENV PYTHONPATH=/app DATA_DIR=/data CONFIG_DIR=/config PATH=/app/.venv/bin:$PATH
