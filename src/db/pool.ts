import mysql, { type Pool } from "mysql2/promise";
import { loadDatabaseConfig, toPoolOptions, type DatabaseConfig } from "./config.js";

export interface DatabaseContext {
  config: DatabaseConfig;
  pool: Pool;
}

export async function createDatabaseContext(): Promise<DatabaseContext> {
  const config = loadDatabaseConfig();
  const pool = mysql.createPool(await toPoolOptions(config));
  pool.pool.on("connection", (connection) => {
    connection.query("SET SESSION time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });
  return { config, pool };
}
