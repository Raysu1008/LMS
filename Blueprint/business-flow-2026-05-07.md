# Ready Crew CRM — 業務フロー図（V10.5.0）
> 最終更新: 2026-05-07

---

## 1. 全体フロー概要

```mermaid
flowchart TD
    A([📧 顧客からメール着信]) --> B[Gmail 受信トレイ]
    B --> C{gmailAgentRunner\n自動同期}
    C -->|重複チェック\nMsgID / CaseID / Subject| D{重複あり?}
    D -->|Yes| E[スキップ・ログ記録]
    D -->|No| F[AI解析\nparseBodyToStructured\nDeepSeek-V3-2]
    F --> G[(Review_Buffer\n一時保管シート)]

    G --> H[Review Center\n顧問が一覧確認]
    H --> I[詳細パネルを開く\nopenDetail]
    I --> J{顧問裁決\nsubmitConsultantDecision}

    J -->|GO ✅| K[Case_infor に保存\nsaveOrUpdateLead]
    J -->|HOLD ⏸| K
    J -->|SKIP ⏭| L[Buffer行を AUDITED に\n更新してクローズ]

    K --> M[会議結論記録\nsaveMeetingConclusion]
    M --> N{最終判断}
    N -->|BID SENT| O[📧 AIメール下書き生成\ngenerateOutreachEmail]
    N -->|ON HOLD| O
    O --> P[顧問が文面確認・編集]
    P --> Q[Gmail で顧客へ送付]
    Q --> R([顧客返信待ち → 正式対応へ])

    K --> S[(Dashboard\n統計・アーカイブ)]
    L --> S
```

---

## 2. Gmail 自動同期フロー

```mermaid
flowchart LR
    A([定期トリガー / 手動実行]) --> B[gmailAgentRunner\noptions: dateAfter, maxEmails=100]
    B --> C[Prompt_Config B2\nSystemPrompt 読み込み\nキャッシュ]
    C --> D[buildDuplicateSet\nReview_Buffer + Case_infor 参照]
    D --> E{対象メール\n1件ずつ処理}

    E --> F{重複チェック 3段階}
    F -->|MsgID 重複| G[スキップ]
    F -->|CaseID 重複| G
    F -->|Subject 重複| G
    F -->|新規| H[parseBodyToStructured\nAI解析]

    H --> I{解析品質チェック\n非空フィールド数 >= 5?}
    I -->|OK| J[Review_Buffer に appendRow\nStatus=Pending]
    I -->|NG| K[兜底: 正規表現で\nID・法人名のみ抽出して保存]
    K --> J

    J --> L[Agent_Logs に記録]
    G --> L
    L --> M([同期完了\nB10に最終同期日時書き込み])
```

---

## 3. AI メール解析フロー（parseBodyToStructured）

```mermaid
flowchart TD
    A([メール本文 rawBody]) --> B{Prompt_Config B2\nに値あり?}
    B -->|Yes| C[B2 の SystemPrompt を使用]
    B -->|No| D[FALLBACK_PARSE_PROMPT を使用]
    C --> E[callAIText\nDeepSeek-V3-2 API 呼び出し]
    D --> E

    E --> F[safeJsonParse\nMarkdownブロック除去 + JSON.parse]
    F --> G{パース成功?}
    G -->|Yes| H[キー名マッピング\n売上→売上高 / 必須機能→核心需求 etc.]
    G -->|No| I[正規表現兜底\n案件ID + 法人名のみ抽出]
    H --> J([構造化JSONを返す])
    I --> J
```

---

## 4. 顧問裁決フロー（Review Center）

```mermaid
flowchart TD
    A([顧問がレビューセンターを開く]) --> B[loadReviewBuffer\nStatus=Pending 一覧表示]
    B --> C[openDetail\n詳細パネルを開く]
    C --> D[ParsedJSON 読み込み\n顧問名・前回判断 自動復元]

    D --> E{サブタブ選択}
    E --> F[顧問裁決タブ\nGO / HOLD / SKIP 選択 + 理由記入]
    E --> G[顧問意見一覧タブ]
    E --> H[会議結論タブ\n会議日 + 参加者 + 結論]
    E --> I[Todoタブ\n次アクション管理]

    F --> J[Commit Verdict\nsubmitConsultantDecision]
    J --> K{ParsedJSON が\n使えるか?}
    K -->|Yes| L[saveOrUpdateLead\nCase_infor に登録/更新]
    K -->|No| M[AI 再解析 実行]
    M --> L

    L --> N[Review_Buffer → AUDITED に更新]
    N --> O[Decisions シートに追記\n判断ログ]
    O --> P([完了])
```

---

## 5. AIメール下書き生成フロー

