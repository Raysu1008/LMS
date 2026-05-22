/*
 * ==========================================
 * Ready Crew CRM - V10.5.1
 * AI Engine: DeepSeek-V3-2 (Volces Ark API)
 * Changes in V10.5.1:
 *   - Ark/DeepSeek API キーをコードから削除し Script Properties（ARK_API_KEY）に移行
 *   - ローカル config/local.settings.json + scripts/sync-secrets-to-gas.sh で一括設定（clasp run）
 * Changes in V10.5.0:
 *   - Yeeflow CRM 直接 API シンク（syncToYeeflow / _yeeflowFindItem / resetYeeflowSyncFlag）
 *   - Case_infor AG列（col33）に Yeeflow 同期タイムスタンプ自動記録
 *   - saveMeetingRecord: 会議結論を Case_infor AF列（col32）へ自動反映
 *   - backfillMeetingStatus: Meeting_Records → Case_infor AF列 履歴データ補正
 *   - フロントエンド: Yeeflow 同期パネル・歴史補正パネル追加
 * Changes in V10.4.1:
 *   - メール生成に会議結論（Meeting_Records）を統合
 *   - 会議で決まった方針・次アクションをメール本文に自動反映
 *   - 🐛 修正: HOLD選択時にSKIPと表示されるバグを修正
 * Changes in V9.8.9:
 *   - safeJsonParse: 剥离 AI 返回的 markdown 代码块再解析（```json...```）
 *   - parseBodyToStructured: 正则兜底直接提取案件ID/法人名，AI失败也不丢数据
 *   - parseBodyToStructured: 支持传入缓存 B2 Prompt，Sync 时只读一次 Spreadsheet
 *   - gmailAgentRunner: Sync 开始时一次性缓存 B2 Prompt，避免每封邮件重复 I/O
 *   - submitConsultantDecision: 改用"非空字段数 < 5"判断解析质量（而非 key 数量）
 *   - reparseBufferUnidentified: 同步改用非空字段数判断，补全所有解析不完整的行
 *   - 禁止 rawBody 全文写入法人概要（之前会把邮件正文塞进 N 列）
 *   - 新增 Re-parse Unidentified 按钮（橙色），批量补全 Buffer 中解析不完整的行
 *   - parseBodyToStructured: 从 Prompt_Config B2 动态读取 System Prompt
 *   - 新增 B2 key名 → Case_infor 列名映射层（売上→売上高 / 必須機能→核心需求 等）
 *   - 兜底 Prompt 优化：完整字段别名表 + 分类三选一判定规则 + 严格 JSON 输出约束
 * Changes in V9.8.1:
 *   - Review Center: added Case ID column in list view
 *   - Sync Controls: replaced "Lookback Days" with "Emails After" date picker
 *   - saveOrUpdateLead: explicitly targets Case_infor sheet (not ss.getSheets()[0])
 * PHYSICAL MAPPING:
 *   Case_infor: A=1(ID), B=2(Corp), C=3(Date), D=4(Status)
 *               I=9(売上高), J=10(決算月), K=11(社員数)
 *               L=12(都道府県), M=13(最寄駅)
 *               N=14(法人概要), O=15(相談内容), P=16(相談背景), Q=17(現状課題)
 *               AA=27(Category), AB=28(AI_Type), AC=29(AI_Action), AD=30(AI_Reason)
 *   Review_Buffer: [0]=MailDate [1]=CaseID [2]=Corp [3]=Subject [4]=Body
 *                  [5]=GmailLink [6]=MsgID [7]=AI_Type [8]=AI_Action [9]=AI_Reason
 *                  [10]=Status [11]=SyncTime
 * ==========================================
 */

/**
 * ランタイム設定（Secrets はコードに書かない）
 *
 * Script Properties で上書き。必須:
 *   ARK_API_KEY  — Volces Ark / DeepSeek の Bearer トークン
 *
 * 任意（省略時は下記デフォルト）:
 *   ARK_ENDPOINT / ARK_API_URL / ALLOWED_DOMAIN / DEFAULT_TZ
 * Yeeflow 関連は syncToYeeflow 内と同様（YEEFLOW_API_KEY など）
 *
 * ローカルから一括設定: scripts/sync-secrets-to-gas.sh（要 clasp / jq）
 */
