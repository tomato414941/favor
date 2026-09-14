# X認証の接続設定

X側の設定・認証・利用条件は、公式の[アプリ設定](https://docs.x.com/fundamentals/developer-apps)・[OAuth 2.0](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)・[料金](https://docs.x.com/x-api/getting-started/pricing)を参照。

## ローカル設定

この実装はOAuth 2.0のWeb App（Confidential client）を使用する。
[.env.example](../.env.example)を参考に、Git管理外の `.env.local` に設定する。`npm run dev` 用の値は次のとおり。

```dotenv
COMMISSION_AUTH_MODE=x
COMMISSION_PUBLIC_ORIGIN=http://127.0.0.1:3211
X_CLIENT_ID=YOUR_OAUTH2_CLIENT_ID
X_CLIENT_SECRET=YOUR_OAUTH2_CLIENT_SECRET
X_APP_BEARER_TOKEN=YOUR_APP_ONLY_BEARER_TOKEN
```

設定後、起動中の開発サーバーを終了してから `npm run dev` で再起動する。

`npm run dev` 用にXアプリへ追加するCallback URLは `http://127.0.0.1:3211/api/auth/x/callback`。
`npm run build && npm start` の場合は、`COMMISSION_PUBLIC_ORIGIN=http://127.0.0.1:3210` とし、Callback URLも `http://127.0.0.1:3210/api/auth/x/callback` にする。

## この実装の制約

- `X_APP_BEARER_TOKEN` が未設定でもログインは可能だが、新しい招待先の確認・招待作成は利用できない。
- Xモードでは体験用セッションを使えない。Client ID / Secretが未設定、またはURLの形式が不正なら起動を止め、体験用認証には切り替えない。
- X用のDBは既定で `data/x-sandbox/commission.sqlite`。体験用DB `data/commission.sqlite` は引き継がない。`COMMISSION_DATA_DIR` の指定があればそちらを優先する。
- 要求スコープは `tweet.read users.read`。投稿の取得・作成やDM送信は行わない。ユーザーアクセストークンは本人情報の取得だけに使い、保存しない。
- 認証の有効期限は10分。招待リンクはタブ内に一時保存するため、認証中にタブを閉じたら元のリンクを開き直す。同じブラウザープロファイルで新しく認証を開始すると、先の認証は無効になる。
- ログイン開始は接続元ごと、宛先検索は登録ユーザーごとに10分30回までの暫定制限。X側の利用制限・費用上限の代わりではない。
- Xモードでも決済は模擬処理で、待受は `127.0.0.1` のみ。npmスクリプトの `--demo` は模擬決済を表す。

起動・検証範囲・未対応機能は[README](../README.md)を参照。
