# Favor

制作依頼をリンクで共有し、受諾・納品するWebアプリ。決済は模擬処理です。

## 起動

Node.js 24.14以上・25未満が必要です。

```sh
npm ci
npm run dev
```

<http://127.0.0.1:3211> を開きます。

## 検証

```sh
npm run check
```

ブラウザ検証は `npm run test:browser`。Python 3・Playwright・Chromiumが必要です。
