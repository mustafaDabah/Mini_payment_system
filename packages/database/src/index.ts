// ==============================================================================
// PostgreSQL Connection Pool & Database Utilities
// ==============================================================================

import { Pool, PoolConfig } from "pg";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";

// Ensure environment variables are loaded
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/**
 * Build PostgreSQL Pool configuration from environment variables.
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
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

export const pool = new Pool(createPoolConfig());

pool.on("error", (err) => {
  console.error("[database] Unexpected error on idle PostgreSQL client", err);
});

// ------------------------------------------------------------------------------
// TypeScript Types
// ------------------------------------------------------------------------------

export class TransferError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "TransferError";
  }
}

export type PaymentCurrency = "USD" | "EUR" | "GBP";
export type PaymentStatus =
  | "PENDING"
  | "PENDING_FRAUD_CHECK"
  | "COMPLETED"
  | "FAILED"
  | "FRAUD_REJECTED"
  | "UNDER_REVIEW";

export type ReservationStatus = "ACTIVE" | "CONSUMED" | "RELEASED";

export interface Account {
  id: string;
  balance: string;
  reserved_balance: string;
  currency: PaymentCurrency;
  created_at: string;
}

export interface Payment {
  id: string;
  idempotency_key: string;
  source_account_id: string;
  destination_account_id: string;
  amount: string;
  currency: PaymentCurrency;
  status: PaymentStatus;
  created_at: string;
}

export interface Reservation {
  id: string;
  payment_id: string;
  account_id: string;
  amount: string;
  currency: PaymentCurrency;
  status: ReservationStatus;
  created_at: string;
  updated_at: string;
}

export interface OutboxEvent {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  published_at: string | null;
  attempts: number;
}

export type FraudDecision = "APPROVED" | "REJECTED" | "REVIEW";

export interface ApplyFraudDecisionParams {
  paymentId: string;
  decision: FraudDecision;
  reason?: string;
}

export interface CreateAccountParams {
  balance?: number | string;
  currency?: PaymentCurrency;
}

export interface CreatePaymentParams {
  idempotency_key: string;
  source_account_id: string;
  destination_account_id: string;
  amount: number | string;
  currency: PaymentCurrency;
  status?: PaymentStatus;
}

// ------------------------------------------------------------------------------
// Database Schema Initialization (DDL)
// ------------------------------------------------------------------------------

const SCHEMA_SQL = `
-- 1. Create Enums if they do not already exist
DO $$ BEGIN
  CREATE TYPE payment_currency AS ENUM ('USD', 'EUR', 'GBP');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE reservation_status AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Accounts Table
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  balance DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  reserved_balance DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  currency payment_currency NOT NULL DEFAULT 'USD',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Safe migration for existing accounts table: ensure reserved_balance exists
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reserved_balance DECIMAL(18,2) NOT NULL DEFAULT 0.00;

-- 3. Payments Table
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(255) NOT NULL,
  source_account_id UUID NOT NULL REFERENCES accounts(id),
  destination_account_id UUID NOT NULL REFERENCES accounts(id),
  amount DECIMAL(18,2) NOT NULL CHECK (amount > 0),
  currency payment_currency NOT NULL DEFAULT 'USD',
  status payment_status NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Reservations Table
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  amount DECIMAL(18,2) NOT NULL CHECK (amount > 0),
  currency payment_currency NOT NULL DEFAULT 'USD',
  status reservation_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Outbox Events Table (Transactional Outbox Pattern)
CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(255) NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  published_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Safe migrations in case table was partially created in past
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS published_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- 6. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_payments_source ON payments(source_account_id);
CREATE INDEX IF NOT EXISTS idx_payments_destination ON payments(destination_account_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_reservations_account_status ON reservations(account_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_payment ON reservations(payment_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished ON outbox_events(created_at ASC) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate_id ON outbox_events(aggregate_id);

-- 7. Safe Migration for Existing Payments Table
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
UPDATE payments SET idempotency_key = gen_random_uuid()::text WHERE idempotency_key IS NULL;
ALTER TABLE payments ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key ON payments(idempotency_key);
`;

/** 
 * Executes DDL queries to create accounts, payments, reservations tables, and enums.
 */
