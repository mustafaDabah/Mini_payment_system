// ==============================================================================
// OpenAPI 3.0.3 Specification for Mini Payment System
// ==============================================================================

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Mini Payment System API",
    version: "1.0.0",
    description:
      "Educational payment event-processing API for practicing backend system design concepts.",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development server",
    },
  ],
  tags: [
    {
      name: "System",
      description: "Health and readiness verification endpoints",
    },
    {
      name: "Accounts",
      description: "Account creation and balance inspection",
    },
    {
      name: "Payments",
      description: "Payment transaction management",
    },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Basic service health check",
        description: "Returns OK if the HTTP server process is running.",
        responses: {
          "200": {
            description: "Service is operational",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/health/db": {
      get: {
        tags: ["System"],
        summary: "Database connectivity check",
        description: "Executes `SELECT NOW()` against PostgreSQL to verify connectivity.",
        responses: {
          "200": {
            description: "Database connection healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    database: { type: "string", example: "connected" },
                    timestamp: { type: "string", format: "date-time", example: "2026-10-04T12:00:00.000Z" },
                  },
                },
              },
            },
          },
          "503": {
            description: "Database connection failed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "error" },
                    database: { type: "string", example: "disconnected" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/accounts": {
      post: {
        tags: ["Accounts"],
        summary: "Create a new account",
        description: "Creates an account with an initial balance and supported currency.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateAccountRequest",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Account created successfully",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Account",
                },
              },
            },
          },
          "400": {
            description: "Invalid input data",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "500": {
            description: "Internal server error",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/accounts/{id}": {
      get: {
        tags: ["Accounts"],
        summary: "Get account by ID",
        description: "Retrieves account information and current balance by account UUID.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Account UUID",
            schema: {
              type: "string",
              format: "uuid",
              example: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
            },
          },
        ],
        responses: {
          "200": {
            description: "Account found",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Account",
                },
              },
            },
          },
          "404": {
            description: "Account not found",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/payments": {
      post: {
        tags: ["Payments"],
        summary: "Create and execute an atomic payment transfer",
        description:
          "Atomically transfers funds from source to destination account using deterministic row-level locks (SELECT ... FOR UPDATE). Enforces idempotency via the required Idempotency-Key header.",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "Client-generated unique key (UUID) to guarantee idempotent payment execution on network retries.",
            schema: {
              type: "string",
              format: "uuid",
              example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreatePaymentRequest",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Payment executed atomically and completed (or existing payment returned for idempotent retry)",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Payment",
                },
              },
            },
          },
          "400": {
            description: "Validation or business error (missing Idempotency-Key, insufficient balance, currency mismatch, invalid amount)",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
                examples: {
                  missing_key: {
                    summary: "Missing Idempotency-Key header",
                    value: {
                      error: "Idempotency-Key header is required",
                    },
                  },
                  insufficient_balance: {
                    summary: "Insufficient balance",
                    value: {
                      error: "Insufficient balance: source account balance is 100.00 USD, required 300.00 USD",
                    },
                  },
                  currency_mismatch: {
                    summary: "Currency mismatch",
                    value: {
                      error: "Currency mismatch: source account currency is EUR, payment currency is USD",
                    },
                  },
                },
              },
            },
          },
          "404": {
            description: "Source or destination account not found",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
          "409": {
            description: "Idempotency key conflict: the key was previously used with different payment parameters",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
                examples: {
                  idempotency_conflict: {
                    summary: "Parameter mismatch for existing idempotency key",
                    value: {
                      error: "Idempotency key conflict: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' was previously used with different payment parameters",
                    },
                  },
                },
              },
            },
          },
        },
      },
      get: {
        tags: ["Payments"],
        summary: "List payments",
        description: "Retrieves a paginated list of recent payments ordered by creation date descending.",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Number of payments to return (max 100)",
            schema: {
              type: "integer",
              default: 20,
              minimum: 1,
              maximum: 100,
            },
          },
          {
            name: "offset",
            in: "query",
            required: false,
            description: "Number of payments to skip",
            schema: {
              type: "integer",
              default: 0,
              minimum: 0,
            },
          },
        ],
        responses: {
          "200": {
            description: "List of payments",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/PaymentListResponse",
                },
              },
            },
          },
        },
      },
    },
    "/payments/{id}": {
      get: {
        tags: ["Payments"],
        summary: "Get payment by ID",
        description: "Retrieves payment details by UUID.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Payment UUID",
            schema: {
              type: "string",
              format: "uuid",
              example: "e4b6e5e0-7c64-4e4b-9721-827dbd761234",
            },
          },
        ],
        responses: {
          "200": {
            description: "Payment details",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Payment",
                },
              },
            },
          },
          "404": {
            description: "Payment not found",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Currency: {
        type: "string",
        enum: ["USD", "EUR", "GBP"],
        description: "Supported currencies in the payment system",
        example: "USD",
      },
      PaymentStatus: {
        type: "string",
        enum: ["PENDING", "COMPLETED", "FAILED"],
        description: "Lifecycle status of a payment",
        example: "COMPLETED",
      },
      Account: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            example: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          },
          balance: {
            type: "string",
            example: "1000.00",
            description: "Account balance formatted as decimal string",
          },
          currency: {
            $ref: "#/components/schemas/Currency",
          },
          created_at: {
            type: "string",
            format: "date-time",
            example: "2026-10-04T12:00:00.000Z",
          },
        },
        required: ["id", "balance", "currency", "created_at"],
      },
      CreateAccountRequest: {
        type: "object",
        properties: {
          balance: {
            type: "number",
            minimum: 0,
            default: 0,
            example: 1000.0,
            description: "Initial balance for the account",
          },
          currency: {
            $ref: "#/components/schemas/Currency",
            default: "USD",
          },
        },
      },
      Payment: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            example: "e4b6e5e0-7c64-4e4b-9721-827dbd761234",
            description: "Backend-generated unique payment ID",
          },
          idempotency_key: {
            type: "string",
            format: "uuid",
            example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
            description: "Client-provided idempotency key",
          },
          source_account_id: {
            type: "string",
            format: "uuid",
            example: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          },
          destination_account_id: {
            type: "string",
            format: "uuid",
            example: "b1ffcd88-8b0a-3de7-aa5c-5aa8ac270b22",
          },
          amount: {
            type: "string",
            example: "300.00",
            description: "Payment amount formatted as decimal string",
          },
          currency: {
            $ref: "#/components/schemas/Currency",
          },
          status: {
            $ref: "#/components/schemas/PaymentStatus",
            example: "COMPLETED",
          },
          created_at: {
            type: "string",
            format: "date-time",
            example: "2026-10-04T12:05:00.000Z",
          },
        },
        required: [
          "id",
          "idempotency_key",
          "source_account_id",
          "destination_account_id",
          "amount",
          "currency",
          "status",
          "created_at",
        ],
      },
      CreatePaymentRequest: {
        type: "object",
        required: ["source_account_id", "destination_account_id", "amount"],
        properties: {
          source_account_id: {
            type: "string",
            format: "uuid",
            example: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
            description: "UUID of the source account",
          },
          destination_account_id: {
            type: "string",
            format: "uuid",
            example: "b1ffcd88-8b0a-3de7-aa5c-5aa8ac270b22",
            description: "UUID of the destination account",
          },
          amount: {
            type: "number",
            minimum: 0.01,
            example: 300.0,
            description: "Payment amount (must be positive)",
          },
          currency: {
            $ref: "#/components/schemas/Currency",
            default: "USD",
          },
        },
      },
      PaymentListResponse: {
        type: "object",
        properties: {
          data: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Payment",
            },
          },
          limit: { type: "integer", example: 20 },
          offset: { type: "integer", example: 0 },
        },
        required: ["data", "limit", "offset"],
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "string",
            example: "Insufficient balance: source account balance is 100.00 USD, required 300.00 USD",
          },
        },
        required: ["error"],
      },
    },
  },
};

