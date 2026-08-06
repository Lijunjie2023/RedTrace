import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRelevance,
  count,
  extractComments,
  findNoteData,
  hasTimeConflict,
  normalizePost,
  parseInitialStateScript
} from "../src/xhs-probe/extract.js";
import { sanitizeText, sanitizeUnknown } from "../src/xhs-probe/sanitize.js";
import type { CapturedPayload, SearchPost } from "../src/xhs-probe/types.js";
import { parseNoteUrl } from "../src/xhs-probe/url.js";
import { classifyPageText } from "../src/xhs-probe/page-signals.js";

test("互动数量支持中文单位和英文单位", () => {
  assert.equal(count("1.1万"), 11_000);
  assert.equal(count("2.5k"), 2_500);
  assert.equal(count("1,234"), 1_234);
  assert.equal(count("赞"), null);
});

test("Leader只有与品牌或品类同时出现时才判定相关", () => {
  assert.equal(assessRelevance("职场 leader 如何管理团队").relevance, "uncertain");
  assert.equal(assessRelevance("Leader统帅三筒洗衣机").relevance, "related");
  assert.equal(assessRelevance("海尔空调售后体验").relevance, "related");
});

test("能够从嵌套响应中定位帖子原始数据", () => {
  const payloads: CapturedPayload[] = [{
    url: "https://edith.xiaohongshu.com/api/sns/web/v1/feed",
    body: { data: { items: [{ noteCard: { noteId: "note-1", desc: "正文" } }] } }
  }];
  assert.deepEqual(findNoteData(payloads, "note-1"), { noteId: "note-1", desc: "正文" });
});

test("帖子候选不会被同note_id的评论记录覆盖", () => {
  const payloads: CapturedPayload[] = [{
    url: "https://edith.xiaohongshu.com/api/sns/web/v1/feed",
    body: {
      data: {
        items: [{ noteCard: { noteId: "note-1", title: "正确标题", desc: "完整正文", interactInfo: { commentCount: "18" } } }],
        comments: [{ id: "comment-1", note_id: "note-1", content: "评论正文", user_info: { nickname: "评论者" } }]
      }
    }
  }];
  assert.deepEqual(findNoteData(payloads, "note-1"), {
    noteId: "note-1",
    title: "正确标题",
    desc: "完整正文",
    interactInfo: { commentCount: "18" }
  });
});

test("实测搜索结果链接能够解析成无Token规范链接", () => {
  assert.deepEqual(
    parseNoteUrl("https://www.xiaohongshu.com/search_result/6a7301f90000000025013a75?xsec_token=secret&xsec_source=pc_search"),
    {
      noteId: "6a7301f90000000025013a75",
      canonicalUrl: "https://www.xiaohongshu.com/explore/6a7301f90000000025013a75"
    }
  );
  assert.equal(parseNoteUrl("https://www.xiaohongshu.com/search_result?keyword=Leader"), null);
  assert.equal(parseNoteUrl("https://example.com/explore/6a7301f90000000025013a75"), null);
});

test("安全解析INITIAL_STATE且不执行脚本内容", () => {
  const state = parseInitialStateScript(
    'window.__INITIAL_STATE__={"note":{"noteDetail":{"noteId":"note-1","desc":"undefined保留","optional":undefined}}};'
  );
  assert.deepEqual(state, {
    note: { noteDetail: { noteId: "note-1", desc: "undefined保留", optional: null } }
  });
  assert.equal(parseInitialStateScript("window.__INITIAL_STATE__=alert(1)"), null);
});

test("帖子标准化保留三个时间来源与互动数据", () => {
  const search: SearchPost = {
    noteId: "note-1",
    title: "Leader统帅洗衣机",
    author: { nickname: "作者" },
    displayedTime: "昨天 18:37",
    interactionSummary: "9",
    sourceUrl: "https://www.xiaohongshu.com/explore/note-1",
    relevance: "related",
    relevanceTerms: ["Leader", "统帅", "洗衣机"]
  };
  const post = normalizePost(
    search,
    {
      noteId: "note-1",
      desc: "海尔统帅洗衣机故障",
      ipLocation: "福建",
      time: 1_785_922_041_000,
      lastUpdateTime: 1_785_926_231_000,
      user: { nickname: "Shylie" },
      tagList: [{ name: "三筒洗衣机" }],
      imageList: [{ urlDefault: "https://example.com/1.webp" }],
      interactInfo: {
        likedCount: "9",
        collectedCount: "3",
        commentCount: "22",
        shareCount: "12"
      }
    },
    { displayedTime: "昨天 18:37", title: "Leader统帅洗衣机" },
    { datePublished: "2026-08-06T03:06:34.795Z" }
  );
  assert.equal(post.author.nickname, "Shylie");
  assert.equal(post.commentCount, 22);
  assert.deepEqual(post.timeSources.map((item) => item.source), ["page_text", "json_ld", "page_state"]);
});

