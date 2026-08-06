import type { Pool } from "mysql2/promise";
import { persistenceErrorType, safePersistenceSummary } from "./errors.js";
import { validatePersistPostInput } from "./mapping.js";
import { CollectionPersistenceRepository } from "./repository.js";
import { CollectionTaskRepository } from "./task-repository.js";
import type { PersistBatchInput, PersistBatchResult, PersistPostInput } from "./types.js";

export class CollectionPersistenceService {
  private readonly contentRepository = new CollectionPersistenceRepository();
  readonly tasks: CollectionTaskRepository;

  constructor(private readonly pool: Pool) {
    this.tasks = new CollectionTaskRepository(pool);
  }

  private async persistOne(
    taskId: number,
    dataSourceId: number,
    brandId: number,
    item: PersistPostInput
  ): Promise<void> {
    validatePersistPostInput(item.post, item.comments, item.matches, item.observedAt);
    const connection = await this.pool.getConnection();
    let connectionReusable = true;
    try {
      await connection.beginTransaction();
      const postId = await this.contentRepository.upsertPost(connection, dataSourceId, taskId, item);
      const commentIds = await this.contentRepository.upsertComments(connection, dataSourceId, taskId, postId, item);
      await this.contentRepository.appendInteractionSnapshots(connection, taskId, postId, commentIds, item);
      await this.contentRepository.saveRawSnapshots(connection, taskId, postId, commentIds, item);
      await this.contentRepository.saveBrandMatches(connection, dataSourceId, brandId, taskId, postId, item.matches);
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        connectionReusable = false;
        connection.destroy();
      }
      throw error;
    } finally {
      if (connectionReusable) connection.release();
    }
  }

  async persistBatch(input: PersistBatchInput): Promise<PersistBatchResult> {
    await this.tasks.startTask(input.taskId, input.dataSourceId, input.brandId);
    let succeededPostCount = 0;
    const failures: PersistBatchResult["failures"] = [];
    for (const item of input.items) {
      try {
        await this.persistOne(input.taskId, input.dataSourceId, input.brandId, item);
        succeededPostCount += 1;
      } catch (error) {
        failures.push({ noteId: item.post.noteId, errorType: persistenceErrorType(error) });
      }
    }

    const failedPostCount = failures.length;
    const status = failedPostCount === 0 ? "success" : succeededPostCount > 0 ? "partial_success" : "failed";
    const firstErrorType = failures[0]?.errorType ?? null;
    await this.tasks.finishTask(
      input.taskId,
      status,
      succeededPostCount,
      failedPostCount,
      firstErrorType,
      firstErrorType ? safePersistenceSummary(firstErrorType) : null
    );
    return { taskId: input.taskId, status, succeededPostCount, failedPostCount, failures };
  }
}
