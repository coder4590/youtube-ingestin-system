import { NextResponse } from 'next/server';
import { getPlaylists, addPlaylist } from '@/lib/db';

export async function GET() {
  try {
    const playlists = await getPlaylists();
    return NextResponse.json(playlists);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch playlists' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const playlistUrl = (body.playlist_url || '').trim();
    const ingestMode = body.ingest_mode || 'NEW_ONLY';
    const active = body.active !== undefined ? Boolean(body.active) : true;

    if (!playlistUrl) {
      return NextResponse.json({ error: "Missing playlist_url in request payload" }, { status: 400 });
    }

    const result = await addPlaylist(playlistUrl, ingestMode, active);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to add playlist' }, { status: 400 });
  }
}
