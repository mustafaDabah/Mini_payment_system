// ==============================================================================
// Fraud Worker Entry Point (Kafka Consumer & Fraud Evaluation)
// ==============================================================================

import dotenv from "dotenv";
import path from "path";

// Load environment variables from project root
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import Redis from "ioredis";
import {
  createLogger,
  CONSUMER_GROUPS,
  KAFKA_TOPICS,
  EventEnvelope,
  PaymentCreatedEventPayload,
} from "@payment/shared";
import { EventConsumer } from "@payment/kafka";

const logger = createLogger("fraud-worker");

const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const redisPassword = process.env.REDIS_PASSWORD || undefined;

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

const consumer = new EventConsumer(
  CONSUMER_GROUPS.FRAUD_DETECTOR,
  "payment-fraud-worker"
);

/**
 * Foundation message processor.
 * Business logic will evaluate velocity checks, blacklists, and ML thresholds.
 */
async function handlePaymentEvent(
  event: EventEnvelope<PaymentCreatedEventPayload>
): Promise<void> {
  logger.info(`Received event for fraud evaluation: ${event.eventType}`, {
    eventId: event.eventId,
    aggregateId: event.aggregateId,
  });

  // Future implementation:
  // 1. Check idempotency using ProcessedEvent table / Redis
  // 2. Velocity check in Redis (e.g. transactions per minute per user)
  // 3. Amount threshold check
  // 4. Publish decision (APPROVED / FLAGGED) to KAFKA_TOPICS.FRAUD_DECISIONS
}

async function startWorker(): Promise<void> {
  logger.info("Initializing Fraud Worker...");

  try {
    await redis.connect();
    logger.info(`Connected to Redis at ${redisHost}:${redisPort}`);
  } catch (err) {
    logger.warn("Redis connection pending; will retry on command execution.");
  }

  try {
    await consumer.connect();
    await consumer.subscribe([KAFKA_TOPICS.PAYMENT_EVENTS]);
    await consumer.run(handlePaymentEvent as any);
    logger.info(
      `Fraud worker listening on topic: ${KAFKA_TOPICS.PAYMENT_EVENTS}`
    );
  } catch (err) {
    logger.warn("Kafka connection pending; will retry automatically.");
  }
}

// ------------------------------------------------------------------------------
// Graceful Shutdown
// ------------------------------------------------------------------------------
const handleShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Shutting down fraud worker gracefully...`);
  try {
    await consumer.disconnect();
    redis.disconnect();
    logger.info("Fraud worker connections closed.");
    process.exit(0);
  } catch (err) {
    logger.error("Error during fraud worker shutdown", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

startWorker().catch((err) => {
  logger.error("Failed to start fraud worker", err);
  process.exit(1);
});

