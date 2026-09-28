// ==============================================================================
// PostgreSQL Connection Pool & Database Utilities
// ==============================================================================

import { Pool, PoolConfig } from "pg";
import dotenv from "dotenv";
import path from "path";

// Ensure environment variables are loaded if not already loaded by caller
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/**
 * Build PostgreSQL Pool configuration from environment variables.
 *
 * Notice the host configuration:
 * - Running locally on Mac: POSTGRES_HOST=localhost (connecting via port mapping 5432:5432)
 * - Running inside Docker:  POSTGRES_HOST=postgres (connecting via Docker container DNS)
 */
function createPoolConfig(): PoolConfig {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
    };
  }

  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.POSTGRES_PORT) || 5432,
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "postgres",
    database: process.env.POSTGRES_DB || "payment_db",
    max: 10, // Maximum number of connection clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

/**
 * Singleton PostgreSQL connection pool.
 */
export const pool = new Pool(createPoolConfig());

// Handle unexpected idle client errors
pool.on("error", (err) => {
  console.error("[database] Unexpected error on idle PostgreSQL client", err);
});

/**
 * Simple database connectivity test.
 * Runs `SELECT NOW()` to confirm that PostgreSQL is reachable and authenticating.
 */
export async function checkDatabaseConnection(): Promise<{
  connected: boolean;
  timestamp?: string;
  error?: string;
}> {
  try {
    const result = await pool.query("SELECT NOW() as current_time");
    return {
      connected: true,
      timestamp: result.rows[0].current_time,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      connected: false,
      error: message,
    };
  }
}

/**
 * Gracefully terminates all active database connections in the pool.
 */
export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
}

