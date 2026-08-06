import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium, type Page, type Response } from "playwright";
import { assessRelevance, extractComments, findNoteData, hasTimeConflict, normalizePost, parseInitialStateScript } from "./extract.js";
import { safeErrorSummary, sanitizeUnknown } from "./sanitize.js";
import type { CapturedPayload, Comment, Post, ProbeError, ProbeReport, SearchPost } from "./types.js";
import { parseNoteUrl } from "./url.js";
import { classifyPageText } from "./page-signals.js";

const SEARCH_LIMIT_MAX = 20;
const DETAIL_LIMIT_MAX = 3;
const DETAIL_DELAY_MIN_MS = 2_000;
const DEFAULT_PROFILE = path.resolve(".local", "xhs-profile");
const ARTIFACT_ROOT = path.resolve("artifacts", "xhs-probe");
const LOCK_PATH = path.resolve(".local", "xhs-probe.lock");

interface Options {
  keyword: string;
  searchLimit: number;
  detailLimit: number;
  detailDelayMs: number;
  profileDir: string;
  loginWaitMs: number;
}

function parsePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith("--") && value && !value.startsWith("--")) values.set(key.slice(2), value);
  }
  return {
    keyword: values.get("keyword") ?? "Leader",
    searchLimit: Math.min(parsePositive(values.get("search-limit"), SEARCH_LIMIT_MAX), SEARCH_LIMIT_MAX),
    detailLimit: Math.min(parsePositive(values.get("detail-limit"), DETAIL_LIMIT_MAX), DETAIL_LIMIT_MAX),
    detailDelayMs: Math.max(parsePositive(values.get("detail-delay-ms"), DETAIL_DELAY_MIN_MS), DETAIL_DELAY_MIN_MS),
    profileDir: path.resolve(values.get("profile-dir") ?? DEFAULT_PROFILE),
    loginWaitMs: parsePositive(values.get("login-wait-ms"), 300_000)
  };
}

