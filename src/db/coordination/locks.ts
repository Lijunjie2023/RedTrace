import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  assertOwnerToken,
  databaseIdsEqual,
  leaseDurationMicroseconds,
  type DatabaseExecutor,
  type DatabaseId
} from "./types.js";

export interface AcquireBrandLeaseInput {
  dataSourceId: DatabaseId;
  brandId: DatabaseId;
  taskId: DatabaseId;
  ownerToken: string;
  leaseDurationMs: number;
}

export type AcquireBrandLeaseResult =
  | { acquired: true; outcome: "acquired" | "taken_over"; leaseExpiresAt: Date }
  | {
      acquired: false;
      outcome: "rejected";
      reason: "active_lease" | "owner_token_conflict" | "task_not_eligible";
      leaseExpiresAt?: Date;
    };

export interface RenewBrandLeaseInput {
  dataSourceId: DatabaseId;
  brandId: DatabaseId;
  taskId: DatabaseId;
  ownerToken: string;
  leaseDurationMs: number;
}

export type RenewBrandLeaseResult =
  | { renewed: true; leaseExpiresAt: Date }
  | { renewed: false; reason: "not_owner_or_expired" };

export interface ReleaseBrandLeaseInput {
  dataSourceId: DatabaseId;
  brandId: DatabaseId;
  taskId: DatabaseId;
  ownerToken: string;
}

export type ReleaseBrandLeaseResult =
  | { released: true }
  | { released: false; reason: "not_owner" };

interface LockRow extends RowDataPacket {
  ownerToken: string;
  taskId: DatabaseId;
  leaseExpiresAt: Date;
  acquiredAt: Date;
}

interface TaskStateRow extends RowDataPacket {
  status: string;
}

const LOCK_ELIGIBLE_TASK_STATUSES = new Set(["queued", "running"]);

export async function acquireBrandLease(
  executor: DatabaseExecutor,
  input: AcquireBrandLeaseInput
): Promise<AcquireBrandLeaseResult> {
  assertOwnerToken(input.ownerToken);
  const leaseMicroseconds = leaseDurationMicroseconds(input.leaseDurationMs);
  const [result] = await executor.execute<ResultSetHeader>(
    `INSERT INTO collection_locks (
     data_source_id, brand_id, owner_token, task_id, lease_expires_at, acquired_at, updated_at
     )
     SELECT incoming.incoming_data_source_id,
            incoming.incoming_brand_id,
            incoming.incoming_owner_token,
            incoming.incoming_task_id,
            incoming.incoming_lease_expires_at,
            incoming.incoming_acquired_at,
            incoming.incoming_updated_at
     FROM (
       SELECT ? AS incoming_data_source_id,
              ? AS incoming_brand_id,
              CONVERT(? USING ascii) COLLATE ascii_bin AS incoming_owner_token,
              eligible_task.id AS incoming_task_id,
              TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3)) AS incoming_lease_expires_at,
              UTC_TIMESTAMP(3) AS incoming_acquired_at,
              UTC_TIMESTAMP(3) AS incoming_updated_at
       FROM collection_tasks AS eligible_task
       WHERE eligible_task.id = ?
         AND eligible_task.data_source_id = ?
         AND eligible_task.brand_id = ?
         AND eligible_task.status IN ('queued', 'running')
     ) AS incoming
     ON DUPLICATE KEY UPDATE
       id = IF(
         collection_locks.data_source_id = incoming.incoming_data_source_id
           AND collection_locks.brand_id = incoming.incoming_brand_id
           AND collection_locks.lease_expires_at <= UTC_TIMESTAMP(3),
         collection_locks.id + (LAST_INSERT_ID(collection_locks.id) * 0),
         collection_locks.id + (LAST_INSERT_ID(0) * 0)
       ),
       updated_at = IF(
         collection_locks.data_source_id = incoming.incoming_data_source_id
           AND collection_locks.brand_id = incoming.incoming_brand_id
           AND collection_locks.lease_expires_at <= UTC_TIMESTAMP(3),
         UTC_TIMESTAMP(3), collection_locks.updated_at
       ),
       owner_token = IF(
         collection_locks.data_source_id = incoming.incoming_data_source_id
           AND collection_locks.brand_id = incoming.incoming_brand_id
           AND collection_locks.lease_expires_at <= UTC_TIMESTAMP(3),
         incoming.incoming_owner_token, collection_locks.owner_token
       ),
       task_id = IF(
         collection_locks.data_source_id = incoming.incoming_data_source_id
           AND collection_locks.brand_id = incoming.incoming_brand_id
           AND collection_locks.lease_expires_at <= UTC_TIMESTAMP(3),
         incoming.incoming_task_id, collection_locks.task_id
       ),
       acquired_at = IF(
         collection_locks.data_source_id = incoming.incoming_data_source_id
           AND collection_locks.brand_id = incoming.incoming_brand_id
           AND collection_locks.lease_expires_at <= UTC_TIMESTAMP(3),
         UTC_TIMESTAMP(3), collection_locks.acquired_at
       ),
       lease_expires_at = IF(
         collection_locks.data_source_id = incoming.incoming_data_source_id
           AND collection_locks.brand_id = incoming.incoming_brand_id
           AND collection_locks.lease_expires_at <= UTC_TIMESTAMP(3),
         incoming.incoming_lease_expires_at, collection_locks.lease_expires_at
       )`,
    [
      input.dataSourceId,
      input.brandId,
      input.ownerToken,
      leaseMicroseconds,
      input.taskId,
      input.dataSourceId,
      input.brandId
    ]
  );
  const [[task], [lock]] = await Promise.all([
    executor.execute<TaskStateRow[]>(
      `SELECT status FROM collection_tasks
       WHERE id = ? AND data_source_id = ? AND brand_id = ?`,
      [input.taskId, input.dataSourceId, input.brandId]
    ).then(([rows]) => rows),
    executor.execute<LockRow[]>(
      `SELECT owner_token AS ownerToken, task_id AS taskId,
              lease_expires_at AS leaseExpiresAt, acquired_at AS acquiredAt
       FROM collection_locks
       WHERE data_source_id = ? AND brand_id = ?`,
      [input.dataSourceId, input.brandId]
    ).then(([rows]) => rows)
  ]);
  if (
    result.affectedRows > 0
    && result.insertId > 0
    && lock?.ownerToken === input.ownerToken
    && databaseIdsEqual(lock.taskId, input.taskId)
  ) {
    return {
      acquired: true,
      outcome: result.affectedRows === 1 ? "acquired" : "taken_over",
      leaseExpiresAt: lock.leaseExpiresAt
    };
  }
  if (!task || !LOCK_ELIGIBLE_TASK_STATUSES.has(task.status)) {
    return { acquired: false, outcome: "rejected", reason: "task_not_eligible" };
  }
  if (!lock) {
    return { acquired: false, outcome: "rejected", reason: "owner_token_conflict" };
  }
  return {
    acquired: false,
    outcome: "rejected",
    reason: "active_lease",
    leaseExpiresAt: lock.leaseExpiresAt
  };
}

