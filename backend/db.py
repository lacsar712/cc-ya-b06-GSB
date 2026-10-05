import os

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://app:app@localhost:54399/yawalign",
)


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


SCHEMA = """
CREATE TABLE IF NOT EXISTS yaw_logs (
    id serial PRIMARY KEY,
    turbine_code text NOT NULL,
    yaw_err_deg double precision NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    verdict text,
    reason text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS encoders (
    serial_no text PRIMARY KEY,
    expires_at date NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_by text,
    updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS encoder_events (
    id serial PRIMARY KEY,
    serial_no text NOT NULL,
    event_type text NOT NULL CHECK (
        event_type IN ('registered', 'renewed', 'date_changed', 'intercepted')
    ),
    detail text NOT NULL,
    actor text NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_encoder_events_serial_id
    ON encoder_events (serial_no, id DESC);

-- 证书有效性的唯一口径：到期日当天仍有效，次日（按 UTC）起过期。
-- 专页展示与写口拦截都调用本函数，禁止在别处另写一套比较逻辑。
CREATE OR REPLACE FUNCTION encoder_cert_valid(
    p_expires date,
    p_at timestamptz DEFAULT now()
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT p_expires >= (p_at AT TIME ZONE 'UTC')::date
$$;
"""
