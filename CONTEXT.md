# Ready Crew CRM — 開発コンテキスト (2026-05-24 更新 / V10.5.1)

## ■ プロジェクト基本情報

| 項目 | 値 |
|---|---|
| システム名 | Ready Crew CRM |
| 現バージョン | V10.5.1（フロント＋バックエンド） |
| AI エンジン | DeepSeek-V3-2（Volces Ark API） |
| 認証アカウント | sulei@terabox.jp |
| GAS Script ID | `1NlFunDOzIMiSSPqp1OObbFyd9YXVNRldFVTOnFD2f1oycBnlXc_ySMep` |
| 固定デプロイ ID | `AKfycbwH0WFyPu-gdLyLDRkB4sqw0TtnhS35aebzpoNNFevz2RMoDpfF_qwxGv065OkWxCvq` |
| 最終デプロイ | V10.5.1（2026-05-16 — API キー Script Properties 移行） |
| プロジェクトDir | `/Users/raysu/Documents/Terabox/VScode/AIProject-DM-platform/projects/LMS` |

### デプロイコマンド（毎回共通）
```bash
cd /Users/raysu/Documents/Terabox/VScode/AIProject-DM-platform/projects/LMS
cp src/index.html frontend.txt
clasp push --force
clasp deploy --deploymentId "AKfycbwH0WFyPu-gdLyLDRkB4sqw0TtnhS35aebzpoNNFevz2RMoDPfF_qwxGv065OkWxCvq" --description "VX.X.X @NNN: 変更内容"
```

---

## ■ ファイル構成

```
src/
  コード.gs    ← GAS バックエンド（2216行）
  index.html   ← フロントエンド（2623行） ＝ frontend.txt と常に同期
  appsscript.json
```

---

## ■ スプレッドシート構造

### Case_infor（案件マスタ）
| 列 | インデックス(0-based) | 内容 |
|---|---|---|
| A | 0 | 案件ID |
| B | 1 | 法人名 |
| C | 2 | 録入日時 |
| D | 3 | 所属部門/分類 (SES/Solution/ロボット) |
| E-H | 4-7 | URL, 業界, 設立, 資本金 |
| I-M | 8-12 | 売上高, 決算月, 社員数, 都道府県, 最寄駅 |
| N-Q | 13-16 | 法人概要, 相談内容, 相談背景, 現状課題 |
| R-T | 17-19 | RFP資料, 連絡窓口, AI话题方向 |
| U-AB | 20-27 | 構築方法, 目的, 核心需求, 拡張需求, 依頼範囲, 予算感, 期望交期, 決策流 |
| AC-AE | 28-30 | AI_Type, AI_Action, AI_Reason |
| AF | 31 | 処理Status (BID SENT / ON HOLD / SKIP / New) |

### Review_Buffer（受信メール一時保管）
| インデックス | 内容 |
|---|---|
| 0 | MailDate |
| 1 | CaseID |
| 2 | Corp（法人名） |
| 3 | Subject（件名） |
| 4 | Body（本文） |
| 5 | GmailLink |
| 6 | MsgID |
| 7 | AI_Type |
| 8 | AI_Action |
| 9 | AI_Reason |
| 10 | Status |
| 11 | SyncTime |

### その他シート
- `Agent_Logs` — 同期ログ（日時/件名/AI判定）
- `Prompt_Config` — B2セル: AI解析システムプロンプト（コードのFALLBACK_PARSE_PROMPT がフォールバック）
- `Decisions` — submitConsultantDecision が追記する顧問判断ログ

---

## ■ バックエンド主要関数（コード.gs）

