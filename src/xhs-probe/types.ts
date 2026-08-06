export type ProbeStatus =
  | "success"
  | "partial_success"
  | "auth_required"
  | "blocked"
  | "failed";

export type ErrorType =
  | "auth_required"
  | "page_timeout"
  | "access_blocked"
  | "captcha_required"
  | "field_missing"
  | "structure_changed"
  | "unexpected_error";

export interface ProbeError {
  stage: "auth" | "search" | "detail" | "comments" | "output";
  type: ErrorType;
  summary: string;
  noteId?: string;
  missingFields?: string[];
}

export interface SourceTime {
  value: string | number | null;
  source: "page_text" | "json_ld" | "page_state";
}

export interface Author {
  nickname: string | null;
}

export interface SearchPost {
  noteId: string;
  title: string | null;
  author: Author;
  displayedTime: string | null;
  interactionSummary: string | null;
  sourceUrl: string;
  relevance: "related" | "uncertain";
  relevanceTerms: string[];
}

export interface Post extends SearchPost {
  description: string | null;
  ipLocation: string | null;
  time: string | number | null;
  lastUpdateTime: string | number | null;
  timeSources: SourceTime[];
  tags: string[] | null;
  imageUrls: string[] | null;
  likedCount: number | null;
  collectedCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
}

export interface Comment {
  commentId: string;
  noteId: string;
  parentCommentId: string | null;
  content: string | null;
  author: Author;
  publishedText: string | null;
  ipLocation: string | null;
  likedCount: number | null;
  sourceUrl: string;
}

export interface ProbeReport {
  runId: string;
  keyword: string;
  startedAt: string;
  finishedAt: string;
  status: ProbeStatus;
  limits: { searchResults: number; details: number; detailDelayMs: number };
  counts: {
    rawSearchResults: number;
    relatedSearchResults: number;
    postsBeforeDeduplication: number;
    postsAfterDeduplication: number;
    commentsBeforeDeduplication: number;
    commentsAfterDeduplication: number;
  };
  fieldCoverage: Record<string, { present: number; total: number }>;
  flags: string[];
  errors: ProbeError[];
}

export interface CapturedPayload {
  url: string;
  body: unknown;
}
