import { css, html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

type LogRow = {
  id: number;
  turbine_code: string;
  encoder_sn: string | null;
  yaw_err_deg: number;
  status: string;
  verdict: string | null;
  reason: string | null;
  created_by: string;
  created_at: string;
  processed_at: string | null;
};

type EncoderRow = {
  serial_no: string;
  expires_at: string;
  expired: boolean;
  updated_by: string;
  updated_at: string;
  recent_block_reason: string | null;
  recent_block_at: string | null;
  recent_block_by: string | null;
};

type Session = {
  token: string;
  username: string;
  role: string;
};

type View = "logs" | "encoders";

@customElement("yaw-align-app")
export class YawAlignApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      box-sizing: border-box;
      padding: 1.5rem;
      max-width: 1040px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.75rem;
      color: #38bdf8;
    }
    .sub {
      color: #94a3b8;
      margin-bottom: 1rem;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 0.6rem 0.9rem;
      margin-bottom: 1rem;
    }
    .topbar .brand {
      font-weight: 700;
      color: #e2e8f0;
      margin-right: 0.5rem;
    }
    .topbar .spacer {
      flex: 1;
    }
    .spacer {
      flex: 1;
    }
    .navbtn {
      background: #334155;
    }
    .navbtn.active {
      background: #0284c7;
    }
    .badge {
      background: #7f1d1d;
      color: #fecaca;
      border-radius: 999px;
      font-size: 0.72rem;
      padding: 0.05rem 0.45rem;
      margin-left: 0.35rem;
    }
    section {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      border: 1px solid #334155;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-bottom: 0.25rem;
    }
    input,
    select {
      width: 100%;
      box-sizing: border-box;
      padding: 0.5rem 0.65rem;
      border-radius: 6px;
      border: 1px solid #475569;
      background: #0f172a;
      color: #f1f5f9;
      margin-bottom: 0.75rem;
    }
    .inline-input {
      width: 170px;
      margin-bottom: 0;
    }
    button {
      cursor: pointer;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: none;
      background: #0284c7;
      color: #fff;
      font-weight: 600;
    }
    button.secondary {
      background: #475569;
    }
    button.warn {
      background: #b45309;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    th,
    td {
      text-align: left;
      padding: 0.55rem 0.45rem;
      border-bottom: 1px solid #334155;
      vertical-align: top;
    }
    th {
      color: #94a3b8;
      font-weight: 600;
      white-space: nowrap;
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-size: 0.8rem;
      white-space: nowrap;
    }
    .ok {
      background: #14532d;
      color: #86efac;
    }
    .bad {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .pending {
      background: #713f12;
      color: #fde68a;
    }
    .err {
      color: #f87171;
      margin-top: 0.5rem;
    }
    .hint {
      color: #fbbf24;
      margin-top: 0.5rem;
    }
    .row-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }
    tr.highlight {
      outline: 2px solid #f59e0b;
      outline-offset: -2px;
    }
    .muted {
      color: #94a3b8;
    }
  `;

  @state() private session: Session | null = null;
  @state() private view: View = "logs";
  @state() private logs: LogRow[] = [];
  @state() private encoders: EncoderRow[] = [];
  @state() private loginUser = "technician";
  @state() private loginPass = "tech123456";
  @state() private turbineCode = "";
  @state() private encoderSn = "";
  @state() private yawErr = "";
  @state() private error = "";
  @state() private hint = "";
  @state() private loading = false;
  // 专页各行的改期输入值 / 行内报错 / 进行中状态
  @state() private expiryDraft: Record<string, string> = {};
  @state() private rowError: Record<string, string> = {};
  @state() private rowBusy: Record<string, boolean> = {};
  // 登记新出厂号
  @state() private newSn = "";
  @state() private newExpiry = "";
  @state() private highlightSn = "";

  connectedCallback() {
    super.connectedCallback();
    const raw = localStorage.getItem("yaw_session");
    if (raw) {
      try {
        this.session = JSON.parse(raw) as Session;
        void this.bootstrap();
      } catch {
        localStorage.removeItem("yaw_session");
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  private _pollTimer?: number;

  private async bootstrap() {
    await this.refreshLogs();
    await this.refreshEncoders();
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = window.setInterval(() => {
      void this.refreshLogs();
      void this.refreshEncoders();
    }, 3000);
  }

  private authHeaders(): HeadersInit {
    return this.session
      ? { Authorization: `Bearer ${this.session.token}` }
      : {};
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  }

  private async refreshLogs() {
    if (!this.session) return;
    const { status, data } = await this.api<LogRow[] | { detail: string }>(
      "GET",
      "/api/logs"
    );
    if (status === 401) {
      this.logout();
      return;
    }
    if (status === 200) this.logs = data as LogRow[];
  }

  private async refreshEncoders() {
    if (!this.session) return;
    const { status, data } = await this.api<EncoderRow[] | { detail: string }>(
      "GET",
      "/api/encoders"
    );
    if (status === 401) {
      this.logout();
      return;
    }
    if (status === 200) {
      const rows = data as EncoderRow[];
      this.encoders = rows;
      // 仅给尚未初始化草稿的行填充默认到期日
      const draft = { ...this.expiryDraft };
      for (const r of rows) {
        if (!draft[r.serial_no]) draft[r.serial_no] = this.toDateInput(r.expires_at);
      }
      this.expiryDraft = draft;
    }
  }

  private async login() {
    this.error = "";
    this.loading = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.loginUser,
          password: this.loginPass,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "登录失败";
        return;
      }
      this.session = {
        token: data.access_token,
        username: data.username,
        role: data.role,
      };
      localStorage.setItem("yaw_session", JSON.stringify(this.session));
      this.view = "logs";
      await this.bootstrap();
    } catch {
      this.error = "无法连接接口";
    } finally {
      this.loading = false;
    }
  }

  private logout() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.session = null;
    this.logs = [];
    this.encoders = [];
    localStorage.removeItem("yaw_session");
  }

  private get isWriter() {
    return this.session?.role === "writer";
  }

  private get expiredCount() {
    return this.encoders.filter((e) => e.expired).length;
  }

  private fmt(ts: string | null | undefined): string {
    if (!ts) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
      d.getHours()
    )}:${p(d.getMinutes())}`;
  }

  private toDateInput(ts: string): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private gotoEncoders(sn = "") {
    this.highlightSn = sn;
    this.view = "encoders";
    void this.refreshEncoders();
  }

  private async submitLog() {
    this.error = "";
    this.hint = "";
    this.loading = true;
    const wantedSn = this.encoderSn.trim();
    try {
      const { status, data } = await this.api<{
        detail?: string;
        blocked?: boolean;
      }>("POST", "/api/logs", {
        turbine_code: this.turbineCode,
        encoder_sn: wantedSn,
        yaw_err_deg: Number(this.yawErr),
      });
      if (!status.toString().startsWith("2")) {
        this.error = data.detail || "提交失败";
        // 证书过期被拒：给出续期入口（写口判定，专页同口径）
        if (status === 403 && wantedSn) {
          this.hint = wantedSn;
        }
        return;
      }
      this.turbineCode = "";
      this.encoderSn = "";
      this.yawErr = "";
      await this.refreshLogs();
    } catch {
      this.error = "提交时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private errText(data: unknown, fallback: string): string {
    const d = data as { detail?: string };
    return d?.detail || fallback;
  }

  private async saveExpiry(sn: string) {
    const expires_at = (this.expiryDraft[sn] || "").trim();
    if (!expires_at) {
      this.rowError = { ...this.rowError, [sn]: "请选择到期日" };
      return;
    }
    this.rowBusy = { ...this.rowBusy, [sn]: true };
    this.rowError = { ...this.rowError, [sn]: "" };
    const { status, data } = await this.api<EncoderRow | { detail?: string }>(
      "PUT",
      `/api/encoders/${encodeURIComponent(sn)}/expiry`,
      { expires_at }
    );
    this.rowBusy = { ...this.rowBusy, [sn]: false };
    if (status !== 200) {
      this.rowError = { ...this.rowError, [sn]: data.detail || "改期失败" };
      return;
    }
    await this.refreshEncoders();
  }

  private async renew(sn: string) {
    this.rowBusy = { ...this.rowBusy, [sn]: true };
    this.rowError = { ...this.rowError, [sn]: "" };
    const { status, data } = await this.api<EncoderRow | { detail?: string }>(
      "POST",
      `/api/encoders/${encodeURIComponent(sn)}/renew`
    );
    this.rowBusy = { ...this.rowBusy, [sn]: false };
    if (status !== 200) {
      this.rowError = { ...this.rowError, [sn]: data.detail || "续期失败" };
      return;
    }
    await this.refreshEncoders();
  }

  private async registerEncoder() {
    const sn = this.newSn.trim();
    const expires_at = this.newExpiry.trim();
    if (!sn || !expires_at) {
      this.rowError = { ...this.rowError, __new: "请填写出厂号与到期日" };
      return;
    }
    this.rowBusy = { ...this.rowBusy, __new: true };
    this.rowError = { ...this.rowError, __new: "" };
    const { status, data } = await this.api<EncoderRow | { detail?: string }>(
      "PUT",
      `/api/encoders/${encodeURIComponent(sn)}/expiry`,
      { expires_at }
    );
    this.rowBusy = { ...this.rowBusy, __new: false };
    if (status !== 200) {
      this.rowError = { ...this.rowError, __new: data.detail || "登记失败" };
      return;
    }
    this.newSn = "";
    this.newExpiry = "";
    this.highlightSn = sn;
    await this.refreshEncoders();
  }

  private verdictClass(row: LogRow) {
    if (row.status === "pending") return "pending";
    if (row.verdict === "合格") return "ok";
    if (row.verdict === "偏航超差") return "bad";
    return "";
  }

  private renderLogin() {
    return html`
      <h1>风机偏航对中台</h1>
      <p class="sub">现场技师提交偏航误差，后台 worker 认领后给出合格或偏航超差结论。</p>
      <section>
        <label>用户名</label>
        <input
          .value=${this.loginUser}
          @input=${(e: Event) =>
            (this.loginUser = (e.target as HTMLInputElement).value)}
        />
        <label>密码</label>
        <input
          type="password"
          .value=${this.loginPass}
          @input=${(e: Event) =>
            (this.loginPass = (e.target as HTMLInputElement).value)}
        />
        <button ?disabled=${this.loading} @click=${this.login}>登录</button>
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
      </section>
    `;
  }

  private renderTopBar() {
    return html`
      <div class="topbar">
        <span class="brand">风机偏航对中台</span>
        <button
          class="navbtn ${this.view === "logs" ? "active" : ""}"
          @click=${() => (this.view = "logs")}
        >
          对中记录
        </button>
        <button
          class="navbtn ${this.view === "encoders" ? "active" : ""}"
          @click=${() => this.gotoEncoders()}
        >
          编码器到期禁交
          ${this.expiredCount > 0
            ? html`<span class="badge">${this.expiredCount} 到期</span>`
            : null}
        </button>
        <span class="spacer"></span>
        <span class="muted"
          >${this.session!.username}（${this.isWriter ? "技师" : "只读"}）</span
        >
        <button class="secondary" @click=${this.logout}>退出</button>
      </div>
    `;
  }

  private renderLogsView() {
    return html`
      ${this.isWriter
        ? html`
            <section>
              <h2 style="margin-top:0;font-size:1.1rem;">提交偏航记录</h2>
              <label>机组编号</label>
              <input
                placeholder="例如 W12"
                .value=${this.turbineCode}
                @input=${(e: Event) =>
                  (this.turbineCode = (e.target as HTMLInputElement).value)}
              />
              <label>编码器出厂号（校准证书须在有效期内）</label>
              <input
                placeholder="例如 ENC-A"
                .value=${this.encoderSn}
                @input=${(e: Event) =>
                  (this.encoderSn = (e.target as HTMLInputElement).value)}
              />
              <label>偏航误差（度，可正可负）</label>
              <input
                type="number"
                step="0.1"
                .value=${this.yawErr}
                @input=${(e: Event) =>
                  (this.yawErr = (e.target as HTMLInputElement).value)}
              />
              <button ?disabled=${this.loading} @click=${this.submitLog}>
                提交（进入待认领队列）
              </button>
              ${this.error ? html`<p class="err">${this.error}</p>` : null}
              ${this.hint
                ? html`
                    <p class="hint">
                      出厂号 ${this.hint} 的校准证书已过期，需先续期才开放报送。
                      <button
                        class="warn"
                        @click=${() => this.gotoEncoders(this.hint)}
                      >
                        前往续期
                      </button>
                    </p>
                  `
                : null}
            </section>
          `
        : null}

      <section>
        <div class="row-actions" style="margin-bottom:0.5rem;">
          <h2 style="margin:0;font-size:1.1rem;">对中记录</h2>
          <span class="spacer"></span>
          <button
            class="secondary"
            ?disabled=${this.loading}
            @click=${this.refreshLogs}
          >
            刷新
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>机组</th>
              <th>编码器出厂号</th>
              <th>误差°</th>
              <th>状态</th>
              <th>结论</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            ${this.logs.map(
              (row) => html`
                <tr>
                  <td>${row.id}</td>
                  <td>${row.turbine_code}</td>
                  <td>${row.encoder_sn ?? "—"}</td>
                  <td>${row.yaw_err_deg}</td>
                  <td>
                    <span
                      class="tag ${row.status === "pending" ? "pending" : "ok"}"
                    >
                      ${row.status === "pending" ? "待处理" : "已完成"}
                    </span>
                  </td>
                  <td>
                    ${row.verdict
                      ? html`<span class="tag ${this.verdictClass(row)}"
                          >${row.verdict}</span
                        >`
                      : "—"}
                  </td>
                  <td>${row.reason ?? "—"}</td>
                </tr>
              `
            )}
          </tbody>
        </table>
      </section>
    `;
  }

  private renderEncoderActions(row: EncoderRow) {
    if (!this.isWriter) return nothing;
    const busy = !!this.rowBusy[row.serial_no];
    return html`
      <div class="row-actions">
        <input
          class="inline-input"
          type="date"
          .value=${this.expiryDraft[row.serial_no] ?? ""}
          @change=${(e: Event) =>
            (this.expiryDraft = {
              ...this.expiryDraft,
              [row.serial_no]: (e.target as HTMLInputElement).value,
            })}
        />
        <button
          ?disabled=${busy}
          @click=${() => this.saveExpiry(row.serial_no)}
        >
          改到期日
        </button>
        <button
          class="warn"
          ?disabled=${busy}
          @click=${() => this.renew(row.serial_no)}
        >
          续期一年
        </button>
      </div>
      ${this.rowError[row.serial_no]
        ? html`<p class="err">${this.rowError[row.serial_no]}</p>`
        : null}
    `;
  }

  private renderEncodersView() {
    return html`
      <section>
        <h2 style="margin-top:0;font-size:1.1rem;">编码器到期禁交专页</h2>
        <p class="sub" style="margin:0 0 0.75rem;">
          校准证书到期时刻过后该出厂号禁止报送；下表到期状态与报送写口为同一口径。
          ${this.isWriter
            ? "技师可改到期日或续期；过期号续期后即恢复报送。"
            : "当前为只读账号，仅可查看。"}
        </p>
        <table>
          <thead>
            <tr>
              <th>出厂号</th>
              <th>到期日</th>
              <th>状态</th>
              <th>最近拦截原因</th>
              <th>最近拦截</th>
              <th>最近更新</th>
              ${this.isWriter ? html`<th>技师操作</th>` : null}
            </tr>
          </thead>
          <tbody>
            ${this.encoders.map(
              (row) => html`
                <tr class=${row.serial_no === this.highlightSn ? "highlight" : ""}>
                  <td><strong>${row.serial_no}</strong></td>
                  <td>${this.fmt(row.expires_at)}</td>
                  <td>
                    <span class="tag ${row.expired ? "bad" : "ok"}">
                      ${row.expired ? "已过期·禁交" : "有效"}
                    </span>
                  </td>
                  <td>${row.recent_block_reason ?? "—"}</td>
                  <td>
                    ${row.recent_block_at
                      ? html`${this.fmt(row.recent_block_at)}<br /><span
                          class="muted"
                          >${row.recent_block_by}</span
                        >`
                      : "—"}
                  </td>
                  <td>
                    ${this.fmt(row.updated_at)}<br /><span class="muted"
                      >${row.updated_by}</span
                    >
                  </td>
                  ${this.isWriter
                    ? html`<td>${this.renderEncoderActions(row)}</td>`
                    : null}
                </tr>
              `
            )}
            ${this.encoders.length === 0
              ? html`<tr><td colspan="7" class="muted">暂无编码器登记</td></tr>`
              : null}
          </tbody>
        </table>
      </section>

      ${this.isWriter
        ? html`
            <section>
              <h2 style="margin-top:0;font-size:1.05rem;">登记新出厂号校准证书</h2>
              <div class="row-actions">
                <input
                  class="inline-input"
                  style="width:200px"
                  placeholder="出厂号 如 ENC-C"
                  .value=${this.newSn}
                  @input=${(e: Event) =>
                    (this.newSn = (e.target as HTMLInputElement).value)}
                />
                <input
                  class="inline-input"
                  type="date"
                  .value=${this.newExpiry}
                  @input=${(e: Event) =>
                    (this.newExpiry = (e.target as HTMLInputElement).value)}
                />
                <button
                  ?disabled=${!!this.rowBusy.__new}
                  @click=${this.registerEncoder}
                >
                  登记
                </button>
              </div>
              ${this.rowError.__new
                ? html`<p class="err">${this.rowError.__new}</p>`
                : null}
            </section>
          `
        : null}
    `;
  }

  render() {
    if (!this.session) return this.renderLogin();

    return html`
      ${this.renderTopBar()}
      ${this.view === "encoders" ? this.renderEncodersView() : this.renderLogsView()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "yaw-align-app": YawAlignApp;
  }
}