```mermaid
flowchart LR
    A([顧問が Todo タブを開く]) --> B{テンプレート選択}
    B -->|初回接触 GO| C[initial_contact テンプレート]
    B -->|現状確認 HOLD| D[hold_check テンプレート]

    C --> E[generateOutreachEmail\ncaseId + action + templateType]
    D --> E

    E --> F[Case_infor から案件情報取得\n法人名/相談内容/予算感/期望交期/核心需求]
    F --> G{Prompt_Config\nB11/B12 にプロンプトあり?}
    G -->|Yes| H[シートのプロンプトを使用]
    G -->|No| I[コード内蔵テンプレートを使用]
    H --> J[callAIText\nDeepSeek-V3-2 でメール文面生成]
    I --> J

    J --> K[件名 + 本文 を返す]
    K --> L[フロントエンドで\nプレビュー表示]
    L --> M{顧問操作}
    M -->|📋 コピー| N[クリップボードへ]
    M -->|📨 Gmail で開く| O[Gmail 作成画面へ]
    N --> P([顧客へ送付])
    O --> P
```

---

## 6. Dashboard & 統計フロー

```mermaid
flowchart LR
    A([Dashboard タブを開く]) --> B[getDashboardData\nCase_infor + Agent_Logs 読み込み]
    B --> C[getStatisticsData\n集計処理]
    C --> D{表示}
    D --> E[統計カード 4枚\nTotal / BID SENT / ON HOLD / SKIP]
    D --> F[Case Archive テーブル\n法人名 / 業界 / Decision / Status / Category]
    D --> G[統計グラフ 3本\n案件分類 / 業界分布 / AIシステム種別]
    D --> H[重複チェックパネル]

    E --> I{フィルタークリック}
    I --> J[filterArchive\nテーブル絞り込み表示]

    H --> K[getDuplicateReport\n重複スキャン]
    K --> L{削除操作}
    L --> M[deleteDuplicates\nbuffer / caseInfor / both]
```

---

## 7. データシート関係図

```mermaid
erDiagram
    Case_infor {
        string CaseID PK
        string CorpName
        datetime RecordedAt
        string Category
        string Industry
        string Status
        string AI_Type
        string AI_Action
        string YeeflowSyncTime
    }
    Review_Buffer {
        string MsgID PK
        string CaseID FK
        string CorpName
        string Subject
        string RawBody
        string GmailLink
        string Status
        string ParsedJSON
        datetime MailDate
        datetime SyncTime
    }
    Meeting_Records {
        string MeetingDate
        string CaseID FK
        string CorpName
        string Participants
        string Decision
        string Conclusion
    }
    Case_Todo {
        string TodoID PK
        string CaseID FK
        string Action
        string AssignedTo
        string DueDate
        string Status
    }
    Decisions {
        datetime Timestamp
        string CaseID FK
        string CorpName
        string Decision
        string ConsultantName
    }
    Agent_Logs {
        datetime Timestamp
        string Subject
        string Status
        string Info
    }
    Prompt_Config {
        string B2_ParsePrompt
        string B3_AnalysisPrompt
        string B4_TargetEmail
        string B8_Whitelist
        string B11_InitialMailPrompt
        string B12_HoldMailPrompt
    }

    Case_infor ||--o{ Meeting_Records : "1件:N会議"
    Case_infor ||--o{ Case_Todo : "1件:NTodo"
    Case_infor ||--o{ Decisions : "1件:N判断"
    Review_Buffer ||--|| Case_infor : "審査後に登録"
```

---

## 8. システム権限・アクセス制御

```mermaid
flowchart TD
    A([ユーザーがアクセス]) --> B[checkAccess\nGAS doGet]
    B --> C{getActiveUser\nメール取得}
    C -->|失敗 execute-as-me| D[放行 anonymous]
    C -->|成功| E{ドメイン確認\n@terabox.jp ?}
    E -->|No| F[🔒 Access Denied 画面]
    E -->|Yes| G{Prompt_Config B8\n白名単あり?}
    G -->|なし| H[ドメイン認証のみで通過]
    G -->|あり| I{メールが白名単に含まれる?}
    I -->|No| F
    I -->|Yes| H
    H --> J[index.html を返す\nReady Crew CRM]
```

---

## 主要バージョン変遷サマリー

| バージョン | 主な変更内容 |
|---|---|
| V9.8.x | AI解析品質向上・重複検出3段階・Re-parse機能追加 |
| V9.9.8 | Yeeflow CRM 一括同期機能追加 |
| V10.4.1 | 会議結論をメール生成に統合・HOLDバグ修正 |
| V10.5.0 | Yeeflow 直接API同期・会議結論 → Case_infor自動反映 |