test("帖子标准化优先使用结构化元数据而非不可靠DOM候选", () => {
  const search: SearchPost = {
    noteId: "note-jsonld",
    title: "搜索结果正确标题",
    author: { nickname: "搜索作者" },
    displayedTime: "昨天 18:37",
    interactionSummary: "9",
    sourceUrl: "https://www.xiaohongshu.com/explore/note-jsonld",
    relevance: "related",
    relevanceTerms: ["Leader", "统帅", "洗衣机"]
  };
  const post = normalizePost(
    search,
    { noteId: "note-jsonld", tagList: [] },
    { title: "页面其他区域标题", description: "一条评论", displayedTime: "备案日期" },
    {
      headline: "避雷海尔Leader统帅三筒洗衣机 - 小红书",
      description: "完整帖子正文#海尔洗烘[话题]# #三筒洗衣机[话题]#",
      author: { name: "Shylie" },
      image: ["https://example.com/1.webp"]
    }
  );
  assert.equal(post.title, "避雷海尔Leader统帅三筒洗衣机");
  assert.equal(post.description, "完整帖子正文#海尔洗烘[话题]# #三筒洗衣机[话题]#");
  assert.equal(post.author.nickname, "Shylie");
  assert.deepEqual(post.imageUrls, ["https://example.com/1.webp"]);
  assert.deepEqual(post.tags, ["海尔洗烘", "三筒洗衣机"]);
  assert.equal(post.displayedTime, "昨天 18:37");
});

test("评论提取保留父评论关系并可由评论ID去重", () => {
  const payloads: CapturedPayload[] = [{
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/comment/page",
    body: {
      comments: [
        { commentId: "root-1", content: "一级评论", userInfo: { nickname: "甲" }, likeCount: "2" },
        { commentId: "reply-1", rootCommentId: "root-1", content: "二级回复", userInfo: { nickname: "乙" } }
      ]
    }
  }];
  const comments = extractComments(payloads, "note-1", "https://example.com/note-1");
  assert.equal(comments[0]?.parentCommentId, null);
  assert.equal(comments[1]?.parentCommentId, "root-1");
});

test("评论提取兼容真实接口id、sub_comments和target_comment", () => {
  const payloads: CapturedPayload[] = [{
    url: "https://edith.xiaohongshu.com/api/sns/web/v2/comment/page",
    body: {
      data: {
        comments: [{
          id: "root-real",
          content: "一级评论",
          user_info: { nickname: "甲" },
          sub_comments: [{
            id: "reply-real",
            content: "二级回复",
            user_info: { nickname: "乙" },
            target_comment: { id: "another-reply" }
          }]
        }]
      }
    }
  }];
  const comments = extractComments(payloads, "note-real", "https://example.com/note-real");
  assert.deepEqual(
    comments.map((item) => ({ id: item.commentId, parent: item.parentCommentId, author: item.author.nickname })),
    [
      { id: "root-real", parent: null, author: "甲" },
      { id: "reply-real", parent: "root-real", author: "乙" }
    ]
  );
});

test("相对展示时间不与绝对时间直接判定冲突", () => {
  assert.equal(hasTimeConflict([
    { source: "page_text", value: "昨天 18:37" },
    { source: "json_ld", value: "2026-08-05T10:37:00.000Z" },
    { source: "page_state", value: 1_785_922_620_000 }
  ]), false);
  assert.equal(hasTimeConflict([
    { source: "json_ld", value: "2026-08-05T10:37:00.000Z" },
    { source: "page_state", value: Date.parse("2026-08-06T10:37:00.000Z") }
  ]), true);
});

test("帖子原始数组字段缺失时保留null而非伪装成空数组", () => {
  const search: SearchPost = {
    noteId: "note-empty",
    title: "Leader统帅冰箱",
    author: { nickname: "作者" },
    displayedTime: null,
    interactionSummary: null,
    sourceUrl: "https://www.xiaohongshu.com/explore/note-empty",
    relevance: "related",
    relevanceTerms: ["Leader", "统帅", "冰箱"]
  };
  const post = normalizePost(search, { noteId: "note-empty" }, {}, null);
  assert.equal(post.tags, null);
  assert.equal(post.imageUrls, null);
});

test("输出脱敏会移除敏感键并遮盖手机号和查询Token", () => {
  const source = {
    cookie: "secret-cookie",
    nested: {
      xsecToken: "secret-token",
      content: "联系电话13800138000",
      sourceUrl: "https://example.com/a?xsec_token=abc123&foo=1"
    }
  };
  const sanitized = sanitizeUnknown(source) as Record<string, unknown>;
  assert.equal("cookie" in sanitized, false);
  assert.deepEqual(sanitized.nested, {
    content: "联系电话[redacted-phone]",
    sourceUrl: "https://example.com/a?xsec_token=[redacted]&foo=1"
  });
  assert.equal(sanitizeText("验证码发到13900139000"), "验证码发到[redacted-phone]");
  assert.equal(
    sanitizeText("6a73ff14000000002a02c444"),
    "6a73ff14000000002a02c444"
  );
});

test("手机号登录页优先判定为需要登录而非验证码拦截", () => {
  assert.equal(classifyPageText("手机号登录 输入手机号 获取验证码 登录").type, "auth_required");
  assert.equal(classifyPageText("安全验证 请拖动滑块完成验证").type, "captcha_required");
  assert.equal(classifyPageText("访问频繁，请稍后再试").type, "access_blocked");
});