function loadRuntimeConfig_() {
  var p = PropertiesService.getScriptProperties();
  return {
    API_KEY: String(p.getProperty("ARK_API_KEY") || "").trim(),
    ENDPOINT: String(p.getProperty("ARK_ENDPOINT") || "deepseek-v3-2-251201").trim(),
    API_URL: String(
      p.getProperty("ARK_API_URL") ||
        "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    ).trim(),
    ALLOWED_DOMAIN: String(p.getProperty("ALLOWED_DOMAIN") || "@terabox.jp").trim(),
    DEFAULT_TZ: String(p.getProperty("DEFAULT_TZ") || "GMT+9").trim()
  };
}

var _runtimeConfigCache = null;

function invalidateRuntimeConfigCache_() {
  _runtimeConfigCache = null;
}

function getRuntimeConfig_() {
  if (!_runtimeConfigCache) {
    _runtimeConfigCache = loadRuntimeConfig_();
  }
  return _runtimeConfigCache;
}

/** 既存コード互換：CONFIG.API_KEY 等は都度 Script Properties を参照 */
var CONFIG = {};
["API_KEY", "ENDPOINT", "API_URL", "ALLOWED_DOMAIN", "DEFAULT_TZ"].forEach(function (k) {
  Object.defineProperty(CONFIG, k, {
    get: function () {
      return getRuntimeConfig_()[k];
    },
    enumerable: true,
    configurable: true
  });
});

function assertArkApiKeyConfigured_() {
  var k = getRuntimeConfig_().API_KEY;
  if (!k) {
    throw new Error(
      "ARK_API_KEY が未設定です。config/local.settings.example.json をコピーして config/local.settings.json を作成し、scripts/sync-secrets-to-gas.sh を実行するか、GAS の「プロジェクトのプロパティ」→ Script properties に ARK_API_KEY を追加してください。"
    );
  }
}

/**
 * ローカル config/local.settings.json の内容を Script Properties へ書き込む。
 * clasp run 用。Web からは呼ばないこと。
 *
 * @param {Object|Array} input - オブジェクト、または clasp -p '[{...}]' のときの単要素配列
 */
function installScriptPropertiesFromLocal(input) {
  var props = input;
  if (
    props &&
    Object.prototype.toString.call(props) === "[object Array]" &&
    props.length === 1 &&
    typeof props[0] === "object" &&
    props[0] !== null
  ) {
    props = props[0];
  }
  if (!props || typeof props !== "object") {
    throw new Error("installScriptPropertiesFromLocal: オブジェクトが必要です");
  }

  var flat = {};
  Object.keys(props).forEach(function (k) {
    var v = props[k];
    if (v === null || v === undefined) return;
    var s = String(v).trim();
    if (!s) return;
    flat[k] = s;
  });
  if (Object.keys(flat).length === 0) {
    throw new Error("installScriptPropertiesFromLocal: 書き込むキーがありません");
  }

  PropertiesService.getScriptProperties().setProperties(flat, false);
  invalidateRuntimeConfigCache_();
  return { ok: true, keysSet: Object.keys(flat).length };
}

/**
 * 邮件解析兜底 Prompt（与 Prompt_Config B2 内容保持一致）
 * B2 有内容时优先使用 B2；B2 为空时使用此常量。
 * Key 名与 B2 保持一致（売上/決算/必須機能等），
 * 代码的映射层（mapped[]）负责转换为 Case_infor 列名（売上高/決算月/核心需求等）。
 *
 * ★ 最新优化版 2026-04-14 ★
 */
const FALLBACK_PARSE_PROMPT = `# 役割
あなたはReady Crew（ITアウトソーシング仲介）向けのCRMデータ抽出AIです。
受信した案件メールから構造化JSONデータを生成してください。

# 案件IDの抽出ルール
- 件名に「[数字]」または「数字：会社名」形式で含まれる場合、その数字のみを抽出する
- 本文冒頭に「案件番号：」「案件ID：」がある場合もそこから抽出する
- 見つからない場合は空文字

# 分类建议の判定ルール（必ず以下の3択から選択）
- 「SES」: 人材派遣・常駐・エンジニア紹介の案件
-「Solution」: システム開発・受託開発・DX・AI導入・Webアプリの案件
- 「ロボット」: RPA・業務自動化・ロボティクス関連の案件
- 判定が難しい場合は「Solution」を選択

# フィールド抽出ルール
| フィールド | 抽出元（メール内の表記） | 備考 |
|---|---|---|
| 案件ID | 件名の数字 / 案件番号 | 数字のみ |
| 法人名 | 【法人名】/ 会社名 / 先頭の「数字：会社名」の会社名部分 | |
| URL | 【URL】/ 【HP】/ 【ホームページ】 | |
| 業界 | 【業界】/ 【業種】 | |
| 設立 | 【設立】/ 【創業】 | |
| 資本金 | 【資本金】 | |
| 売上 | 【売上】/ 【売上高】/ 【年商】 | 数値+単位 |
| 決算 | 【決算】/ 【決算月】 | 「X月」形式 |
| 社員数 | 【社員数】/ 【従業員数】/ 【人数】 | 数値+単位 |
| 都道府県 | 【都道府県】/ 【所在地】/ 【住所】の都道府県部分 | |
| 最寄駅 | 【最寄駅】/ 【アクセス】 | |
| 法人概要 | 【法人概要】/ 【会社概要】/ 【企業概要】 | 要約可・2〜3文 |
| 相談内容 | 【相談内容】/ 【依頼内容】/ メール冒頭の主旨文 | 1〜2文で要約 |
| 相談背景 | 【相談背景】/ 【背景】/ 【経緯】 | |
| 現状課題 | 【現在抱えている課題】/ 【課題】/ 【問題点】 | |
| 既存パートナー | 【既存パートナー】/ 【現在の取引先】/ 【既存ベンダー】 | |
| 連絡窓口 | 【連絡窓口】/ 【担当者】/ 【貴社担当者】/ 【お問い合わせ担当】 | |
| システム概要 | 【システム概要】/ 【現行システム】/ 【既存システム】/ 【インフラ】 | |
| 構築方法 | 【構築方法】/ 【開発手法】/ 【アーキテクチャ】/ 【インフラ構成】 | |
| 目的 | 【目的】/ 【達成すべきゴール】/ 【ゴール】 | |
| 必須機能 | 【必須機能】/ 【必須要件】/ 【選定条件】の必須項目 | |
| 要望機能 | 【要望機能】/ 【あれば嬉しい機能】/ 【優先度低】 | |
| 依頼範囲 | 【依頼範囲】/ 【作業範囲】/ 【スコープ】 | |
| 予算 | 【予算】/ 【予算感】/ 【費用感】/ 【月額】 | 数値+単位 |
| 着手時期 | 【着手時期】/ 【開始時期】/ 【スケジュール】/ 【希望納期】 | |
| 決裁フロー | 【決裁フロー】/ 【選定フロー】/ 【承認フロー】/ 【意思決定フロー】 | |

# 出力ルール
- 回答は純粋なJSONオブジェクトのみ。前後に説明文・マークダウン・コードブロックを含めない
- 情報が存在しない項目は空文字列 "" を設定する（nullや"無し"は不可）
- 全フィールドを必ず出力する（省略禁止）
- **全ての値は必ず日本語で出力すること**（英語・中国語は使用禁止）

# 出力フォーマット
{"案件ID":"","法人名":"","URL":"","業界":"","設立":"","資本金":"","売上":"","決算":"","社員数":"","都道府県":"","最寄駅":"","法人概要":"","相談内容":"","相談背景":"","現状課題":"","既存パートナー":"","連絡窓口":"","システム概要":"","構築方法":"","目的":"","必須機能":"","要望機能":"","依頼範囲":"","予算":"","着手時期":"","決裁フロー":"","分类建议":""}`;


/**
 * 访问控制：检查当前用户是否在白名单内
 * Prompt_Config Sheet 完整行布局：
 *   行3  = メール内容分析プロンプト（邮件解析主提示词）
 *   B3   = 技术分析提示词（评审页专用，runAIPreEvaluation 读取）
 *   B4   = TARGET_EMAIL (rc_support@frontier-gr.jp)
 *   B5   = DRIVE_FOLDER_ID
 *   B6   = AUTO_FETCH_SWITCH (ON/OFF)
 *   B7   = 门卫逻辑提示词
 *   B8   = Access_Whitelist ← 白名单放这里（逗号分隔邮箱，留空=仅域名校验）
 *   B9   = 自動同期間隔（分）
 *   B10  = 最終同期日時（gmailAgentRunner 完了時に自動書き込み）
 *   B11  = 初回接触メールプロンプト（initial_contact テンプレート用）
 *   B12  = 二次沟通メールプロンプト（hold_check / follow_up テンプレート用）
 */
function checkAccess() {
  try {
    var email = "";
    try {
      email = Session.getActiveUser().getEmail();
    } catch(e) {
      // Web App 以"我的身份"执行时，getActiveUser() 无权限 → 直接放行
      console.warn("getActiveUser() failed (expected when Execute-as=Me): " + e.toString());
      return { ok: true, email: "(execute-as-me)", reason: "" };
    }

    // getActiveUser() 成功但返回空 → 同样放行（匿名访问场景）
    if (!email) return { ok: true, email: "(anonymous)", reason: "" };

    // 1. 域名校验
    if (!email.endsWith(CONFIG.ALLOWED_DOMAIN)) {
      return { ok: false, email: email, reason: "Domain not allowed. Only " + CONFIG.ALLOWED_DOMAIN + " accounts are permitted." };
    }

    // 2. 白名单校验（若 B8 有值）
    try {
      const config = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Prompt_Config");
      if (config) {
        const whitelist = String(config.getRange("B8").getValue() || "").trim();
        if (whitelist) {
          const allowed = whitelist.split(",").map(function(e) { return e.trim().toLowerCase(); });
          if (allowed.indexOf(email.toLowerCase()) === -1) {
            return { ok: false, email: email, reason: "Access denied. Your account (" + email + ") is not in the authorized list." };
          }
        }
      }
    } catch(e) { /* Prompt_Config 不存在时跳过白名单校验 */ }

    return { ok: true, email: email };
  } catch(e) {
    // 任何未预期错误 → 放行，不因鉴权异常影响正常使用
    console.error("checkAccess unexpected error: " + e.toString());
    return { ok: true, email: "(auth-error)", reason: "" };
  }
}

function doGet() {
  const access = checkAccess();
  if (!access.ok) {
    // 返回拒绝访问页面
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Access Denied</title>' +
      '<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8fafc;margin:0;}' +
      '.box{background:#fff;border:1px solid #e2e8f0;border-radius:2rem;padding:3rem;max-width:480px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.07);}' +
      'h2{color:#dc2626;font-size:1.5rem;margin-bottom:1rem;}p{color:#64748b;font-size:.9rem;line-height:1.6;}' +
      '.email{background:#fef2f2;color:#dc2626;padding:.25rem .75rem;border-radius:9999px;font-size:.8rem;font-weight:700;display:inline-block;margin:.5rem 0;}' +
      '</style></head><body><div class="box">' +
      '<h2>🔒 Access Denied</h2>' +
      '<p>' + access.reason + '</p>' +
      '<span class="email">' + access.email + '</span>' +
      '<p style="margin-top:1.5rem;font-size:.8rem;color:#94a3b8;">Please contact your administrator to request access.</p>' +
      '</div></body></html>';
    return HtmlService.createHtmlOutput(html).setTitle('Access Denied');
  }

  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('Ready Crew CRM V9.8.0')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 現在のログインユーザーのメールアドレス @ 前を返す
 * 例: "tanaka@terabox.jp" → "tanaka"
 */
function getCurrentUserName() {
  try {
    var email = Session.getActiveUser().getEmail() || "";
    var atIdx = email.indexOf("@");
    return atIdx > 0 ? email.slice(0, atIdx) : email;
  } catch(e) {
    return "";
  }
}

/**
 * 确保工作表初始化且不返回空
 * 支持自动创建 Review_Buffer / Agent_Logs / Prompt_Config
 */
function getSheetSafe(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  try {
    sheet = ss.insertSheet(name);
    if (name === "Review_Buffer") {
      sheet.appendRow(["Date","CaseID","CorpName","Subject","RawBody","Link","MsgID","AI_Type","AI_Action","AI_Reason","Status","SyncTime","ParsedJSON"]);
      sheet.setFrozenRows(1);
    } else if (name === "Agent_Logs") {
      sheet.appendRow(["Timestamp", "Subject", "Status", "Info", "ID"]);
      sheet.setFrozenRows(1);
    } else if (name === "Feedback_Log") {
      // 顾问决策日志：每次 submitConsultantDecision 自动追加一行
      // 列: A=Timestamp B=CaseID C=CorpName D=Decision E=Category F=ConsultantNote G=AIReason H=ConsultantName
      sheet.appendRow(["Timestamp", "CaseID", "CorpName", "Decision", "Category", "ConsultantNote", "AIReason", "ConsultantName"]);
      sheet.setFrozenRows(1);
    } else if (name === "Meeting_Records") {
      // 会議結論ログ：案件ごとの総合判断記録
      // 列: A=MeetingDate B=CaseID C=CorpName D=Participants E=Decision F=Conclusion G=Timestamp
      sheet.appendRow(["MeetingDate", "CaseID", "CorpName", "Participants", "Decision", "Conclusion", "Timestamp"]);
      sheet.getRange("A1:G1").setFontWeight("bold");
      sheet.setFrozenRows(1);
    } else if (name === "Case_Todo") {
      // アクション Todo：案件ごとの次アクション管理
      // 列: A=TodoID B=CaseID C=CorpName D=Action E=AssignedTo F=DueDate G=Status H=CreatedAt
      sheet.appendRow(["TodoID", "CaseID", "CorpName", "Action", "AssignedTo", "DueDate", "Status", "CreatedAt"]);
      sheet.getRange("A1:H1").setFontWeight("bold");
      sheet.setFrozenRows(1);
    } else if (name === "Project_Discussion") {
      // 项目经验知识库：人工维护，AI 判断时自动注入
      // 列说明：Category=SES/Solution/ロボット, Decision=Go/Skip
      sheet.appendRow(["Timestamp", "CorpName", "Category", "Decision", "Keywords", "Experience"]);
      sheet.getRange("A1:F1").setFontWeight("bold");
      sheet.setColumnWidth(6, 400); // Experience 列宽
      sheet.setFrozenRows(1);
    } else if (name === "Spam_Filter") {
      sheet.appendRow(["学習日時", "削除理由", "法人名", "ドメイン", "件名", "キーワード", "メモ", "MsgID", "状態"]);
      sheet.getRange("A1:I1").setFontWeight("bold");
      sheet.setFrozenRows(1);
    } else if (name === "Feature_Request") {
      // ユーザー機能要望ログ
      // 列: A=RequestID B=Timestamp C=SubmittedBy D=Description E=ScreenshotURL F=Status G=AdminNote H=UpdatedAt
      sheet.appendRow(["RequestID","Timestamp","SubmittedBy","Description","ScreenshotURL","Status","AdminNote","UpdatedAt"]);
      sheet.getRange("A1:H1").setFontWeight("bold");
      sheet.setColumnWidth(4, 400);
      sheet.setFrozenRows(1);
    } else if (name === "Prompt_Config") {
      // 仅在 Sheet 不存在时自动创建骨架，不覆盖已有配置
      // 完整行布局见 checkAccess() 注释
      sheet.getRange("A3").setValue("B3_Prompt");
      sheet.getRange("B3").setValue("You are a lead analyst. Analyze this IT staffing inquiry and return JSON {type:'SES'|'Solution', action:'Go'|'Skip', reason:'...'}.");
      sheet.getRange("A4").setValue("TARGET_EMAIL");
      sheet.getRange("B4").setValue("rc_support@frontier-gr.jp");
      sheet.getRange("A5").setValue("DRIVE_FOLDER_ID");
      sheet.getRange("B5").setValue("");
      sheet.getRange("A6").setValue("AUTO_FETCH_SWITCH");
      sheet.getRange("B6").setValue("ON");
      sheet.getRange("A7").setValue("Gatekeeper_Prompt");
      sheet.getRange("B7").setValue("");
      sheet.getRange("A8").setValue("Access_Whitelist");
      sheet.getRange("B8").setValue(""); // 留空=仅域名校验；填逗号分隔邮箱=精确白名单
      sheet.setFrozenRows(1);
    }
    SpreadsheetApp.flush();
    return sheet;
  } catch (e) {
    // 兜底：返回主 Sheet，避免整体崩溃
    console.error("getSheetSafe failed for: " + name + " - " + e.toString());
    return ss.getSheets()[0];
  }
}

/**
 * FIXED: 增强型看板数据接口（防止 Null 报错）
 * Case_infor 列索引（0-based）:
 *   0=案件ID 1=法人名 2=録入日時 3=所属部門 31=処理Status(AF)
 */
function getDashboardData() {
  const result = { projects: [], logs: [], pipeline: {}, lastSyncTime: "" };
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const main = ss.getSheetByName("Case_infor") || ss.getSheets()[0];
    const logs = ss.getSheetByName("Agent_Logs");

    // ── Feature 3: Case_Todo から openTodoCount を事前集計 ──
    var todoCountMap = {}; // { caseId: openCount }
    try {
      var todoSheet = ss.getSheetByName("Case_Todo");
      if (todoSheet && todoSheet.getLastRow() > 1) {
        todoSheet.getDataRange().getValues().slice(1).forEach(function(r) {
          var tid  = String(r[1] || "").trim();
          var tst  = String(r[6] || "Open").trim();
          if (!tid) return;
          if (!todoCountMap[tid]) todoCountMap[tid] = 0;
          if (tst !== "Done") todoCountMap[tid]++;
        });
      }
    } catch(e) { console.warn("Todo count error: " + e); }

    if (main && main.getLastRow() > 1) {
      const pData = main.getDataRange().getValues();
      result.projects = pData.slice(1)
        .filter(function(r) { return r[1] && String(r[1]).trim() !== ""; })
        .map(function(r) {
          var dateStr = "";
          try { dateStr = r[2] ? Utilities.formatDate(new Date(r[2]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd") : ""; } catch(e) {}
          var status = String(r[31] || r[3] || "New").trim();
          if (!status || status === "") status = "New";
          var cid = String(r[0] || "");
          return {
            id           : cid,
            name         : String(r[1] || "Unknown"),
            date         : dateStr,
            status       : status,
            type         : String(r[3] || "SES"),
            industry     : String(r[5] || ""),
            aiTopic      : String(r[19] || ""),
            openTodoCount: todoCountMap[cid] || 0,   // ← Feature 3
            yeeflowSynced: !!String(r[32] || "").trim() // AG列 = Yeeflow同期済み
          };
        });
    }

    // ── Feature 5-B: Agent Pipeline 統計 ──
    var bufferSheet = ss.getSheetByName("Review_Buffer");
    var bufferTotal   = 0;
    var bufferParsed  = 0;
    var bufferPending = 0;
    if (bufferSheet && bufferSheet.getLastRow() > 1) {
      bufferSheet.getDataRange().getValues().slice(1).forEach(function(r) {
        bufferTotal++;
        var st = String(r[10] || "").toUpperCase();
        if (st === "PENDING") bufferPending++;
        else if (st === "AUDITED") bufferParsed++;
      });
    }
    var caseTotal = result.projects.length;
    var goCount   = 0;
    result.projects.forEach(function(p) {
      var s = (p.status || "").toLowerCase();
      if (s.indexOf("bid") >= 0 || s === "go") goCount++;
    });
    result.pipeline = {
      inbox   : bufferTotal,
      parsed  : bufferTotal,          // 全て Parse Agent を通過
      pending : bufferPending,
      audited : bufferParsed,
      caseTotal: caseTotal,
      goCount : goCount
    };

    // ── Feature 1: 最終同期日時 ──
    // Agent_Logs から最後の "Sync complete" 行のタイムスタンプを取得（B10より信頼性が高い）
    try {
      var configSheet = ss.getSheetByName("Prompt_Config");
      result.syncInterval = configSheet ? (parseInt(String(configSheet.getRange("B9").getValue() || "60"), 10) || 60) : 60;
      result.lastSyncTime = "";
      if (logs && logs.getLastRow() > 1) {
        const logData = logs.getDataRange().getValues();
        for (var li = logData.length - 1; li >= 1; li--) {
          var logSubject = String(logData[li][1] || "");
          if (logSubject.indexOf("Sync complete") >= 0) {
            try {
              result.lastSyncTime = Utilities.formatDate(new Date(logData[li][0]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm:ss");
            } catch(e) { result.lastSyncTime = String(logData[li][0]); }
            break;
          }
        }
      }
      // フォールバック: B10 から読む
      if (!result.lastSyncTime && configSheet) {
        result.lastSyncTime = String(configSheet.getRange("B10").getValue() || "");
      }
    } catch(e) {}

    if (logs && logs.getLastRow() > 1) {
      const lData = logs.getDataRange().getValues();
      result.logs = lData.slice(1).reverse().slice(0, 15).map(function(l) {
        let ts = "--:--";
        try { ts = Utilities.formatDate(new Date(l[0]), CONFIG.DEFAULT_TZ, "HH:mm"); } catch(e) {}
        return { t: ts, subject: String(l[1] || ""), res: String(l[2] || "") };
      });
    }
  } catch (e) { console.error("Dashboard Error: " + e.toString()); }
  return result;
}

/**
 * 统计数据接口：从 Case_infor 读取分类/业界/AI话题 做聚合
 * 返回：
 *   byCategory: [{label, count}]  SES/Solution/ロボット
 *   byIndustry:  [{label, count}]  業界(F列)
 *   byAITopic:   [{label, count}]  AI话题方向(T列) — システム概要关键词归类
 *   total: 总案件数
 */
function getStatisticsData() {
  const result = { byCategory: [], byIndustry: [], byAITopic: [], total: 0 };
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const main = ss.getSheetByName("Case_infor");
    if (!main || main.getLastRow() < 2) return result;

    const rows = main.getDataRange().getValues().slice(1)
      .filter(function(r) { return r[1] && String(r[1]).trim() !== ""; });
    result.total = rows.length;

    // byCategory (D列 index 3)
    var catMap = {};
    rows.forEach(function(r) {
      var v = String(r[3] || "不明").trim() || "不明";
      catMap[v] = (catMap[v] || 0) + 1;
    });
    result.byCategory = Object.keys(catMap).map(function(k) { return { label: k, count: catMap[k] }; })
      .sort(function(a, b) { return b.count - a.count; });

    // byIndustry (F列 index 5)
    var indMap = {};
    rows.forEach(function(r) {
      var v = String(r[5] || "").trim();
      if (!v) v = "不明";
      // 简化：取最多30字
      v = v.slice(0, 30);
      indMap[v] = (indMap[v] || 0) + 1;
    });
    result.byIndustry = Object.keys(indMap).map(function(k) { return { label: k, count: indMap[k] }; })
      .sort(function(a, b) { return b.count - a.count; }).slice(0, 8);

    // byAITopic (T列 index 19 = AI话题方向/システム概要)
    // 用关键词归类而非全文匹配
    var topicMap = {};
    var TOPIC_KEYWORDS = [
      { label: "ERPシステム",    keys: ["ERP","SAP","Oracle","会計","販売管理"] },
      { label: "AI・機械学習",   keys: ["AI","機械学習","ML","ChatGPT","LLM","生成AI"] },
      { label: "Webアプリ",      keys: ["Web","EC","ポータル","CMS","PWA"] },
      { label: "RPA・自動化",    keys: ["RPA","自動化","ロボット","Power Automate"] },
      { label: "データ分析",     keys: ["データ分析","BI","ダッシュボード","Tableau","Power BI"] },
      { label: "クラウド移行",   keys: ["AWS","Azure","GCP","クラウド","移行"] },
      { label: "セキュリティ",   keys: ["セキュリティ","認証","SSO","ゼロトラスト"] },
      { label: "基幹システム",   keys: ["基幹","CRM","SFA","Salesforce","ServiceNow"] },
      { label: "モバイルアプリ", keys: ["iOS","Android","スマホ","アプリ","Flutter"] },
      { label: "インフラ",       keys: ["インフラ","サーバ","ネットワーク","オンプレ"] }
    ];
    rows.forEach(function(r) {
      var v = String(r[19] || r[20] || "").trim(); // T列(19) or U列(20)構築方法
      if (!v) { topicMap["その他"] = (topicMap["その他"] || 0) + 1; return; }
      var matched = false;
      for (var i = 0; i < TOPIC_KEYWORDS.length; i++) {
        var tk = TOPIC_KEYWORDS[i];
        for (var j = 0; j < tk.keys.length; j++) {
          if (v.indexOf(tk.keys[j]) >= 0) {
            topicMap[tk.label] = (topicMap[tk.label] || 0) + 1;
            matched = true; break;
          }
        }
        if (matched) break;
      }
      if (!matched) topicMap["その他"] = (topicMap["その他"] || 0) + 1;
    });
    result.byAITopic = Object.keys(topicMap).map(function(k) { return { label: k, count: topicMap[k] }; })
      .sort(function(a, b) { return b.count - a.count; }).slice(0, 8);

  } catch(e) { console.error("getStatisticsData error: " + e); }
  return result;
}

/**
 * 物理列写入核心 — V9.8.0 完整列映射
 * Case_infor 列映射（1-based 列号）：
 *   A=1  案件ID        B=2  法人名         C=3  録入日時
 *   D=4  所属部門(分類) E=5  URL            F=6  業界
 *   G=7  設立           H=8  資本金         I=9  売上高
 *   J=10 決算月         K=11 社員数         L=12 都道府県
 *   M=13 最寄駅         N=14 法人概要       O=15 相談内容
 *   P=16 相談背景       Q=17 現状課題       R=18 RFP/資料情況
 *   S=19 連絡窓口       T=20 AI话题方向     U=21 構築方法
 *   V=22 目的/目標      W=23 核心需求(必)   X=24 拡張需求(望)
 *   Y=25 依頼範囲       Z=26 予算感         AA=27 期望交期
 *   AB=28 決策流        AC=29 AI_Type       AD=30 AI_Action
 *   AE=31 AI_Reason     AF=32 処理Status
 */
function saveOrUpdateLead(data, status) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  // 明确写入 Case_infor，避免误用第一个 Sheet
  const sheet = ss.getSheetByName("Case_infor") || ss.getSheets()[0];
  const rows  = sheet.getDataRange().getValues();

  const id   = String(data["案件ID"] || "").trim();
  const corp = String(data["法人名"] || "").trim();

  // 分類（所属部門）：SES / Solution / ロボット
  const validCats = ["SES", "Solution", "ロボット"];
  const rawCat    = data["分类建议"] || data["所属部門"] || "SES";
  const category  = validCats.indexOf(rawCat) >= 0 ? rawCat : "SES";

  // AI 判定字段
  const aiType   = String(data["ai_type"]   || "").trim();
  const aiAction = String(data["ai_action"] || "").trim();
  const aiReason = String(data["ai_reason"] || "").trim();

  // 全量结构化字段
  const f = function(key) { return String(data[key] || "").trim(); };

  let targetIdx = -1;
  // ① CaseID で既存行を検索
  if (id && id !== "NEW" && id !== "") {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === id) { targetIdx = i + 1; break; }
    }
  }
  // ② 法人名で既存行を検索
  if (targetIdx === -1 && corp && corp !== "[UNIDENTIFIED]") {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]).trim() === corp) { targetIdx = i + 1; break; }
    }
  }

  // 辅助：有值才写（不覆盖已有内容为空）
  const write = function(r, col, val) { if (val) sheet.getRange(r, col).setValue(val); };

  if (targetIdx > -1) {
    const r = targetIdx;
    sheet.getRange(r, 3).setValue(new Date());   // C: 録入日時
    sheet.getRange(r, 4).setValue(category);      // D: 所属部門/分類
    write(r,  5, f("URL"));                        // E
    write(r,  6, f("業界"));                       // F
    write(r,  7, f("設立"));                       // G
    write(r,  8, f("資本金"));                     // H
    write(r,  9, f("売上高"));                     // I
    write(r, 10, f("決算月"));                     // J
    write(r, 11, f("社員数"));                     // K
    write(r, 12, f("都道府県"));                   // L
    write(r, 13, f("最寄駅"));                     // M
    write(r, 14, f("法人概要"));                   // N
    write(r, 15, f("相談内容"));                   // O
    write(r, 16, f("相談背景"));                   // P
    write(r, 17, f("現状課題"));                   // Q
    write(r, 18, f("RFP資料"));                    // R
    write(r, 19, f("連絡窓口"));                   // S
    write(r, 20, f("AI话题方向"));                 // T
    write(r, 21, f("構築方法"));                   // U
    write(r, 22, f("目的"));                       // V
    write(r, 23, f("核心需求"));                   // W
    write(r, 24, f("拡張需求"));                   // X
    write(r, 25, f("依頼範囲"));                   // Y
    write(r, 26, f("予算感"));                     // Z
    write(r, 27, f("期望交期"));                   // AA
    write(r, 28, f("決策流"));                     // AB
    write(r, 29, aiType);                          // AC
    write(r, 30, aiAction);                        // AD
    write(r, 31, aiReason);                        // AE
    sheet.getRange(r, 32).setValue(status);        // AF: 処理Status
  } else {
    var row = new Array(45).fill("");
    row[0]  = id || "NEW";
    row[1]  = corp;
    row[2]  = new Date();
    row[3]  = category;
    row[4]  = f("URL");
    row[5]  = f("業界");
    row[6]  = f("設立");
    row[7]  = f("資本金");
    row[8]  = f("売上高");
    row[9]  = f("決算月");
    row[10] = f("社員数");
    row[11] = f("都道府県");
    row[12] = f("最寄駅");
    row[13] = f("法人概要");
    row[14] = f("相談内容");
    row[15] = f("相談背景");
    row[16] = f("現状課題");
    row[17] = f("RFP資料");
    row[18] = f("連絡窓口");
    row[19] = f("AI话题方向");
    row[20] = f("構築方法");
    row[21] = f("目的");
    row[22] = f("核心需求");
    row[23] = f("拡張需求");
    row[24] = f("依頼範囲");
    row[25] = f("予算感");
    row[26] = f("期望交期");
    row[27] = f("決策流");
    row[28] = aiType;
    row[29] = aiAction;
    row[30] = aiReason;
    row[31] = status;
    sheet.appendRow(row);
  }
  SpreadsheetApp.flush();
  return { status: "SUCCESS" };
}

/**
 * AI 结构化解析邮件正文 → Case_infor 各字段
 * System Prompt 优先从 Prompt_Config B2 读取（可在 Spreadsheet 直接编辑）。
 * B2 为空时使用代码内置的默认 Prompt 兜底。
 * B2 输出的字段名（売上/決算/必須機能等）与 Case_infor 列名不同，解析后做映射。
 * @param {string} rawBody  - 邮件正文（含 "件名: xxx\n\n" 前缀）
 * @param {string} [cachedSystemMsg] - 可选：由调用方传入已读好的 B2 内容，避免重复 I/O
 */
