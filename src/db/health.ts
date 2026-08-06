import process from "node:process";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { safeFailure } from "./errors.js";
import { createDatabaseContext } from "./pool.js";

interface ServerRow extends RowDataPacket {
  databaseName: string | null;
  version: string;
  sessionTimeZone: string;
}

interface StatusRow extends RowDataPacket {
  Variable_name: string;
  Value: string;
}

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof createDatabaseContext>> | undefined;
  let connection: PoolConnection | undefined;
  try {
    context = await createDatabaseContext();
    connection = await context.pool.getConnection();
    const [serverRows] = await connection.query<ServerRow[]>(
      "SELECT DATABASE() AS databaseName, VERSION() AS version, @@session.time_zone AS sessionTimeZone"
    );
    const [sslRows] = await connection.query<StatusRow[]>("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    const server = serverRows[0];
    if (!server) throw new Error("health_query_empty");
    const majorVersion = Number(server.version.match(/^(\d+)/)?.[1]);
    console.log(JSON.stringify({
      ok: true,
      databaseMatches: server.databaseName === context.config.database,
      majorVersion: Number.isFinite(majorVersion) ? majorVersion : null,
      sslEnabled: Boolean(sslRows[0]?.Value),
      utcSession: server.sessionTimeZone === "+00:00",
      connectionLimit: context.config.connectionLimit
    }));
  } catch (error) {
    console.error(JSON.stringify(safeFailure(error)));
    process.exitCode = 1;
  } finally {
    connection?.release();
    await context?.pool.end().catch(() => undefined);
  }
}

void main();
