# 风机偏航对中台

现场技师登记机组编号、编码器出厂号与偏航误差（度）；后台 worker 用数据库行锁认领待处理记录，按 ±1.5° 阈值写入「合格」或「偏航超差」。前端为 Lit 组件 + Vite，接口为 Quart + Hypercorn。

编码器校准证书过了有效期，该出厂号即禁止报送，须技师续期后才开放。顶栏「编码器到期禁交」专页列出各出厂号到期日、到期状态与最近拦截原因；专页读口与报送写口共用同一条到期判定口径（`rules.CERT_EXPIRED_SQL`，以数据库时钟为准），报送与改期/续期在同一瞬间争抢时通过编码器行锁串行化，只产生一种结果。

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3199 |
| 接口 | http://localhost:8199 |
| PostgreSQL | localhost:54399（库名 `yawalign`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| technician | tech123456 | 可提交、可改到期日/续期 |
| observer | obs123456 | 只读（仅查看记录与专页） |

## 启动

```bash
cd projects/20-yaw-align-log
docker compose up --build
```

健康检查：`GET http://localhost:8199/api/health` → `{"status":"ok","service":"yaw-align-log"}`。

## 验收

1. 种子数据：机组 W01 误差 0.4° 结论「合格」；机组 W07 误差 3.2° 结论「偏航超差」。
2. technician 提交新记录后，列表先显示「待处理」，数秒内 worker 处理后变为对应结论。
3. observer 可查看列表与专页，无提交表单、无改期/续期入口。
4. 编码器到期禁交闭环：
   - 出厂号 `ENC-A` 种子在有效期内，报送应收齐（进入待认领队列并被判定）；
   - 技师在专页把其到期日改到昨天后，再报送应被拒（HTTP 403），前端提示「续期后才开放报送」并给出续期入口，该次拦截写入留痕并显示为专页「最近拦截原因」；
   - 续期后再报送应收且留痕；
   - 专页显示的到期状态与报送写口始终同口径；报送与续期同刻并发不会出现又放行又判过期。

## 接口

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/encoders` | 登录 | 专页表格：到期日、`expired`、最近拦截原因/时间/操作人 |
| PUT | `/api/encoders/<sn>/expiry` | 技师 | 登记/改到期日，body `{"expires_at":"YYYY-MM-DD"}`（当天结束前有效）或 ISO 时间 |
| POST | `/api/encoders/<sn>/renew` | 技师 | 续期一年（以数据库时钟加算） |
| POST | `/api/logs` | 技师 | 报送需带 `turbine_code`、`encoder_sn`、`yaw_err_deg`；证书过期返回 403，未登记出厂号返回 400 |

## 技术栈

- 后端：Quart、psycopg、`worker.py`（`FOR UPDATE SKIP LOCKED`）、Hypercorn
- 前端：Lit、TypeScript、Vite；生产镜像内 nginx 反代 `/api`
- 到期拦截：编码器行锁（`FOR UPDATE`）+ 锁内 `clock_timestamp()` 判定，读口/写口共用 `rules.py` 单一表达式
- 镜像源：DaoCloud 基础镜像、清华 PyPI、npmmirror npm