function parseBodyToStructured(rawBody, cachedSystemMsg) {
  if (!rawBody) return {};

  // 优先用调用方传入的缓存，否则实时读 Prompt_Config B2
  var systemMsg = cachedSystemMsg || "";
  if (!systemMsg) {
    try {
      const pc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Prompt_Config");
      if (pc) systemMsg = String(pc.getRange("B2").getValue() || "").trim();
    } catch(e) { console.warn("Prompt_Config B2 read failed: " + e); }
  }
  if (!systemMsg) systemMsg = FALLBACK_PARSE_PROMPT;

  // ─── 正则兜底：不依赖 AI，从 subject/body 直接提取案件ID和法人名 ───
  // subject 格式举例: "【Ready Crew】...募集。： 3374133"  或  "[3365344] 会社名"
  var regexCaseId = "";
  var regexCorp   = "";
  // 匹配 subject 末尾的 "： 数字" 或 "：数字" 或 "[数字]"
  var mId = rawBody.match(/件名:.*?[：:【\[]\s*(\d{5,8})\s*[】\]]?/);
  if (!mId) mId = rawBody.match(/件名:.*[^\d](\d{6,8})\s*$/m);
  if (mId) regexCaseId = mId[1];
  // 匹配 body 里 【法人名】 后的内容
  var mCorp = rawBody.match(/【法人名】\s*([^\n\r【】]{2,50})/);
  if (!mCorp) mCorp = rawBody.match(/法人名[：:]\s*([^\n\r]{2,50})/);
  if (mCorp) regexCorp = mCorp[1].trim();

  const res = callAIText(
    "以下のメールから構造化データを抽出してください:\n\n" + rawBody.slice(0, 9000),
    systemMsg
  );
  if (!res) {
    console.error("parseBodyToStructured: AI returned null/empty");
    // AI 失败时仍用正则兜底返回基础字段
    if (regexCaseId || regexCorp) {
      return { "案件ID": regexCaseId, "法人名": regexCorp, "分类建议": "Solution" };
    }
    return {};
  }
  const raw = safeJsonParse(res);
  if (!raw) {
    console.error("parseBodyToStructured: JSON parse failed. Response: " + res.slice(0, 300));
    if (regexCaseId || regexCorp) {
      return { "案件ID": regexCaseId, "法人名": regexCorp, "分类建议": "Solution" };
    }
    return {};
  }

  // B2 Prompt のキー名 → saveOrUpdateLead で使う Case_infor キー名へマッピング
  // B2は「売上」「決算」「必須機能」「要望機能」「予算」「着手時期」「決裁フロー」「システム概要」を使う
  // saveOrUpdateLead の f() は「売上高」「決算月」「核心需求」「拡張需求」「予算感」「期望交期」「決策流」「AI话题方向」を参照
  const mapped = {};
  // 正则结果优先（正则比 AI 更可靠地提取案件ID/法人名）
  mapped["案件ID"]      = regexCaseId  || raw["案件ID"]      || "";
  mapped["法人名"]      = regexCorp    || raw["法人名"]      || "";
  mapped["所属部門"]    = raw["分类建议"]    || raw["所属部門"]    || "Solution";
  mapped["URL"]         = raw["URL"]         || "";
  mapped["業界"]        = raw["業界"]        || "";
  mapped["設立"]        = raw["設立"]        || "";
  mapped["資本金"]      = raw["資本金"]      || "";
  mapped["売上高"]      = raw["売上高"]      || raw["売上"]        || "";
  mapped["決算月"]      = raw["決算月"]      || raw["決算"]        || "";
  mapped["社員数"]      = raw["社員数"]      || "";
  mapped["都道府県"]    = raw["都道府県"]    || "";
  mapped["最寄駅"]      = raw["最寄駅"]      || "";
  mapped["法人概要"]    = raw["法人概要"]    || "";
  mapped["相談内容"]    = raw["相談内容"]    || "";
  mapped["相談背景"]    = raw["相談背景"]    || "";
  mapped["現状課題"]    = raw["現状課題"]    || "";
  mapped["RFP資料"]     = raw["RFP資料"]     || raw["既存パートナー"] || "";
  mapped["連絡窓口"]    = raw["連絡窓口"]    || "";
  mapped["AI话题方向"]  = raw["AI话题方向"]  || raw["システム概要"] || "";
  mapped["構築方法"]    = raw["構築方法"]    || "";
  mapped["目的"]        = raw["目的"]        || "";
  mapped["核心需求"]    = raw["核心需求"]    || raw["必須機能"]    || "";
  mapped["拡張需求"]    = raw["拡張需求"]    || raw["要望機能"]    || "";
  mapped["依頼範囲"]    = raw["依頼範囲"]    || "";
  mapped["予算感"]      = raw["予算感"]      || raw["予算"]        || "";
  mapped["期望交期"]    = raw["期望交期"]    || raw["着手時期"]    || "";
  mapped["決策流"]      = raw["決策流"]      || raw["決裁フロー"]  || "";
  mapped["分类建议"]    = raw["分类建议"]    || raw["所属部門"]    || "Solution";

  console.log("parseBodyToStructured OK: 法人名=" + mapped["法人名"] + " 案件ID=" + mapped["案件ID"] + " 売上高=" + mapped["売上高"]);
  return mapped;
}

/**
 * 顾问终审提交 V9.8.1
 * 流程：
 *   1. 读 Review_Buffer 对应行的 ParsedJSON（col 13，同步时缓存）
 *   2. 若 ParsedJSON 为空（旧数据）→ 用 rawBody 实时调 AI 完整解析（28字段）
 *   3. 写入 Case_infor，标记 Review_Buffer 对应行为 AUDITED
 */
function submitConsultantDecision(d) {
  const buffer = getSheetSafe("Review_Buffer");

  // 从前端拿到的基础字段
  var rawBody     = String(d.rawBody  || "").trim();
  var caseId      = String(d.caseId   || "").trim();
  var corp        = String(d.corp     || "").trim();
  var bufAiType   = String(d.aiType   || "").trim();
  var bufAiAction = String(d.aiAction || "").trim();
  var bufAiReason = String(d.aiReason || "").trim();

  // 读 Buffer 行的所有列（最多13列，含 ParsedJSON）
  var structured = {};
  try {
    const lastCol = Math.max(buffer.getLastColumn(), 13);
    const rowData = buffer.getRange(d.row, 1, 1, lastCol).getValues()[0];
    // 兜底：从 Buffer 各列读取基础字段（如前端没传）
    if (!rawBody)     rawBody     = String(rowData[4]  || "");
    if (!caseId)      caseId      = String(rowData[1]  || "");
    if (!corp)        corp        = String(rowData[2]  || "");
    if (!bufAiType)   bufAiType   = String(rowData[7]  || "");
    if (!bufAiAction) bufAiAction = String(rowData[8]  || "");
    if (!bufAiReason) bufAiReason = String(rowData[9]  || "");

    // 优先用同步时缓存的 ParsedJSON（col 13, index 12）
    const cachedJson = rowData[12] ? String(rowData[12]).trim() : "";
    if (cachedJson) {
      structured = safeJsonParse(cachedJson) || {};
      console.log("Using cached ParsedJSON, keys=" + Object.keys(structured).length);
    }
  } catch(e) {
    console.error("Buffer read failed: " + e.toString());
  }

  // ParsedJSON 为空或有效字段太少（值非空的字段 < 5，说明 AI 解析实质失败）→ 实时用 AI 完整解析
  const countNonEmpty = function(obj) {
    return Object.keys(obj).filter(function(k) { return obj[k] && String(obj[k]).trim() !== ""; }).length;
  };
  if (countNonEmpty(structured) < 5 && rawBody) {
    console.log("ParsedJSON has too few non-empty fields (nonempty=" + countNonEmpty(structured) + "), calling AI full parse...");
    try {
      const reParsed = parseBodyToStructured(rawBody) || {};
      // 合并：AI 结果优先，但保留已有的案件ID/法人名（正则结果更可靠）
      const savedId   = structured["案件ID"]  || caseId;
      const savedCorp = structured["法人名"]  || corp;
      structured = reParsed;
      if (savedId)   structured["案件ID"] = savedId;
      if (savedCorp && savedCorp !== "[UNIDENTIFIED]") structured["法人名"] = savedCorp;
      console.log("AI re-parse done, nonempty=" + countNonEmpty(structured));
    } catch(e) {
      console.error("AI parse error: " + e.toString());
    }
  }

  // 兜底基础字段（保证至少有法人名和案件ID）
  if (!structured["案件ID"] || structured["案件ID"] === "") structured["案件ID"] = caseId;
  if (!structured["法人名"] || structured["法人名"] === "" || structured["法人名"] === "[UNIDENTIFIED]") {
    structured["法人名"] = corp && corp !== "[UNIDENTIFIED]" ? corp : structured["法人名"] || "";
  }

  // 合并顾问裁决
  structured["分类建议"] = d.type || structured["分类建議"] || structured["所属部門"] || "SES";
  structured["ai_type"]   = bufAiType;
  structured["ai_action"] = bufAiAction;
  structured["ai_reason"] = bufAiReason;

  // 顾问 Notes 追加到 相談内容
  const verdictNote = "[VERDICT:" + d.decision.toUpperCase() + "] " + (d.reason || "");
  structured["相談内容"] = (structured["相談内容"] ? structured["相談内容"] + "\n\n" : "") + verdictNote;

  // 法人概要が空の場合でも rawBody 全文は入れない（邮件全文が入ってしまう問題を防ぐ）
  // 代わりに相談内容の最初の200字で補完するか、空のまま残す
  if (!structured["法人概要"] || structured["法人概要"].trim() === "") {
    // 何も入れない — Case_infor の法人概要セルは空のままにする
    structured["法人概要"] = "";
  }

  console.log("Saving to Case_infor: id=" + structured["案件ID"] + " corp=" + structured["法人名"] + " fields=" + Object.keys(structured).length);
  var statusLabel = d.decision === "Go"   ? "Bid Sent"
                  : d.decision === "Hold" ? "Hold (Consulting)"
                  :                         "Reviewed (Skip)";
  saveOrUpdateLead(structured, statusLabel);

  // 把同一 CaseID 或同一法人名的 PENDING 行标记 AUDITED
  const allData = buffer.getDataRange().getValues();
  for (let i = 1; i < allData.length; i++) {
    const rowCaseId = String(allData[i][1] || "").trim();
    const rowCorp   = String(allData[i][2] || "").trim();
    const rowStatus = String(allData[i][10] || "").toUpperCase();
    const isMatch   = (caseId && caseId !== "NEW" && caseId !== "" && rowCaseId === caseId) ||
                      ((!caseId || caseId === "NEW" || caseId === "") && corp && corp !== "[UNIDENTIFIED]" && rowCorp === corp);
    if (isMatch && rowStatus === "PENDING") {
      buffer.getRange(i + 1, 11).setValue("AUDITED");
    }
  }

  SpreadsheetApp.flush();
  // ── 自动保存顾问决策到 Feedback_Log ──
  try {
    saveFeedbackLog({
      caseId         : structured["案件ID"]  || caseId || "",
      corp           : structured["法人名"]  || corp   || "",
      decision       : d.decision,
      category       : d.type || structured["分类建议"] || "",
      note           : d.reason || "",
      aiReason       : bufAiReason || "",
      consultantName : String(d.consultantName || "")
    });
  } catch(eLog) { console.warn("saveFeedbackLog failed: " + eLog); }

  return { status: "SUCCESS", structuredKeys: Object.keys(structured) };
}

/**
 * 保存顾问决策到 Feedback_Log Sheet（从第2行开始）
 * 列布局：A=Timestamp B=CaseID C=CorpName D=Decision E=Category F=ConsultantNote G=AIReason H=ConsultantName
 */
function saveFeedbackLog(d) {
  const sheet = getSheetSafe("Feedback_Log");
  sheet.appendRow([
    new Date(),
    String(d.caseId          || ""),
    String(d.corp            || ""),
    String(d.decision        || ""),
    String(d.category        || ""),
    String(d.note            || ""),
    String(d.aiReason        || ""),
    String(d.consultantName  || "")
  ]);
  SpreadsheetApp.flush();
}

/**
 * 案件IDに紐付く顧問意見一覧を返す（Feedback_Log）
 * @param {string} caseId
 * @returns {Array<{date,name,decision,category,note}>}
 */
function getFeedbackByCaseId(caseId) {
  const sheet = getSheetSafe("Feedback_Log");
  if (sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues().slice(1); // skip header
  const matched = [];
  rows.forEach(function(r) {
    if (String(r[1] || "").trim() !== String(caseId || "").trim()) return;
    var dateStr = "";
    try { dateStr = r[0] ? Utilities.formatDate(new Date(r[0]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm") : ""; } catch(e) {}
    matched.push({
      date    : dateStr,
      caseId  : String(r[1] || ""),
      corp    : String(r[2] || ""),
      decision: String(r[3] || ""),
      category: String(r[4] || ""),
      note    : String(r[5] || ""),
      aiReason: String(r[6] || ""),
      name    : String(r[7] || "（匿名）")
    });
  });
  return matched.reverse(); // 最新順
}

/**
 * 案件の会議結論を保存・更新（Meeting_Records）
 * 同時に Case_infor AF列（処理Status）も会議判定に合わせて更新する
 * @param {Object} d - {caseId, corp, meetingDate, participants, decision, conclusion}
 */
function saveMeetingRecord(d) {
  const sheet = getSheetSafe("Meeting_Records");
  const rows = sheet.getLastRow() > 1 ? sheet.getDataRange().getValues().slice(1) : [];

  // ── Meeting_Records への保存 ──
  var meetingStatus = "UPDATED";
  var found = false;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][1] || "").trim() === String(d.caseId || "").trim()) {
      var r = i + 2; // 1-based + header
      sheet.getRange(r, 1).setValue(String(d.meetingDate  || ""));
      sheet.getRange(r, 4).setValue(String(d.participants || ""));
      sheet.getRange(r, 5).setValue(String(d.decision     || ""));
      sheet.getRange(r, 6).setValue(String(d.conclusion   || ""));
      sheet.getRange(r, 7).setValue(new Date());
      found = true;
      break;
    }
  }
  if (!found) {
    sheet.appendRow([
      String(d.meetingDate  || ""),
      String(d.caseId       || ""),
      String(d.corp         || ""),
      String(d.participants || ""),
      String(d.decision     || ""),
      String(d.conclusion   || ""),
      new Date()
    ]);
    meetingStatus = "CREATED";
  }

  // ── Case_infor AF列（処理Status）を会議判定に合わせて更新 ──
  var decisionRaw = String(d.decision || "").toLowerCase();
  var newStatus = "";
  if (decisionRaw.indexOf("go") >= 0 || decisionRaw.indexOf("bid") >= 0) {
    newStatus = "Bid Sent";
  } else if (decisionRaw.indexOf("hold") >= 0) {
    newStatus = "Hold (Consulting)";
  } else if (decisionRaw.indexOf("skip") >= 0 || decisionRaw.indexOf("ng") >= 0) {
    newStatus = "Reviewed (Skip)";
  }

  if (newStatus && d.caseId) {
    try {
      const ss        = SpreadsheetApp.getActiveSpreadsheet();
      const ciSheet   = ss.getSheetByName("Case_infor");
      if (ciSheet) {
        const ciRows  = ciSheet.getDataRange().getValues();
        const caseId  = String(d.caseId || "").trim();
        const corp    = String(d.corp   || "").trim();
        for (var j = 1; j < ciRows.length; j++) {
          var rowCaseId = String(ciRows[j][0] || "").trim();
          var rowCorp   = String(ciRows[j][1] || "").trim();
          var isMatch   = (caseId && caseId !== "NEW" && rowCaseId === caseId) ||
                          (!caseId || caseId === "NEW" ? rowCorp === corp : false);
          if (isMatch) {
            ciSheet.getRange(j + 1, 32).setValue(newStatus); // AF列（1-based col 32）
            console.log("Case_infor status updated: row=" + (j+1) + " status=" + newStatus);
            break;
          }
        }
      }
    } catch(e) {
      console.warn("Case_infor status update failed: " + e.toString());
    }
  }

  SpreadsheetApp.flush();
  return { status: meetingStatus, caseInforUpdated: !!newStatus };
}

/**
 * 【歴史データ補正】Meeting_Records の全レコードを読んで
 * Case_infor AF列（処理Status）を一括更新する。
 * 既に Status が入っている行は上書きしない（forceOverwrite=true で強制上書き可）。
 * フロントエンドの「歴史データ補正」ボタンから呼び出す。
 * @param {boolean} forceOverwrite - true の場合、既存 Status を上書きする
 * @returns {{ updated:number, skipped:number, notFound:number }}
 */
function backfillMeetingStatus(forceOverwrite) {
  var mrSheet = getSheetSafe("Meeting_Records");
  var ciSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Case_infor");
  if (!ciSheet) return { updated: 0, skipped: 0, notFound: 0, error: "Case_infor not found" };
  if (mrSheet.getLastRow() < 2) return { updated: 0, skipped: 0, notFound: 0 };

  var mrRows = mrSheet.getDataRange().getValues().slice(1); // Meeting_Records ヘッダースキップ
  var ciRows = ciSheet.getDataRange().getValues();           // Case_infor 全行（ヘッダー含む）

  var updated = 0, skipped = 0, notFound = 0;

  // Case_infor を CaseID → 行番号 のマップに変換（高速検索用）
  var ciIndexById   = {};  // caseId → rowIndex (1-based in sheet)
  var ciIndexByCorp = {};  // corp   → rowIndex
  for (var i = 1; i < ciRows.length; i++) {
    var id   = String(ciRows[i][0] || "").trim();
    var corp = String(ciRows[i][1] || "").trim();
    if (id && id !== "NEW")  ciIndexById[id]     = i + 1;  // 1-based
    if (corp)                ciIndexByCorp[corp] = i + 1;
  }

  for (var m = 0; m < mrRows.length; m++) {
    var mrCaseId  = String(mrRows[m][1] || "").trim();
    var mrCorp    = String(mrRows[m][2] || "").trim();
    var mrDecision = String(mrRows[m][4] || "").toLowerCase();

    // 新ステータスを判定
    var newStatus = "";
    if (mrDecision.indexOf("go") >= 0 || mrDecision.indexOf("bid") >= 0) {
      newStatus = "Bid Sent";
    } else if (mrDecision.indexOf("hold") >= 0) {
      newStatus = "Hold (Consulting)";
    } else if (mrDecision.indexOf("skip") >= 0 || mrDecision.indexOf("ng") >= 0) {
      newStatus = "Reviewed (Skip)";
    }
    if (!newStatus) { skipped++; continue; }

    // Case_infor の対応行を探す
    var targetRow = (mrCaseId && ciIndexById[mrCaseId])
                      ? ciIndexById[mrCaseId]
                      : (mrCorp && ciIndexByCorp[mrCorp] ? ciIndexByCorp[mrCorp] : 0);
    if (!targetRow) { notFound++; continue; }

    // 既存 Status チェック（forceOverwrite が false の場合は空のみ更新）
    var existingStatus = String(ciRows[targetRow - 1][31] || "").trim(); // 0-based index 31
    if (existingStatus && !forceOverwrite) { skipped++; continue; }

    ciSheet.getRange(targetRow, 32).setValue(newStatus); // AF列 1-based col 32
    updated++;
  }

  SpreadsheetApp.flush();
  console.log("backfillMeetingStatus: updated=" + updated + " skipped=" + skipped + " notFound=" + notFound);
  return { updated: updated, skipped: skipped, notFound: notFound };
}

/**
 * 案件の会議結論を取得（Meeting_Records）
 */
function getMeetingRecord(caseId) {
  const sheet = getSheetSafe("Meeting_Records");
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getDataRange().getValues().slice(1);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][1] || "").trim() === String(caseId || "").trim()) {
      return {
        meetingDate : String(rows[i][0] || ""),
        caseId      : String(rows[i][1] || ""),
        corp        : String(rows[i][2] || ""),
        participants: String(rows[i][3] || ""),
        decision    : String(rows[i][4] || ""),
        conclusion  : String(rows[i][5] || "")
      };
    }
  }
  return null;
}

