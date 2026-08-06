import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ProbeImportError,
  loadProbeArtifacts,
  parseProbeImportOptions,
  resolveProbeRunDirectory
} from "../src/db/import-probe.js";

test("探针导入参数必须显式提供运行目录和品牌", () => {
  assert.deepEqual(
    parseProbeImportOptions(["--run-dir", "artifacts/xhs-probe/run-1", "--brand=Leader"]),
    { runDir: "artifacts/xhs-probe/run-1", brand: "Leader" }
  );
  assert.throws(
    () => parseProbeImportOptions(["--brand", "Leader"]),
    (error: unknown) => error instanceof ProbeImportError && error.code === "arguments_invalid"
  );
});

test("探针导入拒绝artifacts/xhs-probe之外的真实路径", async () => {
  await assert.rejects(
    () => resolveProbeRunDirectory(path.resolve(".")),
    (error: unknown) => error instanceof ProbeImportError && error.code === "run_directory_invalid"
  );
});

test("探针产物校验帖子、评论归属、去重数量和运行标识", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "readtrace-probe-import-"));
  try {
    const runId = path.basename(directory);
    const post = {
      noteId: "sample-note",
      title: "样本标题",
      author: { nickname: "样本作者" },
      displayedTime: null,
      interactionSummary: null,
      sourceUrl: "https://www.xiaohongshu.com/explore/sample-note",
      relevance: "related",
      relevanceTerms: ["Leader"],
      description: "样本正文",
      ipLocation: null,
      time: null,
      lastUpdateTime: null,
      timeSources: [],
      tags: [],
      imageUrls: [],
      likedCount: 1,
      collectedCount: 0,
      commentCount: 1,
      shareCount: 0
    };
    const comment = {
      commentId: "sample-comment",
      noteId: "sample-note",
      parentCommentId: null,
      content: "样本评论",
      author: { nickname: "评论作者" },
      publishedText: null,
      ipLocation: null,
      likedCount: 0,
      sourceUrl: post.sourceUrl
    };
    const report = {
      runId,
      keyword: "Leader",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:01:00.000Z",
      status: "success",
      limits: { searchResults: 1, details: 1, detailDelayMs: 2000 },
      counts: {
        rawSearchResults: 1,
        relatedSearchResults: 1,
        postsBeforeDeduplication: 1,
        postsAfterDeduplication: 1,
        commentsBeforeDeduplication: 1,
        commentsAfterDeduplication: 1
      },
      fieldCoverage: {},
      flags: [],
      errors: []
    };
    await Promise.all([
      writeFile(path.join(directory, "posts.json"), JSON.stringify([post]), "utf8"),
      writeFile(path.join(directory, "comments.json"), JSON.stringify([comment]), "utf8"),
      writeFile(path.join(directory, "report.json"), JSON.stringify(report), "utf8")
    ]);
    const artifacts = await loadProbeArtifacts(directory);
    assert.equal(artifacts.posts.length, 1);
    assert.equal(artifacts.comments[0]?.noteId, artifacts.posts[0]?.noteId);

    await writeFile(path.join(directory, "posts.json"), JSON.stringify([{ ...post, sourceUrl: "https://example.com/not-xhs" }]), "utf8");
    await assert.rejects(
      () => loadProbeArtifacts(directory),
      (error: unknown) => error instanceof ProbeImportError && error.code === "artifact_invalid"
    );
    await writeFile(path.join(directory, "posts.json"), JSON.stringify([post]), "utf8");

    await writeFile(path.join(directory, "comments.json"), JSON.stringify([{ ...comment, noteId: "missing-post" }]), "utf8");
    await assert.rejects(
      () => loadProbeArtifacts(directory),
      (error: unknown) => error instanceof ProbeImportError && error.code === "artifact_invalid"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("探针产物文件的符号链接不能逃出运行目录", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "readtrace-probe-symlink-"));
  const externalDirectory = await mkdtemp(path.join(tmpdir(), "readtrace-probe-external-"));
  try {
    const externalPosts = path.join(externalDirectory, "posts.json");
    await writeFile(externalPosts, "[]", "utf8");
    await Promise.all([
      writeFile(path.join(directory, "comments.json"), "[]", "utf8"),
      writeFile(path.join(directory, "report.json"), "{}", "utf8")
    ]);
    try {
      await symlink(externalPosts, path.join(directory, "posts.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("当前Windows环境不允许创建文件符号链接。代码仍执行真实路径边界检查。");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => loadProbeArtifacts(directory),
      (error: unknown) => error instanceof ProbeImportError && error.code === "artifact_read_failed"
    );
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(externalDirectory, { recursive: true, force: true })
    ]);
  }
});
