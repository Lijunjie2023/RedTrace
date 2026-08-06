import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { mapProbeComment, mapProbePost } from "./mapping.js";
import { PersistenceError } from "./errors.js";
import { RAW_REDACTION_VERSION, serializeSanitizedPayload } from "./redaction.js";
import type { BrandMatchInput, PersistCommentInput, PersistPostInput } from "./types.js";

interface IdRow extends RowDataPacket {
  id: number;
}

interface CommentOwnerRow extends RowDataPacket {
  postId: number;
}

export class CollectionPersistenceRepository {
  async upsertPost(
    connection: PoolConnection,
    dataSourceId: number,
    taskId: number,
    item: PersistPostInput
  ): Promise<number> {
    const post = mapProbePost(item.post);
    const tags = post.tags === null ? null : JSON.stringify(post.tags);
    const imageUrls = post.imageUrls === null ? null : JSON.stringify(post.imageUrls);
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO posts (
        data_source_id, platform_post_id, source_url, title, description, author_nickname,
        ip_location, published_at, platform_updated_at, displayed_time, tags, image_urls,
        availability_status, first_collected_at, last_collected_at, last_successful_task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        source_url = COALESCE(?, source_url),
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        author_nickname = COALESCE(?, author_nickname),
        ip_location = COALESCE(?, ip_location),
        published_at = COALESCE(?, published_at),
        platform_updated_at = COALESCE(?, platform_updated_at),
        displayed_time = COALESCE(?, displayed_time),
        tags = COALESCE(?, tags),
        image_urls = COALESCE(?, image_urls),
        availability_status = 'available',
        last_collected_at = ?,
        last_successful_task_id = ?`,
      [
        dataSourceId, post.platformPostId, post.sourceUrl, post.title, post.description, post.authorNickname,
        post.ipLocation, post.publishedAt, post.platformUpdatedAt, post.displayedTime, tags, imageUrls,
        item.observedAt, item.observedAt, taskId,
        post.sourceUrl, post.title, post.description, post.authorNickname, post.ipLocation,
        post.publishedAt, post.platformUpdatedAt, post.displayedTime, tags, imageUrls,
        item.observedAt, taskId
      ]
    );
    return result.insertId;
  }

  private async findCommentId(
    connection: PoolConnection,
    dataSourceId: number,
    postId: number,
    platformCommentId: string | null
  ): Promise<number | null> {
    if (!platformCommentId) return null;
    const [rows] = await connection.execute<IdRow[]>(
      "SELECT id FROM comments WHERE data_source_id = ? AND post_id = ? AND platform_comment_id = ? LIMIT 1",
      [dataSourceId, postId, platformCommentId]
    );
    return rows[0]?.id ?? null;
  }

  async upsertComments(
    connection: PoolConnection,
    dataSourceId: number,
    taskId: number,
    postId: number,
    item: PersistPostInput
  ): Promise<Map<string, number>> {
    const commentIds = new Map<string, number>();
    const ordered = [...item.comments].sort((left, right) => Number(Boolean(left.parentCommentId)) - Number(Boolean(right.parentCommentId)));
    for (const commentInput of ordered) {
      const comment = mapProbeComment(commentInput);
      const parentId = comment.platformParentCommentId
        ? commentIds.get(comment.platformParentCommentId)
          ?? await this.findCommentId(connection, dataSourceId, postId, comment.platformParentCommentId)
        : null;
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO comments (
          data_source_id, post_id, platform_comment_id, parent_comment_id,
          platform_parent_comment_id, platform_target_comment_id, content, author_nickname,
          published_text, ip_location, availability_status, first_collected_at,
          last_collected_at, last_successful_task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          id = LAST_INSERT_ID(id),
          parent_comment_id = COALESCE(?, parent_comment_id),
          platform_parent_comment_id = COALESCE(?, platform_parent_comment_id),
          platform_target_comment_id = COALESCE(?, platform_target_comment_id),
          content = COALESCE(?, content),
          author_nickname = COALESCE(?, author_nickname),
          published_text = COALESCE(?, published_text),
          ip_location = COALESCE(?, ip_location),
          availability_status = 'available',
          last_collected_at = ?,
          last_successful_task_id = ?`,
        [
          dataSourceId, postId, comment.platformCommentId, parentId,
          comment.platformParentCommentId, comment.platformTargetCommentId, comment.content,
          comment.authorNickname, comment.publishedText, comment.ipLocation,
          item.observedAt, item.observedAt, taskId,
          parentId, comment.platformParentCommentId, comment.platformTargetCommentId,
          comment.content, comment.authorNickname, comment.publishedText, comment.ipLocation,
          item.observedAt, taskId
        ]
      );
      const [ownerRows] = await connection.execute<CommentOwnerRow[]>(
        "SELECT post_id AS postId FROM comments WHERE id = ? FOR UPDATE",
        [result.insertId]
      );
      if (ownerRows[0] && ownerRows[0].postId !== postId) {
        throw new PersistenceError("input_invalid", "comment_post_mismatch");
      }
      commentIds.set(comment.platformCommentId, result.insertId);
    }

