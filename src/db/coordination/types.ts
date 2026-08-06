import type { Pool, PoolConnection } from "mysql2/promise";

export type DatabaseExecutor = Pool | PoolConnection;
export type DatabaseId = string | number | bigint;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function databaseIdsEqual(left: DatabaseId, right: DatabaseId): boolean {
  return String(left) === String(right);
}

export function leaseDurationMicroseconds(leaseDurationMs: number): number {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError("leaseDurationMs must be a positive safe integer");
  }
  const microseconds = leaseDurationMs * 1_000;
  if (!Number.isSafeInteger(microseconds)) {
    throw new RangeError("leaseDurationMs is too large");
  }
  return microseconds;
}

export function assertOwnerToken(ownerToken: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerToken)) {
    throw new TypeError("ownerToken must be a valid UUID");
  }
}
