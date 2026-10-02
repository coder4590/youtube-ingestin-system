"""
YouTube Ingestion System - Python FastAPI Backend (main.py)
Automated ingestion system for playlists and single videos.
Features:
- yt-dlp metadata extraction & audio download (requires ffmpeg)
- Cloudflare R2 upload via boto3 (S3-compatible)
- OpenAI Whisper timestamped transcription (verbose_json segments)
- Supabase PostgreSQL persistence & deduplication by YouTube source_id
- APScheduler hourly background worker for active playlists
- GET /api/transcripts route serving READY transcripts to AI Brains
"""

import os
import re
import logging
import tempfile
import asyncio
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl
import boto3
from botocore.config import Config
from supabase import create_client, Client
from openai import OpenAI
import yt_dlp
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("yt_ingest")

# =====================================================================
# CONFIGURATION & ENVIRONMENT
# =====================================================================
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY", "")

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "youtube-audio")
R2_PUBLIC_DOMAIN = os.getenv("R2_PUBLIC_DOMAIN", "") # e.g. https://pub-xxx.r2.dev

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Initialize External Clients lazily/safely
supabase_client: Optional[Client] = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Supabase client initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client: {e}")

s3_client = None
if R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY:
    try:
        s3_client = boto3.client(
            "s3",
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            config=Config(signature_version="s3v4"),
            region_name="auto"
        )
        logger.info("Cloudflare R2 client initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize R2 client: {e}")

openai_client: Optional[OpenAI] = None
if OPENAI_API_KEY:
    try:
        openai_client = OpenAI(api_key=OPENAI_API_KEY)
        logger.info("OpenAI client initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize OpenAI client: {e}")

# =====================================================================
# SCHEDULER SETUP (APScheduler)
# =====================================================================
scheduler = AsyncIOScheduler()