/**
 * 案件の Todo 一覧を取得（Case_Todo）
 */
function getCaseTodos(caseId) {
  const sheet = getSheetSafe("Case_Todo");
  if (sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues().slice(1);
  const result = [];
  rows.forEach(function(r, idx) {
    if (String(r[1] || "").trim() !== String(caseId || "").trim()) return;
    var createdStr = "";
    try { createdStr = r[7] ? Utilities.formatDate(new Date(r[7]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd") : ""; } catch(e) {}
    result.push({
      rowNum    : idx + 2,          // 実際の行番号（1-based + header）
      todoId    : String(r[0] || ""),
      caseId    : String(r[1] || ""),
      corp      : String(r[2] || ""),
      action    : String(r[3] || ""),
      assignedTo: String(r[4] || ""),
      dueDate   : String(r[5] || ""),
      status    : String(r[6] || "Open"),
      createdAt : createdStr
    });
  });
  return result;
}

/**
 * Todo を新規追加（Case_Todo）
 */
function saveCaseTodo(d) {
  const sheet = getSheetSafe("Case_Todo");
  const todoId = "TODO-" + new Date().getTime();
  sheet.appendRow([
    todoId,
    String(d.caseId     || ""),
    String(d.corp       || ""),
    String(d.action     || ""),
    String(d.assignedTo || ""),
    String(d.dueDate    || ""),
    "Open",
    new Date()
  ]);
  SpreadsheetApp.flush();
  return { status: "OK", todoId: todoId };
}

/**
 * Todo のステータスを切り替え（Open ↔ Done）
 * @param {number} rowNum - 実際の行番号（1-based）
 */
function updateTodoStatus(rowNum, status) {
  const sheet = getSheetSafe("Case_Todo");
  sheet.getRange(rowNum, 7).setValue(status);
  SpreadsheetApp.flush();
  return { status: "OK" };
}

/**
 * ── AI 顧客確認メール下書き生成 ──
 * @param {string} caseId       案件ID（Case_infor を検索）
 * @param {string} action       'Go' | 'Hold'
 * @param {string} templateType 'initial_contact' | 'hold_check'
 * @returns {{ subject: string, body: string }}
 *
 * Case_infor 列インデックス（0-based）
 *   0=案件ID  1=法人名  13=法人概要  14=相談内容  15=相談背景  16=現状課題
 *   18=連絡窓口  22=核心需求  25=予算感  26=期望交期
 */
function generateOutreachEmail(caseId, action, templateType) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── 1. Case_infor から構造化データを取得 ──
    const sheet = ss.getSheetByName("Case_infor");
    if (!sheet || sheet.getLastRow() < 2) {
      return { subject: "", body: "案件データが見つかりません (Case_infor が空)。" };
    }
    const rows = sheet.getDataRange().getValues();
    var caseRow = null;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || "").trim() === String(caseId || "").trim()) {
        caseRow = rows[i]; break;
      }
    }
    if (!caseRow) {
      return { subject: "", body: "案件ID「" + caseId + "」が Case_infor に見つかりません。" };
    }

    var corp       = String(caseRow[1]  || "");
    var summary    = String(caseRow[13] || "");
    var consult    = String(caseRow[14] || "");
    var background = String(caseRow[15] || "");
    var challenge  = String(caseRow[16] || "");
    var contact    = String(caseRow[18] || "ご担当者");
    var coreReq    = String(caseRow[22] || "");
    var budget     = String(caseRow[25] || "");
    var deadline   = String(caseRow[26] || "");
    var contactName = contact.replace(/様|さん|先生/g, "").trim().split(/[\s　]/)[0] || "ご担当者";

    // ── 2. Review_Buffer から原始メール本文を取得（RFP・予算・サンプル言及チェック用）──
    var originalEmailBody = "";
    try {
      var buf = ss.getSheetByName("Review_Buffer");
      if (buf && buf.getLastRow() > 1) {
        var bufRows = buf.getDataRange().getValues();
        for (var bi = bufRows.length - 1; bi >= 1; bi--) {
          if (String(bufRows[bi][1] || "").trim() === String(caseId).trim()) {
            originalEmailBody = String(bufRows[bi][4] || "").slice(0, 1000); // 本文先頭1000字
            break;
          }
        }
      }
    } catch(e) { console.warn("Review_Buffer read failed: " + e); }

    // ── 3. Meeting_Records から会議結論を取得 ──
    var meetingConclusion = "";
    var meetingDecision   = "";
    var meetingDate       = "";
    try {
      var mr = ss.getSheetByName("Meeting_Records");
      if (mr && mr.getLastRow() > 1) {
        var mrRows = mr.getDataRange().getValues().slice(1);
        for (var mi = 0; mi < mrRows.length; mi++) {
          if (String(mrRows[mi][1] || "").trim() === String(caseId).trim()) {
            meetingDate       = String(mrRows[mi][0] || "");
            meetingDecision   = String(mrRows[mi][4] || "");
            meetingConclusion = String(mrRows[mi][5] || "");
            break;
          }
        }
      }
    } catch(e) { console.warn("Meeting_Records read failed: " + e); }

    // ── 4. Feedback_Log から顧問コメントを全取得 ──
    var advisorComments = "";
    try {
      var fl = ss.getSheetByName("Feedback_Log");
      if (fl && fl.getLastRow() > 1) {
        var flRows = fl.getDataRange().getValues().slice(1);
        var comments = [];
        flRows.forEach(function(r) {
          if (String(r[1] || "").trim() !== String(caseId).trim()) return;
          var name     = String(r[7] || "顧問");
          var decision = String(r[3] || "");
          var note     = String(r[5] || "").trim();
          if (note) comments.push("・[" + name + " / " + decision + "] " + note);
        });
        advisorComments = comments.join("\n");
      }
    } catch(e) { console.warn("Feedback_Log read failed: " + e); }

    // ── 4. Prompt_Config B11/B12 からプロンプトを読む ──
    var emailPrompt = "";
    try {
      var pc = ss.getSheetByName("Prompt_Config");
      if (pc) {
        var promptCell = (templateType === "hold_check") ? "B12" : "B11";
        emailPrompt = String(pc.getRange(promptCell).getValue() || "").trim();
      }
    } catch(e) {}

    var templateDesc = (templateType === "hold_check")
      ? "HOLD判断案件の現状確認メール（丁寧に現在の進捗確認をする）"
      : "GO判断案件の初回接触確認メール（弊社で支援できると判断し、詳細確認を申し入れる）";

    // B11/B12 が空の場合のデフォルトプロンプト
    var systemMsg = emailPrompt || (
      "あなたはテラボックス株式会社の山口でございます。\n" +
      "AIシステム導入支援・ITアウトソーシングの仲介担当として、顧客へ日本語メールを生成してください。\n\n" +
      "【出力ルール】\n" +
      "- 必ず純粋なJSONのみを返す。形式: {\"subject\":\"件名\",\"body\":\"本文\"}\n" +
      "- 件名は「【テラボックス】」で始めること\n" +
      "- 本文は丁寧なビジネス日本語。署名は含めない\n" +
      "- 文末は「よろしくお願いいたします。」で締める\n"
    );

    // ── 5. ユーザーメッセージ構築（原始メール＋顧問コメントを含む）──
    var userMsg =
      "【メール種別】" + templateDesc + "\n" +
      "【顧問判断】" + (action === "Go" ? "GO（支援可能）" : "HOLD（保留・要確認）") + "\n\n" +
      "【構造化案件情報（Case_inforより）】\n" +
      "- 法人名: " + corp + "\n" +
      "- 担当者名（宛先）: " + contactName + "\n" +
      "- 法人概要: " + summary.slice(0, 200) + "\n" +
      "- 相談内容: " + consult.slice(0, 300) + "\n" +
      "- 相談背景: " + background.slice(0, 200) + "\n" +
      "- 現状課題: " + challenge.slice(0, 200) + "\n" +
      "- 主要要件: " + coreReq.slice(0, 200) + "\n" +
      "- 予算感: " + (budget || "未記載") + "\n" +
      "- 希望着手時期: " + (deadline || "未記載") + "\n\n";

    if (originalEmailBody) {
      userMsg +=
        "【原始メール本文（顧客が実際に送ってきた内容）】\n" +
        originalEmailBody + "\n\n" +
        "※上記の原始メールをよく読み、すでに記載されている情報（RFP有無・予算・サンプルデータ・期日 等）は\n" +
        "　重複して質問しないこと。記載のない項目のみ確認する。\n\n";
    }

    if (advisorComments) {
      userMsg +=
        "【顧問コメント（社内判断・懸念点）】\n" +
        advisorComments + "\n" +
        "※顧問が指摘した疑問点・懸念をメールの確認項目に反映させること。\n\n";
    }

    if (meetingConclusion) {
      userMsg +=
        "【会議結論（" + meetingDate + "）】\n" +
        "- 判断: " + meetingDecision + "\n" +
        "- 結論・方針: " + meetingConclusion + "\n" +
        "※上記の会議で決まった方針・次のアクションをメール本文に反映させること。\n\n";
    }

    userMsg += "上記を踏まえ、" + templateDesc + "を生成してください。";

    // ── 6. AI 呼び出し ──
    var aiRaw = callAIText(userMsg, systemMsg);
    if (!aiRaw) return { subject: "", body: "AI生成に失敗しました。API接続を確認してください。" };

    var parsed = safeJsonParse(aiRaw);
    if (parsed && parsed.subject && parsed.body) {
      return { subject: parsed.subject, body: parsed.body };
    }
    return { subject: "【テラボックス】ご案件についてのご確認 - " + corp + "様", body: aiRaw };

  } catch(e) {
    console.error("generateOutreachEmail error: " + e.toString());
    return { subject: "", body: "エラーが発生しました: " + e.message };
  }
}

/**
 * Case_infor から1案件の詳細を取得（Archive Detail モーダル用）
 */
function getCaseDetail(caseId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Case_infor");
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[0] || "").trim() === String(caseId || "").trim()) {
      var dateStr = "";
      try { dateStr = r[2] ? Utilities.formatDate(new Date(r[2]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd") : ""; } catch(e) {}
      return {
        id         : String(r[0]  || ""),
        corp       : String(r[1]  || ""),
        date       : dateStr,
        category   : String(r[3]  || ""),
        industry   : String(r[5]  || ""),
        summary    : String(r[13] || ""),   // N: 法人概要
        consult    : String(r[14] || ""),   // O: 相談内容
        background : String(r[15] || ""),   // P: 相談背景
        challenge  : String(r[16] || ""),   // Q: 現状課題
        budget     : String(r[25] || ""),   // Z: 予算感
        deadline   : String(r[26] || ""),   // AA: 期望交期
        aiType     : String(r[28] || ""),   // AC: AI_Type
        aiAction   : String(r[29] || ""),   // AD: AI_Action
        status     : String(r[31] || "")    // AF: 処理Status
      };
    }
  }
  return null;
}

/**
 * Review_Buffer から CaseID で原始メール情報を取得
 * Archive Detail / Review Center 両方の「原始メール」タブで使用
 * @param {string} caseId
 * @returns {{ subject, body, mailDate, gmailLink, aiType, aiAction, aiReason, status }|null}
 *
 * Review_Buffer 列インデックス（0-based）:
 *   0=MailDate 1=CaseID 2=Corp 3=Subject 4=Body
 *   5=GmailLink 6=MsgID 7=AI_Type 8=AI_Action 9=AI_Reason 10=Status
 */
function getOriginalEmailByCaseId(caseId) {
  try {
    const sheet = getSheetSafe("Review_Buffer");
    if (sheet.getLastRow() < 2) return null;
    const rows = sheet.getDataRange().getValues();
    // 最新の一致行を返す（複数ある場合は最後の行 = 最新）
    var found = null;
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (String(r[1] || "").trim() === String(caseId || "").trim()) {
        var mailDateStr = "";
        try { mailDateStr = r[0] ? Utilities.formatDate(new Date(r[0]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm") : ""; } catch(e) {}
        found = {
          subject   : String(r[3]  || ""),
          body      : String(r[4]  || ""),
          mailDate  : mailDateStr,
          gmailLink : String(r[5]  || ""),
          msgId     : String(r[6]  || ""),
          aiType    : String(r[7]  || ""),
          aiAction  : String(r[8]  || ""),
          aiReason  : String(r[9]  || ""),
          status    : String(r[10] || "")
        };
        // 上書き継続（最後の行 = 最新を残す）
      }
    }
    return found;
  } catch(e) {
    console.error("getOriginalEmailByCaseId error: " + e.toString());
    return null;
  }
}

/**
 * Direct Intake / Sync 共通解析エンジン
 * subject+body を合わせた全文から完全28フィールドを抽出する。
 * 案件IDはメール件名に "[3365344]" のような形で含まれることが多いため、
 * subject を先頭に付けた fullText で解析する。
 */
function parseContentWithAI(fullText) {
  if (!fullText) return null;
  try {
    const result = parseBodyToStructured(fullText);
    if (result && Object.keys(result).length >= 3) return result;
  } catch(e) { console.error("parseContentWithAI→parseBodyToStructured failed: " + e); }
  // 兜底：シンプルな4フィールド抽出
  const systemMsg = "Extract JSON only: {\"案件ID\":\"\",\"法人名\":\"\",\"相談内容\":\"\",\"分类建议\":\"SES\"}. 案件ID is a 7-digit number found in subject or body. 法人名 is the company name of the sender or requester.";
  const res = callAIText("Extract from:\n" + fullText.slice(0, 4000), systemMsg);
  return safeJsonParse(res);
}

function safeJsonParse(t) {
  if (!t) return null;
  try {
    // 1. 先去掉 AI 有时包裹的 markdown 代码块（```json ... ``` 或 ``` ... ```）
    var cleaned = t.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    // 2. 截取第一个 { 到最后一个 } 之间的内容
    const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1 || e <= s) return null;
    return JSON.parse(cleaned.substring(s, e + 1));
  } catch (e) { return null; }
}

/**
 * 返回 Agent_Logs 中时间戳 > since（毫秒数）的最新条目，供前端轮询。
 * 每条返回 { ts, subject, res, info, type }
 * type: "RUNNING"|"MAIL"|"SKIP"|"AI"|"DONE"|"ERR"
 */
function getSyncProgress(since) {
  since = since || 0;
  try {
    const sheet = getSheetSafe("Agent_Logs");
    if (sheet.getLastRow() < 2) return [];
    const data = sheet.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      try {
        const t = new Date(data[i][0]);
        if (t.getTime() > since) {
          rows.push({
            ts     : t.getTime(),
            tsStr  : Utilities.formatDate(t, CONFIG.DEFAULT_TZ, "HH:mm:ss"),
            subject: String(data[i][1] || ""),
            res    : String(data[i][2] || ""),
            info   : String(data[i][3] || "")
          });
        }
      } catch(e) {}
    }
    return rows;
  } catch(e) { return []; }
}

function gmailAgentRunner(options) {
  options = options || {};
  const logSheet    = getSheetSafe("Agent_Logs");
  const bufferSheet = getSheetSafe("Review_Buffer");

  const _log = function(subject, res, info) {
    logSheet.appendRow([new Date(), subject, res, info || "", "SYS"]);
    SpreadsheetApp.flush();
  };

  try {
    const config      = getSheetSafe("Prompt_Config");
    const targetEmail = (config.getRange("B4").getValue() || "").toString().trim() || "rc_support@frontier-gr.jp";

    // Sync 開始時に B2 を一度だけ読んでキャッシュ（ループ内で毎回読まないための最適化）
    var cachedB2Prompt = "";
    try {
      cachedB2Prompt = String(config.getRange("B2").getValue() || "").trim();
    } catch(e) { console.warn("B2 read failed: " + e); }
    if (!cachedB2Prompt) cachedB2Prompt = FALLBACK_PARSE_PROMPT;

    // sinceDate: 前端传来的 "YYYY-MM-DD" 字符串（用户在日期选择器里选的起始日期）
    // 若未传则回退到 7 天前
    let dateAfter;
    let afterStr;
    if (options.sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(options.sinceDate)) {
      dateAfter = new Date(options.sinceDate + "T00:00:00+09:00");
      afterStr  = options.sinceDate.replace(/-/g, "/");
    } else {
      dateAfter = new Date();
      dateAfter.setDate(dateAfter.getDate() - 7);
      afterStr  = Utilities.formatDate(dateAfter, CONFIG.DEFAULT_TZ, "yyyy/MM/dd");
    }
    let query = `("${targetEmail}" OR "Ready Crew") after:${afterStr}`;
    if (!options.includeRead) query += " is:unread";

    _log(`🔍 Scan started`, "RUNNING", `after:${afterStr} includeRead=${!!options.includeRead} query:${query}`);

    const threads = GmailApp.search(query, 0, 100);
    const total   = threads.length;
    _log(`📬 Found ${total} thread(s)`, "RUNNING", `query result count`);

    let count  = 0;
    let skipped = 0;
    const dupSet = buildDuplicateSet();

    for (let i = 0; i < threads.length; i++) {
      const msgs = threads[i].getMessages();
      if (!msgs || msgs.length === 0) { skipped++; continue; }

      // スレッド内の全メッセージの MsgID を重複チェック → 最初の未登録メッセージを使用
      let msg = null;
      for (let mi = 0; mi < msgs.length; mi++) {
        const mid = msgs[mi].getId();
        if (!dupSet["msgid:" + mid]) { msg = msgs[mi]; break; }
      }
      if (!msg) {
        skipped++;
        _log(`[${i+1}/${total}] ⏭ SKIP (dup-thread-all-msgs)`, "SKIP", msgs[0].getSubject());
        continue;
      }

      const msgId   = msg.getId();
      const subject = msg.getSubject() || "(no subject)";
      const subjKey = "subj:" + subject.trim().replace(/\s+/g, " ").toLowerCase();

      // 件名でも重複チェック
      if (dupSet[subjKey]) {
        skipped++;
        _log(`[${i+1}/${total}] ⏭ SKIP (dup-subject)`, "SKIP", subject);
        continue;
      }

      _log(`[${i+1}/${total}] 📩 Reading`, "MAIL", subject);

      // subject + body を合わせて解析（件名に案件IDが含まれるケースに対応）
      const fullText = "件名: " + subject + "\n\n" + msg.getPlainBody();

      // ── Spam_Filter チェック（削除学習済みルールと照合）──────
      const spamCheck = checkSpamFilter("", subject, msg.getPlainBody().slice(0, 500));
      if (spamCheck.skip) {
        skipped++;
        _log(`[${i+1}/${total}] 🚫 SKIP (Spam_Filter)`, "SKIP", spamCheck.reason + " | " + subject);
        continue;
      }

      // 解析：传入缓存的 B2 Prompt，避免每封邮件重复读 Spreadsheet
      const aiData = parseBodyToStructured(fullText, cachedB2Prompt);
      const corp   = (aiData && aiData["法人名"] && aiData["法人名"] !== "") ? aiData["法人名"] : "[UNIDENTIFIED]";
      const caseId = (aiData && aiData["案件ID"]) ? String(aiData["案件ID"]).trim() : "";

      _log(`[${i+1}/${total}] 🤖 AI parsed`, "AI",
           `corp="${corp}"  id="${caseId}"  fields=${aiData ? Object.keys(aiData).length : 0}  subject="${subject}"`);

      // CaseID が判明した場合は追加で重複チェック
      if (caseId && caseId.length >= 5 && /^\d+$/.test(caseId) && dupSet["caseid:" + caseId]) {
        skipped++;
        _log(`[${i+1}/${total}] ⏭ SKIP (dup-caseid=${caseId})`, "SKIP", subject);
        continue;
      }
      // 完整结构化解析结果直接用 aiData（已包含28字段），存入 col13(ParsedJSON)
      var parsedJson = "";
      try {
        var fullParsed = (aiData && Object.keys(aiData).length >= 3) ? aiData : {};
        parsedJson = Object.keys(fullParsed).length > 0 ? JSON.stringify(fullParsed) : "";
        _log(`[${i+1}/${total}] 📋 Full parse OK`, "AI",
             `fields=${Object.keys(fullParsed).length} 法人名="${fullParsed["法人名"]||""}" 相談内容="${(fullParsed["相談内容"]||"").slice(0,40)}"`);
      } catch(ep) {
        _log(`[${i+1}/${total}] ⚠ Full parse failed`, "AI", ep.toString());
      }

      const mailDate = msg.getDate();
      bufferSheet.appendRow([
        mailDate,
        caseId,
        corp,
        subject,
        msg.getPlainBody(),
        `https://mail.google.com/mail/u/0/#inbox/${msgId}`,
        msgId,
        "", "", "",
        "PENDING",
        new Date(),
        parsedJson
      ]);
      count++;
    }

    SpreadsheetApp.flush();

    if (count > 0) {
      _log(`⚡ Running AI pre-evaluation for ${count} item(s)…`, "RUNNING", "");
      runAIPreEvaluation();
      _log(`✅ AI pre-evaluation done`, "RUNNING", "");
    }

    const summary = `Synced ${count} new | skipped ${skipped} dup | after:${afterStr}`;
    _log(`🎉 Sync complete`, "DONE", summary);

    // ── Feature 1: 最終同期日時を Prompt_Config B10 に書き込み ──
    try {
      const syncTimeStr = Utilities.formatDate(new Date(), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm");
      getSheetSafe("Prompt_Config").getRange("B10").setValue(syncTimeStr);
      SpreadsheetApp.flush();
    } catch(e) { console.warn("B10 write failed: " + e); }

    return summary;

  } catch (e) {
    const msg = e.message || String(e);
    try { _log(`❌ Sync error`, "ERR", msg); } catch(_) {}
    throw new Error(msg);
  }
}

// ══════════════════════════════════════════════════════
// Feature 1: 最終同期日時取得
// Prompt_Config B10 に gmailAgentRunner 完了時刻を保存
// ══════════════════════════════════════════════════════
function getLastSyncTime() {
  try {
    var v = String(getSheetSafe("Prompt_Config").getRange("B10").getValue() || "").trim();
    return v || null;
  } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════
// Feature 2: 自動同期間隔取得・設定 (Prompt_Config B9)
// デフォルト 60 分。
// ══════════════════════════════════════════════════════
function getSyncInterval() {
  try {
    var v = parseInt(String(getSheetSafe("Prompt_Config").getRange("B9").getValue() || "60"), 10);
    return isNaN(v) || v < 1 ? 60 : v;
  } catch(e) { return 60; }
}

/**
 * 同期間隔を B9 に保存して既存トリガーを再構築
 * @param {number} minutes  10/15/30/60/120/360/720 のいずれか
 * @returns {{ ok: boolean, interval: number, message: string }}
 */
function setSyncIntervalAndRebuildTrigger(minutes) {
  try {
    minutes = parseInt(String(minutes), 10);
    var ALLOWED = [10, 15, 30, 60, 120, 360, 720];
    if (!minutes || ALLOWED.indexOf(minutes) === -1) {
      minutes = ALLOWED.reduce(function(prev, cur) {
        return Math.abs(cur - minutes) < Math.abs(prev - minutes) ? cur : prev;
      });
    }
    // B9 に保存
    getSheetSafe("Prompt_Config").getRange("B9").setValue(minutes);
    SpreadsheetApp.flush();

    // 既存の gmailAgentRunner トリガーをすべて削除
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === "gmailAgentRunner") {
        ScriptApp.deleteTrigger(t);
      }
    });

    // 新トリガーを作成
    ScriptApp.newTrigger("gmailAgentRunner")
      .timeBased()
      .everyMinutes(minutes)
      .create();

    console.log("setSyncIntervalAndRebuildTrigger: new trigger set to " + minutes + " min");
    return { ok: true, interval: minutes, message: "自動同期を " + minutes + " 分ごとに設定しました" };
  } catch(e) {
    console.error("setSyncIntervalAndRebuildTrigger error: " + e.toString());
    return { ok: false, interval: 60, message: "エラー: " + e.message };
  }
}