function runId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as { pid?: unknown };
    if (typeof lock.pid === "number") {
      try {
        process.kill(lock.pid, 0);
        throw new Error("本地浏览器目录正被另一个采集探针占用，请等待它结束后重试。");
      } catch (error) {
        if (error instanceof Error && error.message.includes("正在被另一个采集探针占用")) throw error;
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          throw new Error("本地浏览器目录正被另一个采集探针占用，请等待它结束后重试。");
        }
      }
    }
    await rm(LOCK_PATH, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && error instanceof Error && error.message.includes("正在被另一个采集探针占用")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await rm(LOCK_PATH, { force: true });
  }
  try {
    const handle = await open(LOCK_PATH, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("本地浏览器目录正被另一个采集探针占用，请等待它结束后重试。");
    }
    throw error;
  }
  return () => rm(LOCK_PATH, { force: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(sanitizeUnknown(data), null, 2)}\n`, "utf8");
}

async function pageSignals(page: Page): Promise<{ auth: boolean; captcha: boolean; blocked: boolean; text: string }> {
  const text = (await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "")).slice(0, 5_000);
  const classification = classifyPageText(text);
  return {
    auth: classification.type === "auth_required",
    captcha: classification.type === "captcha_required",
    blocked: classification.type === "access_blocked",
    text
  };
}

async function ensureAuthenticated(page: Page, loginWaitMs: number): Promise<boolean> {
  await page.goto("https://www.xiaohongshu.com/explore", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);
  let signals = await pageSignals(page);
  if (!signals.auth) return true;
  console.log("auth_required：请在已打开的浏览器窗口中完成登录，探针会自动继续。");
  const deadline = Date.now() + loginWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    signals = await pageSignals(page);
    if (!signals.auth) return true;
  }
  return false;
}

async function collectSearch(page: Page, options: Options): Promise<{
  rawCount: number;
  posts: SearchPost[];
}> {
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(options.keyword)}&source=web_explore_feed`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const signals = await pageSignals(page);
  if (signals.auth) throw new Error("auth_required");
  if (signals.captcha) throw new Error("captcha_required");
  if (signals.blocked) throw new Error("access_blocked");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hrefs = await page.evaluate<string[]>(`(() => Array.from(document.querySelectorAll(
      'a[href*="/explore/"], a[href*="/discovery/item/"], a[href^="/search_result/"], a[href*="xiaohongshu.com/search_result/"]'
    )).map(function (anchor) { return anchor.href; }))()`);
    const uniqueNoteIds = new Set(hrefs.map((href) => parseNoteUrl(href)?.noteId).filter(Boolean));
    if (uniqueNoteIds.size >= options.searchLimit) break;
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(800);
  }

  const candidateLimit = Math.min(options.searchLimit * 6, 120);
  const raw = await page.evaluate<Array<{ href: string; cardText: string; title: string | null; lines: string[] }>>(`(() => {
    const anchors = Array.from(document.querySelectorAll(
      'a[href*="/explore/"], a[href*="/discovery/item/"], a[href^="/search_result/"], a[href*="xiaohongshu.com/search_result/"]'
    )).slice(0, ${candidateLimit});
    return anchors.map(function (anchor) {
      const link = anchor;
      const card = link.closest("section") || link.closest('[class*="note-item"]') || (link.parentElement && link.parentElement.parentElement) || link;
      const cardText = ((card && card.innerText) || link.innerText || "").trim();
      const rawLines = cardText.split(/\\n+/);
      const lines = [];
      for (let index = 0; index < rawLines.length; index += 1) {
        const value = rawLines[index].trim();
        if (value) lines.push(value);
      }
      const titleNode = card && card.querySelector ? card.querySelector('.title, [class*="title"]') : null;
      const title = link.getAttribute("title") || (titleNode && titleNode.textContent && titleNode.textContent.trim()) || lines[0] || null;
      return { href: link.href, cardText, title, lines };
    });
  })()`);

  const candidatesByNoteId = new Map<string, { href: string; cardText: string; title: string | null; lines: string[] }>();
  const candidateScore = (item: { cardText: string; title: string | null; lines: string[] }): number =>
    (item.title ? 100 : 0) + Math.min(item.cardText.length, 500) + item.lines.length * 20;
  for (const item of raw) {
    const parsed = parseNoteUrl(item.href);
    if (!parsed) continue;
    const current = candidatesByNoteId.get(parsed.noteId);
    if (!current || candidateScore(item) > candidateScore(current)) candidatesByNoteId.set(parsed.noteId, item);
  }

  const posts: SearchPost[] = [];
  for (const item of [...candidatesByNoteId.values()].slice(0, options.searchLimit)) {
    const parsed = parseNoteUrl(item.href);
    if (!parsed) continue;
    const relevance = assessRelevance(item.cardText);
    posts.push({
      noteId: parsed.noteId,
      title: item.title,
      author: { nickname: item.lines.at(-2) ?? null },
      displayedTime: item.lines.find((line) => /\d{1,2}[-月/]\d{1,2}|天前|小时前|分钟前|昨天|刚刚/.test(line)) ?? null,
      interactionSummary: item.lines.at(-1) ?? null,
      sourceUrl: parsed.canonicalUrl,
      ...relevance
    });
  }
  return { rawCount: candidatesByNoteId.size, posts };
}

async function openDetailFromSearch(
  searchPage: Page,
  noteId: string
): Promise<{ detailPage: Page | null; openedNewPage: boolean; reason?: string }> {
  const links = searchPage.locator(`a[href*="/${noteId}"]`);
  const count = await links.count();
  let selected: ReturnType<Page["locator"]> | null = null;
  let selectedScore = -1;
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const [innerText, title] = await Promise.all([
      link.innerText().catch(() => ""),
      link.getAttribute("title").catch(() => null)
    ]);
    const score = (title ? 1_000 : 0) + innerText.trim().length;
    if (score > selectedScore) {
      selected = link;
      selectedScore = score;
    }
  }
  if (!selected) return { detailPage: null, openedNewPage: false, reason: "没有找到可见的帖子链接。" };

  const pagesBeforeClick = new Set(searchPage.context().pages());
  const searchUrlBeforeClick = searchPage.url();
  try {
    await selected.click({ timeout: 10_000 });
  } catch (error) {
    return { detailPage: null, openedNewPage: false, reason: `点击帖子链接失败：${safeErrorSummary(error)}` };
  }

  await Promise.race([
    searchPage.waitForURL(new RegExp(noteId), { timeout: 5_000 }).then(() => undefined).catch(() => undefined),
    searchPage.locator('#detail-title, .note-detail-mask, [class*="note-detail"]').first()
      .waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined)
  ]);
  await searchPage.waitForTimeout(500);
  const newPage = searchPage.context().pages().find((candidate) => !pagesBeforeClick.has(candidate));
  if (newPage) {
    await newPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    return { detailPage: newPage, openedNewPage: true };
  }
  const detailVisible = await searchPage.locator('#detail-title, .note-detail-mask, [class*="note-detail"]').first()
    .isVisible().catch(() => false);
  if (searchPage.url() !== searchUrlBeforeClick || detailVisible) {
    return { detailPage: searchPage, openedNewPage: false };
  }
  return { detailPage: null, openedNewPage: false, reason: "点击后页面地址和详情内容均未发生变化。" };
}

