// ==============================================================================
// Event Message Envelope & Schemas
// ==============================================================================

export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  timestamp: string;
  payload: T;
  version: number;
}

export type PaymentCreatedEventPayload = {
  paymentId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  currency: string;
  status: string;
};

export type FraudDecisionEventPayload = {
  paymentId: string;
  isFlagged: boolean;
  score: number;
  reason?: string;
  evaluatedAt: string;
};

