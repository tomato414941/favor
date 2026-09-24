"""Exercise private request links with independent sender/recipient browser sessions."""
import os
import hashlib
import json
from pathlib import Path
import re
import secrets
import sys
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    base = sys.argv[1]
    artifacts = Path(os.environ.get('COMMISSION_SCREENSHOT_DIR') or tempfile.mkdtemp(prefix='commission-links-browser-'))
    artifacts.mkdir(parents=True, exist_ok=True)
    observed = []
    runtime_errors = []
    tokens = []
    run_id = secrets.token_hex(6)
    sender_email = f'aoba_{run_id}@example.test'
    receiver_email = f'mio_{run_id}@example.test'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        contexts = []

        def context():
            result = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='ja-JP', accept_downloads=True)
            contexts.append(result)
            result.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)
            result.on('request', lambda request: observed.append(request))
            result.on('page', lambda page: page.on('pageerror', lambda error: runtime_errors.append(str(error))))
            return result

        def layout(page, name):
            page.wait_for_load_state('networkidle')
            page.evaluate('document.fonts.ready')
            for width in [320, 390, 768, 1280]:
                page.set_viewport_size({'width': width, 'height': 900})
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'{name}: overflow at {width}'
                if width in [390, 1280]:
                    page.screenshot(path=str(artifacts / f'{name}-{width}.png'), full_page=True)
            body = page.locator('body').inner_text()
            for phrase in ['TODO', 'FIXME', '実装予定', '開発者向け', '設計意図', '次の作業']:
                assert phrase not in body, phrase

        def register(page, email):
            form = page.get_by_role('form', name='メールでログイン')
            form.get_by_label('メールアドレス', exact=True).fill(email)
            form.get_by_role('button', name='確認コードを送る', exact=True).click()
            expect(form.get_by_label('確認コード', exact=True)).to_be_visible()
            layout(page, 'verification')
            mail = Path(os.environ['COMMISSION_TEST_MAIL_DIR']) / (hashlib.sha256(email.strip().lower().encode()).hexdigest() + '.json')
            form.get_by_label('確認コード', exact=True).fill(json.loads(mail.read_text())['code'])
            form.get_by_role('button', name='ログイン', exact=True).click()

        def compose(page, brief):
            page.get_by_role('navigation').get_by_role('link', name='依頼を作る', exact=True).click()
            expect(page.get_by_role('heading', name='依頼リンクを作成', exact=True)).to_be_visible()
            page.get_by_label('依頼内容', exact=True).fill(brief)
            page.get_by_label('依頼金額', exact=True).fill('12000')
            page.get_by_role('checkbox', name=re.compile('^見積もり・打ち合わせ')).check()

        def created_url(page, brief):
            card = page.get_by_role('article', name='依頼リンク', exact=True).filter(has_text=brief)
            url = card.get_by_label('依頼リンク', exact=True).input_value()
            tokens.append(url.split('link#')[1])
            return card, url

        sender = context()
        receiver = context()
        visitor = context()
        page = sender.new_page()
        receiving = receiver.new_page()
        visiting = visitor.new_page()
        try:
            page.goto(base)
            expect(page.get_by_role('heading', name='ログイン', exact=True)).to_be_visible()
            layout(page, 'registration')
            register(page, sender_email)
            expect(page.get_by_role('heading', name='依頼リンクを作成')).to_be_visible()
            cookie_name = '__Host-commission_session' if base.startswith('https://') else 'commission_session'
            session_cookie = next(cookie for cookie in sender.cookies() if cookie['name'] == cookie_name)
            assert session_cookie['httpOnly'] and session_cookie['sameSite'] == 'Strict'
            assert session_cookie['secure'] == base.startswith('https://')
            layout(page, 'compose')
            brief = '海辺の喫茶店を舞台にした、ふたりだけの星の物語をお願いします。'
            compose(page, brief)
            failures = []

            def lose_creation(route):
                if route.request.method != 'POST':
                    route.continue_()
                    return
                result = route.fetch()
                assert result.status == 201
                failures.append(route.request.headers['idempotency-key'])
                route.abort('failed')

            page.route('**/api/links', lose_creation)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('接続を確認できませんでした')
            page.unroute('**/api/links', lose_creation)
            retry_keys = []
            page.on('request', lambda request: retry_keys.append(request.headers.get('idempotency-key')) if request.method == 'POST' and request.url.endswith('/api/links') else None)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            expect(page.get_by_role('status')).to_contain_text('作成済みの依頼')
            assert retry_keys[0] == failures[0]
            assert len(sender.request.get(f'{base}/api/links').json()['links']) == 1
            card = page.get_by_role('article', name='依頼リンク').filter(has_text=brief)
            page.once('dialog', lambda dialog: dialog.accept())
            card.get_by_role('button', name='リンクを再発行').click()
            expect(card.get_by_label('依頼リンク', exact=True)).to_be_visible()
            card, url = created_url(page, brief)
            card.get_by_role('button', name='コピー', exact=True).click()
            expect(page.get_by_role('status')).to_contain_text('コピーしました')
            assert page.evaluate('navigator.clipboard.readText()') == url
            layout(page, 'shared-link')

            receiving.goto(url)
            visiting.goto(url)
            detail = receiving.get_by_role('article', name='依頼', exact=True)
            expect(detail).to_contain_text(brief)
            expect(detail).to_contain_text('¥12,000')
            assert receiver.request.get(f'{base}/api/auth/identity').json() is None
            assert visitor.request.get(f'{base}/api/links/by-token').status == 404
            assert brief not in visitor.request.get(base).text()
            layout(receiving, 'unregistered-reader')

            receiving.get_by_role('button', name='受諾へ進む', exact=True).click()
            expect(receiving.get_by_role('form', name='メールでログイン')).to_be_visible()
            layout(receiving, 'recipient-registration')
            register(receiving, receiver_email)
            expect(detail).to_contain_text(f'{receiver_email}として受け取ります')
            detail.get_by_role('checkbox', name='内容・金額・期限を確認しました', exact=True).check()

            def lose_acceptance(route):
                result = route.fetch()
                assert result.status == 200
                route.abort('failed')

            receiving.route('**/api/links/by-token/accept', lose_acceptance)
            detail.get_by_role('button', name='この依頼を受ける', exact=True).click()
            expect(receiving.get_by_role('alert')).to_contain_text('接続を確認できませんでした')
            receiving.unroute('**/api/links/by-token/accept', lose_acceptance)
            detail.get_by_role('button', name='この依頼を受ける', exact=True).click()
            expect(detail).to_contain_text('受諾済み')
            layout(receiving, 'accepted')
            visiting.reload()
            expect(visiting.get_by_role('alert')).to_contain_text('この依頼リンクは利用できません')
            assert len(receiver.request.get(f'{base}/api/requests').json()['requests']) == 1

            detail.get_by_role('link', name='受けた依頼へ', exact=True).click()
            work = receiving.get_by_role('article', name='依頼の詳細', exact=True)
            expect(work).to_contain_text('制作中')
            work.get_by_label('納品ファイルを選択', exact=True).set_input_files({'name': 'empty.txt', 'mimeType': 'text/plain', 'buffer': b''})
            work.get_by_role('button', name='ファイルを納品', exact=True).click()
            expect(work.get_by_role('alert')).to_contain_text('空でないファイル')
            work.get_by_label('納品ファイルを選択', exact=True).set_input_files([
                {'name': '物語.txt', 'mimeType': 'text/plain', 'buffer': '星の物語。'.encode()},
                {'name': 'メモ.txt', 'mimeType': 'text/plain', 'buffer': '波の音とともに。'.encode()},
            ])
            work.get_by_role('button', name='ファイルを納品', exact=True).click()
            expect(work).to_contain_text('納品済み')
            expect(work.locator('.delivery-files').get_by_role('link')).to_have_count(2)
            work.get_by_text('ファイルを再納品する', exact=True).click()
            latest = '海辺の喫茶店には、星を待つ席があった。'.encode()
            png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f000501020007fa0e9e0000000049454e44ae426082')
            work.get_by_label('納品ファイルを選択', exact=True).set_input_files([
                {'name': '完成版.txt', 'mimeType': 'text/plain', 'buffer': latest},
                {'name': 'イラスト.png', 'mimeType': 'image/png', 'buffer': png},
            ])
            work.get_by_role('button', name='ファイルを納品', exact=True).click()
            expect(work).to_contain_text('第2版')
            layout(receiving, 'delivered')

            page.reload()
            page.get_by_role('navigation').get_by_role('link', name=re.compile('^送った依頼')).click()
            delivered = page.get_by_role('article', name='依頼の詳細', exact=True)
            expect(delivered).to_contain_text('第2版')
            with page.expect_download() as download_info:
                delivered.get_by_role('link', name=re.compile('完成版.txt')).click()
            assert Path(download_info.value.path()).read_bytes() == latest
            layout(page, 'download')

            delivered_id = sender.request.get(f'{base}/api/requests').json()['requests'][0]['id']
            text_id = next(f['id'] for f in sender.request.get(f'{base}/api/requests/{delivered_id}').json()['files'] if f['name'] == '完成版.txt')
            visiting.goto(f'{base}/works')
            expect(visiting.get_by_role('heading', name='作品', exact=True)).to_be_visible()
            visiting.get_by_role('link', name=re.compile(brief[:10])).click()
            shown = visiting.get_by_role('article', name='作品', exact=True)
            expect(shown).to_contain_text(brief)
            expect(shown.get_by_role('img', name='イラスト.png')).to_be_visible()
            assert visiting.request.get(f'{base}/api/works/{delivered_id}/files/{text_id}').status == 404
            layout(visiting, 'work')

            receiving.get_by_role('button', name='ログアウト', exact=True).click()
            layout(receiving, 'email-login')
            register(receiving, receiver_email.upper())
            receiving.get_by_role('navigation').get_by_role('link', name=re.compile('^受けた依頼')).click()
            expect(receiving.get_by_role('article', name='依頼の詳細')).to_contain_text('第2版')

            brief2 = '今回は見送りを確認するための依頼です。'
            compose(page, brief2)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            card2, old_url = created_url(page, brief2)
            page.once('dialog', lambda dialog: dialog.accept())
            card2.get_by_role('button', name='リンクを再発行').click()
            expect(card2.get_by_label('依頼リンク', exact=True)).not_to_have_value(old_url)
            card2, new_url = created_url(page, brief2)
            visiting.goto(old_url)
            expect(visiting.get_by_role('alert')).to_contain_text('この依頼リンクは利用できません')
            visiting.goto(new_url)
            expect(visiting.get_by_role('article', name='依頼', exact=True)).to_contain_text(brief2)
            decline_button = visiting.get_by_role('button', name='この依頼を見送る', exact=True)
            confirmation = visiting.get_by_role('group', name='この依頼を見送りますか？', exact=True)
            for cancel in ['button', 'escape']:
                decline_button.click()
                expect(confirmation.get_by_role('button', name='戻る', exact=True)).to_be_focused()
                if cancel == 'button':
                    confirmation.get_by_role('button', name='戻る', exact=True).click()
                else:
                    visiting.keyboard.press('Escape')
                expect(decline_button).to_be_focused()
                current_link = visitor.request.get(f'{base}/api/links/by-token', headers={'X-Commission-Link': new_url.split('link#')[1]})
                assert current_link.json()['state'] == 'pending'
            decline_button.click()
            layout(visiting, 'decline-confirmation')
            confirmation.get_by_role('button', name='見送る', exact=True).click()
            expect(visiting.get_by_role('status')).to_contain_text('依頼を見送りました')
            assert visitor.request.get(f'{base}/api/auth/identity').json() is None
            layout(visiting, 'declined')
            expect(card2).to_contain_text('支払確保を解除しました', timeout=15000)

            brief3 = '取り消す依頼です。'
            compose(page, brief3)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            card3, url3 = created_url(page, brief3)
            page.once('dialog', lambda dialog: dialog.accept())
            card3.get_by_role('button', name='依頼を取り消す', exact=True).click()
            expect(card3).to_contain_text('支払確保を解除しました')
            visiting.goto(url3)
            expect(visiting.get_by_role('alert')).to_contain_text('この依頼リンクは利用できません')
            for request in observed:
                assert all(token not in request.url for token in tokens), request.url
                assert all(token not in request.headers.get('referer', '') for token in tokens)
                assert request.url.startswith(base), request.url
            assert not runtime_errors, runtime_errors
            print('PASS: メール確認・ログイン、秘密リンク作成・再試行・共有、未登録閲覧、受諾の再試行、専用化、納品・再納品・ダウンロード、辞退・再発行・取消、PC・スマホ表示を確認する')
            print(f'Screenshots: {artifacts}')
        except Exception:
            for i, item in enumerate([page, receiving, visiting]):
                item.screenshot(path=str(artifacts / f'failure-{i}.png'), full_page=True)
            print(f'Failure screenshots: {artifacts}')
            raise
        finally:
            for item in contexts:
                item.close()
            browser.close()


if __name__ == '__main__':
    main()
