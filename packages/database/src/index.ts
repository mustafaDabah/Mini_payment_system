// ==============================================================================
// PostgreSQL Connection Pool & Database Utilities
// ==============================================================================

import { Pool, PoolConfig } from "pg";
import dotenv from "dotenv";
import path from "path";

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
export type PaymentStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface Account {
  id: string;
  balance: string;
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

-- 2. Accounts Table
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  balance DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  currency payment_currency NOT NULL DEFAULT 'USD',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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

-- 4. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_payments_source ON payments(source_account_id);
CREATE INDEX IF NOT EXISTS idx_payments_destination ON payments(destination_account_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- 5. Safe Migration for Existing Payments Table
-- Handles development databases without silently dropping or breaking existing records
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
UPDATE payments SET idempotency_key = gen_random_uuid()::text WHERE idempotency_key IS NULL;
ALTER TABLE payments ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key ON payments(idempotency_key);
`;

/** 
 * Executes DDL queries to create accounts, payments tables, and enums.
 */
export async function initDatabase(): Promise<void> {
  await pool.query(SCHEMA_SQL);
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
     RETURNING id, balance, currency, created_at`,
    [balance, currency]
  );

  return result.rows[0];
}

export async function getAccountById(id: string): Promise<Account | null> {
  const result = await pool.query<Account>(
    `SELECT id, balance, currency, created_at
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
      "SELECT id, balance, currency, created_at FROM accounts WHERE id = $1 FOR UPDATE",
      [firstLockId]
    );

    const secondRes = await client.query<Account>(
      "SELECT id, balance, currency, created_at FROM accounts WHERE id = $1 FOR UPDATE",
      [secondLockId]
    );

    // Re-check idempotency key after acquiring row locks.
    // If two identical requests raced for the same accounts, Request 2 was paused waiting for row locks.
    // Once Request 1 commits, Request 2 acquires the lock and will immediately see Request 1's payment!
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

    // 4. Validate that the source account has sufficient balance
    const sourceBalance = Number(sourceAccount.balance);
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