function callAI(q, s) {
  assertArkApiKeyConfigured_();
  const payload = {
    model: CONFIG.ENDPOINT,
    messages: [
      { role: "system", content: s },
      { role: "user", content: q }
    ],
    response_format: { type: "json_object" }
  };
  const options = {
    method: "post",
    headers: {
      Authorization: "Bearer " + CONFIG.API_KEY,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    return (
      JSON.parse(UrlFetchApp.fetch(CONFIG.API_URL, options).getContentText()).choices?.[0]
        ?.message?.content || null
    );
  } catch (e) {
    return null;
  }
}

/**
 * callAI のテキストモード版（json_object 強制なし）
 * parseBodyToStructured 専用。長い日本語プロンプトでも安定動作。
 */
function callAIText(q, s) {
  assertArkApiKeyConfigured_();
  const payload = { "model": CONFIG.ENDPOINT, "messages": [{ "role": "system", "content": s }, { "role": "user", "content": q }] };
  const options = { "method": "post", "headers": { "Authorization": "Bearer " + CONFIG.API_KEY, "Content-Type": "application/json" }, "payload": JSON.stringify(payload), "muteHttpExceptions": true };
  try {
    const raw = UrlFetchApp.fetch(CONFIG.API_URL, options).getContentText();
    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content || null;
    if (!content) {
      console.error("callAIText: empty content. HTTP response=" + raw.slice(0, 400));
    } else {
      console.log("callAIText OK: response preview=" + content.slice(0, 200));
    }
    return content;
  } catch(e) {
    console.error("callAIText exception: " + e.toString());
    return null;
  }
}

/**
 * ★ 診断用テスト関数 ★
 * GAS エディタで直接実行 → Execution Log でAI応答を確認できる
 * Review_Buffer の最新行を1件取って parseBodyToStructured を実行する
 */
function debugParseLatestBufferRow() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Review_Buffer");
  if (!sheet || sheet.getLastRow() < 2) { console.log("Buffer empty"); return; }

  // 最新行（最後の行）を取得
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(lastRow, 1, 1, 13).getValues()[0];
  const subject = String(data[3] || "");
  const body    = String(data[4] || "");
  const fullText = "件名: " + subject + "\n\n" + body;

  console.log("=== DEBUG: subject=" + subject.slice(0, 80));
  console.log("=== DEBUG: body preview=" + body.slice(0, 200));
  console.log("=== DEBUG: fullText length=" + fullText.length);

  // B2 読み取り確認
  const pc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Prompt_Config");
  const b2 = pc ? String(pc.getRange("B2").getValue() || "").trim() : "";
  console.log("=== DEBUG: B2 prompt length=" + b2.length + " preview=" + b2.slice(0, 100));

  // AI 呼び出し
  const systemMsg = b2 || FALLBACK_PARSE_PROMPT;
  const res = callAIText("以下のメールから構造化データを抽出してください:\n\n" + fullText.slice(0, 9000), systemMsg);
  console.log("=== DEBUG: AI raw response=" + (res ? res.slice(0, 500) : "NULL"));

  // JSON parse
  const parsed = safeJsonParse(res);
  console.log("=== DEBUG: parsed keys=" + (parsed ? Object.keys(parsed).length : 0));
  if (parsed) {
    const nonEmpty = Object.keys(parsed).filter(function(k) { return parsed[k] && String(parsed[k]).trim() !== ""; });
    console.log("=== DEBUG: non-empty fields (" + nonEmpty.length + ")=" + nonEmpty.join(", "));
    console.log("=== DEBUG: 法人名=" + (parsed["法人名"] || parsed["法人名"]));
    console.log("=== DEBUG: 相談内容=" + (parsed["相談内容"] || "").slice(0, 100));
  }
}

function getReviewBufferList() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Review_Buffer");
    if (!sheet || sheet.getLastRow() < 2) return [];
    const data = sheet.getDataRange().getValues();

    // ── JOIN① Case_infor: meetingDecision(AF=col31) + yeeflowSynced(AG=col32) ──
    var caseInfoMap = {}; // { caseId: { meetingDecision, yeeflowSynced } }
    try {
      var ciSheet = ss.getSheetByName("Case_infor");
      if (ciSheet && ciSheet.getLastRow() > 1) {
        ciSheet.getDataRange().getValues().slice(1).forEach(function(r) {
          var cid = String(r[0] || "").trim();
          if (!cid) return;
          var md  = String(r[31] || "").trim(); // AF列 = 会議判定
          var yf  = String(r[32] || "").trim(); // AG列 = Yeeflow同期日時
          caseInfoMap[cid] = {
            meetingDecision: md,
            yeeflowSynced  : !!yf
          };
        });
      }
    } catch(e) { console.warn("Case_infor JOIN error: " + e); }

    // ── JOIN② Case_Todo: openTodoCount 集計 ──
    var todoCountMap = {};
    try {
      var todoSheet = ss.getSheetByName("Case_Todo");
      if (todoSheet && todoSheet.getLastRow() > 1) {
        todoSheet.getDataRange().getValues().slice(1).forEach(function(r) {
          var tid = String(r[1] || "").trim();
          var tst = String(r[6] || "Open").trim();
          if (!tid) return;
          if (!todoCountMap[tid]) todoCountMap[tid] = 0;
          if (tst !== "Done") todoCountMap[tid]++;
        });
      }
    } catch(e) { console.warn("Todo JOIN error: " + e); }

    const list = [];
    for (let i = 1; i < data.length; i++) {
      const rowStatus = String(data[i][10] || "").trim().toUpperCase();
      if (!data[i][0] && !data[i][1] && !data[i][2]) continue;

      let dStr = "Unknown";
      var mailDate = null;
      var syncDate = null;
      try { mailDate = new Date(data[i][0]); if (isNaN(mailDate.getTime())) mailDate = null; } catch(e) { mailDate = null; }
      try { syncDate = new Date(data[i][11]); if (isNaN(syncDate.getTime())) syncDate = null; } catch(e) { syncDate = null; }
      var rawDate = mailDate || syncDate || null;
      try { dStr = rawDate ? Utilities.formatDate(rawDate, CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm") : "Unknown"; } catch(e) { dStr = "Unknown"; }
      var dateRaw    = rawDate ? rawDate.getTime() : 0;
      var dateSource = mailDate ? 'mail' : (syncDate ? 'sync' : 'unknown');
      var rawMailDate = mailDate ? mailDate.getTime() : null;
      var rawSyncDate = syncDate ? syncDate.getTime() : null;

      var parsedFields = null;
      try {
        var pjStr = String(data[i][12] || "").trim();
        if (pjStr) parsedFields = safeJsonParse(pjStr);
      } catch(e) {}

      var corpVal  = String(data[i][2] || "").trim();
      var titleVal = String(data[i][3] || "").trim();
      if (!corpVal  && parsedFields) corpVal  = String(parsedFields["法人名"]  || "").trim();
      if (!titleVal && parsedFields) titleVal = String(parsedFields["相談内容"] || "").trim();
      if (!titleVal) titleVal = String(data[i][3] || "").trim();

      var caseId = String(data[i][1] || "").trim();
      var ciInfo = caseInfoMap[caseId] || {};
      var meetingDecision = ciInfo.meetingDecision || "";
      // meetingDecision を正規化: Go/Hold/Skip
      var mdNorm = "";
      var mdLc = meetingDecision.toLowerCase();
      if (mdLc === "go" || mdLc.indexOf("bid") >= 0) mdNorm = "Go";
      else if (mdLc === "hold" || mdLc.indexOf("hold") >= 0) mdNorm = "Hold";
      else if (mdLc === "skip" || mdLc.indexOf("skip") >= 0 || mdLc.indexOf("reviewed") >= 0) mdNorm = "Skip";

      list.push({
        row: i + 1, date: dStr, dateRaw: dateRaw, dateSource: dateSource,
        rawMailDate: rawMailDate, rawSyncDate: rawSyncDate,
        status: rowStatus || "PENDING",
        id: caseId, corp: corpVal, title: titleVal, body: data[i][4],
        link: data[i][5], aiType: data[i][7], aiAction: data[i][8], aiReason: data[i][9],
        isMapped: (corpVal && corpVal !== "[UNIDENTIFIED]"),
        parsedFields: parsedFields,
        meetingDecision: mdNorm,          // "Go" / "Hold" / "Skip" / ""
        openTodoCount  : todoCountMap[caseId] || 0,
        yeeflowSynced  : ciInfo.yeeflowSynced || false
      });
    }
    return list.reverse();
  } catch (e) { return []; }
}

function runAIPreEvaluation() {
  const buffer  = getSheetSafe("Review_Buffer");
  const data    = buffer.getDataRange().getValues();
  const b3      = getSheetSafe("Prompt_Config").getRange("B3").getValue();
  const b3Ja    = b3 + "\n\n# 言語指示\n必ず日本語で回答してください。英語・中国語は使用禁止です。";
  const ss      = SpreadsheetApp.getActiveSpreadsheet();

  // ── 读取经验知识，注入 Prompt ──
  var knowledgeCtx = "";
  try {
    // Project_Discussion: 所有行（列: Timestamp/CorpName/Category/Decision/Keywords/Experience）
    const pdSheet = ss.getSheetByName("Project_Discussion");
    if (pdSheet && pdSheet.getLastRow() > 1) {
      const pdData = pdSheet.getDataRange().getValues().slice(1);
      const pdLines = pdData
        .filter(function(r) { return r[5] && String(r[5]).trim(); }) // Experience 非空
        .map(function(r) {
          return "[" + (r[2]||"") + "/" + (r[3]||"") + "] " +
                 "Keywords:" + (r[4]||"") + " → " + String(r[5]||"").slice(0, 150);
        });
      if (pdLines.length) {
        knowledgeCtx += "\n\n# 過去のプロジェクト経験（参考）\n" + pdLines.slice(0, 15).join("\n");
      }
    }
    // Feedback_Log: 最近10件の顾问決策（列: Timestamp/CaseID/CorpName/Decision/Category/Note/AIReason）
    const flSheet = ss.getSheetByName("Feedback_Log");
    if (flSheet && flSheet.getLastRow() > 1) {
      const flData = flSheet.getDataRange().getValues().slice(1);
      const recent = flData.reverse().slice(0, 10);
      const flLines = recent
        .filter(function(r) { return r[3]; }) // Decision 非空
        .map(function(r) {
          return "• " + (r[2]||"") + "(" + (r[4]||"") + "): " +
                 (r[3]||"") + " — " + String(r[5]||"").slice(0, 80);
        });
      if (flLines.length) {
        knowledgeCtx += "\n\n# 最近の顧問判断（参考）\n" + flLines.join("\n");
      }
    }
  } catch(eKnow) { console.warn("Knowledge injection failed: " + eKnow); }

  const systemPrompt = b3Ja + knowledgeCtx;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][10]).toUpperCase() === "PENDING" && !data[i][7]) {
      const res = callAI(systemPrompt + "\n\nContent: " + data[i][4] + "\nReturn JSON {type, action, reason}（reasonは日本語で記述）", "Lead Scorer");
      const dec = safeJsonParse(res);
      if (dec) buffer.getRange(i + 1, 8, 1, 3).setValues([[dec.type || "Solution", dec.action || "Skip", dec.reason || "Ok"]]);
    }
  }
}

function checkDuplicate(id) {
  try {
    const d = getSheetSafe("Review_Buffer").getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (d[i][6] === id) return true;
    }
  } catch(e) {}
  return false;
}

/**
 * 批量补充解析 Review_Buffer 中解析不完整的行：
 *   - Corp=[UNIDENTIFIED] 或 CaseID 为空
 *   - 或 ParsedJSON 字段数 < 10（只有正则兜底的少量字段）
 * 每次最多处理 20 行，避免超时。
 */