```javascript
// ── 設定 ──
// Script Properties で ARK_* / YEEFLOW_* / ALLOWED_DOMAIN 等を管理。CONFIG はゲッターで参照（コード内にキーを書かない）
// ローカル設定: config/local.settings.json → scripts/sync-secrets-to-gas.sh（clasp run）
FALLBACK_PARSE_PROMPT  // AI解析用 System Prompt（Prompt_Config B2 が優先）

// ── シート管理 ──
getSheetSafe(name)     // シートがなければヘッダー付きで自動作成

// ── バージョン情報 ──
getVersionInfo()       // { version, buildDate, changelog[] } → フロントのチェンジログモーダル用

// ── Dashboard ──
getDashboardData()     // Case_infor + Agent_Logs → { projects[], logs[] }（yeeflowSynced も含む）
getStatisticsData()    // 分類/業界/AI话题 の集計 → { byCategory, byIndustry, byAITopic, total }

// ── 案件保存 ──
saveOrUpdateLead(data, status)
  // ① CaseID で既存行検索（rows[1]〜 ヘッダースキップ）
  // ② 法人名で既存行検索
  // ③ 両方ヒットしない場合のみ appendRow
  // ※ 明示的に Case_infor シートを指定（getSheets()[0] は使わない）

// ── AI解析 ──
parseBodyToStructured(rawBody, cachedSystemMsg)
  // 正規表現兜底（案件ID/法人名） + AI解析 + キー名マッピング
callAIText(userMsg, systemMsg)  // DeepSeek API 呼び出し
safeJsonParse(str)              // markdown コードブロック除去 → JSON.parse

// ── 顧問判断 ──
submitConsultantDecision(d)
  // d = { rowNum, action, type, reason, consultantName, parsedJson }
  // Review_Buffer[rowNum] の ParsedJSON を読む → なければ AI再解析
  // → saveOrUpdateLead → Buffer 行を AUDITED にマーク → Decisions に追記

// ── Gmail 同期 ──
gmailAgentRunner(options)
  // 重複チェック3段階: MsgID → CaseID → Subject
  // 取得上限 100件
  // buildDuplicateSet(): Review_Buffer + Case_infor 両方参照

// ── 手動再解析 ──
reparseBufferUnidentified()    // Buffer の未解析行を一括再解析
testParseLatestBuffer()        // Buffer 最新行を1件テスト解析

// ── 重複管理 ──
deduplicateReviewBuffer()      // MsgID + CaseID + Subject 3段階で重複削除
deduplicateCaseInfor()         // CaseID + 法人名 2段階で重複削除
getDuplicateReport()           // 削除なしスキャン → フロントエンド表示用
deleteDuplicates(target)       // "buffer"|"caseInfor"|"both"

// ── Todo / Meeting / Knowledge ──
getTodos(caseId) / addTodo(caseId, todo) / updateTodoStatus(caseId, todoIdx, done)
getMeetingConclusion(caseId) / saveMeetingConclusion(caseId, data)
saveMeetingRecord(caseId, data)  // 会議結論保存 + Case_infor AF列 自動ステータス反映（V10.5.0〜）
getProjectDiscussions() / addProjectDiscussion(data) / deleteProjectDiscussion(rowNum)

// ── AI メール生成 ──
generateOutreachEmail(caseId, action, templateType)
  // action: 'Go'|'Hold' / templateType: 'initial_contact'|'hold_check'
  // Case_infor + Meeting_Records + 原始メール本文を統合して AI 生成（V10.4.0〜）
  // Prompt_Config B11（初回）/ B12（二次確認）で管理（V10.3.1〜）
getOriginalEmailByCaseId(caseId)  // Archive 詳細「原始メール」タブ用（V10.1.0〜）

// ── Yeeflow CRM 連携（V10.5.0〜）──
syncToYeeflow()                   // 未同期案件を Yeeflow CRM へ一括 POST
_yeeflowFindItem(caseId)          // Yeeflow 既存レコード検索
resetYeeflowSyncFlag(caseId)      // 同期フラグリセット（再同期用）
// Case_infor AG列（col33）に 同期タイムスタンプ自動記録

// ── 会議ステータス補正（V10.5.0〜）──
backfillMeetingStatus()           // Meeting_Records → Case_infor AF列 历史データ補正

// ── メール送信時刻バックフィル（V9.9.1〜）──
getReviewBufferList()             // dateSource(MAIL/SYNC/UNKNOWN)・dateRaw を付加して返す
backfillMailDate(dryRun, limit)   // dry-run または書き戻し
runBackfillDryRun_writeToSheet(limit)  // dry-run 結果を Backfill_Debug シートへ書き出し
backfillMailDateExecute(limit, batchSize, retries)  // 分批書き戻し（Backfill_Backup / Backfill_Log 付き）

// ── 機能要望（V9.9.3〜）──
saveFeatureRequest(d)             // Feature_Request シートに保存（スクリーンショット対応）
```

---