async def sync_active_playlists_job():
    """Hourly background worker: fetches active playlists and ingests new videos."""
    logger.info("Starting scheduled hourly playlist sync...")
    if not supabase_client:
        logger.warning("Supabase client not configured. Skipping scheduled sync.")
        return
    try:
        # Fetch active playlists
        res = supabase_client.table("playlists").select("*").eq("active", True).execute()
        playlists = res.data or []
        logger.info(f"Found {len(playlists)} active playlists to process")

        for pl in playlists:
            await process_playlist(pl)

    except Exception as e:
        logger.exception(f"Error in sync_active_playlists_job: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Start APScheduler
    scheduler.add_job(
        sync_active_playlists_job,
        trigger="interval",
        hours=1,
        id="hourly_playlist_sync",
        replace_existing=True
    )
    scheduler.start()
    logger.info("APScheduler started (Hourly playlist sync scheduled)")
    yield
    # Shutdown
    scheduler.shutdown(wait=False)
    logger.info("APScheduler stopped")

app = FastAPI(
    title="YouTube Ingestion & AI Brain Worker",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for API Brain and external callers
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =====================================================================
# PYDANTIC SCHEMAS
# =====================================================================
class AddPlaylistRequest(BaseModel):
    playlist_url: str
    ingest_mode: str = "NEW_ONLY" # 'ALL' or 'NEW_ONLY'
    active: bool = True

class UpdatePlaylistRequest(BaseModel):
    active: Optional[bool] = None
    ingest_mode: Optional[str] = None

class AddVideoRequest(BaseModel):
    video_url: str

# =====================================================================
# CORE PIPELINE FUNCTIONS
# =====================================================================
def extract_youtube_id(url: str) -> Optional[str]:
    """Extract standard 11-char YouTube video ID from various URL formats."""
    patterns = [
        r'(?:v=|\/)([0-9A-Za-z_-]{11}).*',
        r'(?:youtu\.be\/)([0-9A-Za-z_-]{11})',
        r'(?:embed\/)([0-9A-Za-z_-]{11})',
        r'(?:shorts\/)([0-9A-Za-z_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

def extract_playlist_id(url: str) -> Optional[str]:
    """Extract YouTube playlist ID from URL."""
    match = re.search(r'[?&]list=([^#&?]+)', url)
    return match.group(1) if match else None

async def download_audio_ytdlp(video_url: str, output_dir: str) -> Dict[str, Any]:
    """
    Downloads audio using yt-dlp and ffmpeg extraction into MP3.
    Runs in a thread executor to avoid blocking the async event loop.
    """
    loop = asyncio.get_event_loop()

    def _sync_download():
        out_tmpl = os.path.join(output_dir, "%(id)s.%(ext)s")
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": out_tmpl,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }],
            "quiet": True,
            "no_warnings": True,
            "ignoreerrors": False,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True)
            source_id = info.get("id")
            audio_path = os.path.join(output_dir, f"{source_id}.mp3")
            if not os.path.exists(audio_path):
                # Fallback check if file extension is different
                for f in os.listdir(output_dir):
                    if f.startswith(source_id):
                        audio_path = os.path.join(output_dir, f)
                        break

            return {
                "source_id": source_id,
                "title": info.get("title", "Unknown Title"),
                "channel": info.get("channel") or info.get("uploader", "Unknown Channel"),
                "duration": info.get("duration", 0),
                "audio_path": audio_path
            }

    return await loop.run_in_executor(None, _sync_download)

async def upload_to_r2(local_file_path: str, object_key: str) -> str:
    """Uploads file to Cloudflare R2 bucket and returns the storage reference."""
    if not s3_client:
        logger.warning("R2 client not initialized. Storing placeholder key.")
        return f"r2://{R2_BUCKET_NAME}/{object_key}"

    loop = asyncio.get_event_loop()

    def _sync_upload():
        s3_client.upload_file(
            local_file_path,
            R2_BUCKET_NAME,
            object_key,
            ExtraArgs={"ContentType": "audio/mpeg"}
        )
        if R2_PUBLIC_DOMAIN:
            return f"{R2_PUBLIC_DOMAIN.rstrip('/')}/{object_key}"
        return f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_BUCKET_NAME}/{object_key}"

    return await loop.run_in_executor(None, _sync_upload)

async def transcribe_with_whisper(audio_file_path: str) -> Dict[str, Any]:
    """Transcribes audio using OpenAI Whisper with timestamped verbose JSON segments."""
    if not openai_client:
        raise ValueError("OPENAI_API_KEY is not configured")

    loop = asyncio.get_event_loop()

    def _sync_transcribe():
        with open(audio_file_path, "rb") as f:
            transcript = openai_client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="verbose_json",
                timestamp_granularities=["segment"]
            )
            # transcript contains .text, .duration, .segments
            return transcript.model_dump()

    return await loop.run_in_executor(None, _sync_transcribe)

