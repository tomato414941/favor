# Favor

制作依頼をリンクで共有し、受諾・納品するWebアプリ。

## 起動

Node.js 24.14以上・25未満が必要です。

```sh
npm ci
cp .env.example .env.local
npm run dev
```

<http://127.0.0.1:3210> を開きます。ローカルでは認証・決済ともに模擬処理で動き、外部サービスのキーは不要です。

## 検証

```sh
npm run check
```

ブラウザ検証は `npm run test:browser`。Python 3・Playwright・Chromiumが必要です。
