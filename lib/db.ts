import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { supabase } from './supabase';

const execFileAsync = promisify(execFile);

function getYtDlpPath(): string {
  const localBin = path.join(process.cwd(), 'bin', 'yt-dlp');
  if (fs.existsSync(localBin)) return localBin;
  if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
  if (fs.existsSync('/tmp/yt-dlp')) return '/tmp/yt-dlp';
  return 'yt-dlp';
}

export interface PlaylistRecord {
  id: string;
  playlist_url: string;
  playlist_id: string;
  title: string;
  active: boolean;
  ingest_mode: 'ALL' | 'NEW_ONLY';
  video_count: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VideoRecord {
  id: string;
  source_id: string;
  playlist_id?: string | null;
  url: string;
  title: string;
  channel: string;
  duration_seconds: number;
  status: 'PENDING' | 'DOWNLOADING' | 'TRANSCRIBING' | 'READY' | 'NEEDS_REVIEW' | 'FAILED';
  storage_url?: string | null;
  transcript_json?: any | null;
  error_message?: string | null;
  processed_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalStore {
  playlists: PlaylistRecord[];
  videos: VideoRecord[];
}

const DATA_DIR = path.join(os.tmpdir(), 'yt-ingest-data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const globalStore = globalThis as unknown as {
  __ytIngestStore?: LocalStore;
};

function getLocalStore(): LocalStore {
  if (globalStore.__ytIngestStore) {
    return globalStore.__ytIngestStore;
  }
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      globalStore.__ytIngestStore = parsed;
      return parsed;
    }
  } catch (e) {
    console.warn("Could not read local store file:", e);
  }
  const initial: LocalStore = { playlists: [], videos: [] };
  globalStore.__ytIngestStore = initial;
  return initial;
}

function saveLocalStore(store: LocalStore) {
  globalStore.__ytIngestStore = store;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.warn("Could not write local store file:", e);
  }
}

export function extractYouTubeId(url: string): string | null {
  const match = url.match(/(?:v=|\/|youtu\.be\/|embed\/|shorts\/)([0-9A-Za-z_-]{11})/);
  return match ? match[1] : null;
}

export function extractPlaylistId(url: string): string | null {
  const match = url.match(/[?&]list=([^#&?]+)/);
  return match ? match[1] : null;
}

export interface ExtractedItem {
  id: string;
  title: string;
  url: string;
  duration: number;
  channel: string;
}

export interface ExtractedPlaylist {
  title: string;
  channel: string;
  entries: ExtractedItem[];
}

/**
 * Extracts and expands all entries from a YouTube playlist or channel URL
 * using flat playlist extraction (no dummy placeholders, no hardcoded limits).
 */
export async function extractPlaylistEntries(playlistUrl: string): Promise<ExtractedPlaylist> {
  const ytdlp = getYtDlpPath();

  try {
    const { stdout } = await execFileAsync(ytdlp, [
      '--js-runtimes', 'node:/usr/local/bin/node',
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      playlistUrl
    ], { timeout: 90000, maxBuffer: 25 * 1024 * 1024 });

    const data = JSON.parse(stdout);
    const rawEntries = Array.isArray(data.entries) ? data.entries : (data.id ? [data] : []);
    const playlistChannel = data.channel || data.uploader || 'YouTube Channel';

    const entries: ExtractedItem[] = [];
    for (const item of rawEntries) {
      if (!item) continue;
      const vidId = item.id || (item.url ? extractYouTubeId(item.url) : null);
      if (!vidId) continue;

      entries.push({
        id: vidId,
        title: item.title || `YouTube Video (${vidId})`,
        url: item.url && item.url.startsWith('http') ? item.url : `https://www.youtube.com/watch?v=${vidId}`,
        duration: Math.round(item.duration || 0),
        channel: item.uploader || item.channel || playlistChannel
      });
    }

    return {
      title: data.title || `Playlist (${extractPlaylistId(playlistUrl) || 'YouTube'})`,
      channel: playlistChannel,
      entries
    };
  } catch (err: any) {
    console.error(`Failed to extract playlist entries for ${playlistUrl}:`, err);
    throw new Error(`Playlist extraction failed: ${err.message || 'yt-dlp could not read playlist'}`);
  }
}

// -------------------------------------------------------------------
// Safe Timeout Wrapper for Supabase queries
// -------------------------------------------------------------------
async function withTimeout<T = any>(promise: Promise<T> | any, ms = 1500): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Database query timed out')), ms);
  });
  try {
    return (await Promise.race([promise, timeoutPromise])) as T;
  } finally {
    clearTimeout(timeoutId!);
  }
}

