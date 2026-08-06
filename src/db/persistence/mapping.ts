import type { Comment, Post } from "../../xhs-probe/types.js";
import { PersistenceError } from "./errors.js";
import type { BrandMatchInput, MappedComment, MappedPost, PersistCommentInput } from "./types.js";

function absoluteDate(value: string | number | null): Date | null {
  if (value === null) return null;
  let milliseconds: number;
  if (typeof value === "number") milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  else if (/^\d{10,13}$/.test(value)) milliseconds = value.length === 10 ? Number(value) * 1_000 : Number(value);
  else milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateExternalId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new PersistenceError("input_invalid", `${field}_missing`);
  return normalized;
}

export function mapProbePost(post: Post): MappedPost {
  return {
    platformPostId: validateExternalId(post.noteId, "note_id"),
    sourceUrl: validateExternalId(post.sourceUrl, "source_url"),
    title: post.title,
    description: post.description,
    authorNickname: post.author.nickname,
    ipLocation: post.ipLocation,
    publishedAt: absoluteDate(post.time),
    platformUpdatedAt: absoluteDate(post.lastUpdateTime),
    displayedTime: post.displayedTime,
    tags: post.tags,
    imageUrls: post.imageUrls,
    likedCount: post.likedCount,
    collectedCount: post.collectedCount,
    commentCount: post.commentCount,
    shareCount: post.shareCount
  };
}

export function mapProbeComment(comment: Comment | PersistCommentInput): MappedComment {
  const persisted = comment as PersistCommentInput;
  return {
    platformCommentId: validateExternalId(comment.commentId, "comment_id"),
    platformParentCommentId: comment.parentCommentId,
    platformTargetCommentId: persisted.targetCommentId ?? null,
    content: comment.content,
    authorNickname: comment.author.nickname,
    publishedText: comment.publishedText,
    ipLocation: comment.ipLocation,
    likedCount: comment.likedCount
  };
}

export function validatePersistPostInput(
  post: Post,
  comments: PersistCommentInput[],
  matches: BrandMatchInput[],
  observedAt: Date
): void {
  validateExternalId(post.noteId, "note_id");
  validateExternalId(post.sourceUrl, "source_url");
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    throw new PersistenceError("input_invalid", "observed_at_invalid");
  }
  for (const comment of comments) {
    validateExternalId(comment.commentId, "comment_id");
    if (comment.noteId !== post.noteId) throw new PersistenceError("input_invalid", "comment_note_mismatch");
  }
  for (const match of matches) {
    if (!Number.isSafeInteger(match.searchTermId) || match.searchTermId <= 0 || !match.matchedTermSnapshot.trim()) {
      throw new PersistenceError("input_invalid", "brand_match_invalid");
    }
  }
}