## ■ フロントエンド主要JS関数（index.html）

```javascript
// ── ナビゲーション ──
showTab(name)          // 'dashboard'|'review'|'manual'|'knowledge'

// ── バージョン表示 ──
openChangelogModal()   // チェンジログモーダルを開く（ヘッダーボタン）

// ── Dashboard ──
refreshDashboard()     // withFailureHandler: ステータスバー + テーブルにエラーメッセージ表示
filterArchive(type)    // 'go'|'hold'|'skip'|null → stat カードハイライト + テーブル再描画
renderArchive()        // window._allProjects を window._archiveFilter + 検索バー で絞り込んで描画
_getDecisionFromStatus(statusStr)  // ステータス文字列 → 'GO'|'HOLD'|'SKIP'
// Case Archive テーブル: Yeeflow 同期バッジ表示（yeeflowSynced 列）

// ── 全文検索（V10.3.0〜）──
// Archive 上部の検索バーで 会社名・業界・ID・相談内容 等を横断検索（renderArchive 内で処理）

// ── 重複チェックパネル ──
runDupCheck()          // getDuplicateReport() → dup-panel-body に結果表示
execDeleteDup(target)  // 確認ダイアログ → deleteDuplicates(target) 呼び出し

// ── Review Center ──
loadReviewBuffer()     // Review_Buffer 一覧取得・描画（dateSource バッジ含む）
openDetail(rowNum)     // 詳細パネルを開く（顧問名自動入力・前回判断復元込み）
submitFinalDecision()  // submitConsultantDecision() 呼び出し
filterBuffer(status)   // 'Pending'|'AUDITED'|'all'

// ── Todo（詳細パネル内） ──
loadDetTodos(caseId) / addDetTodo() / toggleTodoItem(rowNum, newStatus, prefix, caseId)

// ── Meeting 結論 ──
loadDetMeeting(caseId) / saveDetMeetingConclusion()

// ── AI メール草稿（V10.0.0〜）──
generateDraftEmail()          // Review 詳細パネル内：AI メール生成（generateOutreachEmail 呼び出し）
generateArchiveDraftEmail()   // Archive 詳細パネル内：AI メール生成
copyDraftEmail() / copyArchiveDraftEmail()
openGmailDraft() / openArchiveGmailDraft()
loadAdEmail(caseId)           // Archive 詳細「原始メール」タブのメール本文ロード
copuOriginalEmail()           // 原始メールをクリップボードにコピー

// ── Yeeflow 同期（V10.5.0〜）──
runYeeflowSync()              // Admin パネル「Yeeflow 同期」タブから一括同期実行

// ── バックフィルコントロール（V9.9.1〜）──
// Admin パネルに Dry-run / Execute ボタン、結果を backfill-results に表示

// ── Knowledge ──
loadKnowledge() / saveKnowledge() / deleteKnowledge(rowNum)

// ── 機能要望 ──
submitFeatureRequest()        // Feature_Request シートへ送信

// ── ユーティリティ ──
setStatus(msg, color) / escHtml(s) / renderBarChart(id, data, colors)
getCurrentUserName()          // セッションユーザー名取得（ヘッダー表示・顧問名自動入力）
```

---

## ■ UI 構成

### Dashboard タブ
1. **Agent Pipeline バー**（V10.1.0〜）: Inbox → Parse → Gate → Consult → GO の処理ステージ可視化
2. **統計カード**（4枚）: Total / BID SENT / ON HOLD / REVIEWED SKIP（クリックでフィルタリング）
3. **Case Archive テーブル**（6列）: Corp/ID | 業界 | Decision | Status | Category | Yeeflow
   - 全文検索バー（V10.3.0〜）: 会社名・業界・ID・相談内容 等の横断検索
   - Yeeflow 同期バッジ表示（V10.5.0〜）
   - Todo バッジ表示（V10.1.0〜）
4. **統計グラフ**（3本）: 案件分類 / 業界分布 / AIシステム種別（横棒）
5. **重複チェックパネル**: スキャン → 一覧表示 → 削除
6. **最終同期日時 + 同期間隔 UI**（V10.2.0〜）

### Review Center タブ
- **一覧ビュー**（7列）: Date | Case ID | Corp | Subject | AI判定 | Action | Buttons
  - コンテナ幅 max-w-[1500px]、操作列 172px、ホバープレビューカード付き
  - dateSource バッジ（MAIL/SYNC/UNKNOWN）表示
