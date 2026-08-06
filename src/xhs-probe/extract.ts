import type { CapturedPayload, Comment, Post, SearchPost, SourceTime } from "./types.js";

const BRAND_TERMS = ["Leader", "统帅", "海尔"];
const CATEGORY_TERMS = [
  "家电", "冰箱", "洗衣机", "空调", "热水器", "电视", "冷柜", "厨电", "烤箱", "洗碗机", "净水器"
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function first(source: Record<string, unknown> | null, keys: string[]): unknown {
  if (!source) return null;
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return null;
}

export function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

export function count(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/,/g, "");
  const match = normalized.match(/([\d.]+)\s*([万千wWkK]?)/);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2]?.toLowerCase();
  return Math.round(number * (unit === "万" || unit === "w" ? 10_000 : unit === "千" || unit === "k" ? 1_000 : 1));
}

export function assessRelevance(value: string): Pick<SearchPost, "relevance" | "relevanceTerms"> {
  const relevanceTerms = [...BRAND_TERMS, ...CATEGORY_TERMS].filter((term) =>
    value.toLocaleLowerCase().includes(term.toLocaleLowerCase())
  );
  const hasBrand = BRAND_TERMS.some((term) => relevanceTerms.includes(term));
  const hasCategory = CATEGORY_TERMS.some((term) => relevanceTerms.includes(term));
  return { relevance: hasBrand && hasCategory ? "related" : "uncertain", relevanceTerms };
}

