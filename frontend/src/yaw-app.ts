import { css, html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

type LogRow = {
  id: number;
  turbine_code: string;
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
  valid: boolean;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  last_intercept_reason: string | null;
  last_intercept_at: string | null;
  last_renewed_at: string | null;
};

type EncoderEvent = {
  id: number;
  serial_no: string;
  event_type: "registered" | "renewed" | "date_changed" | "intercepted";
  detail: string;
  actor: string;
  created_at: string;
};

type Session = {
  token: string;
  username: string;
  role: string;
};

type View = "logs" | "encoders";

const EVENT_LABELS: Record<EncoderEvent["event_type"], string> = {
  registered: "登记",
  renewed: "续期",
  date_changed: "改期",
  intercepted: "拦截",
};

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

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
    .topbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1.25rem;
    }
    h1 {
      margin: 0;
      font-size: 1.5rem;
      color: #38bdf8;
    }
    nav {
      display: flex;
      gap: 0.5rem;
    }
    nav button {
      background: #1e293b;
      border: 1px solid #334155;
      color: #cbd5e1;
      border-radius: 6px;
      padding: 0.4rem 0.9rem;
    }
    nav button.active {
      background: #0284c7;
      border-color: #0284c7;
      color: #fff;
    }
    .topbar .spacer {
      flex: 1;
    }
    .sub {
      color: #94a3b8;
      margin-bottom: 1.25rem;
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
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 0.5rem 0.65rem;
      border-radius: 6px;
      border: 1px solid #475569;
      background: #0f172a;
      color: #f1f5f9;
      margin-bottom: 0.75rem;
    }
    input.inline {
      width: 10rem;
      margin: 0;
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
    button.ghost {
      background: transparent;
      border: 1px solid #475569;
      font-weight: 400;
      padding: 0.3rem 0.7rem;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th,
    td {
      text-align: left;
      padding: 0.5rem 0.4rem;
      border-bottom: 1px solid #334155;
      vertical-align: top;
    }
    th {
      color: #94a3b8;
      font-weight: 600;
    }
    tr.expired {
      background: rgba(127, 29, 29, 0.25);
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.8rem;
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
    .muted {
      color: #64748b;
    }
    .err {
      color: #f87171;
      margin-top: 0.5rem;
    }
    .ok-msg {
      color: #86efac;
      margin-top: 0.5rem;
    }
    .row-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .events {
      margin: 0;
      padding: 0.5rem 0 0.5rem 1rem;
      background: #0f172a;
      border-radius: 6px;
    }
    .events li {
      list-style: none;
      padding: 0.25rem 0;
      font-size: 0.85rem;
      border-bottom: 1px dashed #1e293b;
    }
  `;

  @state() private session: Session | null = null;
  @state() private view: View = "logs";
  @state() private logs: LogRow[] = [];
  @state() private encoders: EncoderRow[] = [];
  @state() private loginUser = "technician";
  @state() private loginPass = "tech123456";
  @state() private turbineCode = "";
  @state() private yawErr = "";
  @state() private error = "";
  @state() private encoderError = "";
  @state() private encoderMsg = "";
  @state() private loading = false;
  @state() private registerSerial = "";
  @state() private registerExpiry = todayPlus(365);
  @state() private expiryDrafts: Record<string, string> = {};
  @state() private eventsFor: string | null = null;
  @state() private events: EncoderEvent[] = [];

  connectedCallback() {
    super.connectedCallback();
    const raw = localStorage.getItem("yaw_session");
    if (raw) {
      try {
        this.session = JSON.parse(raw) as Session;
        void this.refreshAll();
        this._pollTimer = window.setInterval(() => void this.refreshAll(), 2000);
      } catch {
        localStorage.removeItem("yaw_session");
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
  }

  private _pollTimer?: number;

  private authHeaders(): HeadersInit {
    return this.session
      ? { Authorization: `Bearer ${this.session.token}` }
      : {};
  }

  private async refreshAll() {
    await this.refreshLogs();
    if (this.view === "encoders") {
      await this.refreshEncoders();
      if (this.eventsFor) await this.refreshEvents(this.eventsFor);
    }
  }

  private async refreshLogs() {
    if (!this.session) return;
    try {
      const res = await fetch("/api/logs", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (!res.ok) return;
      this.logs = (await res.json()) as LogRow[];
    } catch {
      /* ignore transient network errors */
    }
  }

  private async refreshEncoders() {
    if (!this.session) return;
    try {
      const res = await fetch("/api/encoders", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (!res.ok) return;
      this.encoders = (await res.json()) as EncoderRow[];
    } catch {
      /* ignore transient network errors */
    }
  }

  private async refreshEvents(serialNo: string) {
    try {
      const res = await fetch(`/api/encoders/${encodeURIComponent(serialNo)}/events`, {
        headers: this.authHeaders(),
      });
      if (res.ok) this.events = (await res.json()) as EncoderEvent[];
    } catch {
      /* ignore */
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
      await this.refreshAll();
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._pollTimer = window.setInterval(() => void this.refreshAll(), 2000);
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
    this.eventsFor = null;
    localStorage.removeItem("yaw_session");
  }

  private get isWriter() {
    return this.session?.role === "writer";
  }

  private setView(v: View) {
    this.view = v;
    this.error = "";
    this.encoderError = "";
    this.encoderMsg = "";
    void this.refreshAll();
  }

  private async submitLog() {
    this.error = "";
    this.loading = true;
    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          turbine_code: this.turbineCode,
          yaw_err_deg: Number(this.yawErr),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "提交失败";
        return;
      }
      this.turbineCode = "";
      this.yawErr = "";
      await this.refreshLogs();
    } catch {
      this.error = "提交时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private draftFor(row: EncoderRow): string {
    return this.expiryDrafts[row.serial_no] ?? row.expires_at;
  }

  private setDraft(serialNo: string, value: string) {
    this.expiryDrafts = { ...this.expiryDrafts, [serialNo]: value };
  }

  private async changeExpiry(row: EncoderRow) {
    const expiresAt = this.draftFor(row);
    this.encoderError = "";
    this.encoderMsg = "";
    if (!expiresAt) {
      this.encoderError = "请填写到期日";
      return;
    }
    const res = await this.sendExpiry(row.serial_no, expiresAt);
    if (res.ok) {
      this.encoderMsg = res.detail;
      this.setDraft(row.serial_no, expiresAt);
      await this.refreshEncoders();
      if (this.eventsFor === row.serial_no) await this.refreshEvents(row.serial_no);
    } else {
      this.encoderError = res.detail;
    }
  }

  private async quickRenew(row: EncoderRow) {
    this.encoderError = "";
    this.encoderMsg = "";
    const expiresAt = todayPlus(365);
    const res = await this.sendExpiry(row.serial_no, expiresAt);
    if (res.ok) {
      this.encoderMsg = res.detail;
      this.setDraft(row.serial_no, expiresAt);
      await this.refreshEncoders();
      if (this.eventsFor === row.serial_no) await this.refreshEvents(row.serial_no);
    } else {
      this.encoderError = res.detail;
    }
  }

  private async sendExpiry(
    serialNo: string,
    expiresAt: string
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(
        `/api/encoders/${encodeURIComponent(serialNo)}/expiry`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders(),
          },
          body: JSON.stringify({ expires_at: expiresAt }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        return {
          ok: true,
          detail: (data.valid ? "续期成功，已开放报送：" : "到期日已修改：") +
            `${serialNo} 到期日 ${expiresAt}`,
        };
      }
      return { ok: false, detail: data.detail || "修改失败" };
    } catch {
      return { ok: false, detail: "网络异常" };
    }
  }

  private async registerEncoder() {
    this.encoderError = "";
    this.encoderMsg = "";
    const serialNo = this.registerSerial.trim();
    if (!serialNo) {
      this.encoderError = "出厂号不能为空";
      return;
    }
    try {
      const res = await fetch("/api/encoders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          serial_no: serialNo,
          expires_at: this.registerExpiry,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.encoderError = data.detail || "登记失败";
        return;
      }
      this.encoderMsg = `出厂号 ${serialNo} 已登记，到期日 ${data.expires_at}`;
      this.registerSerial = "";
      this.registerExpiry = todayPlus(365);
      await this.refreshEncoders();
    } catch {
      this.encoderError = "网络异常";
    }
  }

  private async toggleEvents(serialNo: string) {
    if (this.eventsFor === serialNo) {
      this.eventsFor = null;
      this.events = [];
      return;
    }
    this.eventsFor = serialNo;
    this.events = [];
    await this.refreshEvents(serialNo);
  }

  private verdictClass(row: LogRow) {
    if (row.status === "pending") return "pending";
    if (row.verdict === "合格") return "ok";
    if (row.verdict === "偏航超差") return "bad";
    return "";
  }

  private fmtDateTime(s: string | null): string {
    if (!s) return "—";
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleString("zh-CN", { hour12: false });
  }

  private renderLogin(): TemplateResult {
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

  private renderTopBar(): TemplateResult {
    return html`
      <div class="topbar">
        <h1>风机偏航对中台</h1>
        <nav>
          <button
            class=${this.view === "logs" ? "active" : ""}
            @click=${() => this.setView("logs")}
          >
            对中报送
          </button>
          <button
            class=${this.view === "encoders" ? "active" : ""}
            @click=${() => this.setView("encoders")}
          >
            编码器到期禁交
          </button>
        </nav>
        <span class="spacer"></span>
        <span class="muted">
          ${this.session!.username}（${this.isWriter ? "技师·可提交" : "观察·只读"}）
        </span>
        <button class="secondary" @click=${this.logout}>退出</button>
      </div>
    `;
  }

  private renderLogsView(): TemplateResult {
    return html`
      ${this.isWriter
        ? html`
            <section>
              <h2 style="margin-top:0;font-size:1.1rem;">提交偏航记录</h2>
              <p class="muted" style="margin-top:0;font-size:0.85rem;">
                机组编号即所装编码器出厂号；证书过期的出厂号将被拦截，须先到「编码器到期禁交」续期。
              </p>
              <label>机组编号 / 编码器出厂号</label>
              <input
                placeholder="例如 W12"
                .value=${this.turbineCode}
                @input=${(e: Event) =>
                  (this.turbineCode = (e.target as HTMLInputElement).value)}
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
              ${this.error
                ? html`
                    <p class="err">
                      ${this.error}
                      <button
                        class="ghost"
                        style="margin-left:0.5rem;"
                        @click=${() => this.setView("encoders")}
                      >
                        前往续期 →
                      </button>
                    </p>
                  `
                : null}
            </section>
          `
        : html`
            <p class="muted" style="font-size:0.85rem;">
              当前为只读账号，仅可查看报送记录与编码器证书状态。
            </p>
          `}

      <section>
        <h2 style="margin-top:0;font-size:1.1rem;">对中记录</h2>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>机组/出厂号</th>
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
                  <td>${row.yaw_err_deg}</td>
                  <td>
                    <span class="tag ${row.status === "pending" ? "pending" : "ok"}">
                      ${row.status === "pending" ? "待处理" : "已完成"}
                    </span>
                  </td>
                  <td>
                    ${row.verdict
                      ? html`<span class="tag ${this.verdictClass(row)}">${row.verdict}</span>`
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

  private renderEncodersView(): TemplateResult {
    return html`
      <section>
        <h2 style="margin-top:0;font-size:1.1rem;">编码器到期禁交</h2>
        <p class="muted" style="margin-top:0;font-size:0.85rem;">
          编码器校准证书过有效期后，该出厂号禁止报送；续期后自动恢复。到期状态与报送写口按同一口径实时判定。
        </p>
        ${this.isWriter
          ? html`
              <div class="row-actions" style="align-items:flex-end;">
                <div style="flex:1;min-width:9rem;">
                  <label>新出厂号</label>
                  <input
                    style="margin:0;"
                    placeholder="例如 W12"
                    .value=${this.registerSerial}
                    @input=${(e: Event) =>
                      (this.registerSerial = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div style="width:11rem;">
                  <label>证书到期日</label>
                  <input
                    style="margin:0;"
                    type="date"
                    .value=${this.registerExpiry}
                    @input=${(e: Event) =>
                      (this.registerExpiry = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <button @click=${this.registerEncoder}>登记出厂号</button>
              </div>
            `
          : null}
        ${this.encoderError ? html`<p class="err">${this.encoderError}</p>` : null}
        ${this.encoderMsg ? html`<p class="ok-msg">${this.encoderMsg}</p>` : null}
      </section>

      <section>
        <table>
          <thead>
            <tr>
              <th>出厂号</th>
              <th>到期日</th>
              <th>证书状态</th>
              <th>最近拦截原因</th>
              <th>最近续期</th>
              ${this.isWriter ? html`<th>操作（仅技师）</th>` : html`<th>留痕</th>`}
            </tr>
          </thead>
          <tbody>
            ${this.encoders.map((row) => this.renderEncoderRow(row))}
            ${this.encoders.length === 0
              ? html`<tr><td colspan="6" class="muted">暂无编码器登记</td></tr>`
              : null}
          </tbody>
        </table>
      </section>
    `;
  }

  private renderEncoderRow(row: EncoderRow): TemplateResult {
    const open = this.eventsFor === row.serial_no;
    return html`
      <tr class=${row.valid ? "" : "expired"}>
        <td>${row.serial_no}</td>
        <td>${row.expires_at}</td>
        <td>
          <span class="tag ${row.valid ? "ok" : "bad"}">
            ${row.valid ? "有效" : "已过期·禁交"}
          </span>
        </td>
        <td>
          ${row.last_intercept_reason
            ? html`
                <div>${row.last_intercept_reason}</div>
                <div class="muted" style="font-size:0.78rem;">
                  ${this.fmtDateTime(row.last_intercept_at)}
                </div>
              `
            : html`<span class="muted">—</span>`}
        </td>
        <td>${this.fmtDateTime(row.last_renewed_at)}</td>
        <td>
          <div class="row-actions">
            ${this.isWriter
              ? html`
                  <input
                    class="inline"
                    type="date"
                    .value=${this.draftFor(row)}
                    @change=${(e: Event) =>
                      this.setDraft(
                        row.serial_no,
                        (e.target as HTMLInputElement).value
                      )}
                  />
                  <button
                    class="ghost"
                    @click=${() => this.changeExpiry(row)}
                  >
                    改到期日
                  </button>
                  <button
                    class="ghost"
                    ?disabled=${todayPlus(365) <= row.expires_at}
                    @click=${() => this.quickRenew(row)}
                  >
                    续期一年
                  </button>
                `
              : null}
            <button class="ghost" @click=${() => this.toggleEvents(row.serial_no)}>
              ${open ? "收起留痕" : "查看留痕"}
            </button>
          </div>
        </td>
      </tr>
      ${open
        ? html`
            <tr class=${row.valid ? "" : "expired"}>
              <td></td>
              <td colspan="5">
                <ul class="events">
                  ${this.events.map(
                    (ev) => html`
                      <li>
                        <span class="tag ${ev.event_type === "intercepted"
                          ? "bad"
                          : ev.event_type === "renewed"
                          ? "ok"
                          : "pending"}">
                          ${EVENT_LABELS[ev.event_type]}
                        </span>
                        ${ev.detail}
                        <span class="muted">
                          — ${ev.actor} · ${this.fmtDateTime(ev.created_at)}
                        </span>
                      </li>
                    `
                  )}
                  ${this.events.length === 0
                    ? html`<li class="muted">暂无留痕</li>`
                    : null}
                </ul>
              </td>
            </tr>
          `
        : null}
    `;
  }

  render() {
    if (!this.session) {
      return this.renderLogin();
    }

    return html`
      ${this.renderTopBar()}
      ${this.view === "logs" ? this.renderLogsView() : this.renderEncodersView()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "yaw-align-app": YawAlignApp;
  }
}