- **詳細パネル**（サブタブ5つ）:
  1. **顧問裁決**: 顧問名 + GO/HOLD/SKIP + 理由 + Commit Verdict
  2. **顧問意見一覧**
  3. **会議結論**: 会議日 + 最終判定 + 出席者 + 結論
  4. **Todo**: AI メール草稿パネル（V10.0.0〜）+ アクション追加フォーム + Todo一覧
  5. **原始メール**: 原始メール本文・件名・Gmail リンク（V10.1.0〜）

### Admin / 管理タブ
1. **Yeeflow 同期パネル**（V10.5.0〜）: 未同期案件一括送信
2. **歴史補正パネル**（V10.5.0〜）: backfillMeetingStatus / backfillMailDate
3. **バックフィルコントロール**: dry-run → 結果プレビュー → 書き戻し実行
4. **機能要望フォーム**（V9.9.3〜）: スクリーンショット添付対応

---

## ■ 完了済みバージョン履歴

| Ver（コード） | 日付 | 内容 |
|---|---|---|
| @135 / 以前 | — | 削除ボタン・顧問名自動入力・重複防止・前回判断復元・1500px UI・Archive Decision列・統計カードフィルター |
| V9.8.9 | — | safeJsonParse・parseBodyToStructured 正規表現兜底・Prompt_Config B2 動態取得・Re-parse ボタン |
| V9.9.0 | 2026-04-11 | AI Chat 統合ナレッジ対話・AI 日語出力 |
| V9.9.1 | 2026-04-13 | mail-sent time 表示・dateSource バッジ・backfillMailDate 系関数・フロント Backfill コントロール |
| V9.9.2 | 2026-04-15 | 顧問名ログインユーザー自動入力・多顧問意見汇総・会議結論・Todo 管理・Archive ステータス可視化 |
| V9.9.3 | 2026-04-16 | バージョン管理・チェンジログ表示・Hold ステータス追加・機能要望フォーム |
| V10.0.0 | 2026-04-19 | AI 自動メール下書き（generateOutreachEmail）・Todo タブ AI パネル |
| V10.1.0 | 2026-04-19 | Agent Pipeline バー・Archive Todo バッジ・最終同期 UI・Archive 原始メールタブ（getOriginalEmailByCaseId） |
| V10.2.0 | 2026-04-20 | 案件詳細モーダル大型化・同期間隔設定（saveSyncInterval） |
| V10.3.0 | 2026-04-21 | Case Archive 全文検索バー・Archive Todo タブ AI メール助理パネル |
| V10.3.1 | 2026-04-21 | メールプロンプト Prompt_Config B11/B12 管理・テラボックス担当デフォルト変更 |
| V10.4.0 | 2026-04-22 | メール生成強化：原始メール本文・顧問コメント統合・重複質問排除 |
| V10.4.1 | 2026-04-26 | メール生成に会議結論（Meeting_Records）統合・HOLD→SKIP バグ修正 |
| V10.5.0 | 2026-04-28 | Yeeflow CRM 直接 API シンク・AG列同期タイムスタンプ・会議結論→AF列自動反映・backfillMeetingStatus |
| V10.5.1 | 2026-05-16 | API キーを Script Properties へ完全移行・ローカル sync-secrets-to-gas.sh 整備 |

---

## ■ 実装済み主要機能：AI自動メール下書き（V10.0.0〜 / V10.4.x 強化済み）

### 概要
顧問が案件を GO/HOLD 判断した後、**正式対応前に顧客の反応を確認**するための
**AI メール草稿生成機能**。Review 詳細パネルの Todo サブタブ と Archive 詳細パネル の両方に実装済み。
V10.4.0 以降は原始メール本文・顧問コメント・会議結論を統合して AI が生成する。

### フロー
```
Commit Verdict（GO/HOLD判断確定）
  ↓
Todo タブ → 「📧 AI 顧客確認メール生成」パネル
  ↓
テンプレート選択 + 「生成」ボタン
  ↓
AI が Case_infor の案件データ + 顧問判断 + テンプレートをもとに日本語メール本文生成
  ↓
プレビュー表示（編集可能テキストエリア）
  ↓
「コピー」または「Gmail で開く」→ 顧客へ送付
  ↓
顧客返信確認後 → 正式対応へ
```

