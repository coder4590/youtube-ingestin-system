import { NextResponse } from 'next/server';
import { syncPlaylist } from '@/lib/db';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await syncPlaylist(id);
    return NextResponse.json({
      message: `Playlist synced successfully. Discovered ${result.new_videos_count} new videos.`,
      playlist: result.playlist,
      new_videos: result.new_videos_count
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Playlist sync failed' }, { status: 500 });
  }
}
