// ==============================================================================
// Kafka Topics & Consumer Groups
// ==============================================================================

export const KAFKA_TOPICS = {
  PAYMENT_EVENTS: "payment.events",
  FRAUD_DECISIONS: "fraud.decisions",
  DEAD_LETTER_QUEUE: "payment.dlq",
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export const CONSUMER_GROUPS = {
  OUTBOX_PUBLISHER: "payment-outbox-worker-group",
  FRAUD_DETECTOR: "payment-fraud-worker-group",
} as const;

