import asyncio
import os
from datetime import date, datetime, timedelta, timezone
from functools import wraps

from jose import JWTError, jwt
from passlib.context import CryptContext
from quart import Quart, jsonify, request
from quart.json.provider import DefaultJSONProvider

from db import SCHEMA, connect
from rules import judge


class IsoJsonProvider(DefaultJSONProvider):
    """date/datetime 一律输出 ISO：到期日必须是 YYYY-MM-DD 供前端日期控件使用。"""

    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, date):
            return obj.isoformat()
        return super().default(obj)


app = Quart(__name__)
app.json = IsoJsonProvider(app)

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


def _run_db(fn, *args, **kwargs):
    return fn(*args, **kwargs)


async def run_db(fn, *args, **kwargs):
    return await asyncio.to_thread(_run_db, fn, *args, **kwargs)


# 编码器列表口径：有效性一律走数据库函数 encoder_cert_valid，
# 与报送写口 / 续期写口中的判定是同一个函数，不在 Python 侧另写比较。
_ENCODER_SELECT = """
SELECT e.serial_no,
       e.expires_at,
       encoder_cert_valid(e.expires_at) AS valid,
       e.created_by,
       e.created_at,
       e.updated_by,
       e.updated_at,
       (SELECT ev.detail FROM encoder_events ev
         WHERE ev.serial_no = e.serial_no AND ev.event_type = 'intercepted'
         ORDER BY ev.id DESC LIMIT 1) AS last_intercept_reason,
       (SELECT ev.created_at FROM encoder_events ev
         WHERE ev.serial_no = e.serial_no AND ev.event_type = 'intercepted'
         ORDER BY ev.id DESC LIMIT 1) AS last_intercept_at,
       (SELECT ev.created_at FROM encoder_events ev
         WHERE ev.serial_no = e.serial_no AND ev.event_type = 'renewed'
         ORDER BY ev.id DESC LIMIT 1) AS last_renewed_at
FROM encoders e
{where}
ORDER BY e.serial_no
"""


def query_encoders(serial_no=None):
    with connect() as conn:
        if serial_no is None:
            sql = _ENCODER_SELECT.format(where="")
            return conn.execute(sql).fetchall()
        sql = _ENCODER_SELECT.format(where="WHERE e.serial_no = %s")
        row = conn.execute(sql, (serial_no,)).fetchone()
        return row


def seed_if_empty(conn):
    conn.execute(SCHEMA)

    if conn.execute("SELECT COUNT(*) AS n FROM encoders").fetchone()["n"] == 0:
        now = datetime.now(timezone.utc)
        today = now.date()
        encoder_seeds = [
            ("W01", today + timedelta(days=365)),
            ("W07", today + timedelta(days=30)),
        ]
        for serial_no, expires_at in encoder_seeds:
            conn.execute(
                """INSERT INTO encoders
                   (serial_no, expires_at, created_by, created_at)
                   VALUES (%s, %s, 'system', %s)""",
                (serial_no, expires_at, now),
            )
            conn.execute(
                """INSERT INTO encoder_events
                   (serial_no, event_type, detail, actor, created_at)
                   VALUES (%s, 'registered', %s, 'system', %s)""",
                (
                    serial_no,
                    f"证书登记，到期日 {expires_at.isoformat()}",
                    now,
                ),
            )

    count = conn.execute("SELECT COUNT(*) AS n FROM yaw_logs").fetchone()["n"]
    if count > 0:
        return
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


