// 主動訊息 Proactive Messages
// 讓角色在你回到聊天、一段時間沒說話、或經期前後時主動傳訊息。
// 只在 App 開著時運作（插件無法在背景或 App 關閉時執行）。

const MODULE = 'proactiveMessages';
const PROMPT_KEY = 'proactive_messages';
const LOG_PREFIX = '[Proactive]';
const CHECK_INTERVAL_MS = 30 * 1000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const DEFAULT_TEMPLATES = {
    return: '[系統提示，不要在回覆中提到：{{user}}離開了{{elapsed}}，剛剛重新打開聊天。現在是{{now}}。{{cycle}}請以{{char}}的身分主動傳訊息給{{user}}，自然地回應這段空白。]',
    idle: '[系統提示，不要在回覆中提到：{{user}}已經{{elapsed}}沒有回話了，現在是{{now}}。{{cycle}}請以{{char}}的身分主動找{{user}}說話，可以延續剛剛的話題，或分享自己正在做的事。]',
    cycle: '[系統提示，不要在回覆中提到：{{cycle}}現在是{{now}}。請以{{char}}的身分主動傳一則訊息關心{{user}}。]',
};

const DEFAULT_SETTINGS = {
    enabled: true,
    chars: {},
    returnHours: 6,
    idleMinutes: 60,
    cycleCare: true,
    cycleDaysBefore: 2,
    maxUnanswered: 1,
    templates: { ...DEFAULT_TEMPLATES },
    lastCare: {},
};

const ctx = () => SillyTavern.getContext();

let generating = false;
let busy = false;
let pendingKind = null;
let lastActivity = Date.now();

// ---------- 設定 ----------

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    for (const [k, v] of Object.entries(DEFAULT_TEMPLATES)) s.templates[k] ??= v;
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function charKey() {
    const c = ctx();
    if (c.groupId) return `group:${c.groupId}`;
    if (c.characterId === undefined || c.characterId === null) return null;
    return c.characters[c.characterId]?.avatar ?? null;
}

function charName() {
    const c = ctx();
    if (c.groupId) return c.groups.find(g => g.id == c.groupId)?.name ?? '群組';
    return c.characters[c.characterId]?.name ?? '';
}

function activeForChar() {
    const s = settings();
    const key = charKey();
    return Boolean(s.enabled && key && s.chars[key]);
}

// ---------- 時間工具 ----------

function localDate(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowText() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${localDate(d)}（週${WEEKDAYS[d.getDay()]}）${p(d.getHours())}:${p(d.getMinutes())}`;
}

function elapsedText(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${Math.max(min, 1)} 分鐘`;
    if (min < 24 * 60) {
        const halves = Math.round(min / 30);
        const h = Math.floor(halves / 2);
        return halves % 2 ? `${h} 個半小時` : `${h} 小時`;
    }
    const h = Math.round(min / 60);
    const d = Math.floor(h / 24);
    const rest = h % 24;
    return rest >= 1 ? `${d} 天 ${rest} 小時` : `${d} 天`;
}

function messageTime(msg) {
    if (!msg?.send_date) return null;
    const t = Date.parse(msg.send_date);
    if (!Number.isNaN(t)) return t;
    const m = ctx().timestampToMoment?.(msg.send_date);
    return m?.isValid?.() ? m.valueOf() : null;
}

function lastMessageTime() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_system) continue;
        const t = messageTime(chat[i]);
        if (t) return t;
    }
    return null;
}

// 最後一則使用者訊息之後，角色已經主動傳了幾則
function unansweredCount() {
    const chat = ctx().chat;
    let n = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m.is_user) break;
        if (m.extra?.proactive) n++;
    }
    return n;
}

function inputEmpty() {
    return !String($('#send_textarea').val() ?? '').trim();
}

// ---------- 經期連動（需要「生理紀錄小幫手」） ----------

function cycleLine() {
    const st = globalThis.CycleTracker?.getStatus?.();
    if (!st) return { text: '', relevant: false };
    const user = ctx().name1 || '使用者';
    const s = settings();
    if (st.inPeriod) return { text: `${user}正在經期第 ${st.periodDay} 天。`, relevant: true };
    if (st.late > 0) return { text: `${user}的經期比預計晚了 ${st.late} 天。`, relevant: true };
    if (st.daysUntilNext === 0) return { text: `${user}的經期預計今天來。`, relevant: true };
    if (st.daysUntilNext > 0 && st.daysUntilNext <= Number(s.cycleDaysBefore)) {
        return { text: `${user}的經期預計 ${st.daysUntilNext} 天後來。`, relevant: true };
    }
    return { text: '', relevant: false };
}

