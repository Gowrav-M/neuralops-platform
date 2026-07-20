FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --retries 5 --timeout 60 -r /app/backend/requirements.txt

RUN groupadd --system --gid 10001 neuralops \
    && useradd --system --uid 10001 --gid neuralops --create-home --shell /usr/sbin/nologin neuralops \
    && mkdir -p /data /app/backend/data \
    && chown -R neuralops:neuralops /data /app/backend/data

COPY --chown=neuralops:neuralops backend /app/backend

USER neuralops

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/ready', timeout=2).read()"]

CMD ["sh", "-c", "exec python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000}"]
