# ====================================================================
# Deliverable 5: Railway Dockerfile with explicit ffmpeg installation
# yt-dlp strictly requires ffmpeg for audio extraction and postprocessing
# ====================================================================

FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# Install system dependencies: ffmpeg (required by yt-dlp), ca-certificates, and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Verify ffmpeg installation
RUN ffmpeg -version

WORKDIR /app

# Copy dependency definition and install python packages
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Expose dynamic Railway PORT
EXPOSE 8000

# Start FastAPI application using uvicorn binding to Railway's dynamic PORT
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