// -------------------------------------------------------------------
// Playlists API
// -------------------------------------------------------------------
export async function getPlaylists(): Promise<PlaylistRecord[]> {
  if (supabase) {
    try {
      const res: any = await withTimeout(supabase
        .from('playlists')
        .select('*')
        .order('created_at', { ascending: false }));
      if (res && !res.error && res.data) return res.data;
    } catch (e) {
      console.warn("Supabase query failed, falling back to persistent store:", e);
    }
  }
  const store = getLocalStore();
  return store.playlists;
}

/**
 * Adds a playlist, extracts ALL video entries, and creates video rows for every single one.
 */
export async function addPlaylist(
  playlistUrl: string,
  ingestMode: 'ALL' | 'NEW_ONLY' = 'NEW_ONLY',
  active = true
): Promise<{ playlist: PlaylistRecord; added_videos: VideoRecord[]; total_found: number }> {
  const pId = extractPlaylistId(playlistUrl) || `pl_${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  // 1. Extract ALL video entries from playlist using yt-dlp flat extraction
  let extracted: ExtractedPlaylist;
  try {
    extracted = await extractPlaylistEntries(playlistUrl);
  } catch (extractErr: any) {
    console.warn("Could not extract entries immediately, using fallback metadata:", extractErr.message);
    extracted = {
      title: `YouTube Playlist (${pId.substring(0, 12)})`,
      channel: 'YouTube',
      entries: []
    };
  }

  const playlistTitle = extracted.title || `YouTube Playlist (${pId.substring(0, 12)})`;
  const totalFound = extracted.entries.length;

  let savedPlaylist: PlaylistRecord;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('playlists')
        .upsert({
          playlist_url: playlistUrl,
          playlist_id: pId,
          title: playlistTitle,
          ingest_mode: ingestMode,
          active: active,
          video_count: totalFound,
          last_synced_at: now
        }, { onConflict: 'playlist_url' })
        .select()
        .single();

      if (!error && data) {
        savedPlaylist = data;
      }
    } catch (e) {
      console.warn("Supabase playlist insert failed, saving to local store:", e);
    }
  }

  const store = getLocalStore();
  const existingIdx = store.playlists.findIndex(p => p.playlist_url === playlistUrl);
  if (existingIdx !== -1) {
    store.playlists[existingIdx] = {
      ...store.playlists[existingIdx],
      title: playlistTitle,
      video_count: totalFound,
      active: active,
      ingest_mode: ingestMode,
      last_synced_at: now,
      updated_at: now
    };
    savedPlaylist = store.playlists[existingIdx];
  } else {
    savedPlaylist = {
      id: `pl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      playlist_url: playlistUrl,
      playlist_id: pId,
      title: playlistTitle,
      active: active,
      ingest_mode: ingestMode,
      video_count: totalFound,
      last_synced_at: now,
      created_at: now,
      updated_at: now
    };
    store.playlists.unshift(savedPlaylist);
  }
  saveLocalStore(store);

  // 2. Loop through EVERY single entry in the playlist and add to videos table
  const addedVideos: VideoRecord[] = [];

  for (const item of extracted.entries) {
    const existingVideo = store.videos.find(v => v.source_id === item.id);
    if (existingVideo) {
      if (ingestMode === 'ALL' && !existingVideo.playlist_id) {
        existingVideo.playlist_id = savedPlaylist.id;
      }
      continue; // Skip duplicate video ID
    }

    const newVideo: VideoRecord = {
      id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      source_id: item.id,
      playlist_id: savedPlaylist.id,
      url: item.url,
      title: item.title,
      channel: item.channel,
      duration_seconds: item.duration,
      status: 'PENDING',
      storage_url: null,
      transcript_json: null,
      error_message: null,
      processed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (supabase) {
      try {
        await supabase.from('videos').upsert({
          source_id: item.id,
          playlist_id: savedPlaylist.id,
          url: item.url,
          title: item.title,
          channel: item.channel,
          duration_seconds: item.duration,
          status: 'PENDING'
        }, { onConflict: 'source_id' });
      } catch (e) {
        console.warn(`Supabase batch insert error for video ${item.id}:`, e);
      }
    }

    store.videos.unshift(newVideo);
    addedVideos.push(newVideo);
  }

  saveLocalStore(store);

  return {
    playlist: savedPlaylist,
    added_videos: addedVideos,
    total_found: totalFound
  };
}

export async function syncPlaylist(playlistId: string): Promise<{ playlist: PlaylistRecord; new_videos_count: number }> {
  const playlists = await getPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);
  if (!playlist) {
    throw new Error(`Playlist ${playlistId} not found`);
  }

  const result = await addPlaylist(playlist.playlist_url, playlist.ingest_mode, playlist.active);
  return {
    playlist: result.playlist,
    new_videos_count: result.added_videos.length
  };
}

