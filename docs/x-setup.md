# X認証の接続設定

`npm run dev` でXログインを使う場合の設定。

1. XアプリでOAuth 2.0のWeb App（Confidential client）を選び、Callback URLに `http://127.0.0.1:3211/api/auth/x/callback` を登録する。[X公式の設定手順](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
2. プロジェクト直下の `.env.local` に設定する。このファイルはGit管理外。

   ```dotenv
   FAVOR_AUTH_MODE=x
   FAVOR_PUBLIC_ORIGIN=http://127.0.0.1:3211
   X_CLIENT_ID=YOUR_OAUTH2_CLIENT_ID
   X_CLIENT_SECRET=YOUR_OAUTH2_CLIENT_SECRET
   ```

3. `npm run dev` で起動する。起動済みなら再起動する。

ポートやドメインを変える場合は、変更後の `FAVOR_PUBLIC_ORIGIN`（末尾の `/` なし）に `/api/auth/x/callback` を付けたURLをXアプリに登録する。

X認証時のDBは既定で `data/x-sandbox/favor.sqlite`。通常の起動で使う `data/favor.sqlite` とは別になる。保存先は `FAVOR_DATA_DIR` で指定できる。
