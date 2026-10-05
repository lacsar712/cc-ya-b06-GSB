import asyncio
import os
from datetime import datetime, time, timedelta, timezone
from functools import wraps

from jose import JWTError, jwt
from passlib.context import CryptContext
from quart import Quart, jsonify, request
from quart.json.provider import DefaultJSONProvider

from db import SCHEMA, connect
from rules import CERT_EXPIRED_SQL, judge


class ISOJSONProvider(DefaultJSONProvider):
    """全接口统一输出 ISO 8601（带时区），避免默认 HTTP 日期格式。"""

    ensure_ascii = False

    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return super().default(obj)

SECRET = os.environ.get("JWT_SECRET", "yaw-align-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "technician": {
        "role": "writer",
        "password_hash": pwd.hash("tech123456"),
    },
    "observer": {
        "role": "reader",
        "password_hash": pwd.hash("obs123456"),
    },
}

# 续期快捷按钮一次延长的时长
RENEW_SPAN_DAYS = 365

app = Quart(__name__)
app.json = ISOJSONProvider(app)


def _run_db(fn, *args, **kwargs):
    return fn(*args, **kwargs)


async def run_db(fn, *args, **kwargs):
    return await asyncio.to_thread(_run_db, fn, *args, **kwargs)


def seed_if_empty(conn):
    conn.execute(SCHEMA)
    count = conn.execute("SELECT COUNT(*) AS n FROM yaw_logs").fetchone()["n"]
    if count == 0:
        now = datetime.now(timezone.utc)
        samples = [
            ("W01", 0.4, "合格"),
            ("W07", 3.2, "偏航超差"),
        ]
        for code, err, expected_verdict in samples:
            verdict, reason = judge(err)
            assert verdict == expected_verdict
            conn.execute(
                """INSERT INTO yaw_logs
                   (turbine_code, yaw_err_deg, status, verdict, reason,
                    created_by, created_at, processed_at)
                   VALUES (%s, %s, 'done', %s, %s, %s, %s, %s)""",
                (code, err, verdict, reason, "technician", now, now),
            )

    # 编码器校准证书种子：ENC-A 尚在有效期，ENC-B 已过期且有历史拦截
    enc_count = conn.execute("SELECT COUNT(*) AS n FROM encoders").fetchone()["n"]
    if enc_count == 0:
        now = datetime.now(timezone.utc)
        seeds = [
            ("ENC-A", now + timedelta(days=30)),
            ("ENC-B", now - timedelta(days=1)),
        ]
        for serial_no, expires_at in seeds:
            conn.execute(
                """INSERT INTO encoders (serial_no, expires_at, updated_by, updated_at)
                   VALUES (%s, %s, 'technician', %s)""",
                (serial_no, expires_at, now),
            )
        conn.execute(
            """INSERT INTO encoder_blocks (serial_no, blocked_by, blocked_at, reason)
               VALUES (%s, %s, %s, %s)""",
            (
                "ENC-B",
                "technician",
                now - timedelta(hours=2),
                block_reason(now - timedelta(days=1)),
            ),
        )


@app.before_serving
async def startup():
    def init():
        with connect() as conn:
            seed_if_empty(conn)
            conn.commit()

    await run_db(init)


def parse_bearer():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


async def current_user():
    token = parse_bearer()
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except JWTError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_login(handler):
    @wraps(handler)
    async def wrapper(*args, **kwargs):
        user = await current_user()
        if user is None:
            return jsonify({"detail": "未登录"}), 401
        return await handler(user, *args, **kwargs)

    return wrapper


def require_writer(message: str = "仅现场技师可执行此操作"):
    def decorator(handler):
        @wraps(handler)
        async def wrapper(*args, **kwargs):
            user = await current_user()
            if user is None:
                return jsonify({"detail": "未登录"}), 401
            if user["role"] != "writer":
                return jsonify({"detail": message}), 403
            return await handler(user, *args, **kwargs)

        return wrapper

    return decorator


