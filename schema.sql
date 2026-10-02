-- ====================================================================
-- YOUTUBE INGESTION SYSTEM - SUPABASE POSTGRESQL SCHEMA
-- Deliverable 1: Tables for Playlists and Deduplicated Videos
-- ====================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PLAYLISTS TABLE
-- Stores monitored playlists, active/paused state, and ingestion mode
CREATE TABLE IF NOT EXISTS public.playlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_url TEXT NOT NULL UNIQUE,
    playlist_id TEXT NOT NULL UNIQUE,
    title TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    ingest_mode TEXT NOT NULL DEFAULT 'NEW_ONLY' CHECK (ingest_mode IN ('ALL', 'NEW_ONLY')),
    last_synced_at TIMESTAMPTZ,
    video_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. VIDEOS TABLE
-- Deduplicated by permanent YouTube video ID (source_id)
-- Stores pipeline status, Cloudflare R2 storage URL, and Whisper timestamped JSON
CREATE TABLE IF NOT EXISTS public.videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL UNIQUE, -- Permanent YouTube Video ID (e.g., 'jNQXAC9IVRw')
    playlist_id UUID REFERENCES public.playlists(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    title TEXT,
    channel TEXT,
    duration_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DOWNLOADING', 'TRANSCRIBING', 'READY', 'NEEDS_REVIEW', 'FAILED')),
    storage_url TEXT, -- Cloudflare R2 key or public/presigned URL
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

DROP TRIGGER IF EXISTS tr_playlists_updated_at ON public.playlists;
CREATE TRIGGER tr_playlists_updated_at
    BEFORE UPDATE ON public.playlists
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS tr_videos_updated_at ON public.videos;
CREATE TRIGGER tr_videos_updated_at
    BEFORE UPDATE ON public.videos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