### Backend: 追加する関数

```javascript
/**
 * AI 顧客確認メール本文生成
 * @param {string} caseId       - 案件ID（Case_infor から情報取得）
 * @param {string} action       - 'Go' | 'Hold'
 * @param {string} templateType - 'initial_contact' | 'hold_check'
 * @returns {{ subject: string, body: string }}
 */
function generateOutreachEmail(caseId, action, templateType) {
  // 1. Case_infor から法人名/相談内容/予算感/期望交期/核心需求 等を読む
  // 2. テンプレート選択（Prompt_Config C2 or コード内蔵）
  // 3. callAIText() でメール本文生成
  // 4. { subject, body } を返す
}
```

### メールテンプレート（コード内蔵 or Prompt_Config C2 セル）

**テンプレート1: 初回接触確認（Go）**
```
件名: 【Ready Crew】ご案件についてのご確認 - {法人名}様

{担当者名}様

お世話になっております。Ready Crew 株式会社の{顧問名}でございます。

この度は{案件ID}のご相談をいただき、誠にありがとうございます。
ご案件の内容を拝見し、弊社でご支援できる可能性が十分にあると判断いたしました。

つきましては、以下の点についてご確認させていただけますでしょうか。

【ご確認事項】
1. ご予算感: {予算感}
2. ご希望の着手時期: {期望交期}
3. 主な要件: {核心需求}

ご都合のよいお時間にお打合せをご提案させていただければ幸いです。
よろしくお願いいたします。
```

**テンプレート2: HOLD時の現状確認**
```
件名: 【Ready Crew】ご案件の現状確認 - {法人名}様

{担当者名}様

お世話になっております。Ready Crew 株式会社の{顧問名}でございます。

先般よりご相談いただいておりました{相談内容}につきまして、
現在の進捗状況をお伺いできますでしょうか。

弊社としても引き続き対応を検討しております。
お気軽にご連絡いただければ幸いです。

よろしくお願いいたします。
```

### Frontend: 追加する HTML（det-subpane-todos の先頭に挿入）

```html
<!-- AI メール生成パネル -->
<div id="det-email-draft-panel" class="bg-indigo-50 border-2 border-indigo-100 rounded-2xl p-5 space-y-3">
  <div class="flex items-center justify-between">
    <p class="text-[10px] font-black text-indigo-400 uppercase tracking-widest">📧 AI 顧客確認メール生成</p>
    <select id="det-email-template" class="text-[11px] font-bold border border-indigo-200 rounded-lg p-1.5 bg-white">
      <option value="initial_contact">初回接触（GO案件）</option>
      <option value="hold_check">現状確認（HOLD案件）</option>
    </select>
  </div>
  <button onclick="generateDraftEmail()"
    class="w-full py-2.5 bg-indigo-600 text-white font-black rounded-xl text-[11px] uppercase hover:bg-indigo-700 transition-all">
    ✨ メール文面を生成
  </button>
  <div id="det-email-result" class="hidden space-y-2">
    <input id="det-email-subject" type="text"
      class="w-full p-2.5 rounded-xl border border-indigo-200 text-[12px] font-bold bg-white" placeholder="件名" />
    <textarea id="det-email-body" rows="10"
      class="w-full p-3 rounded-xl border border-indigo-200 text-[12px] bg-white resize-y font-mono leading-relaxed"></textarea>
    <div class="flex gap-2">
      <button onclick="copyDraftEmail()"
        class="flex-1 py-2 bg-slate-700 text-white font-black rounded-xl text-[11px] uppercase">📋 コピー</button>
      <button onclick="openGmailDraft()"
        class="flex-1 py-2 bg-emerald-600 text-white font-black rounded-xl text-[11px] uppercase">📨 Gmail で開く</button>
    </div>
  </div>
</div>
```

### Frontend: 追加する JS