// ---------- 觸發 ----------

function fill(template, vars) {
    const c = ctx();
    let out = template;
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
    return c.substituteParams ? c.substituteParams(out) : out;
}

async function trigger(kind, { elapsedMs = 0, force = false } = {}) {
    const s = settings();
    if (busy || generating) return false;
    if (!force && (!activeForChar() || !inputEmpty() || unansweredCount() >= Number(s.maxUnanswered))) return false;

    const c = ctx();
    const cycle = s.cycleCare ? cycleLine() : { text: '', relevant: false };
    const prompt = fill(s.templates[kind] ?? DEFAULT_TEMPLATES[kind], {
        user: c.name1 || '使用者',
        char: charName(),
        elapsed: elapsedText(elapsedMs),
        now: nowText(),
        cycle: cycle.text,
    });

    busy = true;
    pendingKind = kind;
    if (cycle.relevant) {
        s.lastCare[charKey()] = localDate();
        save();
    }
    console.log(LOG_PREFIX, 'trigger', kind, prompt);
    try {
        // 深度 0：放在最後面，只對這一次生成有效
        c.setExtensionPrompt(PROMPT_KEY, prompt, 1, 0, false, 0);
        await c.generate('normal');
        return true;
    } catch (err) {
        console.error(LOG_PREFIX, err);
        toastr.error(String(err?.message ?? err), '主動訊息失敗');
        return false;
    } finally {
        c.setExtensionPrompt(PROMPT_KEY, '', 1, 0);
        pendingKind = null;
        busy = false;
        lastActivity = Date.now();
    }
}

// 回到聊天時：離開很久 → return；否則今天還沒因為經期關心過 → cycle
async function checkOnOpen() {
    const s = settings();
    if (!activeForChar() || !ctx().chat.length) return;
    const last = lastMessageTime();
    const gap = last ? Date.now() - last : 0;
    if (Number(s.returnHours) > 0 && gap >= Number(s.returnHours) * 3600000) {
        await trigger('return', { elapsedMs: gap });
        return;
    }
    if (s.cycleCare && s.lastCare[charKey()] !== localDate() && cycleLine().relevant) {
        await trigger('cycle');
    }
}

// App 開著時定期檢查：一段時間沒說話 → idle
async function checkIdle() {
    const s = settings();
    if (document.hidden || !activeForChar() || !ctx().chat.length || Number(s.idleMinutes) <= 0) return;
    const since = Math.max(lastActivity, lastMessageTime() ?? 0);
    const gap = Date.now() - since;
    if (gap >= Number(s.idleMinutes) * 60000) await trigger('idle', { elapsedMs: gap });
}

let openTimer = null;
function scheduleOpenCheck() {
    clearTimeout(openTimer);
    // 等聊天載入、畫面穩定後再檢查
    openTimer = setTimeout(() => checkOnOpen().catch(err => console.error(LOG_PREFIX, err)), 1500);
}

function onMessageReceived(id) {
    if (!pendingKind) return;
    const msg = ctx().chat[Number(id)];
    if (!msg || msg.is_user) return;
    msg.extra ??= {};
    msg.extra.proactive = pendingKind;
    const sw = msg.swipe_info?.[msg.swipe_id];
    if (sw && typeof sw === 'object') sw.extra = structuredClone(msg.extra);
    ctx().saveChat();
}

// ---------- 介面 ----------

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const PANEL_HTML = `
<div id="ptm_settings" class="ptm">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>主動訊息</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input id="ptm_enabled" type="checkbox"> 啟用</label>
      <label class="checkbox_label ptm-char"><input id="ptm_char_on" type="checkbox"> 讓 <b id="ptm_char_name">—</b> 主動傳訊息</label>
      <div class="ptm-hint">只在 App 開著時有效；每次主動訊息都是一次完整的生成。</div>

      <div class="ptm-row">
        <label>離開多久後回來，他先開口（小時，0 = 關）
          <input id="ptm_return_hours" type="number" min="0" max="720" step="0.5" class="text_pole"></label>
        <label>App 開著但沒說話多久，他來找你（分鐘，0 = 關）
          <input id="ptm_idle_minutes" type="number" min="0" max="1440" class="text_pole"></label>
      </div>
      <div class="ptm-row">
        <label>你沒回覆時，他最多連續主動幾則
          <input id="ptm_max_unanswered" type="number" min="1" max="10" class="text_pole"></label>
        <label>經期前幾天開始關心
          <input id="ptm_cycle_before" type="number" min="0" max="7" class="text_pole"></label>
      </div>
      <label class="checkbox_label"><input id="ptm_cycle_care" type="checkbox"> 經期前後每天主動關心一次（需要「生理紀錄小幫手」）</label>
      <div id="ptm_cycle_hint" class="ptm-hint"></div>

      <div class="ptm-row">
        <div id="ptm_test" class="menu_button">現在讓他傳一則試試</div>
      </div>

      <details class="ptm-sec">
        <summary>提示詞範本</summary>
        <div class="ptm-hint">可用：{{user}} {{char}} {{elapsed}}（隔了多久） {{now}}（現在時間） {{cycle}}（經期狀態，沒有時為空）</div>
        <label>回到聊天時<textarea id="ptm_tpl_return" class="text_pole" rows="4"></textarea></label>
        <label>一段時間沒說話<textarea id="ptm_tpl_idle" class="text_pole" rows="4"></textarea></label>
        <label>經期關心<textarea id="ptm_tpl_cycle" class="text_pole" rows="3"></textarea></label>
        <div id="ptm_tpl_reset" class="menu_button">恢復預設範本</div>
      </details>
    </div>
  </div>
</div>`;

