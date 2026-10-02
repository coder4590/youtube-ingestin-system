import { NextResponse } from 'next/server';
import { getPlaylists, getVideos } from '@/lib/db';
import { supabase } from '@/lib/supabase';

export async function GET() {
  try {
    const [playlists, videos] = await Promise.all([
      getPlaylists(),
      getVideos(50)
    ]);

    return NextResponse.json({
      database_connected: true,
      backend_target: supabase ? "Supabase (Cloud PostgreSQL)" : "Persistent Pipeline Storage",
      playlists,
      videos
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Status check failed' }, { status: 500 });
  }
}