```javascript
// openDetail(rowNum) 内でセット
window._currentCaseId     = null;
window._currentCaseAction = null;  // 'Go'|'Hold'|'Skip'

function generateDraftEmail() {
  var caseId   = window._currentCaseId;
  var action   = window._currentCaseAction || 'Go';
  var tmplType = document.getElementById('det-email-template').value;
  if (!caseId) { alert('案件が選択されていません'); return; }
  setStatus('✨ AIがメール文面を生成中...', '#6366f1');
  document.getElementById('det-email-result').classList.add('hidden');
  google.script.run
    .withSuccessHandler(function(r) {
      if (!r || !r.body) { setStatus('⚠ 生成失敗', '#f59e0b'); return; }
      document.getElementById('det-email-subject').value = r.subject || '';
      document.getElementById('det-email-body').value    = r.body    || '';
      document.getElementById('det-email-result').classList.remove('hidden');
      setStatus('✅ メール文面生成完了', '#10b981');
    })
    .withFailureHandler(function(e) {
      setStatus('❌ 生成エラー: ' + (e.message||String(e)), '#ef4444');
    })
    .generateOutreachEmail(caseId, action, tmplType);
}

function copyDraftEmail() {
  var subj = document.getElementById('det-email-subject').value;
  var body = document.getElementById('det-email-body').value;
  navigator.clipboard.writeText('件名: ' + subj + '\n\n' + body)
    .then(function() { setStatus('📋 クリップボードにコピーしました', '#10b981'); });
}

function openGmailDraft() {
  var subj = encodeURIComponent(document.getElementById('det-email-subject').value);
  var body = encodeURIComponent(document.getElementById('det-email-body').value);
  window.open('https://mail.google.com/mail/?view=cm&fs=1&su=' + subj + '&body=' + body, '_blank');
}
```

### 実装時の注意点
- `generateOutreachEmail` は AI 呼び出しのため数秒かかる → 生成中にボタンを disabled にする
- メール本文は**編集可能**（AIが生成した後、顧問が手直し可能）
- `openDetail()` 内で `window._currentCaseId` と `window._currentCaseAction` をセット
- `window._currentCaseAction` は `con-action` select の現在値（Go/Hold/Skip）から取得
- Prompt_Config の C2 セルにメールテンプレート用プロンプトを保管する設計にすると拡張しやすい

---

## ■ API 設定

```javascript
// 機密は Script Properties（ARK_API_KEY 等）。ローカルは config/local.settings.json → scripts/sync-secrets-to-gas.sh
// 参照: getRuntimeConfig_() / CONFIG ゲッター（コード.gs）
```

---

## ■ 既知の注意事項

1. **GAS 権限**: 長期間未実行だと `Authorization is required` → GAS エディタで手動実行して再承認
2. **絵文字**: GAS HTML で UTF-8 絵文字が文字化け → 必ず HTML エンティティ使用（`&#9208;` 等）
3. **シート名**: `saveOrUpdateLead` は `getSheetByName("Case_infor")` で明示指定（`getSheets()[0]` 禁止）
4. **ヘッダー行スキップ**: `rows[1]` から検索（`rows[0]` はヘッダー）、スプレッドシート行番号は `i + 1`
5. **エラーハンドラ**: `withFailureHandler` はすべて画面表示（`console.error` のみは禁止）

此文件为本次会话的摘要，聚焦在「把 Gmail 邮件的原始发送时间（mail-sent time）显示并回填到历史记录」这一工作流上的诊断、实现与下一步操作。

## 目标（本次任务）
- 在卡片/列表/详情页显示邮件的原始发送时间（优先使用 Gmail 的 msg.getDate()），而不是系统记录/同步时间。
- 检测 Review_Buffer 中缺失 mail-sent 时间的历史行，提供 dry-run（不可破坏）并在用户批准后分批写回（带备份与日志）。

## 已完成的关键工作
- 后端 (`src/コード.gs`)：
    - 将 `getReviewBufferList()` 改为同时返回：
        - `date`（格式化、用于显示），`dateRaw`（数值时间戳，用于排序），以及 `dateSource`（"MAIL" / "SYNC" / "UNKNOWN"）和原始字段 `rawMailDate` / `rawSyncDate` 以便诊断。
    - 添加了回填工具：
        - `backfillMailDate(dryRun, limit)`：dry-run（默认 limit=200），可选写回（写回模式需谨慎）。
        - `runBackfillDryRun_writeToSheet(limit)`：把 dry-run 结果写入 `Backfill_Debug` sheet（因为 Executions 日志有时无法直接查看 Logger 输出）。
        - `backfillMailDateExecute(limit, batchSize, retries)`：稳健执行函数，支持分批写入、写入前备份到 `Backfill_Backup`、并写执行详情到 `Backfill_Log`（便于审计与回滚）。

