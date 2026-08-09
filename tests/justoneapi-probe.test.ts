import assert from "node:assert/strict";
import test from "node:test";
import { parseJustOneApiConfig } from "../src/justoneapi-probe/config.js";
import { parseProbeOptions } from "../src/justoneapi-probe/options.js";
import { sanitizeApiValue } from "../src/justoneapi-probe/sanitize.js";
import { normalizeCommentPage, normalizeNoteDetail, selectRelatedSearchNotes } from "../src/justoneapi-probe/normalize.js";

test("JustOneAPI配置只接受官方HTTPS地址", () => {
  const config = parseJustOneApiConfig({ JUSTONEAPI_TOKEN: " secret " });
  assert.equal(config.token, " secret ");
  assert.equal(config.baseUrl, "https://api.justoneapi.com");
  assert.throws(() => parseJustOneApiConfig({}), /JUSTONEAPI_TOKEN/);
  assert.throws(() => parseJustOneApiConfig({ JUSTONEAPI_TOKEN: "x", JUSTONEAPI_BASE_URL: "http://47.117.133.51:30015" }), /JUSTONEAPI_BASE_URL/);
  assert.throws(() => parseJustOneApiConfig({ JUSTONEAPI_TOKEN: "x", JUSTONEAPI_BASE_URL: "https://example.com" }), /JUSTONEAPI_BASE_URL/);
});

test("探针强制限制笔记、评论页和回复数量", () => {
  assert.deepEqual(parseProbeOptions([]), { keyword: "Leader", noteLimit: 3, commentPages: 1, replyLimit: 3 });
  assert.deepEqual(parseProbeOptions(["--keyword", "海尔空调", "--note-limit", "2"]), {
    keyword: "海尔空调", noteLimit: 2, commentPages: 1, replyLimit: 3
  });
  assert.throws(() => parseProbeOptions(["--note-limit", "4"]), /note_limit_invalid/);
  assert.throws(() => parseProbeOptions(["--comment-pages", "2"]), /comment_pages_invalid/);
});

test("原始响应递归移除凭据并净化URL查询参数", () => {
  const sanitized = sanitizeApiValue({
    token: "secret",
    Cookie: "a=1",
    nested: { authorization: "Bearer secret", xsec_token: "platform-secret", password: "hidden", url: "https://example.com/a?token=secret&xsec_token=platform-secret&keyword=Leader" }
  });
  assert.deepEqual(sanitized, {
    nested: { url: "https://example.com/a?keyword=Leader" }
  });
});

test("JustOneAPI搜索结果只选择正文或标题命中品牌词的笔记", () => {
  const selected = selectRelatedSearchNotes({ notes: [
    { id: "1", title: "卡萨帝冰箱体验", desc: "正文", user: { nickname: "甲" } },
    { id: "2", title: "普通家电", desc: "没有命中", user: { nickname: "乙" } }
  ] }, "卡萨帝", 3);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, "1");
});

test("JustOneAPI详情映射为现有标准帖子结构并保留缺失值", () => {
  const post = normalizeNoteDetail({ note_list: [{
    id: "note-1", title: "卡萨帝", desc: "使用体验", user: { nickname: "作者" },
    time: 1_700_000_000_000, last_update_time: 1_700_000_100_000, ip_location: "上海",
    topics: [{ name: "冰箱" }], images_list: [{ url: "https://img.example/a.jpg" }],
    liked_count: 2, collected_count: 3, comments_count: 4, shared_count: 5
  }] }, "卡萨帝");
  assert.equal(post?.noteId, "note-1");
  assert.equal(post?.relevance, "related");
  assert.deepEqual(post?.tags, ["冰箱"]);
  assert.equal(post?.sourceUrl, "https://www.xiaohongshu.com/explore/note-1");
});

test("JustOneAPI详情必须同时命中关键词和大家电语境", () => {
  const unrelated = normalizeNoteDetail({ note_list: [{
    id: "pony-1",
    title: "画了小马塑",
    desc: "头发加了挑染，可爱标志是黑洞，哥妹一个统帅一个国王天角兽很合理"
  }] }, "统帅");
  const related = normalizeNoteDetail({ note_list: [{
    id: "appliance-1",
    title: "统帅洗衣机使用体验",
    desc: "脱水时声音有些大"
  }] }, "统帅");

  assert.equal(unrelated?.relevance, "uncertain");
  assert.equal(related?.relevance, "related");
});

test("JustOneAPI评论映射一级评论和内嵌回复关系", () => {
  const comments = normalizeCommentPage({ comments: [{
    id: "c1", note_id: "note-1", content: "一级", user: { nickname: "甲" }, time: 123,
    sub_comments: [{ id: "c2", note_id: "note-1", content: "回复", user: { nickname: "乙" }, time: 124 }]
  }] }, "note-1");
  assert.equal(comments.length, 2);
  assert.equal(comments[0]?.parentCommentId, null);
  assert.equal(comments[1]?.parentCommentId, "c1");
});
