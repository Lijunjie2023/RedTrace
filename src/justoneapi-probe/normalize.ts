import type { Comment, Post } from "../xhs-probe/types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function noteUrl(noteId: string): string { return `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`; }

export function selectRelatedSearchNotes(data: unknown, keyword: string, limit: number): JsonRecord[] {
  const notes = array(record(data)?.notes);
  const normalizedKeyword = keyword.toLocaleLowerCase("zh-CN");
  return notes.filter((item): item is JsonRecord => {
    const note = record(item);
    if (!note || !text(note.id)) return false;
    const content = `${text(note.title) ?? ""}\n${text(note.desc) ?? ""}`.toLocaleLowerCase("zh-CN");
    return content.includes(normalizedKeyword);
  }).slice(0, limit);
}

export function normalizeNoteDetail(data: unknown, keyword: string): Post | null {
  const container = Array.isArray(data) ? record(data[0]) : record(data);
  const note = record(array(container?.note_list)[0]);
  const noteId = text(note?.id);
  if (!note || !noteId) return null;
  const author = record(note.user);
  const topics = array(note.topics).map(record).map((item) => text(item?.name)).filter((item): item is string => Boolean(item));
  const images = array(note.images_list).map(record).map((item) => text(item?.url) ?? text(item?.origin_img) ?? text(item?.original)).filter((item): item is string => Boolean(item));
  const time = typeof note.time === "number" || typeof note.time === "string" ? note.time : null;
  const lastUpdateTime = typeof note.last_update_time === "number" || typeof note.last_update_time === "string" ? note.last_update_time : null;
  return {
    noteId,
    title: text(note.title),
    author: { nickname: text(author?.nickname) ?? text(author?.name) },
    displayedTime: time === null ? null : String(time),
    interactionSummary: null,
    sourceUrl: noteUrl(noteId),
    relevance: "related",
    relevanceTerms: [keyword],
    description: text(note.desc),
    ipLocation: text(note.ip_location),
    time,
    lastUpdateTime,
    timeSources: [
      ...(time === null ? [] : [{ value: time, source: "page_state" as const }]),
      ...(lastUpdateTime === null ? [] : [{ value: lastUpdateTime, source: "page_state" as const }])
    ],
    tags: topics,
    imageUrls: images,
    likedCount: count(note.liked_count),
    collectedCount: count(note.collected_count),
    commentCount: count(note.comments_count),
    shareCount: count(note.shared_count)
  };
}

function normalizeComment(value: unknown, fallbackNoteId: string, parentCommentId: string | null): Comment | null {
  const item = record(value);
  const commentId = text(item?.id) ?? text(item?.comment_id);
  const noteId = text(item?.note_id) ?? fallbackNoteId;
  if (!item || !commentId || !noteId) return null;
  const author = record(item.user) ?? record(item.user_info);
  const published = typeof item.time === "number" || typeof item.time === "string" ? String(item.time) : null;
  return {
    commentId,
    noteId,
    parentCommentId,
    content: text(item.content),
    author: { nickname: text(author?.nickname) ?? text(author?.name) },
    publishedText: published,
    ipLocation: text(item.ip_location),
    likedCount: count(item.like_count),
    sourceUrl: noteUrl(noteId)
  };
}

export function normalizeCommentPage(data: unknown, noteId: string): Comment[] {
  const output: Comment[] = [];
  for (const raw of array(record(data)?.comments)) {
    const parent = normalizeComment(raw, noteId, null);
    if (!parent) continue;
    output.push(parent);
    for (const replyRaw of array(record(raw)?.sub_comments)) {
      const reply = normalizeComment(replyRaw, noteId, parent.commentId);
      if (reply) output.push(reply);
    }
  }
  return output;
}
