# X認証の接続設定

初期対応SNSはX。OAuth 2.0の認証、一般登録・ログイン、招待先の検索・本人照合を実装している。
決済は引き続き模擬処理で、公開サービスとして提供するための設定ではない。

## 既存のXアプリを確認する

[X Developer Console](https://console.x.com/)で対象のアプリを確認する。既存サービスでも使用しているアプリなら、既存の設定・コールバックURL・キーを変更または再発行する前に影響を確認する。

必要なものは次のとおり。

| 設定・認証情報 | このアプリでの用途 |
| --- | --- |
| OAuth 2.0を有効にしたWeb App（Confidential client） | サーバーでの認証コード交換 |
| Client ID / Client Secret | Xでのログイン |
| App-only Bearer Token | 招待先のユーザー名から固有IDを取得 |
| Callback URL | Xから戻る、このアプリのURL |

OAuth 1.0aのAPI Key / Secretや、個人アカウントのAccess Token / Secretとは別の認証情報。
Xの[アプリ設定資料](https://docs.x.com/fundamentals/developer-apps)を参照。

### 開発時のCallback URL

`npm run dev` を使う場合、次をXアプリの許可リストに追加する。既存のURLを置き換えない。

```text
http://127.0.0.1:3211/api/auth/x/callback
```

X側のURLはスキーム・ホスト・ポート・パスまで完全一致が必要。末尾の `/` は付けない。
ローカル開発では `localhost` ではなく `127.0.0.1` を使用する。[Xのアプリ設定資料](https://docs.x.com/fundamentals/developer-apps)

`npm run build && npm start` で画面を3210番ポートから開く場合は、
`COMMISSION_PUBLIC_ORIGIN=http://127.0.0.1:3210` とし、Callback URLも3210に合わせる。

## ローカル設定

プロジェクトルートの `.env.example` を参考に、Git管理外の `.env.local` に設定する。
実際の秘密情報はチャット・スクリーンショット・コミットに載せず、`VITE_` 付きの変数やフロントエンドのコードにも置かない。

```dotenv
COMMISSION_AUTH_MODE=x
COMMISSION_PUBLIC_ORIGIN=http://127.0.0.1:3211
X_CLIENT_ID=YOUR_OAUTH2_CLIENT_ID
X_CLIENT_SECRET=YOUR_OAUTH2_CLIENT_SECRET
X_APP_BEARER_TOKEN=YOUR_APP_ONLY_BEARER_TOKEN
```

設定後、起動中の開発サーバーを終了してから `npm run dev` で再起動する。
X用のDBは既定で `data/x-sandbox/commission.sqlite`。既存の体験用DB `data/commission.sqlite` は引き継がない。
`COMMISSION_DATA_DIR` を指定している場合は、その保存先が優先されるので注意する。

- `COMMISSION_AUTH_MODE=demo` は固定アカウントによる体験モード。Xへの通信はしない。
- `COMMISSION_AUTH_MODE=x` では体験用のアカウント切替API・保存済み体験用セッションを使用できない。
- XモードでClient ID / Secretが未設定、またはURLの形式が不正なら起動を止める。体験用認証には切り替えない。認証情報が実際に有効かどうかは、接続時にX側で確認される。
- App-only Bearer Tokenが未設定でもログインは可能だが、新しい招待先の確認・招待作成は利用できない。
- いずれも起動には `--demo` が必要で、npmスクリプトが付与する。これは**決済が模擬処理**であることを表す。待受は `127.0.0.1` のみ。

## X APIの利用条件

ログインには `/2/users/me`、宛先検索には `/2/users/by/username/:username` の利用が必要。
X APIの料金は従量制のため、コンソールで対象エンドポイントの利用可否、クレジット、料金を確認する。[Xの料金資料](https://docs.x.com/x-api/getting-started/pricing)
クレジット購入やアプリ設定の変更を、このリポジトリのスクリプトが自動で行うことはない。

ログインで要求するスコープは `tweet.read users.read`。Xの[認証対応表](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping)にあるユーザー取得用の組み合わせを使用し、実際の投稿の取得はしない。
投稿・DM送信や `offline.access` は要求しない。ログイン時のユーザーアクセストークンは本人情報の取得にのみ使い、DB・ブラウザーへ保存しない。

## 確認する流れ

1. Xでログインし、アカウント確認後も登録はされていないことを確認する。
2. ルールとアカウント情報の利用に同意して登録する。再ログインでは同じアカウントになる。
3. 「招待を送る」で相手の `@ユーザー名` またはXのプロフィールURLを指定する。
4. 別のブラウザープロファイルで招待リンクを開き、宛先本人のXアカウントで確認する。
5. 別アカウントでは内容が見えないこと、本人は確認だけでは登録されず、受諾時に登録・取引へ移行することを確認する。
6. 辞退・受信停止では登録されないこと、受諾後に納品・ダウンロードできることを確認する。決済は模擬処理。

認証の中断・有効期限切れでも登録や受諾は行わない。招待リンクはXに渡さず、ブラウザーのタブ内に一時保存して認証後に復帰する。
認証中にタブを閉じた場合は、元の招待リンクを開き直す。別タブから新しく認証を開始すると、先に開始した認証は無効になる。

## 検証範囲と残作業

`npm run check` と `npm run test:browser` で検証する。ブラウザーテストは、Xの応答をテスト用のものに置き換えた隔離環境を使用し、実際のX APIへの接続・課金は行わない。
実アプリの設定・認証情報を用いた疎通確認は別途必要。API側の制限・権限不足・通信失敗は、ログインや招待作成の成功とは扱わない。

認証はS256 PKCE、ブラウザーに結び付けた一回限りのstate、10分の有効期限を使う。
ログイン開始は接続元ごと、宛先検索は登録ユーザーごとに10分30回までという暫定制限を設ける。これはX側の利用制限・費用上限の代わりではない。
アプリのリクエストログに認証コード・Cookie・招待トークンは出さない。将来リバースプロキシを設ける場合も、認証コールバックのクエリーや秘密ヘッダーをログに保存しない設定が必要。

募集設定、正式な利用規約・プライバシー方針、実決済・本人確認・出金、本番公開への対応は別工程。
Xのアカウントそのものの乗っ取り防止・復旧は、このサービスの実装範囲に含めない。