function renderPanel() {
    if (!$('#ptm_settings').length) return;
    const s = settings();
    const key = charKey();
    $('#ptm_char_name').text(key ? charName() : '（未選擇角色）');
    $('#ptm_char_on').prop('checked', Boolean(key && s.chars[key])).prop('disabled', !key);
    const hasTracker = Boolean(globalThis.CycleTracker);
    const line = hasTracker ? cycleLine().text : '';
    $('#ptm_cycle_hint').text(hasTracker ? (line ? `目前：${line}` : '目前不在經期前後') : '沒有偵測到「生理紀錄小幫手」');
}

function bindPanel() {
    const s = settings();
    $('#ptm_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = this.checked;
        save();
    });
    $('#ptm_char_on').on('change', function () {
        const key = charKey();
        if (!key) return;
        if (this.checked) s.chars[key] = true;
        else delete s.chars[key];
        lastActivity = Date.now();
        save();
    });
    const num = (sel, key) => $(sel).val(s[key]).on('input', function () {
        if (this.value === '') return;
        s[key] = Number(this.value);
        save();
    });
    num('#ptm_return_hours', 'returnHours');
    num('#ptm_idle_minutes', 'idleMinutes');
    num('#ptm_max_unanswered', 'maxUnanswered');
    num('#ptm_cycle_before', 'cycleDaysBefore');
    $('#ptm_cycle_care').prop('checked', s.cycleCare).on('change', function () {
        s.cycleCare = this.checked;
        save();
        renderPanel();
    });

    const tpl = (sel, key) => $(sel).val(s.templates[key]).on('input', function () {
        s.templates[key] = this.value;
        save();
    });
    tpl('#ptm_tpl_return', 'return');
    tpl('#ptm_tpl_idle', 'idle');
    tpl('#ptm_tpl_cycle', 'cycle');
    $('#ptm_tpl_reset').on('click', () => {
        s.templates = { ...DEFAULT_TEMPLATES };
        $('#ptm_tpl_return').val(s.templates.return);
        $('#ptm_tpl_idle').val(s.templates.idle);
        $('#ptm_tpl_cycle').val(s.templates.cycle);
        save();
    });

    $('#ptm_test').on('click', async () => {
        if (!charKey()) return toastr.warning('請先打開一個聊天');
        const last = lastMessageTime();
        const ok = await trigger('idle', { elapsedMs: last ? Date.now() - last : 0, force: true });
        if (!ok && (busy || generating)) toastr.info('正在生成中，稍後再試');
    });
}

// ---------- 初始化 ----------

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(PANEL_HTML);
    bindPanel();
    renderPanel();

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => {
        if (!dryRun) generating = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => { generating = false; });
    eventSource.on(event_types.GENERATION_STOPPED, () => { generating = false; });
    eventSource.on(event_types.MESSAGE_RECEIVED, id => {
        onMessageReceived(id);
        lastActivity = Date.now();
    });
    eventSource.on(event_types.MESSAGE_SENT, () => { lastActivity = Date.now(); });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastActivity = Date.now();
        renderPanel();
        scheduleOpenCheck();
    });

    $(document).on('input', '#send_textarea', () => { lastActivity = Date.now(); });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            renderPanel();
            scheduleOpenCheck();
        }
    });
    setInterval(() => checkIdle().catch(err => console.error(LOG_PREFIX, err)), CHECK_INTERVAL_MS);

    scheduleOpenCheck();
    console.log(LOG_PREFIX, 'loaded');
});
