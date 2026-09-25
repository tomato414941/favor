import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { serve } from './http.js';

test('公開した運営者情報と問い合わせ先をログイン前から確認できるようにする', async () => {
  const store = new Store();
  const app = await serve(new RequestService(store), {
    publicProfile: {
      businessType: 'individual',
      name: '検証用事業者',
      email: 'support@example.test',
      address: '検証用住所',
      phone: '000-0000-0000',
      contactHours: '平日10〜17時',
      discloseOnRequest: false,
    },
  });
  try {
    for (const [path, content] of [
      ['/legal', '検証用事業者'],
      ['/contact', 'support@example.test'],
      ['/terms', '返金やカード会社への異議申し立て'],
      ['/privacy', '情報の開示・訂正・削除'],
    ]) {
      const response = await app.request(path!);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(content!));
    }
    const login = await app.request('/login');
    assert.match(await login.text(), /href="\/privacy"/);
    const cookie = await app.login('fixture@example.test');
    const compose = await app.request('/me/new', { cookie });
    assert.match(await compose.text(), /href="\/legal"/);
  } finally {
    await app.close();
    store.close();
  }
});

test('個人事業者が選択した請求時開示の文言と窓口を表示する', async () => {
  const store = new Store();
  const app = await serve(new RequestService(store), {
    publicProfile: {
      businessType: 'individual',
      email: 'support@example.test',
      contactHours: '平日10〜17時',
      discloseOnRequest: true,
    },
  });
  try {
    const response = await app.request('/legal');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /個人事業/);
    assert.match(html, /請求に応じて開示/);
    assert.match(html, /申込み前に氏名・住所・電話番号を遅滞なくメールで開示/);
    assert.match(html, /mailto:support@example.test/);
  } finally {
    await app.close();
    store.close();
  }
});
