# メール認証（新規登録の6桁コード）セットアップ手順

新規登録は **実際に受信できるメールアドレス** が必須です。登録フォーム送信 → `noreply@coverletterkit.com` から6桁コードが届く → コード入力でアカウント確定、という流れになります。

送信は **Resend**（メール配信 API）を使います。無料枠は **3,000通/月・100通/日** で、この規模のサイトなら十分です。

> 前提：先に [REDIS_SETUP.md](./REDIS_SETUP.md) を完了してください。認証コードは Redis に保存するため、Redis 未設定だと登録機能は 503 で止まります（匿名の1日2回生成は今まで通り動きます）。

---

## ⚠️ 先に読む：DNS を壊さないこと

このドメインは既に **contact@coverletterkit.com のメール転送** 用に、apex（`@`）へ以下の MX / TXT を入れてあります。

| Type | Name | Value |
| --- | --- | --- |
| MX | `@` | `mx1.efwd.spaceship.net` (Priority 0) |
| MX | `@` | `mx2.efwd.spaceship.net` (Priority 0) |
| TXT | `@` | `v=spf1 include:spf.efwd.spaceship.net ~all` |

**Resend のセットアップで、これらの既存レコードを上書き・削除しないでください。** 消すと `contact@` の受信が止まります。

Resend が要求する MX / SPF は **`send` サブドメイン**（`send.coverletterkit.com`）に入れる形になっているので、apex の既存レコードとは衝突しません。**「Name」欄を必ず確認して、`send` や `resend._domainkey` が付いているものはそのまま追加**してください。

---

## Step 1. Resend アカウント作成

1. https://resend.com/signup を開く
2. メールアドレスで登録（`contact@coverletterkit.com` でも Gmail でも可。ログイン用なので何でも OK）
3. ダッシュボードに入れたら完了

## Step 2. API Key を作成

1. 左メニュー **API Keys** → **Create API Key**
2. Name：`coverletterkit-prod`（任意）
3. Permission：**Sending access**
4. Domain：`coverletterkit.com`（ドメイン追加前は All domains でも可）
5. 作成後に出る `re_xxxxxxxx...` を**コピー**（この画面を閉じると再表示できません）

## Step 3. ドメインを認証（DNS レコード追加）

1. 左メニュー **Domains** → **Add Domain**
2. Domain：`coverletterkit.com`
3. Region：**ap-northeast-1 (Tokyo)** を推奨（日本向けサイトのため）
4. 表示される DNS レコード（通常は次の3種）を控える
   - `MX` → `send` … `feedback-smtp.ap-northeast-1.amazonses.com`（Priority 10）
   - `TXT` → `send` … `v=spf1 include:amazonses.com ~all`
   - `TXT` → `resend._domainkey` … `p=MIGfMA0...`（DKIM 公開鍵）
   ※ 表示された値が正です。リージョンによりホスト名が変わります。
5. Vercel 側で追加：**Domains → coverletterkit.com → View DNS Records / DNS Records** → 上記を1件ずつ **Add**（Name に `send` や `resend._domainkey` が入っていることを毎回確認）→ Save

> apex（`@`）の MX が `mx1/mx2.efwd.spaceship.net` のままであることを、追加後に必ず見直してください。

## Step 4. Resend で Verify

1. Resend の Domains 画面に戻り **Verify DNS Records** をクリック
2. 通常5分程度で `Verified`（最大72時間かかる場合あり）
3. ステータスが **Verified** になったら送信可能

## Step 5. Vercel に環境変数を設定

Vercel プロジェクト `career-ai` → **Settings → Environment Variables**

| Key | Value | 環境 |
| --- | --- | --- |
| `RESEND_API_KEY` | `re_...`（Step 2 の値） | Production / Preview / Development |
| `RESEND_FROM` | `noreply@coverletterkit.com`（省略可・これが既定値） | 同上 |
| `RESEND_REPLY_TO` | `contact@coverletterkit.com`（省略可・これが既定値） | 同上 |

ログイン中の1日上限を変えたい場合のみ（既定 **5**）：

| Key | Value |
| --- | --- |
| `LOGGED_DAILY_LIMIT` | `5` |

## Step 6. 再デプロイ

環境変数は再デプロイしないと反映されません。
**Deployments → 最新のデプロイ →「…」→ Redeploy**

## Step 7. 動作確認

1. https://www.coverletterkit.com/account.html を開く
2. 「ログイン / 新規登録」→ **新規登録** タブ → 実在のメールアドレス＋パスワード（6文字以上）
3. 「認証コードを受け取る」→ 数十秒以内に6桁コードが届く
4. コードを入力 → 「認証して登録」→ マイページに切り替わり、そこから生成すると履歴が保存される

---

## 仕様（実装の詳細）

| 項目 | 値 |
| --- | --- |
| コード | 6桁数字・**10分間有効** |
| 誤入力 | 5回まで。5回失敗で保留データを破棄（再登録が必要）＝総当たり対策 |
| 再送信 | 10分あたり最大5回（メール爆撃対策） |
| 登録確定前 | ログイン不可。再度「新規登録」すると新しいコードで上書き（古いコードは無効） |
| パスワード | scrypt + ソルトでハッシュ保存（平文は保存しません） |
| セッション | httpOnly Cookie `clk_session`・30日 |
| 上限 | 未ログイン 1日2回 / ログイン中 1日5回（`LOGGED_DAILY_LIMIT` で変更可） |

## トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| 登録で「メール送信が未設定です（管理者へ連絡）」（503） | `RESEND_API_KEY` 未設定、または再デプロイ忘れ |
| 「認証ストアが未設定です」（503） | Redis 未接続。REDIS_SETUP.md を実施 |
| 「認証メールの送信に失敗しました」（502） | ドメイン未認証／API Key 誤り／無料枠超過。**Resend の Logs** で詳細を確認 |
| メールが届かない | 迷惑メールフォルダを確認。Resend Logs が `Delivered` なら受信側の問題 |
| `contact@` 宛のメールが届かなくなった | Step 3 で apex の MX を上書きした可能性。`mx1/mx2.efwd.spaceship.net` を復元 |

## 別の送信サービスを使いたい場合

送信は `api/_lib/email.mjs` の `sendVerificationEmail()` 1か所に閉じています（REST を裸の `fetch` で叩くだけ）。Brevo / Amazon SES / Postmark などに変える場合は、この関数の送信部分だけ差し替えれば他は無変更で動きます。API Key の環境変数名もここで自由に決められます。