export async function initDatabase(): Promise<void> {
  await pool.query(SCHEMA_SQL);

  // Extend payment_status ENUM safely with new fraud lifecycle statuses
  const newStatuses = ["PENDING_FRAUD_CHECK", "FRAUD_REJECTED", "UNDER_REVIEW"];
  for (const status of newStatuses) {
    try {
      await pool.query(`ALTER TYPE payment_status ADD VALUE IF NOT EXISTS '${status}'`);
    } catch (_err) {
      // Silently continue if already added
    }
  }
}

/**
 * Health check probe running SELECT NOW().
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
 * Gracefully terminates all pool connections.
 */
export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
}

// ------------------------------------------------------------------------------
// Account Queries
// ------------------------------------------------------------------------------

export async function createAccount(params: CreateAccountParams): Promise<Account> {
  const balance = params.balance ?? 0.0;
  const currency = params.currency ?? "USD";

  const result = await pool.query<Account>(
    `INSERT INTO accounts (balance, currency)
     VALUES ($1, $2)
     RETURNING id, balance, reserved_balance, currency, created_at`,
    [balance, currency]
  );

  return result.rows[0];
}

export async function getAccountById(id: string): Promise<Account | null> {
  const result = await pool.query<Account>(
    `SELECT id, balance, reserved_balance, currency, created_at
     FROM accounts
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

// ------------------------------------------------------------------------------
// Payment Queries
// ------------------------------------------------------------------------------

export async function createPayment(params: CreatePaymentParams): Promise<Payment> {
  const status = params.status ?? "PENDING";

  const result = await pool.query<Payment>(
    `INSERT INTO payments (
       idempotency_key,
       source_account_id,
       destination_account_id,
       amount,
       currency,
       status
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at`,
    [
      params.idempotency_key,
      params.source_account_id,
      params.destination_account_id,
      params.amount,
      params.currency,
      status,
    ]
  );

  return result.rows[0];
}

/**
 * Executes an atomic transfer between two accounts within a single PostgreSQL transaction.
 *
 * Implements deterministic lock ordering (smaller UUID first) to prevent deadlocks under concurrency.
 * Guarantees idempotency via `idempotency_key`:
 * - Case A: First request -> Executes transfer, records payment, commits.
 * - Case B: Same key + same parameters -> Returns original payment without re-transferring.
 * - Case C: Same key + different parameters -> Rejects with 409 Conflict.
 * - Concurrency: Combines row locks with DB unique constraint protection on idempotency_key.
 */
export async function executeTransferPayment(
  params: CreatePaymentParams
): Promise<Payment> {
  const {
    idempotency_key,
    source_account_id,
    destination_account_id,
    amount,
    currency,
  } = params;

  if (!idempotency_key || typeof idempotency_key !== "string" || idempotency_key.trim() === "") {
    throw new TransferError("Idempotency key is required", 400);
  }

  const transferAmount = Number(amount);

  if (source_account_id === destination_account_id) {
    throw new TransferError("Source and destination accounts cannot be the same", 400);
  }

  if (isNaN(transferAmount) || transferAmount <= 0) {
    throw new TransferError("Payment amount must be greater than zero", 400);
  }

  // Pre-check: Fast path if payment with this idempotency key already exists
  const existingPre = await getPaymentByIdempotencyKey(idempotency_key);
  if (existingPre) {
    const isMatch =
      existingPre.source_account_id === source_account_id &&
      existingPre.destination_account_id === destination_account_id &&
      Number(existingPre.amount) === transferAmount &&
      existingPre.currency === currency;

    if (isMatch) {
      return existingPre;
    } else {
      throw new TransferError(
        `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
        409
      );
    }
  }

  const client = await pool.connect();

  try {
    // 0. Begin Transaction
    await client.query("BEGIN");

    // Inside-transaction check: In case another transaction committed just before BEGIN
    const txCheck = await client.query<Payment>(
      `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
       FROM payments
       WHERE idempotency_key = $1`,
      [idempotency_key]
    );

    if (txCheck.rows.length > 0) {
      const existing = txCheck.rows[0];
      await client.query("COMMIT");

      const isMatch =
        existing.source_account_id === source_account_id &&
        existing.destination_account_id === destination_account_id &&
        Number(existing.amount) === transferAmount &&
        existing.currency === currency;

      if (isMatch) {
        return existing;
      } else {
        throw new TransferError(
          `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
          409
        );
      }
    }

    // 1. Determine deterministic lock order using account UUIDs (smaller UUID first)
    const [firstLockId, secondLockId] =
      source_account_id < destination_account_id
        ? [source_account_id, destination_account_id]
        : [destination_account_id, source_account_id];

    // 2. SELECT both account rows using SELECT ... FOR UPDATE in deterministic order
    const firstRes = await client.query<Account>(
      "SELECT id, balance, reserved_balance, currency, created_at FROM accounts WHERE id = $1 FOR UPDATE",
      [firstLockId]
    );

    const secondRes = await client.query<Account>(
      "SELECT id, balance, reserved_balance, currency, created_at FROM accounts WHERE id = $1 FOR UPDATE",
      [secondLockId]
    );

    // Re-check idempotency key after acquiring row locks.
    const postLockCheck = await client.query<Payment>(
      `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
       FROM payments
       WHERE idempotency_key = $1`,
      [idempotency_key]
    );

    if (postLockCheck.rows.length > 0) {
      const existing = postLockCheck.rows[0];
      await client.query("ROLLBACK"); // Release account locks without making changes

      const isMatch =
        existing.source_account_id === source_account_id &&
        existing.destination_account_id === destination_account_id &&
        Number(existing.amount) === transferAmount &&
        existing.currency === currency;

      if (isMatch) {
        return existing;
      } else {
        throw new TransferError(
          `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
          409
        );
      }
    }

    const accountMap = new Map<string, Account>();
    if (firstRes.rows[0]) accountMap.set(firstRes.rows[0].id, firstRes.rows[0]);
    if (secondRes.rows[0]) accountMap.set(secondRes.rows[0].id, secondRes.rows[0]);

    const sourceAccount = accountMap.get(source_account_id);
    const destinationAccount = accountMap.get(destination_account_id);

    // 3. Validate that both accounts exist
    if (!sourceAccount) {
      throw new TransferError(`Source account '${source_account_id}' not found`, 404);
    }
    if (!destinationAccount) {
      throw new TransferError(`Destination account '${destination_account_id}' not found`, 404);
    }

    // 4. Validate that the source account has sufficient available balance
    const sourceBalance = Number(sourceAccount.balance) - Number(sourceAccount.reserved_balance || 0);
    if (sourceBalance < transferAmount) {
      throw new TransferError(
        `Insufficient balance: source account balance is ${sourceAccount.balance} ${sourceAccount.currency}, required ${transferAmount.toFixed(2)} ${currency}`,
        400
      );
    }

    // 5. Validate currencies according to business rules
    if (sourceAccount.currency !== currency) {
      throw new TransferError(
        `Currency mismatch: source account currency is ${sourceAccount.currency}, payment currency is ${currency}`,
        400
      );
    }
    if (destinationAccount.currency !== currency) {
      throw new TransferError(
        `Currency mismatch: destination account currency is ${destinationAccount.currency}, payment currency is ${currency}`,
        400
      );
    }

    // 6. Deduct payment amount from source account
    await client.query(
      "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
      [transferAmount, source_account_id]
    );

    // 7. Add payment amount to destination account
    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
      [transferAmount, destination_account_id]
    );

    // 8. Insert payment record with status COMPLETED and idempotency_key
    const paymentResult = await client.query<Payment>(
      `INSERT INTO payments (
         idempotency_key,
         source_account_id,
         destination_account_id,
         amount,
         currency,
         status
       )
       VALUES ($1, $2, $3, $4, $5, 'COMPLETED')
       RETURNING id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at`,
      [idempotency_key, source_account_id, destination_account_id, transferAmount, currency]
    );

    // 9. COMMIT transaction
    await client.query("COMMIT");

    return paymentResult.rows[0];
  } catch (error: any) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[database] Failed to rollback transaction:", rollbackErr);
    }

    // Handle database-level UNIQUE constraint race condition (error code 23505)
    if (
      error.code === "23505" &&
      (error.constraint?.includes("idempotency") || error.detail?.includes("idempotency_key"))
    ) {
      const existing = await getPaymentByIdempotencyKey(idempotency_key);
      if (existing) {
        const isMatch =
          existing.source_account_id === source_account_id &&
          existing.destination_account_id === destination_account_id &&
          Number(existing.amount) === transferAmount &&
          existing.currency === currency;

        if (isMatch) {
          return existing;
        } else {
          throw new TransferError(
            `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
            409
          );
        }
      }
    }

    throw error;
  } finally {
    // Release client back to the connection pool
    client.release();
  }
}

export async function getPaymentById(id: string): Promise<Payment | null> {
  const result = await pool.query<Payment>(
    `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
     FROM payments
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

export async function getPaymentByIdempotencyKey(key: string): Promise<Payment | null> {
  const result = await pool.query<Payment>(
    `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
     FROM payments
     WHERE idempotency_key = $1`,
    [key]
  );

  return result.rows[0] || null;
}

export async function listPayments(limit = 20, offset = 0): Promise<Payment[]> {
  const result = await pool.query<Payment>(
    `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
     FROM payments
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows;
}

// ------------------------------------------------------------------------------
// Reservation & Asynchronous Fraud Decision Functions
// ------------------------------------------------------------------------------

export async function getReservationByPaymentId(paymentId: string): Promise<Reservation | null> {
  const result = await pool.query<Reservation>(
    `SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at
     FROM reservations
     WHERE payment_id = $1`,
    [paymentId]
  );

  return result.rows[0] || null;
}

/**
 * Phase 1: Atomically creates a pending payment and reserves source account funds.
 *
 * Available balance check: (balance - reserved_balance) >= amount
 * Status created: PENDING_FRAUD_CHECK
 * Reservation status: ACTIVE
 * Full multi-layer idempotency protection.
 */
export async function createPaymentWithReservation(
  params: CreatePaymentParams
): Promise<{ payment: Payment; reservation: Reservation; outboxEvent?: OutboxEvent }> {
  const {
    idempotency_key,
    source_account_id,
    destination_account_id,
    amount,
    currency,
  } = params;

  if (!idempotency_key || typeof idempotency_key !== "string" || idempotency_key.trim() === "") {
    throw new TransferError("Idempotency key is required", 400);
  }

  const paymentAmount = Number(amount);

  if (source_account_id === destination_account_id) {
    throw new TransferError("Source and destination accounts cannot be the same", 400);
  }

  if (isNaN(paymentAmount) || paymentAmount <= 0) {
    throw new TransferError("Payment amount must be greater than zero", 400);
  }

  // Pre-check: Fast path if payment with this idempotency key already exists
  const existingPre = await getPaymentByIdempotencyKey(idempotency_key);
  if (existingPre) {
    const isMatch =
      existingPre.source_account_id === source_account_id &&
      existingPre.destination_account_id === destination_account_id &&
      Number(existingPre.amount) === paymentAmount &&
      existingPre.currency === currency;

    if (isMatch) {
      const reservation = await getReservationByPaymentId(existingPre.id);
      const outboxEvents = await getOutboxEventsByAggregateId(existingPre.id);
      return { payment: existingPre, reservation: reservation!, outboxEvent: outboxEvents[0] };
    } else {
      throw new TransferError(
        `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
        409
      );
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // In-transaction check: In case another transaction committed just before BEGIN
    const txCheck = await client.query<Payment>(
      `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
       FROM payments
       WHERE idempotency_key = $1`,
      [idempotency_key]
    );

    if (txCheck.rows.length > 0) {
      const existing = txCheck.rows[0];
      await client.query("COMMIT");

      const isMatch =
        existing.source_account_id === source_account_id &&
        existing.destination_account_id === destination_account_id &&
        Number(existing.amount) === paymentAmount &&
        existing.currency === currency;

      if (isMatch) {
        const resCheck = await pool.query<Reservation>(
          `SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at
           FROM reservations WHERE payment_id = $1`,
          [existing.id]
        );
        const outboxCheck = await pool.query<OutboxEvent>(
          `SELECT id, event_type, aggregate_id, payload, created_at, published_at, attempts
           FROM outbox_events WHERE aggregate_id = $1`,
          [existing.id]
        );
        return { payment: existing, reservation: resCheck.rows[0], outboxEvent: outboxCheck.rows[0] };
      } else {
        throw new TransferError(
          `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
          409
        );
      }
    }

    // Lock source account with SELECT ... FOR UPDATE to check and modify available funds
    const sourceRes = await client.query<Account>(
      "SELECT id, balance, reserved_balance, currency, created_at FROM accounts WHERE id = $1 FOR UPDATE",
      [source_account_id]
    );

    // Re-check idempotency key after acquiring row lock
    const postLockCheck = await client.query<Payment>(
      `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
       FROM payments
       WHERE idempotency_key = $1`,
      [idempotency_key]
    );

    if (postLockCheck.rows.length > 0) {
      const existing = postLockCheck.rows[0];
      await client.query("ROLLBACK");

      const isMatch =
        existing.source_account_id === source_account_id &&
        existing.destination_account_id === destination_account_id &&
        Number(existing.amount) === paymentAmount &&
        existing.currency === currency;

      if (isMatch) {
        const resCheck = await pool.query<Reservation>(
          `SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at
           FROM reservations WHERE payment_id = $1`,
          [existing.id]
        );
        const outboxCheck = await pool.query<OutboxEvent>(
          `SELECT id, event_type, aggregate_id, payload, created_at, published_at, attempts
           FROM outbox_events WHERE aggregate_id = $1`,
          [existing.id]
        );
        return { payment: existing, reservation: resCheck.rows[0], outboxEvent: outboxCheck.rows[0] };
      } else {
        throw new TransferError(
          `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
          409
        );
      }
    }

    const sourceAccount = sourceRes.rows[0];
    if (!sourceAccount) {
      throw new TransferError(`Source account '${source_account_id}' not found`, 404);
    }

    // Verify destination account exists
    const destRes = await client.query<Account>(
      "SELECT id, balance, reserved_balance, currency, created_at FROM accounts WHERE id = $1",
      [destination_account_id]
    );
    const destinationAccount = destRes.rows[0];
    if (!destinationAccount) {
      throw new TransferError(`Destination account '${destination_account_id}' not found`, 404);
    }

    // Validate currencies
    if (sourceAccount.currency !== currency) {
      throw new TransferError(
        `Currency mismatch: source account currency is ${sourceAccount.currency}, payment currency is ${currency}`,
        400
      );
    }
    if (destinationAccount.currency !== currency) {
      throw new TransferError(
        `Currency mismatch: destination account currency is ${destinationAccount.currency}, payment currency is ${currency}`,
        400
      );
    }

    // Check available balance: balance - reserved_balance >= paymentAmount
    const currentBalance = Number(sourceAccount.balance);
    const currentReserved = Number(sourceAccount.reserved_balance || 0);
    const availableBalance = currentBalance - currentReserved;

    if (availableBalance < paymentAmount) {
      throw new TransferError(
        `Insufficient available balance: source account balance is ${currentBalance.toFixed(2)}, reserved is ${currentReserved.toFixed(2)} (available: ${availableBalance.toFixed(2)} ${sourceAccount.currency}), required ${paymentAmount.toFixed(2)} ${currency}`,
        400
      );
    }

    // 1. Hold funds: increment source account reserved_balance
    await client.query(
      "UPDATE accounts SET reserved_balance = reserved_balance + $1 WHERE id = $2",
      [paymentAmount, source_account_id]
    );

    // 2. Insert payment with status 'PENDING_FRAUD_CHECK'
    const paymentResult = await client.query<Payment>(
      `INSERT INTO payments (
         idempotency_key,
         source_account_id,
         destination_account_id,
         amount,
         currency,
         status
       )
       VALUES ($1, $2, $3, $4, $5, 'PENDING_FRAUD_CHECK')
       RETURNING id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at`,
      [idempotency_key, source_account_id, destination_account_id, paymentAmount, currency]
    );
    const payment = paymentResult.rows[0];

    // 3. Insert reservation record with status 'ACTIVE'
    const reservationResult = await client.query<Reservation>(
      `INSERT INTO reservations (
         payment_id,
         account_id,
         amount,
         currency,
         status
       )
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING id, payment_id, account_id, amount, currency, status, created_at, updated_at`,
      [payment.id, source_account_id, paymentAmount, currency]
    );
    const reservation = reservationResult.rows[0];

    // 4. Insert transactional outbox event (PaymentCreated) in the same transaction
    const outboxEventId = crypto.randomUUID();
    const eventTimestamp = new Date().toISOString();
    const eventPayload = {
      paymentId: payment.id,
      sourceAccountId: payment.source_account_id,
      destinationAccountId: payment.destination_account_id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
    };

    const outboxEnvelope = {
      eventId: outboxEventId,
      eventType: "PaymentCreated",
      aggregateId: payment.id,
      timestamp: eventTimestamp,
      version: 1,
      payload: eventPayload,
      paymentId: payment.id,
      sourceAccountId: payment.source_account_id,
      destinationAccountId: payment.destination_account_id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
    };

    const outboxResult = await client.query<OutboxEvent>(
      `INSERT INTO outbox_events (
         id,
         event_type,
         aggregate_id,
         payload,
         published_at,
         attempts
       )
       VALUES ($1, $2, $3, $4, NULL, 0)
       RETURNING id, event_type, aggregate_id, payload, created_at, published_at, attempts`,
      [outboxEventId, "PaymentCreated", payment.id, JSON.stringify(outboxEnvelope)]
    );
    const outboxEvent = outboxResult.rows[0];

    await client.query("COMMIT");
    return { payment, reservation, outboxEvent };
  } catch (error: any) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[database] Failed to rollback transaction:", rollbackErr);
    }

    // Handle database-level UNIQUE constraint race condition (error code 23505)
    if (
      error.code === "23505" &&
      (error.constraint?.includes("idempotency") || error.detail?.includes("idempotency_key"))
    ) {
      const existing = await getPaymentByIdempotencyKey(idempotency_key);
      if (existing) {
        const isMatch =
          existing.source_account_id === source_account_id &&
          existing.destination_account_id === destination_account_id &&
          Number(existing.amount) === paymentAmount &&
          existing.currency === currency;

        if (isMatch) {
          const resCheck = await pool.query<Reservation>(
            `SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at
             FROM reservations WHERE payment_id = $1`,
            [existing.id]
          );
          const outboxCheck = await pool.query<OutboxEvent>(
            `SELECT id, event_type, aggregate_id, payload, created_at, published_at, attempts
             FROM outbox_events WHERE aggregate_id = $1`,
            [existing.id]
          );
          return { payment: existing, reservation: resCheck.rows[0], outboxEvent: outboxCheck.rows[0] };
        } else {
          throw new TransferError(
            `Idempotency key conflict: '${idempotency_key}' was previously used with different payment parameters`,
            409
          );
        }
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Phase 2: Resolves fraud decisions for held payments.
 *
 * Supported decisions:
 * - APPROVED: Settles transfer, debits source balance, releases source reserved_balance,
 *             credits destination balance, marks reservation CONSUMED, payment COMPLETED.
 * - REJECTED: Releases source reserved_balance, marks reservation RELEASED, payment FRAUD_REJECTED.
 * - REVIEW: Keeps funds reserved, marks payment UNDER_REVIEW.
 *
 * Guarantees idempotent decision delivery.
 */
export async function applyFraudDecision(
  params: ApplyFraudDecisionParams
): Promise<{ payment: Payment; reservation?: Reservation }> {
  const { paymentId, decision, reason } = params;

  if (!["APPROVED", "REJECTED", "REVIEW"].includes(decision)) {
    throw new TransferError(`Invalid fraud decision '${decision}'. Allowed: APPROVED, REJECTED, REVIEW`, 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Lock payment row
    const paymentRes = await client.query<Payment>(
      `SELECT id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at
       FROM payments
       WHERE id = $1
       FOR UPDATE`,
      [paymentId]
    );

    if (paymentRes.rows.length === 0) {
      throw new TransferError(`Payment '${paymentId}' not found`, 404);
    }

    const payment = paymentRes.rows[0];

    // Idempotency check: If already finalized with same decision, safely return current state
    if (payment.status === "COMPLETED") {
      if (decision === "APPROVED") {
        await client.query("COMMIT");
        const resCheck = await pool.query<Reservation>(
          "SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at FROM reservations WHERE payment_id = $1",
          [paymentId]
        );
        return { payment, reservation: resCheck.rows[0] };
      } else {
        throw new TransferError(
          `Conflict: Payment '${paymentId}' is already COMPLETED and cannot be transitioned to ${decision}`,
          409
        );
      }
    }

    if (payment.status === "FRAUD_REJECTED") {
      if (decision === "REJECTED") {
        await client.query("COMMIT");
        const resCheck = await pool.query<Reservation>(
          "SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at FROM reservations WHERE payment_id = $1",
          [paymentId]
        );
        return { payment, reservation: resCheck.rows[0] };
      } else {
        throw new TransferError(
          `Conflict: Payment '${paymentId}' is already FRAUD_REJECTED and cannot be transitioned to ${decision}`,
          409
        );
      }
    }

    // Only payments in PENDING_FRAUD_CHECK or UNDER_REVIEW can receive decisions
    if (payment.status !== "PENDING_FRAUD_CHECK" && payment.status !== "UNDER_REVIEW") {
      throw new TransferError(
        `Payment '${paymentId}' cannot receive a fraud decision because its current status is '${payment.status}'`,
        400
      );
    }

    // 2. Lock reservation row
    const resRes = await client.query<Reservation>(
      `SELECT id, payment_id, account_id, amount, currency, status, created_at, updated_at
       FROM reservations
       WHERE payment_id = $1
       FOR UPDATE`,
      [paymentId]
    );

    if (resRes.rows.length === 0) {
      throw new TransferError(`No reservation record found for payment '${paymentId}'`, 404);
    }

    const reservation = resRes.rows[0];
    if (reservation.status !== "ACTIVE") {
      throw new TransferError(
        `Reservation for payment '${paymentId}' is not ACTIVE (current status: ${reservation.status})`,
        400
      );
    }

    const transferAmount = Number(payment.amount);

    // 3. Process based on decision
    if (decision === "APPROVED") {
      // Deterministic lock order on accounts (smaller UUID first)
      const [firstLockId, secondLockId] =
        payment.source_account_id < payment.destination_account_id
          ? [payment.source_account_id, payment.destination_account_id]
          : [payment.destination_account_id, payment.source_account_id];

      await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [firstLockId]);
      await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [secondLockId]);

      // Deduct from source balance and release reserved_balance hold
      await client.query(
        "UPDATE accounts SET balance = balance - $1, reserved_balance = reserved_balance - $1 WHERE id = $2",
        [transferAmount, payment.source_account_id]
      );

      // Credit destination balance
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
        [transferAmount, payment.destination_account_id]
      );

      // Mark reservation CONSUMED
      const updatedRes = await client.query<Reservation>(
        `UPDATE reservations
         SET status = 'CONSUMED', updated_at = NOW()
         WHERE id = $1
         RETURNING id, payment_id, account_id, amount, currency, status, created_at, updated_at`,
        [reservation.id]
      );

      // Mark payment COMPLETED
      const updatedPayment = await client.query<Payment>(
        `UPDATE payments
         SET status = 'COMPLETED'
         WHERE id = $1
         RETURNING id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at`,
        [payment.id]
      );

      await client.query("COMMIT");
      return { payment: updatedPayment.rows[0], reservation: updatedRes.rows[0] };
    } else if (decision === "REJECTED") {
      // Lock source account to release reserved_balance hold
      await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [payment.source_account_id]);

      await client.query(
        "UPDATE accounts SET reserved_balance = reserved_balance - $1 WHERE id = $2",
        [transferAmount, payment.source_account_id]
      );

      // Mark reservation RELEASED
      const updatedRes = await client.query<Reservation>(
        `UPDATE reservations
         SET status = 'RELEASED', updated_at = NOW()
         WHERE id = $1
         RETURNING id, payment_id, account_id, amount, currency, status, created_at, updated_at`,
        [reservation.id]
      );

      // Mark payment FRAUD_REJECTED
      const updatedPayment = await client.query<Payment>(
        `UPDATE payments
         SET status = 'FRAUD_REJECTED'
         WHERE id = $1
         RETURNING id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at`,
        [payment.id]
      );

      await client.query("COMMIT");
      return { payment: updatedPayment.rows[0], reservation: updatedRes.rows[0] };
    } else {
      // Decision is "REVIEW"
      // Reservation remains ACTIVE; payment is marked UNDER_REVIEW
      const updatedPayment = await client.query<Payment>(
        `UPDATE payments
         SET status = 'UNDER_REVIEW'
         WHERE id = $1
         RETURNING id, idempotency_key, source_account_id, destination_account_id, amount, currency, status, created_at`,
        [payment.id]
      );

      await client.query("COMMIT");
      return { payment: updatedPayment.rows[0], reservation };
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[database] Failed to rollback fraud decision transaction:", rollbackErr);
    }
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------
// Outbox Query & Update Utilities
// ------------------------------------------------------------------------------

/**
 * Retrieves unpublished outbox events in chronological order (FIFO).
 * Uses the partial index on (created_at ASC) WHERE published_at IS NULL.
 */
export async function getUnpublishedOutboxEvents(
  limit: number = 50
): Promise<OutboxEvent[]> {
  const result = await pool.query<OutboxEvent>(
    `SELECT id, event_type, aggregate_id, payload, created_at, published_at, attempts
     FROM outbox_events
     WHERE published_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Retrieves all outbox events associated with a specific aggregate ID (e.g., paymentId).
 */
export async function getOutboxEventsByAggregateId(
  aggregateId: string
): Promise<OutboxEvent[]> {
  const result = await pool.query<OutboxEvent>(
    `SELECT id, event_type, aggregate_id, payload, created_at, published_at, attempts
     FROM outbox_events
     WHERE aggregate_id = $1
     ORDER BY created_at ASC`,
    [aggregateId]
  );
  return result.rows;
}

/**
 * Marks an outbox event as successfully published by setting published_at = NOW().
 */
export async function markOutboxEventPublished(
  id: string
): Promise<OutboxEvent | null> {
  const result = await pool.query<OutboxEvent>(
    `UPDATE outbox_events
     SET published_at = NOW()
     WHERE id = $1
     RETURNING id, event_type, aggregate_id, payload, created_at, published_at, attempts`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Increments publication retry attempts for an outbox event.
 */
export async function incrementOutboxEventAttempts(
  id: string
): Promise<OutboxEvent | null> {
  const result = await pool.query<OutboxEvent>(
    `UPDATE outbox_events
     SET attempts = attempts + 1
     WHERE id = $1
     RETURNING id, event_type, aggregate_id, payload, created_at, published_at, attempts`,
    [id]
  );
  return result.rows[0] || null;
}