export async function renewBrandLease(
  executor: DatabaseExecutor,
  input: RenewBrandLeaseInput
): Promise<RenewBrandLeaseResult> {
  assertOwnerToken(input.ownerToken);
  const leaseMicroseconds = leaseDurationMicroseconds(input.leaseDurationMs);
  const [result] = await executor.execute<ResultSetHeader>(
    `UPDATE collection_locks
     SET lease_expires_at = TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3)),
         updated_at = UTC_TIMESTAMP(3)
     WHERE data_source_id = ? AND brand_id = ? AND task_id = ? AND owner_token = ?
       AND lease_expires_at > UTC_TIMESTAMP(3)`,
    [leaseMicroseconds, input.dataSourceId, input.brandId, input.taskId, input.ownerToken]
  );
  if (result.affectedRows !== 1) return { renewed: false, reason: "not_owner_or_expired" };
  const [rows] = await executor.execute<Array<RowDataPacket & { leaseExpiresAt: Date }>>(
    `SELECT lease_expires_at AS leaseExpiresAt
     FROM collection_locks
     WHERE data_source_id = ? AND brand_id = ? AND task_id = ? AND owner_token = ?`,
    [input.dataSourceId, input.brandId, input.taskId, input.ownerToken]
  );
  const lock = rows[0];
  if (!lock) return { renewed: false, reason: "not_owner_or_expired" };
  return { renewed: true, leaseExpiresAt: lock.leaseExpiresAt };
}

export async function releaseBrandLease(
  executor: DatabaseExecutor,
  input: ReleaseBrandLeaseInput
): Promise<ReleaseBrandLeaseResult> {
  assertOwnerToken(input.ownerToken);
  const [result] = await executor.execute<ResultSetHeader>(
    `DELETE FROM collection_locks
     WHERE data_source_id = ? AND brand_id = ? AND task_id = ? AND owner_token = ?`,
    [input.dataSourceId, input.brandId, input.taskId, input.ownerToken]
  );
  return result.affectedRows === 1
    ? { released: true }
    : { released: false, reason: "not_owner" };
}
