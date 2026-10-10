POST /payments
        │
        │ Idempotency-Key: ABC123
        ↓
executeTransferPayment()
        │
        ├─ Is ABC123 already used?
        │       │
        │       ├─ No → continue
        │       │
        │       └─ Yes
        │            ├─ same request → return original payment
        │            └─ different request → reject
        │
        ↓
       BEGIN
        ↓
       lock accounts
        ↓
       validate
        ↓
        debit
        ↓
        credit
        ↓
        save payment + idempotency key
        ↓
        COMMIT



                    PAYMENT
                       │
                       ▼
                 PostgreSQL
                       │
                       ▼
                    Kafka
                       │
                       ▼
                Fraud Worker
                       │
                       ▼
             Fraud Service
                       │
          ┌────────────┼────────────┐
          │            │            │
       success      timeout       failure
          │            │            │
          ▼            ▼            ▼
       process       retry       retry
                       │
                       ▼
                  max retries
                       │
                       ▼
                      DLQ     