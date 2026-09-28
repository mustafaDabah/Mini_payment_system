// ==============================================================================
// Express API Server - Mini Payment System
// ==============================================================================

import dotenv from "dotenv";
import path from "path";

// Load environment variables from the project root .env file
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import express, { Request, Response } from "express";
import {
  checkDatabaseConnection,
  closeDatabaseConnection,
} from "@payment/database";

const app = express();
const PORT = Number(process.env.API_PORT) || 3000;

app.use(express.json());

// ------------------------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------------------------

/**
 * Health check endpoint.
 * Returns basic service health status.
 */
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
  });
});

/**
 * Database connectivity verification endpoint.
 * Runs a lightweight query (`SELECT NOW()`) against PostgreSQL.
 */
app.get("/health/db", async (_req: Request, res: Response) => {
  const dbStatus = await checkDatabaseConnection();

  if (dbStatus.connected) {
    return res.status(200).json({
      status: "ok",
      database: "connected",
      timestamp: dbStatus.timestamp,
    });
  }

  return res.status(503).json({
    status: "error",
    database: "disconnected",
    error: dbStatus.error,
  });
});

// ------------------------------------------------------------------------------
// Server Lifecycle & Graceful Shutdown
// ------------------------------------------------------------------------------

const server = app.listen(PORT, async () => {
  console.log(`[api] Express server running at http://localhost:${PORT}`);
  console.log(`[api] Health endpoint: http://localhost:${PORT}/health`);
  console.log(`[api] Database check endpoint: http://localhost:${PORT}/health/db`);

  // Verify PostgreSQL connectivity on startup
  const dbCheck = await checkDatabaseConnection();
  if (dbCheck.connected) {
    console.log(`[api] Successfully connected to PostgreSQL (DB Time: ${dbCheck.timestamp})`);
  } else {
    console.warn(`[api] Warning: Could not connect to PostgreSQL: ${dbCheck.error}`);
    console.warn("[api] Ensure Docker PostgreSQL container is running (`docker compose up -d postgres`).");
  }
});

/**
 * Gracefully close HTTP server and database pool on termination signals.
 */
async function handleShutdown(signal: string) {
  console.log(`\n[api] Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new HTTP requests
  server.close(async (serverErr) => {
    if (serverErr) {
      console.error("[api] Error closing HTTP server:", serverErr);
    } else {
      console.log("[api] HTTP server closed.");
    }

    // Close all PostgreSQL pool connections
    try {
      await closeDatabaseConnection();
      console.log("[api] PostgreSQL connections closed.");
      process.exit(0);
    } catch (dbErr) {
      console.error("[api] Error closing database connection pool:", dbErr);
      process.exit(1);
    }
  });

  // Force exit if shutdown takes too long (e.g. 5 seconds)
  setTimeout(() => {
    console.error("[api] Graceful shutdown timed out. Forcing process exit.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

