# YouTube Source Ingestion System & AI Brain Worker

An automated, production-ready ingestion pipeline designed for Railway, Supabase, Cloudflare R2, yt-dlp, and OpenAI Whisper. It monitors YouTube playlists on an hourly cron schedule, deduplicates videos, extracts audio with ffmpeg, uploads files to R2, transcribes audio to timestamped JSON, and exposes clean transcripts to your AI Brain via `GET /api/transcripts`.

---

## Deliverables Summary

| Deliverable | File | Description |
|---|---|---|
| **1. Supabase SQL Schema** | [`schema.sql`](./schema.sql) | DDL for `playlists` and `videos` tables, triggers, indexes, and constraints. |
| **2. Python Backend** | [`main.py`](./main.py) | Full FastAPI app with yt-dlp, boto3 R2, OpenAI Whisper, and APScheduler. |
| **3. AI Brain Endpoint** | `GET /api/transcripts` | Returns strictly `READY` transcripts with timestamped segment JSON. |
| **4. Barebones Frontend** | [`static/index.html`](./static/index.html) & [`index.html`](./index.html) | Single-page HTML/JS with required UI inputs, toggles, and status table. |
| **5. Deployment Config** | [`Dockerfile`](./Dockerfile) & [`nixpacks.toml`](./nixpacks.toml) | Railway deployment configuration explicitly installing `ffmpeg`. |

---

## Architecture Pipeline

```
[ YouTube Playlist / Single Video ]
               │
               ▼
[ yt-dlp Flat Extraction ] ── Deduplication Check in Supabase (by source_id)
               │
               ▼ (if new)
[ yt-dlp Audio Download + ffmpeg MP3 ]
               │
               ▼
[ Cloudflare R2 Upload (boto3) ] ── Stores audio/source_id.mp3
               │
               ▼
[ OpenAI Whisper (verbose_json) ] ── Generates timestamped segment transcript
               │
               ▼
[ Supabase PostgreSQL ] ── Status set to READY, storage_url & transcript_json saved
               │
               ▼
[ GET /api/transcripts ] ── Consumed by AI Brain / Vector Index
```

---

## 1. Setup Supabase Database

1. Open your Supabase project dashboard -> **SQL Editor**.
2. Run the SQL script from [`schema.sql`](./schema.sql).
3. Copy your **Supabase URL** and **Service Role Key** (required to bypass RLS for worker ingestion).

---

## 2. Setup Cloudflare R2

1. In Cloudflare Dashboard -> **R2 Object Storage** -> Create bucket `youtube-audio`.
2. Generate an **R2 API Token** with Edit permissions.
3. Note your `Account ID`, `Access Key ID`, and `Secret Access Key`.

---

## 3. Environment Variables (.env)

Create a `.env` file (see [`.env.example`](./.env.example)):

```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..."
R2_ACCOUNT_ID="your_cloudflare_account_id"
R2_ACCESS_KEY_ID="your_r2_access_key_id"
R2_SECRET_ACCESS_KEY="your_r2_secret_access_key"
R2_BUCKET_NAME="youtube-audio"
R2_PUBLIC_DOMAIN="https://pub-xxxxxx.r2.dev"
OPENAI_API_KEY="sk-..."
PORT=8000
```

---

## 4. Run Locally

```bash
# 1. Install ffmpeg (required for audio extraction)
# Ubuntu/Debian: sudo apt-get install ffmpeg
# macOS: brew install ffmpeg

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Start FastAPI server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Visit `http://localhost:8000` to open the barebones control panel.

---

## 5. Deploy to Railway

### Method A: Using Dockerfile (Recommended)
1. Push this repo to GitHub.
2. Link repo to Railway.
3. Railway automatically detects `Dockerfile` and builds with `ffmpeg` installed.
4. Set the environment variables in Railway project settings.

### Method B: Using Nixpacks
Railway will read `nixpacks.toml` which automatically provisions `python311` and `ffmpeg`.

---

## 6. AI Brain Endpoint Specification

### `GET /api/transcripts`

Retrieves ingested transcripts strictly with `status == 'READY'`.

**Query Parameters:**
- `limit` (int, default: 50, max: 200)
- `offset` (int, default: 0)

**Sample Response:**
```json
{
  "status": "success",
  "count": 1,
  "transcripts": [
    {
      "id": "6b9e28f1-34bb-4e9b-9804-d531bb890c21",
      "source_id": "dQw4w9WgXcQ",
      "title": "Introduction to Autonomous Agents",
      "channel": "AI Lab",
      "duration_seconds": 213,
      "storage_url": "https://pub-xxx.r2.dev/audio/dQw4w9WgXcQ.mp3",
      "processed_at": "2026-10-01T18:30:00Z",
      "created_at": "2026-10-01T18:25:00Z",
      "transcript_json": {
        "text": "Full transcript content...",
        "segments": [
          {
            "id": 0,
            "start": 0.0,
            "end": 4.8,
            "text": "Welcome to this lecture on autonomous AI systems..."
          }
        ]
      }
    }
  ]
}
```
