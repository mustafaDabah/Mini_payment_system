// ==============================================================================
// Outbox Domain Types
// ==============================================================================

export type OutboxStatusType = "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED";

export interface OutboxEventModel {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: OutboxStatusType;
  retryCount: number;
  lastError?: string | null;
  createdAt: Date;
  processedAt?: Date | null;
}