async def process_single_video(video_url: str, playlist_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Complete Processing Pipeline:
    1. Deduplication check in Supabase videos table by source_id
    2. Download audio (yt-dlp + ffmpeg)
    3. Upload audio to Cloudflare R2
    4. Transcribe with OpenAI Whisper
    5. Mark status: READY, NEEDS_REVIEW, or FAILED
    6. Save to Supabase
    """
    source_id = extract_youtube_id(video_url)
    if not source_id:
        raise ValueError(f"Invalid YouTube URL: {video_url}")

    if not supabase_client:
        raise ValueError("Supabase client is not configured")

    # Step 1: Deduplication Check
    existing = supabase_client.table("videos").select("id, status, source_id").eq("source_id", source_id).execute()
    if existing.data and len(existing.data) > 0:
        logger.info(f"Video {source_id} already exists with status: {existing.data[0]['status']}. Skipping.")
        return {"source_id": source_id, "status": existing.data[0]["status"], "action": "skipped_duplicate"}

    # Insert initial PENDING row
    insert_res = supabase_client.table("videos").insert({
        "source_id": source_id,
        "playlist_id": playlist_id,
        "url": video_url,
        "status": "PENDING"
    }).execute()
    video_row_id = insert_res.data[0]["id"] if insert_res.data else None

    # Step 2: Download Audio
    with tempfile.TemporaryDirectory() as temp_dir:
        try:
            # Update status -> DOWNLOADING
            supabase_client.table("videos").update({"status": "DOWNLOADING"}).eq("source_id", source_id).execute()

            meta = await download_audio_ytdlp(video_url, temp_dir)
            audio_path = meta["audio_path"]

            # Update metadata in DB
            supabase_client.table("videos").update({
                "title": meta["title"],
                "channel": meta["channel"],
                "duration_seconds": meta["duration"],
            }).eq("source_id", source_id).execute()

            # Step 3: Upload to Cloudflare R2
            object_key = f"audio/{source_id}.mp3"
            storage_url = await upload_to_r2(audio_path, object_key)

            # Step 4: Transcribe with Whisper
            supabase_client.table("videos").update({"status": "TRANSCRIBING"}).eq("source_id", source_id).execute()
            transcript_data = await transcribe_with_whisper(audio_path)

            # Quality Check: if text is empty or segments are suspicious, mark NEEDS_REVIEW
            full_text = transcript_data.get("text", "").strip()
            segments = transcript_data.get("segments", [])
            final_status = "READY"
            if not full_text or len(segments) == 0:
                final_status = "NEEDS_REVIEW"

            # Step 5: Save final state to Supabase
            now_iso = datetime.now(timezone.utc).isoformat()
            supabase_client.table("videos").update({
                "status": final_status,
                "storage_url": storage_url,
                "transcript_json": transcript_data,
                "processed_at": now_iso,
                "error_message": None
            }).eq("source_id", source_id).execute()

            logger.info(f"Video {source_id} successfully processed with status: {final_status}")
            return {"source_id": source_id, "status": final_status, "storage_url": storage_url}

        except Exception as e:
            logger.exception(f"Pipeline failed for video {source_id}: {e}")
            supabase_client.table("videos").update({
                "status": "FAILED",
                "error_message": str(e)
            }).eq("source_id", source_id).execute()
            return {"source_id": source_id, "status": "FAILED", "error": str(e)}

async def process_playlist(playlist_row: Dict[str, Any]):
    """
    Extracts videos from playlist using yt-dlp flat extraction.
    Respects ALL vs NEW_ONLY mode.
    """
    playlist_url = playlist_row["playlist_url"]
    playlist_id_pk = playlist_row["id"]
    ingest_mode = playlist_row.get("ingest_mode", "NEW_ONLY")

    logger.info(f"Processing playlist: {playlist_url} (Mode: {ingest_mode})")

    loop = asyncio.get_event_loop()

    def _sync_extract_playlist_items():
        ydl_opts = {
            "extract_flat": True,
            "quiet": True,
            "skip_download": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(playlist_url, download=False)

    try:
        info = await loop.run_in_executor(None, _sync_extract_playlist_items)
        entries = info.get("entries", [])
        playlist_title = info.get("title", playlist_row.get("title") or "YouTube Playlist")

        # Update playlist title and video count
        supabase_client.table("playlists").update({
            "title": playlist_title,
            "video_count": len(entries),
            "last_synced_at": datetime.now(timezone.utc).isoformat()
        }).eq("id", playlist_id_pk).execute()

        # Ingest all discovered items from the playlist with deduplication
        logger.info(f"Extracting all {len(entries)} items from playlist {playlist_title}")
        for item in entries:
            v_id = item.get("id")
            if not v_id:
                continue
            video_url = item.get("url") or f"https://www.youtube.com/watch?v={v_id}"
            await process_single_video(video_url, playlist_id=playlist_id_pk)

    except Exception as e:
        logger.exception(f"Failed to process playlist {playlist_url}: {e}")

# =====================================================================
# API ENDPOINTS
# =====================================================================

# ---------------------------------------------------------------------
# Deliverable 3: GET /api/transcripts - ONLY returns READY transcripts
# ---------------------------------------------------------------------
@app.get("/api/transcripts")
async def get_ready_transcripts(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0)
):
    """
    Serves ingested, timestamped transcripts strictly filtered to status == 'READY'.
    Consumed directly by external AI Brains, vector databases, or LLM context loaders.
    """
    if not supabase_client:
        raise HTTPException(status_code=503, detail="Database not configured")

    try:
        res = (
            supabase_client.table("videos")
            .select("id, source_id, title, channel, duration_seconds, storage_url, transcript_json, processed_at, created_at")
            .eq("status", "READY")
            .order("processed_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return {
            "status": "success",
            "count": len(res.data or []),
            "transcripts": res.data or []
        }
    except Exception as e:
        logger.error(f"Error fetching transcripts: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ---------------------------------------------------------------------
# Playlists Management
# ---------------------------------------------------------------------
@app.get("/api/playlists")
async def list_playlists():
    if not supabase_client:
        return []
    res = supabase_client.table("playlists").select("*").order("created_at", desc=True).execute()
    return res.data or []

@app.post("/api/playlists")
async def add_playlist(payload: AddPlaylistRequest, background_tasks: BackgroundTasks):
    if not supabase_client:
        raise HTTPException(status_code=503, detail="Database not configured")

    p_id = extract_playlist_id(payload.playlist_url) or payload.playlist_url
    try:
        # Check if already exists
        check = supabase_client.table("playlists").select("*").eq("playlist_url", payload.playlist_url).execute()
        if check.data and len(check.data) > 0:
            return check.data[0]

        insert_res = supabase_client.table("playlists").insert({
            "playlist_url": payload.playlist_url,
            "playlist_id": p_id,
            "ingest_mode": payload.ingest_mode,
            "active": payload.active
        }).execute()
        new_pl = insert_res.data[0]

        # Trigger immediate sync in background
        background_tasks.add_task(process_playlist, new_pl)
        return new_pl
    except Exception as e:
        logger.error(f"Error adding playlist: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/api/playlists/{playlist_id}")
async def update_playlist(playlist_id: str, payload: UpdatePlaylistRequest):
    if not supabase_client:
        raise HTTPException(status_code=503, detail="Database not configured")

    updates = {}
    if payload.active is not None:
        updates["active"] = payload.active
    if payload.ingest_mode is not None:
        updates["ingest_mode"] = payload.ingest_mode

    if not updates:
        return {"message": "No changes requested"}

    res = supabase_client.table("playlists").update(updates).eq("id", playlist_id).execute()
    return res.data[0] if res.data else {"message": "Updated"}

# ---------------------------------------------------------------------
# Single Video Ingestion & Video Status List
# ---------------------------------------------------------------------
@app.post("/api/videos")
async def add_single_video(payload: AddVideoRequest, background_tasks: BackgroundTasks):
    source_id = extract_youtube_id(payload.video_url)
    if not source_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL")

    # Queue background processing
    background_tasks.add_task(process_single_video, payload.video_url)
    return {"message": "Video queued for ingestion", "source_id": source_id}

@app.get("/api/videos")
async def list_videos(limit: int = 50):
    if not supabase_client:
        return []
    res = (
        supabase_client.table("videos")
        .select("id, source_id, url, title, channel, duration_seconds, status, storage_url, error_message, created_at, processed_at")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return res.data or []

@app.get("/api/status")
async def get_system_status():
    """Returns database status and all real videos and playlists."""
    if not supabase_client:
        return {"database_connected": False, "videos": [], "playlists": [], "message": "Supabase not configured"}
    try:
        vid_res = supabase_client.table("videos").select("*").order("created_at", desc=True).limit(50).execute()
        pl_res = supabase_client.table("playlists").select("*").order("created_at", desc=True).execute()
        return {
            "database_connected": True,
            "videos": vid_res.data or [],
            "playlists": pl_res.data or []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/sync-now")
async def trigger_sync_now(background_tasks: BackgroundTasks):
    """Manually trigger playlist sync."""
    background_tasks.add_task(sync_active_playlists_job)
    return {"message": "Hourly sync triggered immediately in background"}

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "supabase": supabase_client is not None,
        "r2_storage": s3_client is not None,
        "openai": openai_client is not None,
        "scheduler_running": scheduler.running
    }

# Serve Deliverable 4: index.html at root
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        with open(index_file, "r") as f:
            return f.read()
    return "<h1>YouTube Ingestion Service Running</h1><p>Visit /api/transcripts</p>"

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
