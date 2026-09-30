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
       source_account_id,
       destination_account_id,
       amount,
       currency,
       status
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, source_account_id, destination_account_id, amount, currency, status, created_at`,
    [
      params.source_account_id,
      params.destination_account_id,
      params.amount,
      params.currency,
      status,
    ]
  );

  return result.rows[0];
}

export async function getPaymentById(id: string): Promise<Payment | null> {
  const result = await pool.query<Payment>(
    `SELECT id, source_account_id, destination_account_id, amount, currency, status, created_at
     FROM payments
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

export async function listPayments(limit = 20, offset = 0): Promise<Payment[]> {
  const result = await pool.query<Payment>(
    `SELECT id, source_account_id, destination_account_id, amount, currency, status, created_at
     FROM payments
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows;
}