def block_reason(expires_at: datetime) -> str:
    """拦截留痕与用户提示共用的文案口径。"""
    day = expires_at.astimezone(timezone.utc).strftime("%Y-%m-%d")
    return f"编码器校准证书已于 {day} 到期，续期后才开放报送"


def parse_expires_at(raw) -> datetime | None:
    """支持 YYYY-MM-DD（当天结束前有效）或完整 ISO 时间； naive 视为 UTC。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    try:
        if len(text) == 10:
            day = datetime.strptime(text, "%Y-%m-%d").date()
            return datetime.combine(day, time(23, 59, 59, 999999), timezone.utc)
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


ENCODERS_SELECT = f"""
    SELECT e.serial_no, e.expires_at, e.updated_by, e.updated_at,
           {CERT_EXPIRED_SQL} AS expired,
           b.reason AS recent_block_reason,
           b.blocked_at AS recent_block_at,
           b.blocked_by AS recent_block_by
    FROM encoders e
    LEFT JOIN LATERAL (
        SELECT reason, blocked_at, blocked_by
        FROM encoder_blocks
        WHERE serial_no = e.serial_no
        ORDER BY id DESC
        LIMIT 1
    ) b ON true
"""


@app.get("/api/health")
async def health():
    return jsonify({"status": "ok", "service": "yaw-align-log"})


@app.post("/api/auth/login")
async def login():
    body = await request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return jsonify({"detail": "用户名或密码错误"}), 401
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return jsonify(
        {
            "access_token": token,
            "username": username,
            "role": user["role"],
        }
    )


@app.get("/api/logs")
@require_login
async def list_logs(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT id, turbine_code, encoder_sn, yaw_err_deg, status, verdict,
                          reason, created_by, created_at, processed_at
                   FROM yaw_logs ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.post("/api/logs")
@require_writer("仅现场技师可提交偏航记录")
async def create_log(user):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = (body.get("turbine_code") or "").strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    encoder_sn = (body.get("encoder_sn") or "").strip()
    if not encoder_sn:
        return jsonify({"detail": "编码器出厂号不能为空"}), 400
    try:
        yaw_err_deg = float(body.get("yaw_err_deg"))
    except (TypeError, ValueError):
        return jsonify({"detail": "偏航误差必须是数字"}), 400

    def submit():
        # 单事务 + 编码器行锁：证书判定、拦截留痕、报送入库在这里面原子完成。
        # 与改到期日/续期抢同一把行锁，同刻争抢时只会出现一种结果。
        # 判定时刻与留痕时刻都取数据库 clock_timestamp()，与专页读口同源。
        with connect() as conn:
            with conn.transaction():
                # 第一步先取行锁（不做判定），取锁后再读 clock_timestamp 判定，
                # 保证在锁队列里等待期间续期/改期先提交时，本次按新到期日判定，
                # 且留痕时刻晚于先提交的一方。
                locked = conn.execute(
                    """SELECT serial_no FROM encoders
                       WHERE serial_no = %s
                       FOR UPDATE""",
                    (encoder_sn,),
                ).fetchone()
                if locked is None:
                    return "unregistered", None
                enc = conn.execute(
                    f"""SELECT expires_at,
                               clock_timestamp() AS db_now,
                               {CERT_EXPIRED_SQL} AS expired
                        FROM encoders
                        WHERE serial_no = %s""",
                    (encoder_sn,),
                ).fetchone()
                if enc["expired"]:
                    reason = block_reason(enc["expires_at"])
                    conn.execute(
                        """INSERT INTO encoder_blocks
                           (serial_no, blocked_by, blocked_at, reason)
                           VALUES (%s, %s, %s, %s)""",
                        (
                            encoder_sn,
                            user["username"],
                            enc["db_now"],
                            reason,
                        ),
                    )
                    return "blocked", {
                        "serial_no": encoder_sn,
                        "expires_at": enc["expires_at"],
                        "reason": reason,
                    }
                row = conn.execute(
                    """INSERT INTO yaw_logs
                       (turbine_code, encoder_sn, yaw_err_deg, status, verdict,
                        reason, created_by, created_at)
                       VALUES (%s, %s, %s, 'pending', NULL, NULL, %s, %s)
                       RETURNING id, turbine_code, encoder_sn, yaw_err_deg, status,
                                 verdict, reason, created_by, created_at, processed_at""",
                    (
                        turbine_code,
                        encoder_sn,
                        yaw_err_deg,
                        user["username"],
                        enc["db_now"],
                    ),
                ).fetchone()
                return "accepted", row

    outcome, payload = await run_db(submit)
    if outcome == "unregistered":
        return (
            jsonify(
                {
                    "detail": (
                        f"出厂号 {encoder_sn} 未登记校准证书，"
                        "请先由技师录入到期日后续期再报送"
                    )
                }
            ),
            400,
        )
    if outcome == "blocked":
        return jsonify({"detail": payload["reason"], "blocked": True}), 403
    return jsonify(payload), 201


@app.get("/api/encoders")
@require_login
async def list_encoders(user):
    def query():
        with connect() as conn:
            return conn.execute(
                ENCODERS_SELECT + " ORDER BY e.serial_no"
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.put("/api/encoders/<serial_no>/expiry")
@require_writer("仅现场技师可维护编码器校准证书")
async def set_encoder_expiry(user, serial_no):
    body = await request.get_json(force=True, silent=True) or {}
    expires_at = parse_expires_at(body.get("expires_at"))
    if expires_at is None:
        return jsonify({"detail": "到期日格式应为 YYYY-MM-DD 或 ISO 时间"}), 400

    row = await run_db(upsert_expiry, serial_no, expires_at, user["username"])
    return jsonify(row)


@app.post("/api/encoders/<serial_no>/renew")
@require_writer("仅现场技师可维护编码器校准证书")
async def renew_encoder(user, serial_no):
    # 续期时长由数据库时钟加算，不采用前端时间，避免口径分叉。
    row = await run_db(renew_expiry, serial_no, user["username"])
    return jsonify(row)


def upsert_expiry(serial_no, expires_at, username):
    # 先锁行再写：与报送写口互斥，续期与报送同刻到达时，
    # 后拿到锁的一方按新到期日重新判定，不会又放行又判过期。
    with connect() as conn:
        with conn.transaction():
            existing = conn.execute(
                "SELECT serial_no FROM encoders WHERE serial_no = %s FOR UPDATE",
                (serial_no,),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO encoders
                       (serial_no, expires_at, updated_by, updated_at)
                       VALUES (%s, %s, %s, clock_timestamp())""",
                    (serial_no, expires_at, username),
                )
            else:
                conn.execute(
                    """UPDATE encoders
                       SET expires_at = %s, updated_by = %s,
                           updated_at = clock_timestamp()
                       WHERE serial_no = %s""",
                    (expires_at, username, serial_no),
                )
            return conn.execute(
                ENCODERS_SELECT + " WHERE e.serial_no = %s",
                (serial_no,),
            ).fetchone()


def renew_expiry(serial_no, username):
    span = timedelta(days=RENEW_SPAN_DAYS)
    with connect() as conn:
        with conn.transaction():
            # 先取行锁，再读统一时刻：与报送写口互斥，且续期基准时刻
            # 不包含等锁时间，留痕顺序与行锁顺序一致。
            conn.execute(
                "SELECT serial_no FROM encoders WHERE serial_no = %s FOR UPDATE",
                (serial_no,),
            ).fetchone()
            act = conn.execute("SELECT clock_timestamp() AS t").fetchone()["t"]
            conn.execute(
                """INSERT INTO encoders (serial_no, expires_at, updated_by, updated_at)
                   VALUES (%s, %s + %s::interval, %s, %s)
                   ON CONFLICT (serial_no) DO UPDATE
                   SET expires_at = GREATEST(encoders.expires_at, %s) + %s::interval,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = %s""",
                (
                    serial_no,
                    act,
                    span,
                    username,
                    act,
                    act,
                    span,
                    act,
                ),
            )
            return conn.execute(
                ENCODERS_SELECT + " WHERE e.serial_no = %s",
                (serial_no,),
            ).fetchone()