- 前端 (`src/index.html`)：
    - 在卡片与详情页上显示 `date`，并渲染 `dateSource` 徽章（MAIL/SYNC/UNKNOWN）。
    - 新增 Dry-run 与 Execute Backfill 按钮，前端通过 `google.script.run` 调用后端 dry-run/execute，并在页面下方显示回填结果（已兼容返回对象或数组两种形态）。

- 部署：通过 `deploy.sh` 多次推送与部署（最近部署版本包含 robust backfill execute）。

## 关键文件与函数（快速索引）
- `src/コード.gs`：`getReviewBufferList()`, `backfillMailDate(dryRun, limit)`, `runBackfillDryRun_writeToSheet(limit)`, `backfillMailDateExecute(limit, batchSize, retries)`。
- `src/index.html`：前端显示/交互逻辑，新增 backfill 控件与 `dateSource` 徽章。
- `deploy.sh`：把 `backend.txt`/`frontend.txt` 拷贝到 `src/` 并做 clasp push + deploy（使用时请注意会触发授权/权限页面）。

## 推荐的安全操作流程（回填历史数据）
1. Dry-run：在 UI 或 Apps Script 控制台运行 `backfillMailDate(true, limit)`（例如 limit=200）。检查 `Backfill_Debug`（若存在）或前端 `backfill-results` 输出样本（至少 5–10 行）。
2. 审查样本：关注日期格式、时区（项目使用 GMT+9/Asia/Tokyo）、以及无效或找不到的 MsgID。确认样本正确才继续。
3. 小批量写回（首轮）：在 Apps Script 编辑器中运行：
     - `backfillMailDateExecute(50, 20, 2)` —— 50 行候选、每批写 20 行、重试 2 次。
     - 执行前脚本会把这些待写入行备份到 `Backfill_Backup`，并把每次写入的详情写到 `Backfill_Log`。
4. 验证：打开 `Backfill_Backup` 与 `Backfill_Log`，抽查 5–10 行，确认 `Review_Buffer` 对应行的 A 列已写入正确的 mail-sent 时间，前端排序与显示正确（`dateSource` 显示为 MAIL）。
5. 放大执行：确认无误后可增大 limit/批量规模，直到清理完缺失的行。

## 验证检查要点（QA）
- 日期格式：`yyyy/MM/dd HH:mm`（按项目约定用 `CONFIG.DEFAULT_TZ` 格式化，默认 GMT+9）。
- 排序基准：前端应以 `dateRaw`（数值）排序，而非字符串日期或同步时间。
- 备份检查：`Backfill_Backup` 应包含写回前的原始行，`Backfill_Log` 应包含成功/失败及错误信息。
- 权限：写 Gmail 相关信息或访问 GmailApp 需要用户在 Apps Script 中授权 Gmail scopes；在控制台运行会触发授权弹窗。

## 风险与回滚
- 若写回导致问题（时区错置或 msgId 错误），可用 `Backfill_Backup` 中的数据回滚（手动或写脚本按备份还原）。
- 写回应分批且先做小批量验证，避免一次性大规模破坏性写入。

## 当前待办（简短）
- 已完成：dry-run 功能、前端显示 `dateSource`、后端稳健写回函数与备份日志。
- 待做：用户运行小批量写回并把 `Backfill_Log`/`Backfill_Backup` 的样例（前 10 行）贴回，助手复核并建议放大策略。

## 如何查看/运行（快速命令）
在项目根目录运行（这是本地 deploy 流程，不是写回代码本身）：
```bash
bash deploy.sh "描述信息"
```
要在 Apps Script 编辑器里直接触发小批量写回（推荐）：
```js
// 打开 Apps Script 编辑器 -> 在执行下拉选择 backfillMailDateExecute -> 运行
backfillMailDateExecute(50, 20, 2)
```

---
（记录生成于 2026-04-13；如需包含更多执行日志或具体样例行，请把 `Backfill_Log` / `Backfill_Backup` 的前若干行粘贴到会话中，我将帮你逐条验证。）
---
