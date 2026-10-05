"""偏航对中判定：绝对值不超过 1.5 度为合格。"""

THRESHOLD_DEG = 1.5


def judge(yaw_err_deg: float) -> tuple[str, str]:
    if abs(yaw_err_deg) <= THRESHOLD_DEG:
        return "合格", f"偏航误差 {yaw_err_deg}° 在 ±{THRESHOLD_DEG}° 以内"
    return "偏航超差", f"偏航误差 {yaw_err_deg}° 超过 ±{THRESHOLD_DEG}°"


# ── 编码器校准证书到期：全系统唯一口径 ────────────────────────────────
# 到期时刻「早于当前时刻」即过期（到期日当天结束前仍有效）。
# 专页表格的读口与 /api/logs 的报送写口必须共用本表达式，
# 一律以数据库时钟为准，禁止任何一侧另用本机时间重算，
# 否则会出现一边放行、一边显示过期的不一致。
# 用 clock_timestamp() 而非 now()/transaction_timestamp()：写口先对编码器
# 行 FOR UPDATE 取锁、取锁后再执行判定，此时读到的 clock_timestamp() 才是
# 真实判定时刻；与续期/改期同刻争抢时，留痕顺序与行锁顺序严格一致。
CERT_EXPIRED_SQL = "(expires_at < clock_timestamp())"
