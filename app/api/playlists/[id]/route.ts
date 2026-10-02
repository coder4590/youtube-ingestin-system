import { NextResponse } from 'next/server';
import { updatePlaylist } from '@/lib/db';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const updates: Record<string, any> = {};

    if (body.active !== undefined) updates.active = Boolean(body.active);
    if (body.ingest_mode !== undefined) updates.ingest_mode = body.ingest_mode;

    const updated = await updatePlaylist(id, updates);
    if (!updated) {
      return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to update playlist' }, { status: 400 });
  }
}