function reparseBufferUnidentified() {
  const sheet = getSheetSafe("Review_Buffer");
  const data  = sheet.getDataRange().getValues();

  // 一次性读 B2 Prompt 用于整批解析
  var cachedB2 = "";
  try {
    const pc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Prompt_Config");
    if (pc) cachedB2 = String(pc.getRange("B2").getValue() || "").trim();
  } catch(e) {}
  if (!cachedB2) cachedB2 = FALLBACK_PARSE_PROMPT;

  let reparsed = 0;
  let checked  = 0;

  for (let i = 1; i < data.length; i++) {
    const corp      = String(data[i][2] || "").trim();
    const caseId    = String(data[i][1] || "").trim();
    const status    = String(data[i][10] || "").trim();
    const cachedJson = String(data[i][12] || "").trim();

    // 已审核的行不重新解析
    if (status === "AUDITED") continue;

    // 判断是否需要重新解析：Corp未识别 或 CaseID空 或 ParsedJSON有效非空字段 < 5
    const cachedObj  = cachedJson ? (safeJsonParse(cachedJson) || {}) : {};
    const nonEmptyCount = Object.keys(cachedObj).filter(function(k) {
      return cachedObj[k] && String(cachedObj[k]).trim() !== "";
    }).length;
    const needReparse = corp === "[UNIDENTIFIED]" || !caseId || nonEmptyCount < 5;
    if (!needReparse) continue;

    checked++;
    if (checked > 20) break; // 每批最多20条

    const subject = String(data[i][3] || "");
    const body    = String(data[i][4] || "");
    if (!subject && !body) continue;

    const fullText = "件名: " + subject + "\n\n" + body;
    try {
      const parsed = parseBodyToStructured(fullText, cachedB2);
      if (!parsed || Object.keys(parsed).length < 3) continue;

      const newCorp   = (parsed["法人名"] && parsed["法人名"] !== "") ? parsed["法人名"] : corp;
      const newCaseId = parsed["案件ID"] ? String(parsed["案件ID"]).trim() : caseId;

      const rowNum = i + 1;
      if (newCaseId) sheet.getRange(rowNum, 2).setValue(newCaseId);
      if (newCorp && newCorp !== "[UNIDENTIFIED]") sheet.getRange(rowNum, 3).setValue(newCorp);
      sheet.getRange(rowNum, 13).setValue(JSON.stringify(parsed));

      console.log(`reparseBuffer row${rowNum}: corp="${newCorp}" id="${newCaseId}" fields=${Object.keys(parsed).length}`);
      reparsed++;
    } catch(e) {
      console.error("reparseBuffer row" + (i+1) + " failed: " + e);
    }
  }

  SpreadsheetApp.flush();
  return { reparsed: reparsed, checked: checked };
}

/**
 * 返回 Knowledge Tab 所需数据：
 *   - feedbacks: Feedback_Log 最近50条（倒序）
 *   - discussions: Project_Discussion 所有行
 */