export function walk(value: unknown, visit: (record: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 14 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walk(child, visit, depth + 1);
}

function replaceUndefinedOutsideStrings(source: string): string {
  let result = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      index += 1;
      continue;
    }
    if (source.startsWith("undefined", index)) {
      const before = source[index - 1];
      const after = source[index + "undefined".length];
      const boundaryBefore = before === undefined || !/[a-zA-Z0-9_$]/.test(before);
      const boundaryAfter = after === undefined || !/[a-zA-Z0-9_$]/.test(after);
      if (boundaryBefore && boundaryAfter) {
        result += "null";
        index += "undefined".length;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

export function parseInitialStateScript(script: string): Record<string, unknown> | null {
  const marker = "window.__INITIAL_STATE__";
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) return null;
  const assignmentIndex = script.indexOf("=", markerIndex + marker.length);
  if (assignmentIndex < 0) return null;
  let source = script.slice(assignmentIndex + 1).trim();
  if (source.endsWith(";")) source = source.slice(0, -1).trim();
  try {
    const parsed = JSON.parse(replaceUndefinedOutsideStrings(source)) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function authorOf(record: Record<string, unknown> | null): { nickname: string | null } {
  const user = asRecord(first(record, ["user", "author", "userInfo", "user_info"]));
  return { nickname: text(first(user, ["nickname", "nickName", "name"])) };
}

function noteCandidate(record: Record<string, unknown>): Record<string, unknown> | null {
  const candidate = asRecord(first(record, ["noteCard", "note", "noteDetail"]));
  if (candidate) return candidate;
  return first(record, ["noteId", "note_id"]) ? record : null;
}

function noteCandidateScore(record: Record<string, unknown>): number {
  let score = 0;
  if (text(first(record, ["title", "displayTitle"]))) score += 10;
  if (text(first(record, ["desc", "description"]))) score += 8;
  if (asRecord(first(record, ["interactInfo", "interact_info", "interaction"]))) score += 8;
  if (Array.isArray(first(record, ["imageList", "images"]))) score += 4;
  if (Array.isArray(first(record, ["tagList", "tags"]))) score += 2;
  if (asRecord(first(record, ["user", "author", "userInfo", "user_info"]))) score += 2;
  if (first(record, ["time", "publishTime", "publish_time"]) !== null) score += 1;
  return score;
}

export function findNoteData(
  payloads: CapturedPayload[],
  noteId: string,
  initialState: Record<string, unknown> | null = null
): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  let resultScore = -1;
  const sources: unknown[] = initialState ? [initialState, ...payloads.map((payload) => payload.body)] : payloads.map((payload) => payload.body);
  for (const source of sources) {
    walk(source, (record) => {
      const candidate = noteCandidate(record);
      if (!candidate || text(first(candidate, ["noteId", "note_id", "id"])) !== noteId) return;
      const score = noteCandidateScore(candidate);
      if (score > resultScore) {
        result = candidate;
        resultScore = score;
      }
    });
  }
  return result;
}

export function normalizePost(
  search: SearchPost,
  data: Record<string, unknown> | null,
  dom: Record<string, unknown>,
  jsonLd: Record<string, unknown> | null
): Post {
  const interact = asRecord(first(data, ["interactInfo", "interact_info", "interaction"]));
  const images = first(data, ["imageList", "images"]);
  const dataImageUrls: string[] | null = Array.isArray(images)
    ? images.map((image) => {
        const item = asRecord(image);
        return text(first(item, ["urlDefault", "url", "urlPre"]));
      }).filter((item): item is string => Boolean(item))
    : null;
  const tagsValue = first(data, ["tagList", "tags"]);
  const dataTags: string[] | null = Array.isArray(tagsValue)
    ? tagsValue.map((tag) => text(first(asRecord(tag), ["name", "title"])) ?? text(tag)).filter((item): item is string => Boolean(item))
    : null;
  const timeSources: SourceTime[] = [];
  const displayedTime = search.displayedTime ?? text(dom.displayedTime);
  if (displayedTime) timeSources.push({ value: displayedTime, source: "page_text" });
  const jsonLdTime = first(jsonLd, ["datePublished", "dateCreated"]);
  if (typeof jsonLdTime === "string" || typeof jsonLdTime === "number") timeSources.push({ value: jsonLdTime, source: "json_ld" });
  const stateTime = first(data, ["time", "publishTime", "publish_time"]);
  if (typeof stateTime === "string" || typeof stateTime === "number") timeSources.push({ value: stateTime, source: "page_state" });

  const jsonLdTitle = text(first(jsonLd, ["headline", "name"]))?.replace(/\s*-\s*小红书\s*$/, "") ?? null;
  const jsonLdDescription = text(first(jsonLd, ["description", "articleBody"]));
  const jsonLdAuthorRecord = asRecord(first(jsonLd, ["author", "creator"]));
  const jsonLdAuthor = { nickname: text(first(jsonLdAuthorRecord, ["name", "nickname"])) };
  const jsonLdImages = first(jsonLd, ["image", "images"]);
  const jsonLdImageUrls: string[] | null = Array.isArray(jsonLdImages)
    ? jsonLdImages.map((image) => text(image) ?? text(first(asRecord(image), ["url", "contentUrl"]))).filter((item): item is string => Boolean(item))
    : text(jsonLdImages) ? [text(jsonLdImages) as string]
      : asRecord(jsonLdImages) ? [text(first(asRecord(jsonLdImages), ["url", "contentUrl"]))].filter((item): item is string => Boolean(item))
        : null;
  const dataAuthor = authorOf(data);
  const title = text(first(data, ["title", "displayTitle"])) ?? jsonLdTitle ?? search.title ?? text(dom.title);
  const description = text(first(data, ["desc", "description", "content"])) ?? jsonLdDescription ?? text(dom.description);
  const descriptionTags = description
    ? [...description.matchAll(/#([^#\n]+?)\[话题\]#/g)].map((match) => match[1]?.trim()).filter((item): item is string => Boolean(item))
    : [];
  const tags = dataTags && dataTags.length > 0
    ? dataTags
    : descriptionTags.length > 0 ? [...new Set(descriptionTags)] : dataTags;
  const author = dataAuthor.nickname ? dataAuthor : jsonLdAuthor.nickname ? jsonLdAuthor : search.author;
  const imageUrls = dataImageUrls ?? jsonLdImageUrls;
  const relevance = assessRelevance(`${title ?? ""} ${description ?? ""} ${search.author.nickname ?? ""}`);
  return {
    ...search,
    ...relevance,
    title,
    author,
    displayedTime,
    description,
    ipLocation: text(first(data, ["ipLocation", "ip_location"])) ?? text(dom.ipLocation),
    time: (stateTime as string | number | null) ?? jsonLdTime as string | number | null,
    lastUpdateTime: first(data, ["lastUpdateTime", "last_update_time", "updateTime"]) as string | number | null,
    timeSources,
    tags: tags === null ? null : [...new Set(tags)],
    imageUrls: imageUrls === null ? null : [...new Set(imageUrls)],
    likedCount: count(first(interact, ["likedCount", "liked_count", "likes"])),
    collectedCount: count(first(interact, ["collectedCount", "collected_count", "collects"])),
    commentCount: count(first(interact, ["commentCount", "comment_count", "comments"])),
    shareCount: count(first(interact, ["shareCount", "share_count", "shares"]))
  };
}

function absoluteTime(value: string | number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 100_000_000_000 ? value * 1_000 : value;
  if (typeof value !== "string" || /刚刚|分钟前|小时前|天前|昨天|前天/.test(value)) return null;
  if (/^\d{10,13}$/.test(value)) {
    const numeric = Number(value);
    return value.length === 10 ? numeric * 1_000 : numeric;
  }
  if (!/\d{4}[-/.年]\d{1,2}/.test(value)) return null;
  const parsed = Date.parse(value.replace(/年|月/g, "-").replace(/日/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasTimeConflict(timeSources: SourceTime[], toleranceMs = 2 * 60 * 60 * 1_000): boolean {
  const absoluteTimes = timeSources
    .map((item) => absoluteTime(item.value))
    .filter((value): value is number => value !== null);
  if (absoluteTimes.length < 2) return false;
  return Math.max(...absoluteTimes) - Math.min(...absoluteTimes) > toleranceMs;
}

export function extractComments(payloads: CapturedPayload[], noteId: string, sourceUrl: string): Comment[] {
  const comments: Comment[] = [];
  const visit = (value: unknown, contextualParentId: string | null, inCommentTree: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, contextualParentId, inCommentTree);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const explicitCommentId = text(first(record, ["commentId", "comment_id"]));
    const commentId = explicitCommentId ?? (inCommentTree ? text(record.id) : null);
    const content = text(first(record, ["content", "text"]));
    const isComment = Boolean(commentId && content && (explicitCommentId || inCommentTree));
    let currentParentId = contextualParentId;
    if (isComment && commentId) {
      const targetComment = asRecord(first(record, ["targetComment", "target_comment"]));
      const declaredRootId = text(first(record, ["rootCommentId", "root_comment_id"]));
      const declaredParentId = text(first(record, ["parentCommentId", "parent_comment_id"]));
      const targetCommentId = text(first(targetComment, ["commentId", "comment_id", "id"]));
      const parentCandidate = declaredRootId ?? contextualParentId ?? declaredParentId ?? targetCommentId;
      const parentCommentId = parentCandidate && parentCandidate !== commentId ? parentCandidate : null;
      comments.push({
        commentId,
        noteId,
        parentCommentId,
        content,
        author: authorOf(record),
        publishedText: text(first(record, ["showTime", "show_time", "createTime", "create_time"])),
        ipLocation: text(first(record, ["ipLocation", "ip_location"])),
        likedCount: count(first(record, ["likeCount", "like_count", "likedCount"])),
        sourceUrl
      });
      currentParentId = parentCommentId ?? commentId;
    }

    for (const [key, child] of Object.entries(record)) {
      if (key === "comments") visit(child, contextualParentId, true);
      else if (key === "subComments" || key === "sub_comments") visit(child, currentParentId, true);
      else visit(child, contextualParentId, inCommentTree);
    }
  };
  for (const payload of payloads) {
    visit(payload.body, null, false);
  }
  return comments;
}
