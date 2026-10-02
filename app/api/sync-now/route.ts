import { NextResponse } from 'next/server';
import { getPlaylists, updatePlaylist } from '@/lib/db';

export async function POST() {
  try {
    const playlists = await getPlaylists();
    const active = playlists.filter(p => p.active);
    const now = new Date().toISOString();

    for (const pl of active) {
      await updatePlaylist(pl.id, { last_synced_at: now });
    }

    return NextResponse.json({
      status: "success",
      message: `Triggered background sync for ${active.length} active playlists.`,
      synced_count: active.length,
      timestamp: now
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Sync trigger failed' }, { status: 500 });
  }
}
