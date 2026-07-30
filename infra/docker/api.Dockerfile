FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/api/requirements.txt /app/services/api/requirements.txt
RUN pip install --no-cache-dir -r /app/services/api/requirements.txt
COPY services/api /app/services/api
COPY services/worker /app/services/worker
CMD ["uvicorn", "app.main:app", "--app-dir", "services/api", "--host", "0.0.0.0", "--port", "8000"]

