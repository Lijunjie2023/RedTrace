import type { Comment, Post } from "../../xhs-probe/types.js";

export type CollectionTaskStatus = "queued" | "running" | "success" | "partial_success" | "failed";
export type CollectionTriggerType = "manual" | "scheduled" | "retry";

export interface CreateTaskInput {
  dataSourceId: number;
  brandId: number;
  triggerType: Exclude<CollectionTriggerType, "retry">;
}

export interface BrandMatchInput {
  searchTermId: number;
  matchedTermSnapshot: string;
}

export interface PersistCommentInput extends Comment {
  targetCommentId?: string | null;
  rawPayload?: unknown;
}

export interface PersistPostInput {
  post: Post;
  comments: PersistCommentInput[];
  matches: BrandMatchInput[];
  observedAt: Date;
  rawPayload?: unknown;
}

export interface PersistBatchInput {
  taskId: number;
  dataSourceId: number;
  brandId: number;
  items: PersistPostInput[];
}

export interface PersistBatchResult {
  taskId: number;
  status: Extract<CollectionTaskStatus, "success" | "partial_success" | "failed">;
  succeededPostCount: number;
  failedPostCount: number;
  failures: Array<{ noteId: string; errorType: PersistenceErrorType }>;
}

export type PersistenceErrorType =
  | "input_invalid"
  | "task_state_conflict"
  | "raw_snapshot_sanitize_failed"
  | "database_write_failed";

export interface MappedPost {
  platformPostId: string;
  sourceUrl: string;
  title: string | null;
  description: string | null;
  authorNickname: string | null;
  ipLocation: string | null;
  publishedAt: Date | null;
  platformUpdatedAt: Date | null;
  displayedTime: string | null;
  tags: string[] | null;
  imageUrls: string[] | null;
  likedCount: number | null;
  collectedCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
}

export interface MappedComment {
  platformCommentId: string;
  platformParentCommentId: string | null;
  platformTargetCommentId: string | null;
  content: string | null;
  authorNickname: string | null;
  publishedText: string | null;
  ipLocation: string | null;
  likedCount: number | null;
}