def require_writer(handler):
    @wraps(handler)
    async def wrapper(*args, **kwargs):
        user = await current_user()
        if user is None:
            return jsonify({"detail": "未登录"}), 401
        if user["role"] != "writer":
            return jsonify({"detail": "仅现场技师可提交偏航记录"}), 403
        return await handler(user, *args, **kwargs)

    return wrapper


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
                """SELECT id, turbine_code, yaw_err_deg, status, verdict, reason,
                          created_by, created_at, processed_at
                   FROM yaw_logs ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.post("/api/logs")
@require_writer
async def create_log(user):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = (body.get("turbine_code") or "").strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    try:
        yaw_err_deg = float(body.get("yaw_err_deg"))
    except (TypeError, ValueError):
        return jsonify({"detail": "偏航误差必须是数字"}), 400

    now = datetime.now(timezone.utc)

    def insert():
        # 关键：先对编码器行加 FOR UPDATE 行锁，再用库函数判定有效性。
        # 续期/改期事务也锁同一行，二者严格串行，
        # 报送要么看到改期前、要么看到改期后，不会同时出现两种结果。
        with connect() as conn:
            enc = conn.execute(
                """SELECT serial_no, expires_at,
                          encoder_cert_valid(expires_at) AS cert_valid
                   FROM encoders
                   WHERE serial_no = %s
                   FOR UPDATE""",
                (turbine_code,),
            ).fetchone()

            if enc is None:
                conn.rollback()
                return {
                    "status": 400,
                    "detail": (
                        f"出厂号 {turbine_code} 未登记编码器校准证书，"
                        f"无法报送，请先在编码器专页登记"
                    ),
                }

            if not enc["cert_valid"]:
                intercept_detail = (
                    f"证书已于 {enc['expires_at'].isoformat()} 到期，"
                    f"续期后才开放报送"
                )
                conn.execute(
                    """INSERT INTO encoder_events
                       (serial_no, event_type, detail, actor, created_at)
                       VALUES (%s, 'intercepted', %s, %s, %s)""",
                    (
                        turbine_code,
                        intercept_detail,
                        user["username"],
                        now,
                    ),
                )
                conn.commit()
                return {
                    "status": 403,
                    "detail": (
                        f"出厂号 {turbine_code} 的编码器校准证书已过期"
                        f"（到期日 {enc['expires_at'].isoformat()}），"
                        f"请续期后再报送"
                    ),
                }

            row = conn.execute(
                """INSERT INTO yaw_logs
                   (turbine_code, yaw_err_deg, status, verdict, reason,
                    created_by, created_at)
                   VALUES (%s, %s, 'pending', NULL, NULL, %s, %s)
                   RETURNING id, turbine_code, yaw_err_deg, status, verdict, reason,
                             created_by, created_at, processed_at""",
                (turbine_code, yaw_err_deg, user["username"], now),
            ).fetchone()
            conn.commit()
            return {"status": 201, "row": row}

    result = await run_db(insert)
    if "row" in result:
        return jsonify(result["row"]), 201
    return jsonify({"detail": result["detail"]}), result["status"]


@app.get("/api/encoders")
@require_login
async def list_encoders(user):
    rows = await run_db(query_encoders)
    return jsonify(rows)


@app.post("/api/encoders")
@require_writer
async def register_encoder(user):
    body = await request.get_json(force=True, silent=True) or {}
    serial_no = (body.get("serial_no") or "").strip()
    if not serial_no:
        return jsonify({"detail": "出厂号不能为空"}), 400
    raw_expiry = (body.get("expires_at") or "").strip()
    try:
        expires_at = date.fromisoformat(raw_expiry)
    except ValueError:
        return jsonify({"detail": "到期日格式应为 YYYY-MM-DD"}), 400

    def create():
        now = datetime.now(timezone.utc)
        with connect() as conn:
            with conn.transaction():
                exists = conn.execute(
                    "SELECT 1 FROM encoders WHERE serial_no = %s FOR UPDATE",
                    (serial_no,),
                ).fetchone()
                if exists is not None:
                    return {
                        "status": 409,
                        "detail": f"出厂号 {serial_no} 已登记，请直接修改到期日",
                    }
                conn.execute(
                    """INSERT INTO encoders
                       (serial_no, expires_at, created_by, created_at)
                       VALUES (%s, %s, %s, %s)""",
                    (serial_no, expires_at, user["username"], now),
                )
                conn.execute(
                    """INSERT INTO encoder_events
                       (serial_no, event_type, detail, actor, created_at)
                       VALUES (%s, 'registered', %s, %s, %s)""",
                    (
                        serial_no,
                        f"证书登记，到期日 {expires_at.isoformat()}",
                        user["username"],
                        now,
                    ),
                )
            conn.commit()
            return {"status": 201, "row": query_encoders(serial_no)}

    result = await run_db(create)
    if "row" in result:
        return jsonify(result["row"]), result["status"]
    return jsonify({"detail": result["detail"]}), result["status"]


@app.get("/api/encoders/<serial_no>/events")
@require_login
async def encoder_events(user, serial_no):
    def query():
        with connect() as conn:
            exists = conn.execute(
                "SELECT 1 FROM encoders WHERE serial_no = %s", (serial_no,)
            ).fetchone()
            if exists is None:
                return None
            return conn.execute(
                """SELECT id, serial_no, event_type, detail, actor, created_at
                   FROM encoder_events
                   WHERE serial_no = %s
                   ORDER BY id DESC""",
                (serial_no,),
            ).fetchall()

    rows = await run_db(query)
    if rows is None:
        return jsonify({"detail": f"出厂号 {serial_no} 不存在"}), 404
    return jsonify(rows)


@app.put("/api/encoders/<serial_no>/expiry")
@require_writer
async def update_encoder_expiry(user, serial_no):
    body = await request.get_json(force=True, silent=True) or {}
    raw_expiry = (body.get("expires_at") or "").strip()
    try:
        new_expiry = date.fromisoformat(raw_expiry)
    except ValueError:
        return jsonify({"detail": "到期日格式应为 YYYY-MM-DD"}), 400

    def change():
        now = datetime.now(timezone.utc)
        with connect() as conn:
            # 与报送写口锁同一行、用同一个函数判有效性。
            with conn.transaction():
                row = conn.execute(
                    """SELECT serial_no, expires_at,
                              encoder_cert_valid(expires_at) AS cert_valid
                       FROM encoders
                       WHERE serial_no = %s
                       FOR UPDATE""",
                    (serial_no,),
                ).fetchone()
                if row is None:
                    return {"status": 404, "detail": f"出厂号 {serial_no} 不存在"}

                old_expiry = row["expires_at"]
                if new_expiry == old_expiry:
                    return {
                        "status": 400,
                        "detail": (
                            f"到期日与当前值（{old_expiry.isoformat()}）相同，"
                            f"无需修改"
                        ),
                    }

                if new_expiry > old_expiry:
                    event_type = "renewed"
                    action = "续期"
                else:
                    event_type = "date_changed"
                    action = "改期"
                detail = (
                    f"{action}：到期日 {old_expiry.isoformat()} → "
                    f"{new_expiry.isoformat()}"
                )

                conn.execute(
                    """UPDATE encoders
                       SET expires_at = %s, updated_by = %s, updated_at = %s
                       WHERE serial_no = %s""",
                    (new_expiry, user["username"], now, serial_no),
                )
                conn.execute(
                    """INSERT INTO encoder_events
                       (serial_no, event_type, detail, actor, created_at)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (serial_no, event_type, detail, user["username"], now),
                )

            conn.commit()
            return {"status": 200, "row": query_encoders(serial_no)}

    result = await run_db(change)
    if "row" in result:
        return jsonify(result["row"]), result["status"]
    return jsonify({"detail": result["detail"]}), result["status"]