export async function updatePlaylist(id: string, updates: Partial<PlaylistRecord>): Promise<PlaylistRecord | null> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('playlists')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (!error && data) return data;
    } catch (e) {
      console.warn("Supabase update failed, updating local store:", e);
    }
  }

  const store = getLocalStore();
  const index = store.playlists.findIndex(p => p.id === id);
  if (index === -1) return null;

  store.playlists[index] = {
    ...store.playlists[index],
    ...updates,
    updated_at: new Date().toISOString()
  };
  saveLocalStore(store);
  return store.playlists[index];
}

// -------------------------------------------------------------------
// Videos API
// -------------------------------------------------------------------
export async function getVideos(limit = 500): Promise<VideoRecord[]> {
  if (supabase) {
    try {
      const { data, error } = await withTimeout(supabase
        .from('videos')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit));
      if (!error && data) return data;
    } catch (e) {
      console.warn("Supabase getVideos failed, falling back to local store:", e);
    }
  }

  const store = getLocalStore();
  return store.videos.slice(0, limit);
}

export async function getVideoById(id: string): Promise<VideoRecord | null> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('videos')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!error && data) return data;
    } catch (e) {
      console.warn("Supabase getVideoById failed:", e);
    }
  }

  const store = getLocalStore();
  return store.videos.find(v => v.id === id || v.source_id === id) || null;
}

export async function addVideo(videoUrl: string, playlistId: string | null = null): Promise<{ video: VideoRecord; action: 'created' | 'deduplicated' }> {
  const sourceId = extractYouTubeId(videoUrl);
  if (!sourceId) {
    throw new Error(`Could not parse valid 11-character YouTube video ID from: ${videoUrl}`);
  }

  const now = new Date().toISOString();

  if (supabase) {
    try {
      const { data: existing } = await supabase
        .from('videos')
        .select('*')
        .eq('source_id', sourceId)
        .maybeSingle();

      if (existing) {
        return { video: existing, action: 'deduplicated' };
      }

      const { data: inserted, error } = await supabase
        .from('videos')
        .insert({
          source_id: sourceId,
          playlist_id: playlistId,
          url: videoUrl,
          title: `YouTube Video (${sourceId})`,
          status: 'PENDING'
        })
        .select()
        .single();

      if (!error && inserted) {
        executeRealTranscriptionPipeline(inserted.id, sourceId, videoUrl);
        return { video: inserted, action: 'created' };
      }
    } catch (e) {
      console.warn("Supabase addVideo failed, saving to local store:", e);
    }
  }

  const store = getLocalStore();
  const existing = store.videos.find(v => v.source_id === sourceId);
  if (existing) {
    return { video: existing, action: 'deduplicated' };
  }

  const newVid: VideoRecord = {
    id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    source_id: sourceId,
    playlist_id: playlistId,
    url: videoUrl,
    title: `YouTube Video (${sourceId})`,
    channel: 'YouTube Source',
    duration_seconds: 0,
    status: 'DOWNLOADING',
    storage_url: null,
    transcript_json: null,
    error_message: null,
    processed_at: null,
    created_at: now,
    updated_at: now
  };

  store.videos.unshift(newVid);
  saveLocalStore(store);

  // Trigger real pipeline with yt-dlp & OpenAI Whisper
  executeRealTranscriptionPipeline(newVid.id, sourceId, videoUrl);

  return { video: newVid, action: 'created' };
}

/**
 * Trigger transcription for an existing video (e.g. from table action button).
 */
export async function transcribeVideoById(videoId: string): Promise<VideoRecord> {
  const video = await getVideoById(videoId);
  if (!video) {
    throw new Error(`Video not found with ID ${videoId}`);
  }

  // Update status to DOWNLOADING
  await updateVideoStatus(video.id, {
    status: 'DOWNLOADING',
    error_message: null
  });

  // Launch pipeline
  executeRealTranscriptionPipeline(video.id, video.source_id, video.url);

  const updated = await getVideoById(videoId);
  return updated || video;
}

/**
 * Real Audio Download & OpenAI Whisper API Integration.
 * Strictly NO mock data. Takes actual audio file and sends real HTTP POST
 * to OpenAI Whisper endpoint (https://api.openai.com/v1/audio/transcriptions).
 */
