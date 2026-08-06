export interface ParsedNoteUrl {
  noteId: string;
  canonicalUrl: string;
}

export function parseNoteUrl(value: string): ParsedNoteUrl | null {
  let url: URL;
  try {
    url = new URL(value, "https://www.xiaohongshu.com");
  } catch {
    return null;
  }
  if (url.hostname !== "www.xiaohongshu.com" && url.hostname !== "xiaohongshu.com") return null;
  const match = url.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9_-]{8,})(?:\/|$)/);
  const noteId = match?.[1];
  if (!noteId) return null;
  return { noteId, canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId}` };
}