function getKnowledgeData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = { feedbacks: [], discussions: [] };
  try {
    const flSheet = ss.getSheetByName("Feedback_Log");
    if (flSheet && flSheet.getLastRow() > 1) {
      const rows = flSheet.getDataRange().getValues().slice(1).reverse().slice(0, 50);
      result.feedbacks = rows.map(function(r) {
        var ts = "";
        try { ts = Utilities.formatDate(new Date(r[0]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm"); } catch(e) {}
        return { ts: ts, caseId: String(r[1]||""), corp: String(r[2]||""),
                 decision: String(r[3]||""), category: String(r[4]||""),
                 note: String(r[5]||""), aiReason: String(r[6]||"") };
      });
    }
  } catch(e) { console.warn("getKnowledgeData feedbacks: " + e); }
  try {
    const pdSheet = ss.getSheetByName("Project_Discussion");
    if (pdSheet && pdSheet.getLastRow() > 1) {
      const rows = pdSheet.getDataRange().getValues().slice(1);
      result.discussions = rows.map(function(r, i) {
        var ts = "";
        try { ts = Utilities.formatDate(new Date(r[0]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd"); } catch(e) {}
        return { rowNum: i + 2, ts: ts, corp: String(r[1]||""), category: String(r[2]||""),
                 decision: String(r[3]||""), keywords: String(r[4]||""), experience: String(r[5]||""),
                 industry: String(r[6]||"") };
      });
    }
  } catch(e) { console.warn("getKnowledgeData discussions: " + e); }
  return result;
}

/**
 * 新增一条项目经验到 Project_Discussion（从第2行开始追加）
 * @param {Object} d - { corp, category, decision, keywords, experience }
 */
function addProjectDiscussion(d) {
  if (!d || !d.experience) return { status: "ERROR", msg: "experience required" };
  const sheet = getSheetSafe("Project_Discussion");
  sheet.appendRow([
    new Date(),
    String(d.corp       || ""),
    String(d.category   || "Solution"),
    String(d.decision   || "Go"),
    String(d.keywords   || ""),
    String(d.experience || ""),
    String(d.industry   || "")   // G列：業界
  ]);
  SpreadsheetApp.flush();
  return { status: "SUCCESS" };
}

/**
 * 删除 Project_Discussion 中指定行（rowNum 为 Sheet 物理行号，从2开始）
 */
function deleteProjectDiscussion(rowNum) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Project_Discussion");
    if (!sheet) return { status: "ERROR", msg: "Sheet not found" };
    if (rowNum < 2 || rowNum > sheet.getLastRow()) return { status: "ERROR", msg: "Invalid row" };
    sheet.deleteRow(rowNum);
    SpreadsheetApp.flush();
    return { status: "SUCCESS" };
  } catch(e) {
    return { status: "ERROR", msg: e.toString() };
  }
}

/**
 * AI Chat — 案件情報をコンテキストとして会話する
 * @param {string} userMsg    - ユーザーの質問
 * @param {Array}  history    - [{role:'user'|'assistant', content:string}] 直近の会話履歴
 * @param {string} caseId     - 絞り込む案件ID（空の場合はCase_infor全件をサマリー化）
 * @returns {string} AI の日本語回答
 */
/**
 * ========================================================
 * AI Chat — 統合ナレッジベース対話エンジン
 * ========================================================
 * scope の種類:
 *   "case:ID"   → Case_infor の特定案件1件（詳細フル）
 *   "all"       → Case_infor 全件サマリー（最新20件）
 *   "buffer"    → Review_Buffer 未処理案件（最新20件）
 *   "knowledge" → Project_Discussion + Feedback_Log（ナレッジベース）
 *   "full"      → 全データソース横断（Case+Buffer+Knowledge）
 * ========================================================
 */
function chatWithCaseAI(userMsg, history, scope) {
  if (!userMsg) return "質問を入力してください。";
  history = history || [];
  scope   = scope || "all";

  var ctx = "";

  // ── ① Case_infor ────────────────────────────────────────
  var needCaseAll    = (scope === "all" || scope === "full");
  var needCaseSingle = scope.startsWith("case:");
  if (needCaseAll || needCaseSingle) {
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Case_infor");
      if (sheet && sheet.getLastRow() > 1) {
        var data = sheet.getDataRange().getValues().slice(1).filter(function(r) { return r[1]; });
        var rows = needCaseSingle
          ? data.filter(function(r) { return String(r[0]).trim() === scope.replace("case:", "").trim(); })
          : data.slice(-20);
        if (rows.length > 0) {
          ctx += "\n\n# 【案件アーカイブ（Case_infor）】\n";
          rows.forEach(function(r) {
            ctx += "▪ [" + (r[0]||"") + "] " + (r[1]||"") +
              " | 分類:" + (r[3]||"") +
              " | 業界:" + (r[5]||"") +
              " | 都道府県:" + (r[11]||"") +
              " | 設立:" + (r[6]||"") +
              " | 資本金:" + (r[7]||"") +
              " | 売上:" + (r[8]||"") +
              " | 社員数:" + (r[10]||"") +
              " | 予算:" + (r[25]||"") +
              " | 納期:" + (r[26]||"") +
              " | AI判定:" + (r[28]||"") + "/" + (r[29]||"") +
              " | Status:" + (r[31]||"") + "\n";
            // 単一案件のときは詳細テキストも付加
            if (needCaseSingle) {
              if (r[13]) ctx += "   法人概要: " + String(r[13]).slice(0, 300) + "\n";
              if (r[14]) ctx += "   相談内容: " + String(r[14]).slice(0, 400) + "\n";
              if (r[15]) ctx += "   相談背景: " + String(r[15]).slice(0, 300) + "\n";
              if (r[16]) ctx += "   現状課題: " + String(r[16]).slice(0, 300) + "\n";
              if (r[22]) ctx += "   核心ニーズ: " + String(r[22]).slice(0, 200) + "\n";
            }
          });
        }
      }
    } catch(e) { console.warn("ctx Case_infor: " + e); }
  }

  // ── ② Review Buffer ─────────────────────────────────────
  if (scope === "buffer" || scope === "full") {
    try {
      var bufSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Review_Buffer");
      if (bufSheet && bufSheet.getLastRow() > 1) {
        var bufData = bufSheet.getDataRange().getValues().slice(1)
          .filter(function(r) { return r[1] && (!r[7] || r[7] === ""); })  // 未処理のみ
          .slice(-20);
        if (bufData.length > 0) {
          ctx += "\n\n# 【レビュー待ち案件（Review_Buffer）】\n";
          bufData.forEach(function(r) {
            ctx += "▪ MsgID:" + (r[0]||"") +
              " | 件名:" + String(r[2]||"").slice(0,60) +
              " | 受信:" + (r[3]||"") +
              " | From:" + (r[4]||"") + "\n";
            if (r[6]) ctx += "   本文抜粋: " + String(r[6]).slice(0, 300) + "\n";
          });
        }
      }
    } catch(e) { console.warn("ctx Review_Buffer: " + e); }
  }

  // ── ③ Project_Discussion（ナレッジ）────────────────────
  if (scope === "knowledge" || scope === "full") {
    try {
      var pdSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Project_Discussion");
      if (pdSheet && pdSheet.getLastRow() > 1) {
        var pdData = pdSheet.getDataRange().getValues().slice(1)
          .filter(function(r) { return r[1]; }).slice(-20);
        if (pdData.length > 0) {
          ctx += "\n\n# 【プロジェクト経験ナレッジ（Project_Discussion）】\n";
          pdData.forEach(function(r) {
            ctx += "▪ [" + (r[0]||"") + "] " + (r[1]||"") +
              " | 業界:" + (r[6]||"") +
              " | キーワード:" + (r[4]||"") + "\n";
            if (r[2]) ctx += "   経験:" + String(r[2]).slice(0, 200) + "\n";
          });
        }
      }
    } catch(e) { console.warn("ctx Project_Discussion: " + e); }

    // ── ④ Feedback_Log（顧問決定履歴）──────────────────
    try {
      var flSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Feedback_Log");
      if (flSheet && flSheet.getLastRow() > 1) {
        var flData = flSheet.getDataRange().getValues().slice(1)
          .filter(function(r) { return r[1]; }).slice(-20);
        if (flData.length > 0) {
          ctx += "\n\n# 【顧問判断履歴（Feedback_Log）】\n";
          flData.forEach(function(r) {
            ctx += "▪ 案件ID:" + (r[0]||"") +
              " | アクション:" + (r[2]||"") +
              " | タイプ:" + (r[3]||"") +
              " | 日時:" + (r[1]||"") + "\n";
            if (r[4]) ctx += "   判断理由: " + String(r[4]).slice(0, 150) + "\n";
          });
        }
      }
    } catch(e) { console.warn("ctx Feedback_Log: " + e); }
  }

  // ── System Prompt 構築 ───────────────────────────────────
  var scopeDesc = {
    "all"      : "Case_infor（案件アーカイブ全件）",
    "buffer"   : "Review_Buffer（レビュー待ち案件）",
    "knowledge": "Project_Discussion + Feedback_Log（ナレッジベース）",
    "full"     : "全データソース（案件アーカイブ・レビュー待ち・ナレッジベース）"
  }[scope] || ("特定案件: " + scope.replace("case:", ""));

  const systemMsg =
    "あなたはReady Crew（ITアウトソーシング仲介）のCRMアシスタントAIです。\n" +
    "参照スコープ: " + scopeDesc + "\n" +
    "以下のデータを根拠に、営業担当者の質問に日本語で的確・実用的に回答してください。\n" +
    "• 回答は必ず日本語で。英語・中国語の使用禁止。\n" +
    "• 数値・固有名詞はデータから引用し、推測は「※推測」と明示すること。\n" +
    "• 質問に関係するデータが複数あれば、比較・傾向分析も行うこと。\n" +
    ctx;

  // ── API 呼び出し ─────────────────────────────────────────
  const messages = [{ "role": "system", "content": systemMsg }];
  history.slice(-8).forEach(function(h) {
    messages.push({ "role": h.role, "content": h.content });
  });
  messages.push({ "role": "user", "content": userMsg });

  assertArkApiKeyConfigured_();
  const payload = { "model": CONFIG.ENDPOINT, "messages": messages };
  const options = {
    "method": "post",
    "headers": { "Authorization": "Bearer " + CONFIG.API_KEY, "Content-Type": "application/json" },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  try {
    const raw     = UrlFetchApp.fetch(CONFIG.API_URL, options).getContentText();
    const parsed  = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content || null;
    if (!content) {
      console.error("chatWithCaseAI empty. raw=" + raw.slice(0, 300));
      return "AI応答が取得できませんでした。しばらく後に再度お試しください。";
    }
    return content;
  } catch(e) {
    console.error("chatWithCaseAI exception: " + e);
    return "エラーが発生しました: " + e.toString();
  }
}

/**
 * Chat 用：スコープ選択肢 + Case_infor 案件リストを一括返却
 */
function getCaseListForChat() {
  var cases = [];
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Case_infor");
    if (sheet && sheet.getLastRow() > 1) {
      cases = sheet.getDataRange().getValues().slice(1)
        .filter(function(r) { return r[1]; })
        .map(function(r) { return { id: String(r[0]||""), name: String(r[1]||""), category: String(r[3]||""), industry: String(r[5]||"") }; })
        .reverse()
        .slice(0, 80);
    }
  } catch(e) { console.warn("getCaseListForChat: " + e); }
  return cases;
}

/**
 * ================================================================
 * スマート削除 — Review_Buffer 行削除 + Spam_Filter 学習
 * ================================================================
 * @param {number} row     - Review_Buffer の行番号（1始まり）
 * @param {string} reason  - 削除理由カテゴリ（"spam"|"irrelevant"|"duplicate"|"wrong_target"|"other"）
 * @param {string} memo    - 自由記述メモ（任意）
 * @returns {{ status, learned }}
 */
function deleteBufferItem(row, reason, memo) {
  try {
    const bufSheet = getSheetSafe("Review_Buffer");
    const lastRow  = bufSheet.getLastRow();
    if (!row || row < 2 || row > lastRow) return { status: "ERROR", msg: "無効な行番号: " + row };

    const rowData = bufSheet.getRange(row, 1, 1, 13).getValues()[0];
    const corp    = String(rowData[2] || "");
    const subject = String(rowData[3] || "");
    const body    = String(rowData[4] || "").slice(0, 500);
    const msgId   = String(rowData[6] || "");

    // ── Spam_Filter シートに学習データを保存 ──────────────────
    var learned = false;
    try {
      const sfSheet = getSheetSafe("Spam_Filter");

      // 送信元ドメイン抽出（件名から "frontier-gr.jp" 等を抽出する簡易実装）
      var domain = "";
      var domainMatch = body.match(/[\w.-]+@([\w.-]+\.[a-z]{2,})/i);
      if (domainMatch) domain = domainMatch[1].toLowerCase();

      // キーワード抽出：件名の【】内や先頭の特徴語
      var keywords = [];
      var kwMatch = subject.match(/【([^】]+)】/g);
      if (kwMatch) keywords = kwMatch.map(function(s) { return s.replace(/[【】]/g, "").trim(); });

      sfSheet.appendRow([
        new Date(),            // A: 学習日時
        reason || "other",     // B: 削除理由
        corp,                  // C: 法人名
        domain,                // D: ドメイン
        subject.slice(0, 100), // E: 件名
        keywords.join(", "),   // F: 抽出キーワード
        memo || "",            // G: メモ
        msgId,                 // H: MsgID（重複防止参照）
        "ACTIVE"               // I: ルール状態
      ]);
      learned = true;
    } catch(eLearn) {
      console.warn("Spam_Filter save failed: " + eLearn);
    }

    // ── Review_Buffer から行を削除 ──────────────────────────
    bufSheet.deleteRow(row);
    SpreadsheetApp.flush();

    return { status: "SUCCESS", learned: learned };
  } catch(e) {
    console.error("deleteBufferItem: " + e);
    return { status: "ERROR", msg: e.toString() };
  }
}

/**
 * Spam_Filter ルール一覧を返す（フロントエンド表示用）
 */
function getSpamFilterRules() {
  try {
    const sfSheet = getSheetSafe("Spam_Filter");
    if (sfSheet.getLastRow() < 2) return [];
    return sfSheet.getDataRange().getValues().slice(1)
      .filter(function(r) { return r[8] === "ACTIVE"; })
      .map(function(r, i) {
        return {
          rowNum   : i + 2,
          date     : r[0] ? Utilities.formatDate(new Date(r[0]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd") : "",
          reason   : r[1] || "",
          corp     : r[2] || "",
          domain   : r[3] || "",
          subject  : r[4] || "",
          keywords : r[5] || "",
          memo     : r[6] || ""
        };
      }).reverse().slice(0, 50);
  } catch(e) { return []; }
}

/**
 * gmailAgentRunner で使う：Spam_Filter と照合して SKIP すべきか判定
 * @param {string} corp    - 法人名
 * @param {string} subject - 件名
 * @param {string} body    - 本文（先頭500文字）
 * @returns {{ skip: boolean, reason: string }}
 */
function checkSpamFilter(corp, subject, body) {
  try {
    const sfSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Spam_Filter");
    if (!sfSheet || sfSheet.getLastRow() < 2) return { skip: false, reason: "" };

    const rules = sfSheet.getDataRange().getValues().slice(1)
      .filter(function(r) { return r[8] === "ACTIVE"; });

    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var rCorp     = String(r[2] || "").trim().toLowerCase();
      var rDomain   = String(r[3] || "").trim().toLowerCase();
      var rSubject  = String(r[4] || "").trim().toLowerCase();
      var rKeywords = String(r[5] || "").split(",").map(function(k) { return k.trim().toLowerCase(); }).filter(Boolean);

      var corpLc    = corp.toLowerCase();
      var subjectLc = subject.toLowerCase();
      var bodyLc    = body.toLowerCase();

      // 法人名完全一致
      if (rCorp && corpLc.indexOf(rCorp) !== -1) {
        return { skip: true, reason: "Spam_Filter: 法人名一致「" + r[2] + "」(" + r[1] + ")" };
      }
      // 送信元ドメイン一致
      if (rDomain && bodyLc.indexOf(rDomain) !== -1) {
        return { skip: true, reason: "Spam_Filter: ドメイン一致「" + r[3] + "」(" + r[1] + ")" };
      }
      // 件名キーワード（登録件名の一部が一致）
      if (rSubject && subjectLc.indexOf(rSubject) !== -1) {
        return { skip: true, reason: "Spam_Filter: 件名一致「" + r[4].slice(0,30) + "...」(" + r[1] + ")" };
      }
      // キーワードリスト（ANDではなくOR）
      for (var j = 0; j < rKeywords.length; j++) {
        if (rKeywords[j] && subjectLc.indexOf(rKeywords[j]) !== -1) {
          return { skip: true, reason: "Spam_Filter: キーワード「" + rKeywords[j] + "」一致(" + r[1] + ")" };
        }
      }
    }
  } catch(e) { console.warn("checkSpamFilter: " + e); }
  return { skip: false, reason: "" };
}

/**
 * 优化版：批量构建已存在 MsgID 的 Set，避免 gmailAgentRunner 中每封邮件都全量读一次
 */
function buildDuplicateSet() {
  // Review_Buffer（PENDING/AUDITED 両方）＋ Case_infor（既登録済み）を対象に重複セットを構築
  const set = {};
  try {
    // ── Review_Buffer: MsgID(col7) + CaseID(col2) + Subject(col4) ──
    const buf = getSheetSafe("Review_Buffer");
    if (buf.getLastRow() > 1) {
      const d = buf.getDataRange().getValues();
      for (let i = 1; i < d.length; i++) {
        // MsgID (index 6)
        const mid = String(d[i][6] || "").trim();
        if (mid) set["msgid:" + mid] = true;
        // CaseID (index 1) - 5桁以上の数値
        const cid = String(d[i][1] || "").trim();
        if (cid && cid.length >= 5 && /^\d+$/.test(cid)) {
          set["caseid:" + cid] = true;
        }
        // Subject (index 3) - 件名の正規化ハッシュ
        const subj = String(d[i][3] || "").trim().replace(/\s+/g, " ").toLowerCase();
        if (subj.length > 10) set["subj:" + subj] = true;
      }
    }
  } catch(e) { console.warn("buildDuplicateSet Buffer error: " + e); }
  try {
    // ── Case_infor: CaseID(index0) ── 既に判断済みの案件も除外
    const main = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Case_infor");
    if (main && main.getLastRow() > 1) {
      const rows = main.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        const cid = String(rows[i][0] || "").trim();
        if (cid && cid.length >= 5 && /^\d+$/.test(cid)) {
          set["caseid:" + cid] = true;
        }
      }
    }
  } catch(e) { console.warn("buildDuplicateSet Case_infor error: " + e); }
  return set;
}

/**
 * Backfill mail send date into Review_Buffer column A (index 0) for rows that are missing it.
 * - dryRun=true: do not write, just return the list of rows that would be changed and the dates
 * - dryRun=false: perform writes (may require Gmail authorization)
 * - limit: maximum number of messages to process in one run (safety)
 * Returns an object: { processed: N, details: [ { row, msgId, mailDate, ok, error } ] }
 */
function backfillMailDate(dryRun, limit) {
  dryRun = !!dryRun;
  limit = parseInt(limit) || 100;
  const sheet = getSheetSafe("Review_Buffer");
  const data = sheet.getDataRange().getValues();
  const details = [];
  let processed = 0;
  for (let i = 1; i < data.length && processed < limit; i++) {
    try {
      const rowNum = i + 1;
      const mailCell = data[i][0];
      const msgId = data[i][6];
      // only consider rows that have MsgID and missing/invalid mailDate
      let hasMail = false;
      try { hasMail = !!mailCell && (new Date(mailCell)).getTime() ? true : false; } catch(e) { hasMail = false; }
      if (!hasMail && msgId) {
        let detail = { row: rowNum, msgId: msgId, mailDate: null, ok: false, error: null };
        try {
          const msg = GmailApp.getMessageById(msgId);
          if (msg) {
            const md = msg.getDate();
            if (md && !isNaN(md.getTime())) {
              detail.mailDate = Utilities.formatDate(md, CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm:ss");
              detail.ok = true;
              if (!dryRun) {
                sheet.getRange(rowNum, 1).setValue(md);
              }
            } else {
              detail.error = 'msg.getDate() invalid';
            }
          } else {
            detail.error = 'message not found';
          }
        } catch(e) {
          detail.error = String(e && e.message ? e.message : e);
        }
        details.push(detail);
        processed++;
      }
    } catch(e) {
      // continue
    }
  }
  if (!dryRun) SpreadsheetApp.flush();
  return { processed: processed, details: details };
}

/**
 * 诊断函数：读出 Review_Buffer 表头 + 所有行的关键字段
 * 在 GAS 编辑器中直接运行此函数，查看 Logger 输出，确认实际列布局。
 */
function diagReviewBuffer() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Review_Buffer");
  if (!sheet) { Logger.log("❌ Review_Buffer sheet not found!"); return; }
  const data = sheet.getDataRange().getValues();
  Logger.log("=== Review_Buffer 共 " + data.length + " 行（含表头）===");
  // 表头
  Logger.log("表头: " + JSON.stringify(data[0]));
  // 所有数据行
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    Logger.log("Row " + (i+1) + " | " +
      "col1(0)=" + String(row[0]).slice(0,20) + " | " +
      "col2(1)=" + String(row[1]).slice(0,20) + " | " +
      "col3(2)=" + String(row[2]).slice(0,20) + " | " +
      "col4(3)=" + String(row[3]).slice(0,30) + " | " +
      "col5(4)body=" + String(row[4]).slice(0,30) + " | " +
      "col11(10)status=" + String(row[10]) + " | " +
      "col12(11)sync=" + String(row[11]).slice(0,20) + " | " +
      "col13(12)json=" + String(row[12]).slice(0,30)
    );
  }
}

// ================================================================
// バージョン管理 & 機能要望 — V9.9.3 追加
// ================================================================

/**
 * バージョン情報＋チェンジログを返す（フロントエンドのバージョンモーダル用）
 */
function getVersionInfo() {
  return {
    version  : "V10.5.1",
    buildDate: "2026-05-16",
    changelog: [
      { version: "V10.5.1", date: "2026-05-16", changes: [
          "API キーをコードから削除し Script Properties（ARK_API_KEY 等）で管理",
          "ローカル config/local.settings.json + scripts/sync-secrets-to-gas.sh で一括同期可能"
      ]},
      { version: "V10.5.0", date: "2026-04-28", changes: [
          "Yeeflow CRM 直接 API シンク機能（syncToYeeflow）",
          "Case_infor AG列に Yeeflow 同期タイムスタンプ自動記録",
          "会議結論 → Case_infor AF列 自動ステータス反映（saveMeetingRecord 強化）",
          "backfillMeetingStatus: 歴史データ補正関数追加（Meeting_Records → AF列）",
          "フロントエンド: Yeeflow 同期パネル・歴史補正パネル追加"
      ]},
      { version: "V10.4.1", date: "2026-04-26", changes: [
          "メール生成に会議結論（Meeting_Records）を統合",
          "会議で決まった方針・次アクションをメール本文に自動反映",
          "🐛 修正: HOLD選択時にSKIPと表示されるバグを修正（非同期Feedback_Log復元によるレースコンディション解消）"
      ]},
      { version: "V10.4.0", date: "2026-04-22", changes: [
          "メール生成フロー強化：原始メール本文・顧問コメントを読み取り統合",
          "原始メール記載済み情報は重複質問しないようAIに指示",
          "顧問の疑問点をメール確認項目に自動反映"
      ]},
      { version: "V10.3.1", date: "2026-04-21", changes: [
          "メールプロンプトを Prompt_Config B11（初回接触）/ B12（二次沟通）で管理",
          "デフォルトプロンプトをテラボックス株式会社・山口担当に変更"
      ]},
      { version: "V10.3.0", date: "2026-04-21", changes: [
          "Case Archive 全文検索バー追加（会社名・業界・ID・相談内容など横断検索）",
          "Archive Todo タブに AI メール助理パネル追加",
          "バージョン表示を全箇所で同期更新"
      ]},
      { version: "V10.2.0", date: "2026-04-20", changes: [
          "案件詳細モーダルの大型化（高齢者対応：幅・フォント・パディング拡大）",
          "最終同期日時を Agent_Logs から直接取得（Sync complete 行のタイムスタンプ）",
          "同期間隔設定 saveSyncInterval() 実装"
      ]},
      { version: "V10.1.0", date: "2026-04-19", changes: [
          "Agent Pipeline バー追加（Inbox→Parse→Gate→Consult→GO）",
          "Archive テーブルに Todo バッジ表示",
          "最終同期日時・同期間隔 UI を Sync Controls パネルに追加",
          "Case Archive 原始メールタブ追加（getOriginalEmailByCaseId）"
      ]},
      { version: "V10.0.0", date: "2026-04-19", changes: [
          "AI 自動メール下書き機能（generateOutreachEmail）",
          "Todo タブ AI パネル HTML/JS 追加",
          "openDetail() グローバル変数セット"
      ]},
      { version: "V9.9.3", date: "2026-04-16", changes: [
          "バージョン管理・チェンジログ表示機能",
          "案件判断に「Hold」ステータス追加（客先確認中）",
          "ユーザー機能要望フォーム追加（スクリーンショット対応）"
      ]},
      { version: "V9.9.2", date: "2026-04-15", changes: [
          "顧問名フィールドをログインユーザーで自動入力",
          "多顧問意見汇総 / 会議結論 / Todo管理",
          "Archive ステータス可視化 ＋ クリックで案件詳細"
      ]},
      { version: "V9.9.1", date: "2026-04-13", changes: [
          "削除→AI学習（Spam_Filter）",
          "詳細ページ高さ可変",
          "バージョン表示"
      ]},
      { version: "V9.9.0", date: "2026-04-11", changes: [
          "AI Chat 統合ナレッジ対話",
          "AI日語出力対応"
      ]}
    ]
  };
}

/**
 * ユーザーからの機能要望を Feature_Request シートに保存する
 * @param {Object} d - { submittedBy, description, screenshotUrl }
 */
function saveFeatureRequest(d) {
  if (!d || !d.description) return { status: "ERROR", msg: "description required" };
  const sheet = getSheetSafe("Feature_Request");
  const reqId = "FR-" + new Date().getTime();
  sheet.appendRow([
    reqId,
    new Date(),
    String(d.submittedBy   || ""),
    String(d.description   || ""),
    String(d.screenshotUrl || ""),
    "New",
    "",
    new Date()
  ]);
  SpreadsheetApp.flush();
  return { status: "OK", requestId: reqId };
}

/**
 * 全ての機能要望を返す（フロントエンドの一覧表示用）
 * @returns {Array<{rowNum,requestId,timestamp,submittedBy,description,screenshotUrl,status,adminNote}>}
 */
function getFeatureRequests() {
  const sheet = getSheetSafe("Feature_Request");
  if (sheet.getLastRow() < 2) return [];
  const rows = sheet.getDataRange().getValues().slice(1);
  return rows.map(function(r, i) {
    var ts = "", updated = "";
    try { ts      = r[1] ? Utilities.formatDate(new Date(r[1]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm") : ""; } catch(e) {}
    try { updated = r[7] ? Utilities.formatDate(new Date(r[7]), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm") : ""; } catch(e) {}
    return {
      rowNum       : i + 2,
      requestId    : String(r[0] || ""),
      timestamp    : ts,
      submittedBy  : String(r[2] || ""),
      description  : String(r[3] || ""),
      screenshotUrl: String(r[4] || ""),
      status       : String(r[5] || "New"),
      adminNote    : String(r[6] || ""),
      updatedAt    : updated
    };
  }).reverse();
}

/**
 * 機能要望のステータス更新（管理者用）
 * @param {number} rowNum    - Feature_Request の行番号（2始まり）
 * @param {string} status    - New / Under Review / Accepted / Rejected / Implemented
 * @param {string} adminNote - 管理者コメント（任意）
 */
function updateFeatureRequestStatus(rowNum, status, adminNote) {
  const sheet = getSheetSafe("Feature_Request");
  if (!rowNum || rowNum < 2) return { status: "ERROR", msg: "Invalid rowNum" };
  sheet.getRange(rowNum, 6).setValue(String(status || "New"));
  if (adminNote !== undefined) sheet.getRange(rowNum, 7).setValue(String(adminNote || ""));
  sheet.getRange(rowNum, 8).setValue(new Date());
  SpreadsheetApp.flush();
  return { status: "OK" };
}

/**
 * Review_Buffer の CaseID 重複行を削除する（最初に出現した行を残し、後続の重複を削除）
 * MsgID（col7）と CaseID（col2）の両方でチェック
 * GAS エディタから手動実行する用途
 */
function deduplicateReviewBuffer() {
  const sheet = getSheetSafe("Review_Buffer");
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) {
    Logger.log("重複チェック対象なし（データ行が2行未満）");
    return;
  }

  const data = sheet.getDataRange().getValues();
  const seenMsgId  = {};
  const seenCaseId = {};
  const seenSubj   = {};
  const rowsToDelete = [];

  for (var i = 1; i < data.length; i++) {
    var rowNum = i + 1;
    var msgId  = String(data[i][6] || "").trim();
    var caseId = String(data[i][1] || "").trim();
    var subj   = String(data[i][3] || "").trim().replace(/\s+/g, " ").toLowerCase();
    var isDup  = false;

    if (msgId && seenMsgId[msgId]) {
      Logger.log("重複(MsgID) row=" + rowNum + " msgId=" + msgId);
      isDup = true;
    } else if (caseId && caseId.length >= 5 && /^\d+$/.test(caseId) && seenCaseId[caseId]) {
      Logger.log("重複(CaseID) row=" + rowNum + " caseId=" + caseId);
      isDup = true;
    } else if (subj && subj.length > 10 && seenSubj[subj]) {
      Logger.log("重複(Subject) row=" + rowNum + " subj=" + subj.slice(0, 40));
      isDup = true;
    }

    if (isDup) {
      rowsToDelete.push(rowNum);
    } else {
      if (msgId)  seenMsgId[msgId]  = true;
      if (caseId && caseId.length >= 5 && /^\d+$/.test(caseId)) seenCaseId[caseId] = true;
      if (subj && subj.length > 10) seenSubj[subj] = true;
    }
  }

  if (rowsToDelete.length === 0) {
    Logger.log("重複行なし。削除対象: 0件");
    return;
  }

  rowsToDelete.reverse().forEach(function(r) {
    sheet.deleteRow(r);
    Logger.log("削除: row=" + r);
  });

  SpreadsheetApp.flush();
  Logger.log("✅ Review_Buffer 重複削除完了。削除件数: " + rowsToDelete.length);
}

/**
 * Case_infor の CaseID 重複行を削除する（先勝ち）
 * GAS エディタから手動実行
 */
function deduplicateCaseInfor() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Case_infor");
  if (!sheet || sheet.getLastRow() < 3) {
    Logger.log("Case_infor: 重複チェック対象なし");
    return;
  }

  const data = sheet.getDataRange().getValues();
  const seenId   = {};
  const seenCorp = {};
  const rowsToDelete = [];

  for (var i = 1; i < data.length; i++) {
    var rowNum = i + 1;
    var cid    = String(data[i][0] || "").trim();
    var corp   = String(data[i][1] || "").trim();
    var isDup  = false;

    if (cid && cid.length >= 5 && /^\d+$/.test(cid) && seenId[cid]) {
      Logger.log("重複(CaseID) row=" + rowNum + " id=" + cid);
      isDup = true;
    } else if (corp && corp !== "[UNIDENTIFIED]" && seenCorp[corp]) {
      Logger.log("重複(Corp) row=" + rowNum + " corp=" + corp);
      isDup = true;
    }

    if (isDup) {
      rowsToDelete.push(rowNum);
    } else {
      if (cid && cid.length >= 5 && /^\d+$/.test(cid)) seenId[cid] = true;
      if (corp && corp !== "[UNIDENTIFIED]") seenCorp[corp] = true;
    }
  }

  if (rowsToDelete.length === 0) {
    Logger.log("Case_infor: 重複行なし");
    return;
  }

  rowsToDelete.reverse().forEach(function(r) {
    sheet.deleteRow(r);
    Logger.log("削除: row=" + r);
  });

  SpreadsheetApp.flush();
  Logger.log("✅ Case_infor 重複削除完了。削除件数: " + rowsToDelete.length);
}

/**
 * 重複データをスキャンして一覧を返す（削除はしない）
 * フロントエンドの重複チェックパネル用
 */
function getDuplicateReport() {
  var result = { buffer: [], caseInfor: [] };

  // ── Review_Buffer スキャン ──
  try {
    var buf = getSheetSafe("Review_Buffer");
    if (buf.getLastRow() > 1) {
      var bData = buf.getDataRange().getValues();
      var bSeenMsgId  = {}, bSeenCaseId = {}, bSeenSubj = {};
      for (var i = 1; i < bData.length; i++) {
        var msgId  = String(bData[i][6] || "").trim();
        var caseId = String(bData[i][1] || "").trim();
        var corp   = String(bData[i][2] || "").trim();
        var subj   = String(bData[i][3] || "").trim().replace(/\s+/g, " ").toLowerCase();
        var dateStr = "";
        try { dateStr = bData[i][0] ? Utilities.formatDate(new Date(bData[i][0]), "Asia/Tokyo", "MM/dd HH:mm") : ""; } catch(e) {}
        var dupReason = null;

        if (msgId && bSeenMsgId[msgId])                                    dupReason = "MsgID重複";
        else if (caseId && caseId.length >= 5 && /^\d+$/.test(caseId) && bSeenCaseId[caseId]) dupReason = "CaseID重複: " + caseId;
        else if (subj && subj.length > 10 && bSeenSubj[subj])             dupReason = "件名重複";

        if (dupReason) {
          result.buffer.push({ row: i + 1, date: dateStr, caseId: caseId, corp: corp,
                               subj: String(bData[i][3] || "").slice(0, 50),
                               reason: dupReason, status: String(bData[i][10] || "") });
        } else {
          if (msgId)  bSeenMsgId[msgId]  = true;
          if (caseId && caseId.length >= 5 && /^\d+$/.test(caseId)) bSeenCaseId[caseId] = true;
          if (subj && subj.length > 10) bSeenSubj[subj] = true;
        }
      }
    }
  } catch(e) { console.error("DupReport Buffer: " + e); }

  // ── Case_infor スキャン ──
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var main = ss.getSheetByName("Case_infor");
    if (main && main.getLastRow() > 1) {
      var cData = main.getDataRange().getValues();
      var cSeenId = {}, cSeenCorp = {};
      for (var j = 1; j < cData.length; j++) {
        var cid    = String(cData[j][0] || "").trim();
        var cCorp  = String(cData[j][1] || "").trim();
        var status = String(cData[j][31] || cData[j][3] || "").trim();
        var dateStr2 = "";
        try { dateStr2 = cData[j][2] ? Utilities.formatDate(new Date(cData[j][2]), "Asia/Tokyo", "MM/dd") : ""; } catch(e) {}
        var dupReason2 = null;

        if (cid && cid.length >= 5 && /^\d+$/.test(cid) && cSeenId[cid])       dupReason2 = "CaseID重複: " + cid;
        else if (cCorp && cCorp !== "[UNIDENTIFIED]" && cSeenCorp[cCorp])        dupReason2 = "法人名重複: " + cCorp;

        if (dupReason2) {
          result.caseInfor.push({ row: j + 1, date: dateStr2, caseId: cid,
                                  corp: cCorp, status: status, reason: dupReason2 });
        } else {
          if (cid && cid.length >= 5 && /^\d+$/.test(cid)) cSeenId[cid] = true;
          if (cCorp && cCorp !== "[UNIDENTIFIED]") cSeenCorp[cCorp] = true;
        }
      }
    }
  } catch(e) { console.error("DupReport CaseInfor: " + e); }

  return result;
}

/**
 * 重複行を一括削除する（フロントエンドからの呼び出し用）
 * target: "buffer" | "caseInfor" | "both"
 */
function deleteDuplicates(target) {
  if (target === "buffer" || target === "both") deduplicateReviewBuffer();
  if (target === "caseInfor" || target === "both") deduplicateCaseInfor();
  return { status: "OK" };
}

// ============================================================
// ===== Yeeflow CRM 同期 =====
// ============================================================

/**
 * Case_infor の未同期行を Yeeflow CRM へ Upsert する
 *
 * Script Properties に以下を設定してください（コードに書かない）:
 *   YEEFLOW_API_KEY  — Yeeflow の API Key
 *   YEEFLOW_APP_ID   — 41
 *   YEEFLOW_LIST_ID  — 2049413947693350913
 *
 * Case_infor AG列（index 32, 1-based col 33）= YeeflowSyncedAt
 *   空 → 未同期 / 値あり → 同期済み（タイムスタンプ）
 *
 * @returns {{ success:number, updated:number, failed:number, skipped:number, errors:string[] }}
 */
function syncToYeeflow() {
  var props   = PropertiesService.getScriptProperties();
  var apiKey  = props.getProperty("YEEFLOW_API_KEY")  || "";
  var appId   = props.getProperty("YEEFLOW_APP_ID")   || "41";
  var listId  = props.getProperty("YEEFLOW_LIST_ID")  || "";

  if (!apiKey) throw new Error("Script Property 'YEEFLOW_API_KEY' が設定されていません");
  if (!listId) throw new Error("Script Property 'YEEFLOW_LIST_ID' が設定されていません");

  var BASE    = "https://api.yeeflow.com/v1";
  var ITEMS   = BASE + "/lists/" + appId + "/" + listId + "/items";
  var QUERY   = ITEMS + "/query";
  var HEADERS = { "apiKey": apiKey, "Content-Type": "application/json" };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Case_infor");
  if (!sheet) throw new Error("Case_infor シートが見つかりません");

  var rows    = sheet.getDataRange().getValues();
  var result  = { success: 0, updated: 0, failed: 0, skipped: 0, errors: [] };
  var TZ      = CONFIG.DEFAULT_TZ;

  // AG列 = index 32 (0-based), col 33 (1-based)
  var SYNCED_COL = 33;

  for (var i = 1; i < rows.length; i++) {
    var row    = rows[i];
    var caseId = String(row[0] || "").trim();
    var corp   = String(row[1] || "").trim();

    // 法人名も案件IDも空はスキップ
    if (!corp && !caseId) { result.skipped++; continue; }

    // AG列に値があれば同期済みとしてスキップ
    var syncedAt = String(row[32] || "").trim();
    if (syncedAt) { result.skipped++; continue; }

    // 社員数：数値に変換（空なら空文字）
    var empRaw  = String(row[10] || "").replace(/[^0-9]/g, "");
    var empNum  = empRaw ? empRaw : "";

    // Yeeflow へ送るデータを構築
    var data = {
      "Title"    : corp,
      "Text3"    : String(row[5]  || ""),   // 業界
      "Text4"    : String(row[3]  || ""),   // 種別 (SES/Solution/ロボット)
      "Text6"    : String(row[4]  || ""),   // URL
      "Text7"    : caseId,                   // 案件ID
      "Text8"    : String(row[14] || ""),   // 相談内容（説明）
      "Text11"   : String(row[11] || ""),   // 都道府県
      "Text22"   : String(row[31] || "")    // 処理Status（リードソース）
    };
    if (empNum) data["Decimal1"] = empNum;  // 従業員数（数字型）

    try {
      // ① Yeeflow に同じ案件IDが存在するか検索
      var existingId = _yeeflowFindItem(QUERY, HEADERS, caseId, corp);

      var res;
      if (existingId) {
        // ② 既存レコードを PATCH 更新
        res = UrlFetchApp.fetch(ITEMS + "/" + existingId, {
          method      : "PATCH",
          headers     : HEADERS,
          payload     : JSON.stringify({ RowVersion: 0, Data: data }),
          muteHttpExceptions: true
        });
      } else {
        // ③ 新規作成
        res = UrlFetchApp.fetch(ITEMS, {
          method      : "POST",
          headers     : HEADERS,
          payload     : JSON.stringify({ Data: data }),
          muteHttpExceptions: true
        });
      }

      var body   = JSON.parse(res.getContentText());
      var status = res.getResponseCode();

      if (status === 200 && body.Status === 0) {
        // 成功 → AG列にタイムスタンプを書き込む
        var ts = Utilities.formatDate(new Date(), TZ, "yyyy/MM/dd HH:mm");
        sheet.getRange(i + 1, SYNCED_COL).setValue(ts);
        if (existingId) { result.updated++; } else { result.success++; }
      } else {
        var errMsg = "Row" + (i+1) + " [" + corp + "] HTTP:" + status + " Msg:" + (body.Message || "");
        result.errors.push(errMsg);
        result.failed++;
        console.error("Yeeflow sync error: " + errMsg);
      }
    } catch(e) {
      var errMsg = "Row" + (i+1) + " [" + corp + "] Exception: " + e.toString();
      result.errors.push(errMsg);
      result.failed++;
      console.error(errMsg);
    }

    // レート制限対策：10件/秒まで → 110ms ずつ待つ
    Utilities.sleep(110);
  }

  SpreadsheetApp.flush();
  console.log("Yeeflow sync done: " + JSON.stringify(result));
  return result;
}

/**
 * Yeeflow で Text7(案件ID) または Title(法人名) が一致するアイテムIDを返す
 * 見つからなければ null を返す
 */
function _yeeflowFindItem(queryUrl, headers, caseId, corp) {
  var filters = [];

  // 案件IDが有効な場合は案件IDで検索
  if (caseId && caseId !== "NEW" && caseId !== "") {
    filters.push({ Field: "Text7", Type: 1, Value: caseId });  // Type 1 = equals
  } else if (corp) {
    filters.push({ Field: "Title", Type: 1, Value: corp });
  } else {
    return null;
  }

  try {
    var res = UrlFetchApp.fetch(queryUrl, {
      method     : "POST",
      headers    : headers,
      payload    : JSON.stringify({
        Fields   : ["ListDataID", "Title", "Text7"],
        Filters  : filters,
        PageIndex: 0,
        PageSize : 5
      }),
      muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText());
    if (body.Status === 0 && body.Data && body.Data.length > 0) {
      return body.Data[0]["ListDataID"] || body.Data[0]["ID"] || null;
    }
  } catch(e) {
    console.warn("_yeeflowFindItem error: " + e.toString());
  }
  return null;
}

/**
 * 指定行の YeeflowSyncedAt（AG列）をリセットして再同期可能にする
 * @param {number} rowNum - 1-based 行番号（ヘッダー含む）
 */
function resetYeeflowSyncFlag(rowNum) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Case_infor");
  if (!sheet) throw new Error("Case_infor シートが見つかりません");
  sheet.getRange(rowNum, 33).setValue("");
  SpreadsheetApp.flush();
  return { status: "OK" };
}

// ============================================================
// Project Timeline Management
// ============================================================

/**
 * Project_Timeline シートの構造:
 * A: EventID (自動生成)
 * B: CaseID
 * C: EventType (Meeting/Proposal/QA/Reference/Milestone)
 * D: EventDate (yyyy/MM/dd HH:mm)
 * E: Title
 * F: Description
 * G: Attachments (JSON array or comma-separated URLs)
 * H: Status (Planned/Completed/Cancelled)
 * I: CreatedBy
 * J: CreatedAt
 */

/**
 * 指定案件のタイムラインイベントを取得
 * @param {string} caseId - 案件ID
 * @return {Array} イベント配列
 */
function getProjectTimeline(caseId) {
  var sheet = getSheetSafe("Project_Timeline");
  var rows = sheet.getDataRange().getValues();
  var events = [];

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1]) === String(caseId)) {
      events.push({
        eventId: rows[i][0],
        caseId: rows[i][1],
        eventType: rows[i][2],
        eventDate: rows[i][3],
        title: rows[i][4],
        description: rows[i][5],
        attachments: rows[i][6],
        status: rows[i][7],
        createdBy: rows[i][8],
        createdAt: rows[i][9]
      });
    }
  }

  // 日付順にソート（新しい順）
  events.sort(function(a, b) {
    var dateA = new Date(a.eventDate);
    var dateB = new Date(b.eventDate);
    return dateB - dateA;
  });

  return events;
}