    await connection.execute(
      `UPDATE comments AS child
       INNER JOIN comments AS parent
         ON parent.data_source_id = child.data_source_id
        AND parent.post_id = child.post_id
        AND parent.platform_comment_id = child.platform_parent_comment_id
       SET child.parent_comment_id = parent.id
       WHERE child.data_source_id = ? AND child.post_id = ?
         AND child.parent_comment_id IS NULL AND child.platform_parent_comment_id IS NOT NULL`,
      [dataSourceId, postId]
    );
    return commentIds;
  }

  async appendInteractionSnapshots(
    connection: PoolConnection,
    taskId: number,
    postId: number,
    commentIds: Map<string, number>,
    item: PersistPostInput
  ): Promise<void> {
    const post = mapProbePost(item.post);
    await connection.execute(
      `INSERT INTO post_interaction_snapshots (
        task_id, post_id, liked_count, collected_count, comment_count, share_count, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE id = id`,
      [taskId, postId, post.likedCount, post.collectedCount, post.commentCount, post.shareCount, item.observedAt]
    );
    for (const commentInput of item.comments) {
      const comment = mapProbeComment(commentInput);
      const commentId = commentIds.get(comment.platformCommentId);
      if (!commentId) continue;
      await connection.execute(
        `INSERT INTO comment_interaction_snapshots (task_id, comment_id, liked_count, observed_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [taskId, commentId, comment.likedCount, item.observedAt]
      );
    }
  }

  async saveRawSnapshots(
    connection: PoolConnection,
    taskId: number,
    postId: number,
    commentIds: Map<string, number>,
    item: PersistPostInput
  ): Promise<void> {
    if (item.rawPayload !== undefined) {
      const payload = serializeSanitizedPayload(item.rawPayload);
      await connection.execute(
        `INSERT INTO raw_field_snapshots (
          task_id, post_id, comment_id, snapshot_kind, payload, redaction_version, collected_at
        ) VALUES (?, ?, NULL, 'post', ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id`,
        [taskId, postId, payload, RAW_REDACTION_VERSION, item.observedAt]
      );
    }
    for (const commentInput of item.comments) {
      if (commentInput.rawPayload === undefined) continue;
      const commentId = commentIds.get(commentInput.commentId);
      if (!commentId) continue;
      const payload = serializeSanitizedPayload(commentInput.rawPayload);
      await connection.execute(
        `INSERT INTO raw_field_snapshots (
          task_id, post_id, comment_id, snapshot_kind, payload, redaction_version, collected_at
        ) VALUES (?, NULL, ?, 'comment', ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id`,
        [taskId, commentId, payload, RAW_REDACTION_VERSION, item.observedAt]
      );
    }
  }

  async saveBrandMatches(
    connection: PoolConnection,
    dataSourceId: number,
    brandId: number,
    taskId: number,
    postId: number,
    matches: BrandMatchInput[]
  ): Promise<void> {
    const uniqueMatches = new Map(matches.map((match) => [match.searchTermId, match]));
    for (const match of uniqueMatches.values()) {
      await connection.execute(
        `INSERT INTO brand_post_matches (
          data_source_id, brand_id, search_term_id, post_id, first_matched_task_id, matched_term_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id`,
        [dataSourceId, brandId, match.searchTermId, postId, taskId, match.matchedTermSnapshot]
      );
    }
  }
}