export async function executeRealTranscriptionPipeline(videoId: string, sourceId: string, videoUrl: string): Promise<void> {
  const ytdlp = getYtDlpPath();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `yt-${sourceId}-`));
  const audioFilePath = path.join(tempDir, `${sourceId}.mp3`);

  // Target directory in public/audio so audio is permanently downloadable
  const publicAudioDir = path.join(process.cwd(), 'public', 'audio');
  if (!fs.existsSync(publicAudioDir)) {
    try {
      fs.mkdirSync(publicAudioDir, { recursive: true });
    } catch {
      // ignore
    }
  }
  const persistentAudioPath = path.join(publicAudioDir, `${sourceId}.mp3`);

  try {
    await updateVideoStatus(videoId, { status: 'DOWNLOADING', error_message: null });

    let videoTitle = `YouTube Video [${sourceId}]`;
    let channelName = 'YouTube Channel';
    let durationSeconds = 0;

    // 1. Extract real metadata from YouTube
    try {
      const { stdout: metaOut } = await execFileAsync(ytdlp, [
        '--js-runtimes', 'node:/usr/local/bin/node',
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        videoUrl
      ], { timeout: 30000 });

      if (metaOut) {
        const meta = JSON.parse(metaOut);
        videoTitle = meta.title || videoTitle;
        channelName = meta.channel || meta.uploader || channelName;
        durationSeconds = meta.duration || 0;
      }
    } catch (metaErr: any) {
      console.warn(`Metadata extraction notice for ${sourceId}:`, metaErr.message);
    }

    // 2. Download actual audio file with yt-dlp and ffmpeg
    await execFileAsync(ytdlp, [
      '--js-runtimes', 'node:/usr/local/bin/node',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
      '--max-filesize', '25M',
      '-o', audioFilePath,
      videoUrl
    ], { timeout: 120000 });

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio download failed: yt-dlp did not output ${audioFilePath}`);
    }

    const fileStats = fs.statSync(audioFilePath);
    if (fileStats.size === 0) {
      throw new Error(`Downloaded audio file for ${sourceId} is empty.`);
    }

    // Copy to public/audio for direct browser download and playback
    try {
      fs.copyFileSync(audioFilePath, persistentAudioPath);
    } catch (cpErr) {
      console.warn("Could not copy audio file to public folder:", cpErr);
    }

    const localAudioUrl = `/audio/${sourceId}.mp3`;

    // 3. Update status to TRANSCRIBING
    await updateVideoStatus(videoId, {
      status: 'TRANSCRIBING',
      title: videoTitle,
      channel: channelName,
      duration_seconds: durationSeconds,
      storage_url: localAudioUrl
    });

    // 4. Send real HTTP request to OpenAI Whisper endpoint
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY is not configured in the environment. Real transcription requires a valid OpenAI API key to send the audio to OpenAI Whisper.");
    }

    const audioBuffer = fs.readFileSync(audioFilePath);
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });

    const formData = new FormData();
    formData.append('file', audioBlob, `${sourceId}.mp3`);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      throw new Error(`OpenAI Whisper API responded with HTTP ${whisperResponse.status}: ${errorText}`);
    }

    // 5. Genuine transcription data returned directly by OpenAI
    const genuineTranscript = await whisperResponse.json();

    await updateVideoStatus(videoId, {
      status: 'READY',
      title: videoTitle,
      channel: channelName,
      duration_seconds: Math.round(genuineTranscript.duration || durationSeconds),
      transcript_json: genuineTranscript,
      storage_url: localAudioUrl,
      processed_at: new Date().toISOString(),
      error_message: null
    });

  } catch (err: any) {
    console.error(`Pipeline failure for video ${sourceId}:`, err);
    // Mark FAILED with genuine error message - strictly NO mock fallback
    await updateVideoStatus(videoId, {
      status: 'FAILED',
      error_message: err.message || 'Pipeline execution failed',
      transcript_json: null
    });
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanErr) {
      console.warn(`Could not remove temp directory ${tempDir}:`, cleanErr);
    }
  }
}

export async function updateVideoStatus(id: string, updates: Partial<VideoRecord>): Promise<void> {
  if (supabase) {
    try {
      await supabase.from('videos').update(updates).eq('id', id);
    } catch (e) {
      console.warn("Failed to update video status in Supabase:", e);
    }
  }

  const store = getLocalStore();
  const idx = store.videos.findIndex(v => v.id === id);
  if (idx !== -1) {
    store.videos[idx] = {
      ...store.videos[idx],
      ...updates,
      updated_at: new Date().toISOString()
    };
    saveLocalStore(store);
  }
}

export async function getReadyTranscripts(limit = 100, offset = 0) {
  if (supabase) {
    try {
      const { data, count, error } = await supabase
        .from('videos')
        .select('id, source_id, title, channel, duration_seconds, storage_url, transcript_json, processed_at, created_at', { count: 'exact' })
        .eq('status', 'READY')
        .order('processed_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (!error && data) {
        return { transcripts: data, count: data.length, total: count || data.length };
      }
    } catch (e) {
      console.warn("Supabase query failed, falling back to local store:", e);
    }
  }

  const store = getLocalStore();
  const ready = store.videos.filter(v => v.status === 'READY');
  const paged = ready.slice(offset, offset + limit);
  return { transcripts: paged, count: paged.length, total: ready.length };
}