/**
 * 全案件のタイムラインイベントを取得（日程表用）
 * @param {Array} caseIds - 案件IDの配列（省略時は全件）
 * @return {Array} イベント配列
 */
function getAllProjectTimelines(caseIds) {
  var sheet = getSheetSafe("Project_Timeline");
  var rows = sheet.getDataRange().getValues();
  var events = [];

  for (var i = 1; i < rows.length; i++) {
    var caseId = String(rows[i][1]);

    // caseIds が指定されている場合はフィルタ
    if (caseIds && caseIds.length > 0) {
      if (caseIds.indexOf(caseId) === -1) continue;
    }

    events.push({
      eventId: rows[i][0],
      caseId: rows[i][1],
      eventType: rows[i][2],
      eventDate: rows[i][3],
      title: rows[i][4],
      description: rows[i][5],
      attachments: rows[i][6],
      status: rows[i][7],
      createdBy: rows[i][8],
      createdAt: rows[i][9]
    });
  }

  // 日付順にソート
  events.sort(function(a, b) {
    var dateA = new Date(a.eventDate);
    var dateB = new Date(b.eventDate);
    return dateA - dateB;
  });

  return events;
}

/**
 * タイムラインイベントを追加
 * @param {Object} data - イベントデータ
 * @return {Object} 結果
 */
function addTimelineEvent(data) {
  var sheet = getSheetSafe("Project_Timeline");
  var eventId = "EVT-" + Utilities.getUuid().substring(0, 8).toUpperCase();
  var now = Utilities.formatDate(new Date(), CONFIG.DEFAULT_TZ, "yyyy/MM/dd HH:mm:ss");

  sheet.appendRow([
    eventId,
    data.caseId || "",
    data.eventType || "Milestone",
    data.eventDate || now,
    data.title || "",
    data.description || "",
    data.attachments || "",
    data.status || "Planned",
    data.createdBy || "System",
    now
  ]);

  SpreadsheetApp.flush();
  return { status: "OK", eventId: eventId };
}

/**
 * タイムラインイベントを更新
 * @param {string} eventId - イベントID
 * @param {Object} data - 更新データ
 * @return {Object} 結果
 */
function updateTimelineEvent(eventId, data) {
  var sheet = getSheetSafe("Project_Timeline");
  var rows = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(eventId)) {
      if (data.eventType !== undefined) sheet.getRange(i + 1, 3).setValue(data.eventType);
      if (data.eventDate !== undefined) sheet.getRange(i + 1, 4).setValue(data.eventDate);
      if (data.title !== undefined) sheet.getRange(i + 1, 5).setValue(data.title);
      if (data.description !== undefined) sheet.getRange(i + 1, 6).setValue(data.description);
      if (data.attachments !== undefined) sheet.getRange(i + 1, 7).setValue(data.attachments);
      if (data.status !== undefined) sheet.getRange(i + 1, 8).setValue(data.status);

      SpreadsheetApp.flush();
      return { status: "OK" };
    }
  }

  return { status: "ERROR", message: "Event not found" };
}

/**
 * タイムラインイベントを削除
 * @param {string} eventId - イベントID
 * @return {Object} 結果
 */
function deleteTimelineEvent(eventId) {
  var sheet = getSheetSafe("Project_Timeline");
  var rows = sheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(eventId)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { status: "OK" };
    }
  }

  return { status: "ERROR", message: "Event not found" };
}

/**
 * 清除运行时配置缓存（当 Script Properties 更新后调用）
 */
function clearConfigCache() {
  invalidateRuntimeConfigCache_();
  Logger.log("Config cache cleared");

  // 重新加载并显示当前配置
  var config = getRuntimeConfig_();
  Logger.log("Current config:");
  Logger.log("- API_KEY: " + (config.API_KEY ? config.API_KEY.substring(0, 10) + "..." : "NULL"));
  Logger.log("- ENDPOINT: " + config.ENDPOINT);
  Logger.log("- API_URL: " + config.API_URL);

  return {
    success: true,
    hasApiKey: !!config.API_KEY,
    endpoint: config.ENDPOINT
  };
}

/**
 * 测试函数：检查 API 密钥配置
 */
function testApiKeyConfig() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty("ARK_API_KEY");

  Logger.log("=== API Key Config Test ===");
  Logger.log("ARK_API_KEY exists: " + (apiKey ? "YES" : "NO"));
  Logger.log("ARK_API_KEY length: " + (apiKey ? apiKey.length : 0));
  Logger.log("ARK_API_KEY preview: " + (apiKey ? apiKey.substring(0, 10) + "..." : "NULL"));

  // 测试所有配置
  var config = loadRuntimeConfig_();
  Logger.log("API_KEY: " + (config.API_KEY ? config.API_KEY.substring(0, 10) + "..." : "NULL"));
  Logger.log("ENDPOINT: " + config.ENDPOINT);
  Logger.log("API_URL: " + config.API_URL);

  return {
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey ? apiKey.length : 0,
    endpoint: config.ENDPOINT,
    apiUrl: config.API_URL
  };
}

/**
 * 测试函数：返回简单数据验证 Web App 调用
 */
function testTrackerConnection() {
  return [
    { caseId: "TEST001", corp: "Test Company 1", status: "HOLD" },
    { caseId: "TEST002", corp: "Test Company 2", status: "BID SENT" }
  ];
}

/**
 * HOLD/GO 状態の案件一覧を取得（Project Tracker 用）
 * getDashboardData と同じロジックを使用して確実に動作させる
 * @return {Array} 案件配列
 */
/**
 * 诊断函数：检查 Web App 调用环境
 */
function diagnoseWebAppCall() {
  var result = {
    timestamp: new Date().toISOString(),
    user: Session.getActiveUser().getEmail(),
    effectiveUser: Session.getEffectiveUser().getEmail(),
    hasSpreadsheetAccess: false,
    spreadsheetName: null,
    hasCaseInforSheet: false,
    caseInforRows: 0,
    error: null
  };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    result.hasSpreadsheetAccess = !!ss;
    result.spreadsheetName = ss ? ss.getName() : null;

    if (ss) {
      var sheet = ss.getSheetByName("Case_infor");
      result.hasCaseInforSheet = !!sheet;
      result.caseInforRows = sheet ? sheet.getLastRow() : 0;
    }
  } catch (e) {
    result.error = e.toString();
  }

  Logger.log("Diagnosis result: " + JSON.stringify(result));
  return result;
}

function getTrackedProjects() {
  Logger.log("[getTrackedProjects] START - Web App call");

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      Logger.log("[getTrackedProjects] ERROR: No active spreadsheet");
      return [];
    }
    Logger.log("[getTrackedProjects] Got spreadsheet: " + ss.getName());

    var sheet = ss.getSheetByName("Case_infor");
    if (!sheet) {
      Logger.log("[getTrackedProjects] ERROR: Case_infor sheet not found");
      return [];
    }
    Logger.log("[getTrackedProjects] Got sheet, last row: " + sheet.getLastRow());

    if (sheet.getLastRow() < 2) {
      Logger.log("[getTrackedProjects] No data rows");
      return [];
    }

    var rows = sheet.getDataRange().getValues();
    Logger.log("[getTrackedProjects] Total rows: " + rows.length);

    var projects = [];

    // Dashboard と同じフィルタリングロジック
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      // 空行をスキップ
      if (!r[1] || String(r[1]).trim() === "") continue;

      // Status を取得（Dashboard と同じロジック）
      var status = String(r[31] || r[3] || "New").trim();
      if (!status || status === "") status = "New";

      var statusLower = status.toLowerCase();

      // HOLD または BID SENT のみ
      if (statusLower.indexOf("hold") >= 0 || statusLower.indexOf("bid") >= 0 || statusLower === "go") {
        // 日期对象转换为字符串，避免序列化问题
        var dateStr = "";
        try {
          if (r[2]) {
            dateStr = Utilities.formatDate(new Date(r[2]), "GMT+9", "yyyy-MM-dd");
          }
        } catch (e) {
          dateStr = String(r[2] || "");
        }

        projects.push({
          rowNum: i + 1,
          caseId: String(r[0] || ""),
          corp: String(r[1] || ""),
          date: dateStr,
          category: String(r[3] || ""),
          industry: String(r[5] || ""),
          consultContent: String(r[14] || "").substring(0, 200), // 限制长度
          status: status,
          aiType: String(r[28] || ""),
          aiAction: String(r[29] || "")
        });
      }
    }

    Logger.log("[getTrackedProjects] Found: " + projects.length + " projects");
    Logger.log("[getTrackedProjects] Sample project: " + JSON.stringify(projects[0] || {}));
    Logger.log("[getTrackedProjects] Returning projects array");
    return projects;

  } catch (e) {
    Logger.log("[getTrackedProjects] EXCEPTION: " + e.toString());
    Logger.log("[getTrackedProjects] Stack: " + e.stack);
    console.error("[getTrackedProjects] Error details:", e);
    return [];
  }
}

