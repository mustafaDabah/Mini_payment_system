// ==============================================================================
// Outbox Worker Entry Point (Transactional Outbox Pattern)
// ==============================================================================

import dotenv from "dotenv";
import path from "path";

// Load environment variables from project root
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { createLogger } from "@payment/shared";
import { prisma, checkDatabaseHealth } from "@payment/database";
import { EventProducer } from "@payment/kafka";

const logger = createLogger("outbox-worker");
const producer = new EventProducer("payment-outbox-worker");

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 1000;
let isRunning = true;
let pollTimer: NodeJS.Timeout | null = null;

/**
 * Foundation polling loop: Runs periodically to check for pending outbox events.
 * Business logic will be implemented in subsequent exercises.
 */
async function pollOutbox(): Promise<void> {
  if (!isRunning) return;

  try {
    logger.debug("Checking for pending outbox events...");
    // Future implementation:
    // 1. SELECT * FROM outbox_events WHERE status = 'PENDING' FOR UPDATE SKIP LOCKED LIMIT :batchSize
    // 2. Publish to Kafka
    // 3. UPDATE outbox_events SET status = 'PUBLISHED'
  } catch (err) {
    logger.error("Error during outbox polling cycle", err);
  } finally {
    if (isRunning) {
      pollTimer = setTimeout(pollOutbox, POLL_INTERVAL_MS);
    }
  }
}

async function startWorker(): Promise<void> {
  logger.info("Initializing Outbox Worker...");

  const isDbHealthy = await checkDatabaseHealth();
  if (!isDbHealthy) {
    logger.warn("Database connection is not healthy yet; worker will retry in loop.");
  } else {
    logger.info("Database connection verified.");
  }

  try {
    await producer.connect();
    logger.info("Kafka producer initialized for outbox publisher.");
  } catch (err) {
    logger.warn("Kafka connection pending; will retry on first publish.");
  }

  logger.info(`Outbox worker started. Polling interval: ${POLL_INTERVAL_MS}ms`);
  pollOutbox();
}

// ------------------------------------------------------------------------------
// Graceful Shutdown
// ------------------------------------------------------------------------------
const handleShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Stopping outbox worker gracefully...`);
  isRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
  }

  try {
    await producer.disconnect();
    await prisma.$disconnect();
    logger.info("Outbox worker resources released cleanly.");
    process.exit(0);
  } catch (err) {
    logger.error("Error while terminating outbox worker", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

startWorker().catch((err) => {
  logger.error("Failed to start outbox worker", err);
  process.exit(1);
});

