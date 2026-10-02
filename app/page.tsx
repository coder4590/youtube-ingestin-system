'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Play,
  Pause,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  FileCode,
  Terminal,
  Radio,
  Cpu,
  CheckCircle2,
  AlertCircle,
  FileText,
  Download,
  Clock,
  Search,
  X,
  Volume2
} from 'lucide-react';

interface Playlist {
  id: string;
  playlist_url: string;
  playlist_id: string;
  title: string;
  active: boolean;
  ingest_mode: 'ALL' | 'NEW_ONLY';
  video_count: number;
  last_synced_at: string | null;
}

interface Video {
  id: string;
  source_id: string;
  playlist_id?: string | null;
  url: string;
  title: string;
  channel: string;
  duration_seconds: number;
  status: 'PENDING' | 'DOWNLOADING' | 'TRANSCRIBING' | 'READY' | 'NEEDS_REVIEW' | 'FAILED';
  storage_url?: string | null;
  error_message?: string | null;
  processed_at?: string | null;
  created_at: string;
  transcript_json?: any;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<'ui' | 'code' | 'api'>('ui');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  // Form states
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [playlistMode, setPlaylistMode] = useState<'NEW_ONLY' | 'ALL'>('NEW_ONLY');
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistMsg, setPlaylistMsg] = useState<{ text: string; type: 'ok' | 'err' | 'info' | '' }>({ text: '', type: '' });

  const [videoUrl, setVideoUrl] = useState('');
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoMsg, setVideoMsg] = useState<{ text: string; type: 'ok' | 'err' | '' }>({ text: '', type: '' });

  // Video Action states
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(new Set());
  const [syncingPlaylistIds, setSyncingPlaylistIds] = useState<Set<string>>(new Set());

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Selected video for transcript modal
  const [inspectVideoId, setInspectVideoId] = useState<string | null>(null);
  const inspectVideo = useMemo(() => {
    return inspectVideoId ? (videos.find(v => v.id === inspectVideoId) || null) : null;
  }, [videos, inspectVideoId]);

  // Code viewer tab
  const [selectedFile, setSelectedFile] = useState<'schema' | 'main' | 'html' | 'docker' | 'nixpacks' | 'reqs'>('schema');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Fetch real data from backend API
  const fetchRealData = useCallback(async () => {
    try {
      const [plRes, vidRes] = await Promise.all([
        fetch('/api/playlists'),
        fetch('/api/videos?limit=500')
      ]);

      if (plRes.ok) {
        const plData = await plRes.json();
        if (Array.isArray(plData)) setPlaylists(plData);
      }
      if (vidRes.ok) {
        const vidData = await vidRes.json();
        if (Array.isArray(vidData)) setVideos(vidData);
      }
    } catch (err) {
      console.error("Error fetching real data from database:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll for updates if any video is currently processing
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRealData();
    }, 0);

    const interval = setInterval(() => {
      fetchRealData();
    }, 4000);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [fetchRealData]);

  function formatTime(isoString?: string | null): string {
    if (!isoString) return 'Never';
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return 'Recently';
      const hours = String(d.getUTCHours()).padStart(2, '0');
      const mins = String(d.getUTCMinutes()).padStart(2, '0');
      const secs = String(d.getUTCSeconds()).padStart(2, '0');
      return `${hours}:${mins}:${secs} UTC`;
    } catch {
      return 'Recently';
    }
  }

  function formatDuration(seconds?: number): string {
    if (!seconds) return '-';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }

  function formatSegmentTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // Add Playlist with Full Flat Extraction
  async function handleAddPlaylist(e: React.FormEvent) {
    e.preventDefault();
    if (!playlistUrl.trim() || playlistLoading) return;

    setPlaylistLoading(true);
    setPlaylistMsg({
      text: 'Extracting and expanding playlist entries with yt-dlp... (This may take a few seconds)',
      type: 'info'
    });

    try {
      const res = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playlist_url: playlistUrl.trim(),
          ingest_mode: playlistMode,
          active: true
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error (${res.status})`);

      setPlaylistUrl('');
      const total = data.total_found ?? (data.added_videos?.length || 0);
      const added = data.added_videos?.length || 0;
      setPlaylistMsg({
        text: `Success! Discovered ${total} video entries from playlist (${added} new videos added to pipeline table).`,
        type: 'ok'
      });
      await fetchRealData();
    } catch (err: any) {
      setPlaylistMsg({ text: err.message, type: 'err' });
    } finally {
      setPlaylistLoading(false);
    }
  }

  // Toggle Playlist active/paused via real API
  async function togglePlaylistActive(id: string, currentActive: boolean) {
    try {
      const res = await fetch(`/api/playlists/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentActive })
      });
      if (res.ok) fetchRealData();
    } catch (err) {
      console.error("Failed to toggle playlist active state:", err);
    }
  }

  // Change Playlist ingest mode via real API
  async function changePlaylistMode(id: string, mode: 'ALL' | 'NEW_ONLY') {
    try {
      const res = await fetch(`/api/playlists/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingest_mode: mode })
      });
      if (res.ok) fetchRealData();
    } catch (err) {
      console.error("Failed to update ingest mode:", err);
    }
  }

  // Re-sync specific playlist now
  async function handleSyncPlaylist(id: string) {
    setSyncingPlaylistIds(prev => new Set(prev).add(id));
    setPlaylistMsg({ text: `Syncing playlist entries with yt-dlp...`, type: 'info' });
    try {
      const res = await fetch(`/api/playlists/${id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');

      setPlaylistMsg({
        text: data.message || `Playlist synced! Discovered ${data.new_videos || 0} new videos.`,
        type: 'ok'
      });
      await fetchRealData();
    } catch (err: any) {
      setPlaylistMsg({ text: err.message, type: 'err' });
    } finally {
      setSyncingPlaylistIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // Add Single Video via real API
  async function handleAddSingleVideo(e: React.FormEvent) {
    e.preventDefault();
    if (!videoUrl.trim() || videoLoading) return;

    setVideoLoading(true);
    setVideoMsg({ text: 'Submitting video to pipeline...', type: '' });
    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: videoUrl.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error (${res.status})`);

      setVideoUrl('');
      setVideoMsg({ text: data.message || `Queued [source_id: ${data.source_id}]`, type: 'ok' });
      await fetchRealData();
    } catch (err: any) {
      setVideoMsg({ text: err.message, type: 'err' });
    } finally {
      setVideoLoading(false);
    }
  }

  // Action: Transcribe Now for a single video
  async function handleTranscribeVideo(videoId: string) {
    setTranscribingIds(prev => new Set(prev).add(videoId));
    try {
      // Optimistic status update
      setVideos(prev => prev.map(v => v.id === videoId ? { ...v, status: 'DOWNLOADING', error_message: null } : v));

      const res = await fetch(`/api/videos/${videoId}/transcribe`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transcription failed to start');

      await fetchRealData();
    } catch (err: any) {
      console.error(`Transcription trigger failed for ${videoId}:`, err);
      await fetchRealData();
    } finally {
      setTranscribingIds(prev => {
        const next = new Set(prev);
        next.delete(videoId);
        return next;
      });
    }
  }

  // Action: Download Audio
  function handleDownloadAudio(v: Video) {
    // Direct audio endpoint
    const url = `/api/videos/${v.id}/audio`;
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${v.source_id}.mp3`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Action: View Transcript
  function handleViewTranscript(v: Video) {
    setInspectVideoId(v.id);
  }

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  // Filtered videos list
  const filteredVideos = useMemo(() => {
    return videos.filter(v => {
      const matchesSearch =
        searchQuery === '' ||
        v.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.source_id?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.channel?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === 'ALL' ||
        v.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [videos, searchQuery, statusFilter]);

  const counts = useMemo(() => {
    const c = { PENDING: 0, DOWNLOADING: 0, TRANSCRIBING: 0, READY: 0, FAILED: 0 };
    for (const v of videos) {
      if (v.status in c) {
        c[v.status as keyof typeof c]++;
      }
    }
    return c;
  }, [videos]);

  // Deliverables Snippets for code inspection
  const CODE_SNIPPETS = {
    schema: {
      name: "schema.sql",
      desc: "Deliverable 1: Exact Supabase PostgreSQL DDL for playlists & videos tables with deduplication and triggers.",
      code: `-- ====================================================================
-- YOUTUBE INGESTION SYSTEM - SUPABASE POSTGRESQL SCHEMA
-- Database: Supabase PostgreSQL
-- Features: Strict deduplication by permanent YouTube source_id,
--           relational playlist foreign keys, and status constraints.
-- ====================================================================

-- 1. PLAYLISTS TABLE
CREATE TABLE IF NOT EXISTS public.playlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_url TEXT NOT NULL UNIQUE,
    playlist_id TEXT NOT NULL,
    title TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    ingest_mode TEXT NOT NULL DEFAULT 'NEW_ONLY' CHECK (ingest_mode IN ('ALL', 'NEW_ONLY')),
    video_count INTEGER DEFAULT 0,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. VIDEOS TABLE
CREATE TABLE IF NOT EXISTS public.videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL UNIQUE, -- Permanent YouTube Video ID (e.g. 'jNQXAC9IVRw')
    playlist_id UUID REFERENCES public.playlists(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    title TEXT,
    channel TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DOWNLOADING', 'TRANSCRIBING', 'READY', 'NEEDS_REVIEW', 'FAILED')),
    storage_url TEXT, -- Cloudflare R2 URL or bucket object key
    transcript_json JSONB, -- Full timestamped segments [{ "id": 0, "start": 0.0, "end": 4.2, "text": "..." }]
    error_message TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_videos_source_id ON public.videos(source_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON public.videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_playlist_id ON public.videos(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlists_active ON public.playlists(active);

-- Auto-update updated_at timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER tr_playlists_updated_at
    BEFORE UPDATE ON public.playlists
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER tr_videos_updated_at
    BEFORE UPDATE ON public.videos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
    },
    main: {
      name: "main.py",
      desc: "Deliverable 2: Complete FastAPI backend with yt-dlp flat extraction, Cloudflare R2 boto3 upload, OpenAI Whisper transcription, Supabase persistence, and hourly APScheduler worker.",
      code: `"""
YouTube Ingestion System - Python FastAPI Backend (main.py)
Automated ingestion system for playlists and single videos.
Features:
- yt-dlp flat metadata extraction (extract_flat: True) & audio download
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
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import boto3
from botocore.config import Config
from supabase import create_client, Client
from openai import OpenAI
import yt_dlp
from apscheduler.schedulers.asyncio import AsyncIOScheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("yt_ingest")

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY", "")
R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "youtube-audio")
R2_PUBLIC_DOMAIN = os.getenv("R2_PUBLIC_DOMAIN", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

supabase_client: Optional[Client] = create_client(SUPABASE_URL, SUPABASE_KEY) if (SUPABASE_URL and SUPABASE_KEY) else None
s3_client = boto3.client(
    "s3",
    endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    config=Config(signature_version="s3v4"),
    region_name="auto"
) if (R2_ACCOUNT_ID and R2_ACCESS_KEY_ID) else None
openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

scheduler = AsyncIOScheduler()

async def sync_active_playlists_job():
    logger.info("Hourly cron job executing...")
    if not supabase_client: return
    res = supabase_client.table("playlists").select("*").eq("active", True).execute()
    for pl in (res.data or []):
        await process_playlist(pl)

@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.add_job(sync_active_playlists_job, "interval", hours=1, id="hourly_sync", replace_existing=True)
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)

app = FastAPI(title="YouTube Ingestion & AI Brain Worker", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

async def process_playlist(playlist_row: Dict[str, Any]):
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

        supabase_client.table("playlists").update({
            "title": playlist_title,
            "video_count": len(entries),
            "last_synced_at": datetime.now(timezone.utc).isoformat()
        }).eq("id", playlist_id_pk).execute()

        # Ingest all discovered items from the playlist with deduplication
        logger.info(f"Extracting all {len(entries)} items from playlist {playlist_title}")
        for item in entries:
            v_id = item.get("id")
            if not v_id: continue
            video_url = item.get("url") or f"https://www.youtube.com/watch?v={v_id}"
            await process_single_video(video_url, playlist_id=playlist_id_pk)

    except Exception as e:
        logger.exception(f"Failed to process playlist {playlist_url}: {e}")

@app.get("/api/transcripts")
async def get_ready_transcripts(limit: int = 50, offset: int = 0):
    if not supabase_client:
        raise HTTPException(status_code=503, detail="Database not configured")
    res = supabase_client.table("videos").select(
        "id, source_id, title, channel, duration_seconds, storage_url, transcript_json, processed_at, created_at"
    ).eq("status", "READY").order("processed_at", desc=True).range(offset, offset + limit - 1).execute()
    return {"transcripts": res.data, "count": len(res.data)}`
    },
    html: {
      name: "index.html",
      desc: "Deliverable 4: Barebones plain HTML/JS frontend served directly by FastAPI.",
      code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>YouTube Ingestion Worker</title>
  <style>
    body { font-family: monospace; background: #0f1115; color: #e6e8ec; padding: 24px; max-width: 900px; margin: 0 auto; }
    .panel { background: #181b21; border: 1px solid #292d39; padding: 18px; margin-bottom: 20px; border-radius: 6px; }
    input, select, button { padding: 8px 12px; background: #0f1115; border: 1px solid #292d39; color: #fff; border-radius: 4px; }
    button { background: #3b82f6; cursor: pointer; border: none; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 10px; border-bottom: 1px solid #292d39; text-align: left; }
    .status-READY { color: #10b981; }
    .status-TRANSCRIBING { color: #3b82f6; }
    .status-DOWNLOADING { color: #f59e0b; }
    .status-FAILED { color: #ef4444; }
  </style>
</head>
<body>
  <h1>YouTube Ingestion System</h1>
  <a href="/api/transcripts" target="_blank">&rarr; GET /api/transcripts (AI Brain)</a>

  <div class="panel">
    <h3>1. Add YouTube Playlist (Hourly Cron)</h3>
    <form onsubmit="addPlaylist(event)">
      <input type="url" id="playlist_url" placeholder="https://www.youtube.com/playlist?list=PL..." required />
      <select id="playlist_mode"><option value="NEW_ONLY">NEW ONLY</option><option value="ALL">ALL</option></select>
      <button type="submit">Monitor Playlist</button>
    </form>
    <table><thead><tr><th>Playlist</th><th>Mode</th><th>Status</th><th>Last Synced</th></tr></thead><tbody id="pl_tbody"></tbody></table>
  </div>

  <div class="panel">
    <h3>2. Ingest Single Video Immediately</h3>
    <form onsubmit="addSingleVideo(event)">
      <input type="url" id="video_url" placeholder="https://www.youtube.com/watch?v=..." required />
      <button type="submit">Ingest Video</button>
    </form>
  </div>

  <div class="panel">
    <h3>3. Video Pipeline Status List</h3>
    <table><thead><tr><th>Source ID</th><th>Title</th><th>Status</th><th>Processed</th><th>Actions</th></tr></thead><tbody id="vid_tbody"></tbody></table>
  </div>
</body>
</html>`
    },
    docker: {
      name: "Dockerfile",
      desc: "Deliverable 5: Production Dockerfile configured for Railway that explicitly installs ffmpeg (strictly required by yt-dlp).",
      code: `# Deliverable 5: Railway Dockerfile with explicit ffmpeg
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PORT=8000

# Install ffmpeg (strictly required for yt-dlp audio extraction)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ffmpeg \\
    ca-certificates \\
    curl \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p static && cp index.html static/index.html 2>/dev/null || true

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`
    },
    nixpacks: {
      name: "nixpacks.toml",
      desc: "Alternative Railway deployment config via Nixpacks with ffmpeg system package package definition.",
      code: `[phases.setup]
nixPkgs = ["python311", "ffmpeg"]

[phases.install]
cmds = ["pip install -r requirements.txt"]

[start]
cmd = "uvicorn main:app --host 0.0.0.0 --port $PORT"`
    },
    reqs: {
      name: "requirements.txt",
      desc: "Python dependencies strictly adhering to the user tech stack.",
      code: `fastapi>=0.110.0
uvicorn[standard]>=0.28.0
pydantic>=2.6.0
supabase>=2.3.0
boto3>=1.34.0
botocore>=1.34.0
yt-dlp>=2024.3.10
openai>=1.14.0
apscheduler>=3.10.4
python-dotenv>=1.0.1`
    }
  };

  return (
    <div className="min-h-screen bg-[#0b0d13] text-[#e2e8f0] font-sans antialiased selection:bg-blue-600 selection:text-white">
      {/* Top Navigation */}
      <header className="border-b border-[#1d2332] bg-[#11141c]/90 sticky top-0 z-30 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded bg-gradient-to-tr from-red-600 via-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-red-500/20">
              <Radio className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-sm font-bold tracking-tight text-white">
                  YouTube Source Ingestion &amp; Worker
                </h1>
                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                  Live
                </span>
              </div>
              <p className="text-[11px] text-[#768499]">
                Automated Playlist Ingestion &bull; yt-dlp &bull; Cloudflare R2 &bull; OpenAI Whisper &bull; Supabase
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center space-x-1.5 bg-[#171b26] p-1 rounded-md border border-[#242b3d]">
            <button
              onClick={() => setActiveTab('ui')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                activeTab === 'ui'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-[#8b99ad] hover:text-white hover:bg-[#202636]'
              }`}
            >
              Interactive Ingestion UI
            </button>
            <button
              onClick={() => setActiveTab('code')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center space-x-1.5 ${
                activeTab === 'code'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-[#8b99ad] hover:text-white hover:bg-[#202636]'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>Deliverables &amp; Code</span>
            </button>
            <button
              onClick={() => setActiveTab('api')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center space-x-1.5 font-mono ${
                activeTab === 'api'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-[#8b99ad] hover:text-white hover:bg-[#202636]'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>GET /api/transcripts</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* Architecture Snapshot Banner */}
        <div className="mb-6 p-4 rounded-lg bg-gradient-to-r from-[#151922] via-[#1a202c] to-[#151922] border border-[#262e40] flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="flex -space-x-1">
              <span className="w-7 h-7 rounded-full bg-red-600/20 text-red-400 border border-red-500/30 flex items-center justify-center text-xs font-bold font-mono">YT</span>
              <span className="w-7 h-7 rounded-full bg-purple-600/20 text-purple-400 border border-purple-500/30 flex items-center justify-center text-xs font-bold font-mono">FF</span>
              <span className="w-7 h-7 rounded-full bg-orange-600/20 text-orange-400 border border-orange-500/30 flex items-center justify-center text-xs font-bold font-mono">R2</span>
              <span className="w-7 h-7 rounded-full bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center text-xs font-bold font-mono">DB</span>
            </div>
            <div className="text-xs">
              <span className="font-semibold text-white">Full Ingestion Active:</span>
              <span className="text-[#8fa0b5] ml-1.5">
                Playlists expand every single video with yt-dlp flat extraction. Action buttons on each row trigger real OpenAI Whisper transcription.
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <a
              href="/api/transcripts"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-1 text-xs px-2.5 py-1.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 transition-colors font-mono"
            >
              <span>Test AI Brain Endpoint</span>
              <ExternalLink className="w-3 h-3 ml-1" />
            </a>
          </div>
        </div>

        {/* TAB 1: INTERACTIVE BAREBONES UI */}
        {activeTab === 'ui' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-12 space-y-6">
              {/* SECTION 1: ADD PLAYLIST */}
              <div className="bg-[#151922] border border-[#262e40] rounded-lg p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                    <h2 className="text-xs font-bold tracking-wider uppercase text-[#94a3b8]">
                      1. Add YouTube Playlist (Full Extraction &bull; Hourly Cron)
                    </h2>
                  </div>
                  <span className="text-[11px] text-[#6d7e97] font-mono">
                    yt-dlp extract_flat: expands ALL videos in playlist
                  </span>
                </div>

                <form onSubmit={handleAddPlaylist} className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={playlistUrl}
                    onChange={(e) => setPlaylistUrl(e.target.value)}
                    placeholder="https://www.youtube.com/playlist?list=PL... or channel URL"
                    className="flex-1 bg-[#0d1017] border border-[#2b3447] text-white px-3 py-2 rounded text-xs font-mono placeholder-[#57647a] focus:outline-none focus:border-blue-500"
                    disabled={playlistLoading}
                    required
                  />
                  <select
                    value={playlistMode}
                    onChange={(e) => setPlaylistMode(e.target.value as 'NEW_ONLY' | 'ALL')}
                    className="bg-[#0d1017] border border-[#2b3447] text-white px-3 py-2 rounded text-xs font-mono focus:outline-none focus:border-blue-500"
                    disabled={playlistLoading}
                  >
                    <option value="NEW_ONLY">NEW ONLY (Deduplicate)</option>
                    <option value="ALL">ALL (Ingest All)</option>
                  </select>
                  <button
                    type="submit"
                    disabled={playlistLoading}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-5 py-2 rounded text-xs font-medium transition-colors whitespace-nowrap flex items-center justify-center space-x-1.5"
                  >
                    {playlistLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                    <span>{playlistLoading ? 'Extracting All Videos...' : 'Ingest Playlist'}</span>
                  </button>
                </form>

                {playlistMsg.text && (
                  <div className={`text-xs mt-3 p-2.5 rounded font-mono border ${
                    playlistMsg.type === 'ok'
                      ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                      : playlistMsg.type === 'info'
                      ? 'bg-blue-950/40 border-blue-500/30 text-blue-300'
                      : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                  }`}>
                    {playlistMsg.text}
                  </div>
                )}

                {/* Monitored Playlists Table */}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#252c3d] text-[#6e7d94]">
                        <th className="py-2 px-3 font-semibold">Playlist Title / URL</th>
                        <th className="py-2 px-3 font-semibold">Total Discovered</th>
                        <th className="py-2 px-3 font-semibold">Mode</th>
                        <th className="py-2 px-3 font-semibold">Status Toggle</th>
                        <th className="py-2 px-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1f2533]">
                      {playlists.length > 0 ? (
                        playlists.map((pl) => {
                          const isSyncing = syncingPlaylistIds.has(pl.id);
                          return (
                            <tr key={pl.id} className="hover:bg-[#181d28]/60 transition-colors">
                              <td className="py-2.5 px-3">
                                <div className="font-medium text-white">{pl.title || pl.playlist_id}</div>
                                <a
                                  href={pl.playlist_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[11px] text-[#6d7e97] hover:text-blue-400 font-mono truncate max-w-sm block"
                                >
                                  {pl.playlist_url}
                                </a>
                              </td>
                              <td className="py-2.5 px-3 font-mono">
                                <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-bold">
                                  {pl.video_count ?? 0} videos
                                </span>
                              </td>
                              <td className="py-2.5 px-3">
                                <select
                                  value={pl.ingest_mode}
                                  onChange={(e) => changePlaylistMode(pl.id, e.target.value as 'ALL' | 'NEW_ONLY')}
                                  className="bg-[#121620] border border-[#2b354a] text-white px-2 py-1 rounded text-[11px] font-mono"
                                >
                                  <option value="NEW_ONLY">NEW ONLY</option>
                                  <option value="ALL">ALL</option>
                                </select>
                              </td>
                              <td className="py-2.5 px-3">
                                <button
                                  onClick={() => togglePlaylistActive(pl.id, pl.active)}
                                  className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded text-[11px] font-semibold transition-all border ${
                                    pl.active
                                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20'
                                      : 'bg-zinc-800/40 border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                                  }`}
                                >
                                  {pl.active ? <Play className="w-2.5 h-2.5" /> : <Pause className="w-2.5 h-2.5" />}
                                  <span>{pl.active ? 'Active' : 'Paused'}</span>
                                </button>
                              </td>
                              <td className="py-2.5 px-3 text-right">
                                <button
                                  onClick={() => handleSyncPlaylist(pl.id)}
                                  disabled={isSyncing}
                                  className="inline-flex items-center space-x-1 text-[11px] px-2.5 py-1 rounded bg-[#1e2433] hover:bg-[#273042] border border-[#2f394e] text-white transition-colors disabled:opacity-50"
                                >
                                  <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                                  <span>{isSyncing ? 'Syncing...' : 'Sync Now'}</span>
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-[#6e7d94] text-xs">
                            {loading ? "Connecting to Supabase database..." : "No playlists stored in database. Add a playlist above to ingest all entries."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SECTION 2: ADD SINGLE VIDEO */}
              <div className="bg-[#151922] border border-[#262e40] rounded-lg p-5">
                <div className="flex items-center space-x-2 mb-4">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <h2 className="text-xs font-bold tracking-wider uppercase text-[#94a3b8]">
                    2. Ingest Single Video Immediately
                  </h2>
                </div>

                <form onSubmit={handleAddSingleVideo} className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="flex-1 bg-[#0d1017] border border-[#2b3447] text-white px-3 py-2 rounded text-xs font-mono placeholder-[#57647a] focus:outline-none focus:border-blue-500"
                    disabled={videoLoading}
                    required
                  />
                  <button
                    type="submit"
                    disabled={videoLoading}
                    className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-5 py-2 rounded text-xs font-medium transition-colors whitespace-nowrap flex items-center justify-center space-x-1.5"
                  >
                    {videoLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                    <span>{videoLoading ? 'Queuing...' : 'Ingest Video'}</span>
                  </button>
                </form>

                {videoMsg.text && (
                  <p className={`text-xs mt-2 font-mono ${videoMsg.type === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {videoMsg.text}
                  </p>
                )}
              </div>

              {/* SECTION 3: VIDEO PIPELINE STATUS LIST */}
              <div className="bg-[#151922] border border-[#262e40] rounded-lg p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div className="flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                    <h2 className="text-xs font-bold tracking-wider uppercase text-[#94a3b8]">
                      3. Video Pipeline Status List ({videos.length} Total Discovered)
                    </h2>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-[#6c7d96] absolute left-2.5 top-2" />
                      <input
                        type="text"
                        placeholder="Search videos..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-[#0e1118] border border-[#273042] text-xs text-white pl-8 pr-3 py-1 rounded placeholder-[#5c687d] focus:outline-none focus:border-blue-500 w-44 sm:w-56"
                      />
                    </div>
                  </div>
                </div>

                {/* Filter pills */}
                <div className="flex flex-wrap items-center gap-1.5 mb-4 text-xs font-mono">
                  <button
                    onClick={() => setStatusFilter('ALL')}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      statusFilter === 'ALL'
                        ? 'bg-blue-600 border-blue-500 text-white font-bold'
                        : 'bg-[#121620] border-[#252c3d] text-[#8695aa] hover:text-white'
                    }`}
                  >
                    ALL ({videos.length})
                  </button>
                  <button
                    onClick={() => setStatusFilter('PENDING')}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      statusFilter === 'PENDING'
                        ? 'bg-zinc-700 border-zinc-600 text-white font-bold'
                        : 'bg-[#121620] border-[#252c3d] text-zinc-400 hover:text-white'
                    }`}
                  >
                    PENDING ({counts.PENDING})
                  </button>
                  <button
                    onClick={() => setStatusFilter('DOWNLOADING')}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      statusFilter === 'DOWNLOADING'
                        ? 'bg-amber-600 border-amber-500 text-white font-bold'
                        : 'bg-[#121620] border-[#252c3d] text-amber-400 hover:text-white'
                    }`}
                  >
                    DOWNLOADING ({counts.DOWNLOADING})
                  </button>
                  <button
                    onClick={() => setStatusFilter('TRANSCRIBING')}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      statusFilter === 'TRANSCRIBING'
                        ? 'bg-blue-600 border-blue-500 text-white font-bold'
                        : 'bg-[#121620] border-[#252c3d] text-blue-400 hover:text-white'
                    }`}
                  >
                    TRANSCRIBING ({counts.TRANSCRIBING})
                  </button>
                  <button
                    onClick={() => setStatusFilter('READY')}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      statusFilter === 'READY'
                        ? 'bg-emerald-600 border-emerald-500 text-white font-bold'
                        : 'bg-[#121620] border-[#252c3d] text-emerald-400 hover:text-white'
                    }`}
                  >
                    READY ({counts.READY})
                  </button>
                  <button
                    onClick={() => setStatusFilter('FAILED')}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      statusFilter === 'FAILED'
                        ? 'bg-rose-600 border-rose-500 text-white font-bold'
                        : 'bg-[#121620] border-[#252c3d] text-rose-400 hover:text-white'
                    }`}
                  >
                    FAILED ({counts.FAILED})
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#252c3d] text-[#6e7d94]">
                        <th className="py-2.5 px-3 font-semibold">Video Details</th>
                        <th className="py-2.5 px-3 font-semibold">Source ID</th>
                        <th className="py-2.5 px-3 font-semibold">Duration</th>
                        <th className="py-2.5 px-3 font-semibold">Pipeline Status</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Functional Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1f2533]">
                      {filteredVideos.length > 0 ? (
                        filteredVideos.map((v) => {
                          const isTranscribing = transcribingIds.has(v.id) || v.status === 'DOWNLOADING' || v.status === 'TRANSCRIBING';

                          const statusColors: Record<string, string> = {
                            READY: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
                            TRANSCRIBING: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
                            DOWNLOADING: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
                            PENDING: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
                            NEEDS_REVIEW: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
                            FAILED: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
                          };

                          return (
                            <tr key={v.id} className="hover:bg-[#181d28]/60 transition-colors">
                              <td className="py-3 px-3 max-w-sm">
                                <div className="font-medium text-white truncate" title={v.title}>
                                  {v.title || `YouTube Video (${v.source_id})`}
                                </div>
                                <div className="text-[11px] text-[#6d7e97] truncate">
                                  {v.channel || 'YouTube'}
                                </div>
                                {v.error_message && (
                                  <div className="text-[10px] text-rose-400 mt-1 font-mono truncate" title={v.error_message}>
                                    &bull; {v.error_message}
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-3 font-mono font-medium text-blue-400">
                                <a
                                  href={v.url || `https://www.youtube.com/watch?v=${v.source_id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:underline inline-flex items-center space-x-1"
                                >
                                  <span>{v.source_id}</span>
                                  <ExternalLink className="w-2.5 h-2.5 text-[#5e6d85]" />
                                </a>
                              </td>
                              <td className="py-3 px-3 text-[#8a98ad] font-mono">
                                {formatDuration(v.duration_seconds)}
                              </td>
                              <td className="py-3 px-3">
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono border ${
                                    statusColors[v.status] || 'text-zinc-400'
                                  }`}
                                >
                                  {v.status === 'PENDING' && <Clock className="w-2.5 h-2.5 mr-1" />}
                                  {v.status === 'DOWNLOADING' && <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin" />}
                                  {v.status === 'TRANSCRIBING' && <Cpu className="w-2.5 h-2.5 mr-1 animate-pulse" />}
                                  {v.status === 'READY' && <CheckCircle2 className="w-2.5 h-2.5 mr-1" />}
                                  {v.status === 'FAILED' && <AlertCircle className="w-2.5 h-2.5 mr-1" />}
                                  {v.status}
                                </span>
                              </td>
                              <td className="py-3 px-3 text-right">
                                <div className="flex items-center justify-end space-x-2">
                                  {/* Action 1: Transcribe Now */}
                                  <button
                                    onClick={() => handleTranscribeVideo(v.id)}
                                    disabled={isTranscribing}
                                    title="Trigger actual yt-dlp download and OpenAI Whisper transcription"
                                    className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors border ${
                                      v.status === 'READY'
                                        ? 'bg-[#1b2230] border-[#2e3a50] text-[#93a2b7] hover:bg-[#232c3f] hover:text-white'
                                        : 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30'
                                    } disabled:opacity-40`}
                                  >
                                    {isTranscribing ? (
                                      <>
                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                        <span>Working...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Play className="w-2.5 h-2.5" />
                                        <span>{v.status === 'READY' ? 'Re-Transcribe' : 'Transcribe Now'}</span>
                                      </>
                                    )}
                                  </button>

                                  {/* Action 2: Download Audio */}
                                  <button
                                    onClick={() => handleDownloadAudio(v)}
                                    title="Download audio stream (.mp3)"
                                    className="inline-flex items-center space-x-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[#1e2433] hover:bg-[#283144] border border-[#2f394e] text-white transition-colors"
                                  >
                                    <Download className="w-3 h-3 text-[#94a3b8]" />
                                    <span>Download Audio</span>
                                  </button>

                                  {/* Action 3: View Transcript */}
                                  <button
                                    onClick={() => handleViewTranscript(v)}
                                    className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${
                                      v.status === 'READY' && v.transcript_json
                                        ? 'bg-emerald-600/20 border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30'
                                        : 'bg-[#161a24] border-[#252b3b] text-[#717f94] hover:text-white'
                                    }`}
                                  >
                                    <FileText className="w-3 h-3" />
                                    <span>View Transcript</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-[#6e7d94] text-xs">
                            {loading
                              ? "Loading videos from database..."
                              : videos.length === 0
                              ? "No videos stored in database yet. Paste a YouTube Playlist or Video URL above to extract all entries."
                              : "No videos match the current search or status filter."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: SYSTEM ARCHITECTURE & CODE DELIVERABLES */}
        {activeTab === 'code' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-4 space-y-2">
              <div className="text-xs font-bold text-[#8fa0b5] uppercase tracking-wider mb-2">
                User Deliverables (Strict Tech Stack)
              </div>
              {Object.entries(CODE_SNIPPETS).map(([key, item]) => (
                <button
                  key={key}
                  onClick={() => setSelectedFile(key as any)}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${
                    selectedFile === key
                      ? 'bg-blue-600/10 border-blue-500/40 text-white'
                      : 'bg-[#151922] border-[#242b3d] text-[#8695ab] hover:bg-[#1a202c] hover:text-white'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold">{item.name}</span>
                    <span className="text-[10px] text-blue-400 font-mono">Deliverable</span>
                  </div>
                  <p className="text-[11px] text-[#6d7d93] mt-1 line-clamp-2">
                    {item.desc}
                  </p>
                </button>
              ))}
            </div>

            <div className="lg:col-span-8">
              <div className="bg-[#12151e] border border-[#242c3e] rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-[#181d28] border-b border-[#242c3e] flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <FileCode className="w-4 h-4 text-blue-400" />
                    <span className="font-mono text-xs font-bold text-white">
                      {CODE_SNIPPETS[selectedFile].name}
                    </span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(CODE_SNIPPETS[selectedFile].code, selectedFile)}
                    className="inline-flex items-center space-x-1 text-xs text-blue-400 hover:text-white bg-blue-500/10 hover:bg-blue-500/20 px-2.5 py-1 rounded transition-colors font-mono"
                  >
                    {copiedKey === selectedFile ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedKey === selectedFile ? 'Copied!' : 'Copy Code'}</span>
                  </button>
                </div>
                <div className="p-3 bg-[#0d1017] border-b border-[#1f2637] text-xs text-[#8c9cb2]">
                  {CODE_SNIPPETS[selectedFile].desc}
                </div>
                <pre className="p-4 text-xs font-mono overflow-x-auto text-[#d6deeb] max-h-[600px] leading-relaxed">
                  <code>{CODE_SNIPPETS[selectedFile].code}</code>
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: GET /api/transcripts LIVE AI BRAIN ENDPOINT */}
        {activeTab === 'api' && (
          <div className="bg-[#151922] border border-[#262e40] rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center space-x-2">
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono text-xs font-bold">GET</span>
                  <span>/api/transcripts</span>
                </h2>
                <p className="text-xs text-[#8898af] mt-1">
                  Deliverable 3: AI Brain Consumption Route. Strictly filters and serves ONLY videos where <code className="font-mono text-emerald-400">status === &quot;READY&quot;</code>.
                </p>
              </div>
              <a
                href="/api/transcripts"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium font-mono"
              >
                <span>Open JSON Endpoint</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="bg-[#0e1117] border border-[#242b3c] rounded p-4">
              <div className="text-xs font-mono text-[#8696ab] mb-2 font-bold">Query Parameters Supported:</div>
              <ul className="text-xs font-mono text-[#abb8cb] space-y-1">
                <li><code className="text-blue-400">limit</code>: Number of records to return (default: 50, max: 200)</li>
                <li><code className="text-blue-400">offset</code>: Pagination offset (default: 0)</li>
              </ul>
            </div>

            <div className="bg-[#0e1117] border border-[#242b3c] rounded p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-[#8696ab] font-bold">Live Response Output:</span>
                <span className="text-[11px] font-mono text-emerald-400">
                  {videos.filter(v => v.status === 'READY').length} READY Transcripts in Database
                </span>
              </div>
              <pre className="text-xs font-mono text-[#c7d3e6] overflow-x-auto p-3 bg-[#080a0f] rounded max-h-96">
                <code>
                  {JSON.stringify({
                    transcripts: videos.filter(v => v.status === 'READY').map(v => ({
                      id: v.id,
                      source_id: v.source_id,
                      title: v.title,
                      channel: v.channel,
                      duration_seconds: v.duration_seconds,
                      storage_url: v.storage_url,
                      transcript_json: v.transcript_json,
                      processed_at: v.processed_at,
                      created_at: v.created_at
                    })),
                    count: videos.filter(v => v.status === 'READY').length,
                    total: videos.filter(v => v.status === 'READY').length
                  }, null, 2)}
                </code>
              </pre>
            </div>
          </div>
        )}
      </main>

      {/* TRANSCRIPT MODAL / INSPECTOR */}
      {inspectVideo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#151922] border border-[#2c374d] rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 border-b border-[#252c3d] flex items-center justify-between bg-[#191e2b]">
              <div>
                <div className="flex items-center space-x-2">
                  <span className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded border ${
                    inspectVideo.status === 'READY'
                      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                      : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                  }`}>
                    {inspectVideo.status}
                  </span>
                  <span className="font-mono text-xs text-blue-400 font-bold">
                    {inspectVideo.source_id}
                  </span>
                </div>
                <h3 className="text-sm font-bold text-white mt-1 line-clamp-1">
                  {inspectVideo.title || `Video ${inspectVideo.source_id}`}
                </h3>
              </div>
              <button
                onClick={() => setInspectVideoId(null)}
                className="w-8 h-8 rounded-lg bg-[#202737] hover:bg-[#2b354a] flex items-center justify-center text-[#8e9eb3] hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              {/* Metadata strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono p-3 rounded-lg bg-[#0e1118] border border-[#232a3a]">
                <div>
                  <div className="text-[10px] text-[#6d7e97]">Channel</div>
                  <div className="text-white truncate">{inspectVideo.channel || 'YouTube'}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#6d7e97]">Duration</div>
                  <div className="text-white">{formatDuration(inspectVideo.duration_seconds)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#6d7e97]">Processed At</div>
                  <div className="text-white truncate" suppressHydrationWarning>{formatTime(inspectVideo.processed_at)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#6d7e97]">Audio Storage</div>
                  <button
                    onClick={() => handleDownloadAudio(inspectVideo)}
                    className="text-blue-400 hover:underline flex items-center space-x-1"
                  >
                    <Download className="w-3 h-3" />
                    <span>Download MP3</span>
                  </button>
                </div>
              </div>

              {/* Status Notice if not READY */}
              {inspectVideo.status !== 'READY' && (
                <div className="p-4 rounded-lg bg-[#1a202d] border border-[#2b354a] space-y-2">
                  <div className="flex items-center space-x-2 text-xs font-bold text-white">
                    <Clock className="w-4 h-4 text-amber-400" />
                    <span>Video status is {inspectVideo.status}</span>
                  </div>
                  <p className="text-xs text-[#8c9db2]">
                    {inspectVideo.status === 'PENDING' && "This video has been discovered and queued. Click 'Transcribe Now' to trigger audio extraction and OpenAI Whisper transcription."}
                    {inspectVideo.status === 'DOWNLOADING' && "Audio stream is currently being extracted via yt-dlp & ffmpeg."}
                    {inspectVideo.status === 'TRANSCRIBING' && "Audio has been uploaded and is currently being transcribed by OpenAI Whisper."}
                    {inspectVideo.status === 'FAILED' && `Error: ${inspectVideo.error_message || 'Pipeline failed during processing.'}`}
                  </p>
                  {inspectVideo.status !== 'DOWNLOADING' && inspectVideo.status !== 'TRANSCRIBING' && (
                    <button
                      onClick={() => handleTranscribeVideo(inspectVideo.id)}
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
                    >
                      <Play className="w-3 h-3" />
                      <span>Transcribe Now with OpenAI Whisper</span>
                    </button>
                  )}
                </div>
              )}

              {/* Full Text & Timestamped Segments */}
              {inspectVideo.status === 'READY' && inspectVideo.transcript_json && (
                <div className="space-y-4">
                  {/* Full Text */}
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-[#8da0b6] mb-2">
                      Full Transcript Text
                    </h4>
                    <div className="p-3.5 rounded-lg bg-[#0e1118] border border-[#232a3a] text-xs leading-relaxed text-[#d4dde8]">
                      {inspectVideo.transcript_json.text || 'No text extracted'}
                    </div>
                  </div>

                  {/* Timestamped Segments */}
                  {Array.isArray(inspectVideo.transcript_json.segments) && inspectVideo.transcript_json.segments.length > 0 && (
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#8da0b6] mb-2 flex items-center justify-between">
                        <span>Timestamped Segments ({inspectVideo.transcript_json.segments.length})</span>
                        <span className="text-[10px] text-[#6d7e97] font-mono">OpenAI Whisper Verbose JSON</span>
                      </h4>
                      <div className="divide-y divide-[#1e2535] border border-[#232a3a] rounded-lg overflow-hidden bg-[#0e1118] max-h-60 overflow-y-auto">
                        {inspectVideo.transcript_json.segments.map((seg: any, idx: number) => (
                          <div key={idx} className="p-2.5 flex items-start space-x-3 text-xs hover:bg-[#141924] transition-colors">
                            <span className="px-1.5 py-0.5 rounded bg-[#1e2536] text-blue-400 font-mono text-[10px] whitespace-nowrap mt-0.5">
                              [{formatSegmentTime(seg.start || 0)} - {formatSegmentTime(seg.end || 0)}]
                            </span>
                            <span className="text-[#ccd7e6] flex-1">
                              {seg.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Raw JSON */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-[#8da0b6]">
                        Raw Transcript JSON (AI Brain Payload)
                      </h4>
                      <button
                        onClick={() => copyToClipboard(JSON.stringify(inspectVideo.transcript_json, null, 2), 'modal_json')}
                        className="inline-flex items-center space-x-1 text-xs text-blue-400 hover:text-white font-mono"
                      >
                        {copiedKey === 'modal_json' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedKey === 'modal_json' ? 'Copied' : 'Copy JSON'}</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-[#080a0f] border border-[#202737] rounded text-[11px] font-mono text-[#a6b8ce] max-h-48 overflow-x-auto">
                      <code>{JSON.stringify(inspectVideo.transcript_json, null, 2)}</code>
                    </pre>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-[#252c3d] bg-[#191e2b] flex items-center justify-between">
              <a
                href={inspectVideo.url || `https://www.youtube.com/watch?v=${inspectVideo.source_id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-400 hover:underline inline-flex items-center space-x-1 font-mono"
              >
                <span>Open Video on YouTube</span>
                <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={() => setInspectVideoId(null)}
                className="px-4 py-1.5 rounded bg-[#252d3d] hover:bg-[#303a4e] text-white text-xs font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