async function returnToSearch(searchPage: Page, searchUrl: string, detailPage: Page, openedNewPage: boolean): Promise<void> {
  if (openedNewPage) {
    await detailPage.close().catch(() => undefined);
    return;
  }
  await searchPage.keyboard.press("Escape").catch(() => undefined);
  await searchPage.waitForTimeout(300);
  if (searchPage.url() === searchUrl) return;
  await searchPage.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
  if (searchPage.url() !== searchUrl) {
    await searchPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  await searchPage.waitForTimeout(1_000);
}

function captureJson(response: Response, destination: CapturedPayload[], pending: Set<Promise<void>>): void {
  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("application/json") || !/xiaohongshu\.com/.test(response.url())) return;
  const task = response.json().then((body: unknown) => {
    if (destination.length < 100) destination.push({ url: response.url().split("?")[0] ?? response.url(), body });
  }).catch(() => undefined).finally(() => pending.delete(task));
  pending.add(task);
}

async function waitForCapturedResponses(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

async function readDom(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate<Record<string, unknown>>(`(() => {
    const body = document.body.innerText;
    const displayedMatch = body.match(/(?:编辑于|发布于)\\s*([^\\n]+)/);
    const locationMatch = body.match(/IP属地[:：]?\\s*([^\\n]+)/);
    const titleNode = document.querySelector("#detail-title, .title, h1");
    const descriptionNode = document.querySelector("#detail-desc, .desc, .note-content");
    return {
      title: titleNode && titleNode.textContent ? titleNode.textContent.trim() : null,
      description: descriptionNode && descriptionNode.textContent ? descriptionNode.textContent.trim() : null,
      displayedTime: displayedMatch && displayedMatch[1] ? displayedMatch[1].trim() : null,
      ipLocation: locationMatch && locationMatch[1] ? locationMatch[1].trim() : null
    };
  })()`);
}

async function readJsonLd(page: Page): Promise<Record<string, unknown> | null> {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  for (const script of scripts) {
    try {
      const value = JSON.parse(script) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* invalid JSON-LD is reported through missing fields */ }
  }
  return null;
}

async function readInitialState(page: Page): Promise<Record<string, unknown> | null> {
  const scripts = await page.locator("script").allTextContents();
  for (const script of scripts) {
    const state = parseInitialStateScript(script);
    if (state) return state;
  }
  return null;
}

function missingPostFields(post: Post): string[] {
  const required: (keyof Post)[] = [
    "title", "description", "author", "ipLocation", "time", "lastUpdateTime", "tags", "imageUrls",
    "likedCount", "collectedCount", "commentCount", "shareCount", "sourceUrl"
  ];
  return required.filter((key) => {
    const value = post[key];
    return value === null || value === undefined || (key === "author" && post.author.nickname === null);
  });
}

function coverage(posts: Post[], comments: Comment[]): ProbeReport["fieldCoverage"] {
  const result: ProbeReport["fieldCoverage"] = {};
  const add = (prefix: string, rows: Record<string, unknown>[]) => {
    const keys = new Set(rows.flatMap((row) => Object.keys(row)));
    for (const key of keys) result[`${prefix}.${key}`] = {
      present: rows.filter((row) => row[key] !== null && row[key] !== undefined).length,
      total: rows.length
    };
  };
  add("post", posts as unknown as Record<string, unknown>[]);
  add("comment", comments as unknown as Record<string, unknown>[]);
  return result;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const id = runId();
  const outputDir = path.join(ARTIFACT_ROOT, id);
  const startedAt = new Date().toISOString();
  const errors: ProbeError[] = [];
  const flags: string[] = [];
  let searchPosts: SearchPost[] = [];
  let rawSearchResultCount = 0;
  const postsBeforeDeduplication: Post[] = [];
  const commentsBeforeDeduplication: Comment[] = [];
  let releaseLock: (() => Promise<void>) | undefined;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

  try {
    releaseLock = await acquireLock();
    await mkdir(options.profileDir, { recursive: true });
    context = await chromium.launchPersistentContext(options.profileDir, {
      headless: false,
      viewport: { width: 1440, height: 960 },
      locale: "zh-CN"
    });
    const page = context.pages()[0] ?? await context.newPage();
    if (!(await ensureAuthenticated(page, options.loginWaitMs))) {
      errors.push({ stage: "auth", type: "auth_required", summary: "等待用户登录超时，未开始搜索。" });
    } else {
      try {
        const search = await collectSearch(page, options);
        rawSearchResultCount = search.rawCount;
        searchPosts = search.posts;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unexpected_error";
        const type = message === "captcha_required" || message === "access_blocked" || message === "auth_required"
          ? message : message.includes("Timeout") ? "page_timeout" : "structure_changed";
        errors.push({ stage: "search", type, summary: safeErrorSummary(error) });
      }

      const targets = [...searchPosts.filter((post) => post.relevance === "related"), ...searchPosts.filter((post) => post.relevance === "uncertain")]
        .slice(0, options.detailLimit);
      const searchUrl = page.url();
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        if (!target) continue;
        if (index > 0) await page.waitForTimeout(options.detailDelayMs);
        const payloads: CapturedPayload[] = [];
        const pendingResponses = new Set<Promise<void>>();
        const listener = (response: Response) => captureJson(response, payloads, pendingResponses);
        context.on("response", listener);
        let detailPage: Page | null = null;
        let openedNewPage = false;
        try {
          const opened = await openDetailFromSearch(page, target.noteId);
          detailPage = opened.detailPage;
          openedNewPage = opened.openedNewPage;
          if (!detailPage) {
            errors.push({
              stage: "detail",
              type: "structure_changed",
              summary: `帖子 ${target.noteId} 无法通过搜索结果打开：${opened.reason ?? "未知原因"}`,
              noteId: target.noteId
            });
            continue;
          }
          await detailPage.waitForTimeout(2_000);
          const signals = await pageSignals(detailPage);
          if (signals.auth || signals.captcha || signals.blocked) {
            const type = signals.auth ? "auth_required" : signals.captcha ? "captcha_required" : "access_blocked";
            errors.push({ stage: "detail", type, summary: `读取帖子 ${target.noteId} 时页面要求登录或验证。`, noteId: target.noteId });
            break;
          }
          await detailPage.mouse.wheel(0, 700);
          await detailPage.waitForTimeout(1_000);
          context.off("response", listener);
          await waitForCapturedResponses(pendingResponses);
          const [dom, jsonLd, initialState] = await Promise.all([readDom(detailPage), readJsonLd(detailPage), readInitialState(detailPage)]);
          const data = findNoteData(payloads, target.noteId, initialState);
          const post = normalizePost(target, data, dom, jsonLd);
          postsBeforeDeduplication.push(post);
          const commentSources: CapturedPayload[] = initialState
            ? [{ url: "page-initial-state", body: initialState }, ...payloads]
            : payloads;
          const extractedComments = extractComments(commentSources, target.noteId, target.sourceUrl);
          commentsBeforeDeduplication.push(...extractedComments);
          if ((post.commentCount ?? 0) > 0 && extractedComments.length === 0) errors.push({
            stage: "comments",
            type: "structure_changed",
            summary: `帖子 ${target.noteId} 显示有评论，但没有从首批响应中解析出评论。`,
            noteId: target.noteId,
            missingFields: ["comments"]
          });
          const missingFields = missingPostFields(post);
          if (missingFields.length) errors.push({
            stage: "detail", type: "field_missing", summary: `帖子 ${target.noteId} 存在缺失字段。`, noteId: target.noteId, missingFields
          });
          if (hasTimeConflict(post.timeSources)) flags.push(`time_conflict:${target.noteId}`);
          try {
            const commentPayloads = commentSources.filter((payload) =>
              /\/comment(?:\/|_|\?|$)/i.test(payload.url)
              || extractComments([payload], target.noteId, target.sourceUrl).length > 0
            );
            await writeJson(path.join(outputDir, "raw", `${target.noteId}.json`), {
              noteId: target.noteId,
              sourceUrl: target.sourceUrl,
              dom,
              jsonLd,
              extractedState: data,
              capturedApiUrls: payloads.map((payload) => payload.url),
              commentPayloads
            });
          } catch (error) {
            errors.push({ stage: "output", type: "unexpected_error", summary: safeErrorSummary(error), noteId: target.noteId });
          }
        } catch (error) {
          errors.push({
            stage: "detail",
            type: error instanceof Error && error.name === "TimeoutError" ? "page_timeout" : "unexpected_error",
            summary: safeErrorSummary(error),
            noteId: target.noteId
          });
        } finally {
          context.off("response", listener);
          if (detailPage) await returnToSearch(page, searchUrl, detailPage, openedNewPage).catch((error) => {
            errors.push({ stage: "detail", type: "structure_changed", summary: safeErrorSummary(error), noteId: target.noteId });
          });
        }
      }
    }
  } catch (error) {
    errors.push({ stage: "output", type: "unexpected_error", summary: safeErrorSummary(error) });
  } finally {
    await context?.close().catch(() => undefined);
    await releaseLock?.().catch(() => undefined);
  }

  const posts = [...new Map(postsBeforeDeduplication.map((post) => [post.noteId, post])).values()];
  const comments = [...new Map(commentsBeforeDeduplication.map((comment) => [comment.commentId, comment])).values()];
  const deriveStatus = (): ProbeReport["status"] => {
    const authError = errors.some((error) => error.type === "auth_required");
    const blockingError = errors.some((error) => error.type === "access_blocked" || error.type === "captcha_required");
    return authError && posts.length === 0 ? "auth_required"
      : blockingError && posts.length === 0 ? "blocked"
      : errors.length > 0 && (searchPosts.length > 0 || posts.length > 0) ? "partial_success"
      : errors.length > 0 ? "failed" : "success";
  };
  const dataWrites = await Promise.allSettled([
    writeJson(path.join(outputDir, "posts.json"), posts),
    writeJson(path.join(outputDir, "comments.json"), comments),
    writeJson(path.join(outputDir, "raw", "search-results.json"), searchPosts)
  ]);
  for (const result of dataWrites) {
    if (result.status === "rejected") errors.push({ stage: "output", type: "unexpected_error", summary: safeErrorSummary(result.reason) });
  }
  const report: ProbeReport = {
    runId: id,
    keyword: options.keyword,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: deriveStatus(),
    limits: { searchResults: options.searchLimit, details: options.detailLimit, detailDelayMs: options.detailDelayMs },
    counts: {
      rawSearchResults: rawSearchResultCount,
      relatedSearchResults: searchPosts.filter((post) => post.relevance === "related").length,
      postsBeforeDeduplication: postsBeforeDeduplication.length,
      postsAfterDeduplication: posts.length,
      commentsBeforeDeduplication: commentsBeforeDeduplication.length,
      commentsAfterDeduplication: comments.length
    },
    fieldCoverage: coverage(posts, comments),
    flags: [...new Set(flags)],
    errors
  };
  try {
    await writeJson(path.join(outputDir, "report.json"), report);
  } catch (error) {
    errors.push({ stage: "output", type: "unexpected_error", summary: safeErrorSummary(error) });
    report.errors = errors;
    report.status = deriveStatus();
    await writeJson(path.join(ARTIFACT_ROOT, `${id}-report.json`), report).catch(() => undefined);
  }
  console.log(`探针结束：${report.status}。结果目录：${outputDir}`);
  if (report.status === "auth_required" || report.status === "blocked" || report.status === "failed") process.exitCode = 1;
}

void main();
