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
    encoder_sn text,
    yaw_err_deg double precision NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    verdict text,
    reason text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    processed_at timestamptz
);
-- 老库升级：已存在的 yaw_logs 补上编码器出厂号列。
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS encoder_sn text;

-- 编码器校准证书：出厂号 → 到期日。报送是否拦截全以本表为准。
CREATE TABLE IF NOT EXISTS encoders (
    serial_no text PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL
);

-- 报送拦截留痕：每次因证书过期被拒写入一行，recent 取最新一条。
CREATE TABLE IF NOT EXISTS encoder_blocks (
    id bigserial PRIMARY KEY,
    serial_no text NOT NULL,
    blocked_by text NOT NULL,
    blocked_at timestamptz NOT NULL,
    reason text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_encoder_blocks_recent
    ON encoder_blocks (serial_no, id DESC);
"""
