"""Exercise private request links with independent sender/recipient browser sessions."""
import os
import hashlib
import json
from pathlib import Path
import re
import secrets
from urllib.parse import parse_qs
import sys
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    base = sys.argv[1]
    artifacts = Path(os.environ.get('FAVOR_SCREENSHOT_DIR') or tempfile.mkdtemp(prefix='favor-links-browser-'))
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
            form.get_by_role('button', name='ログイン', exact=True).click()

        def compose(page, brief):
            page.get_by_role('navigation').get_by_role('link', name='お願いを書く', exact=True).click()
            expect(page.get_by_role('heading', name='お願いを書く', exact=True)).to_be_visible()
            page.get_by_label('内容', exact=True).fill(brief)
            page.get_by_label('金額', exact=True).fill('12000')

        def review(page):
            page.get_by_role('button', name='確認へ', exact=True).click()
            expect(page.get_by_role('heading', name='内容の確認', exact=True)).to_be_focused()
            page.get_by_role('checkbox', name='内容・金額・条件を確認しました', exact=True).check()

        def confirm_action(scope, label, question):
            scope.get_by_role('button', name=label, exact=True).click()
            confirmation = scope.get_by_role('group', name=question, exact=True)
            expect(confirmation.get_by_role('button', name='戻る', exact=True)).to_be_focused()
            confirmation.get_by_role('button', name=label, exact=True).click()

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
            expect(page.get_by_role('heading', name='公開作品', exact=True)).to_be_visible()
            layout(page, 'home')
            page.get_by_role('link', name='作品を見る', exact=True).click()
            expect(page).to_have_url(re.compile(r'/works$'))
            expect(page.get_by_role('heading', name='公開作品', exact=True)).to_be_visible()
            page.go_back()
            expect(page).to_have_url(re.compile(r'/$'))
            page.get_by_role('link', name='ログイン', exact=True).click()
            expect(page.get_by_role('form', name='メールでログイン')).to_be_visible()
            page.go_back()
            page.get_by_role('link', name='お願いを書く', exact=True).click()
            expect(page.get_by_role('heading', name='ログイン', exact=True)).to_be_visible()
            layout(page, 'registration')
            register(page, sender_email)
            expect(page.get_by_role('heading', name='お願いを書く')).to_be_visible()
            cookie_name = '__Host-favor_session' if base.startswith('https://') else 'favor_session'
            session_cookie = next(cookie for cookie in sender.cookies() if cookie['name'] == cookie_name)
            assert session_cookie['httpOnly'] and session_cookie['sameSite'] == 'Strict'
            assert session_cookie['secure'] == base.startswith('https://')
            layout(page, 'compose')
            brief = '海辺の喫茶店を舞台にした、ふたりだけの星の物語をお願いします。'
            compose(page, brief)
            review(page)
            expect(page.locator('.review-brief')).to_have_text(brief)
            expect(page.locator('.review-facts')).to_contain_text('¥12,000')
            assert len(sender.request.get(f'{base}/api/links').json()['links']) == 0
            layout(page, 'review')
            page.get_by_role('button', name='編集に戻る', exact=True).click()
            expect(page.get_by_label('内容', exact=True)).to_have_value(brief)
            expect(page.get_by_label('金額', exact=True)).to_have_value('12000')
            review(page)
            failures = []

            def operation_key(request):
                return parse_qs(request.post_data or '').get('key', [None])[0]

            def lose_creation(route):
                if route.request.method != 'POST':
                    route.continue_()
                    return
                result = route.fetch()
                assert result.status == 200
                failures.append(operation_key(route.request))
                route.abort('failed')

            page.route('**/me/new.data', lose_creation)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('接続を確認できませんでした')
            page.unroute('**/me/new.data', lose_creation)
            retry_keys = []
            page.on('request', lambda request: retry_keys.append(operation_key(request)) if request.method == 'POST' and request.url.endswith('/me/new.data') else None)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            expect(page.get_by_role('status')).to_contain_text('作成済みの依頼')
            assert failures[0] and retry_keys[0] == failures[0]
            assert len(sender.request.get(f'{base}/api/links').json()['links']) == 1
            card = page.get_by_role('article', name='依頼リンク').filter(has_text=brief)
            confirm_action(card, 'リンクを再発行', 'リンクを再発行しますか？')
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
            expect(detail.locator('.detail-facts > div').filter(has=detail.page.locator('dt', has_text='利用料（税込）'))).to_contain_text('−¥960')
            expect(detail.locator('.detail-facts > div').filter(has=detail.page.locator('dt', has_text='受取額'))).to_contain_text('¥11,040')
            assert receiver.request.get(f'{base}/api/auth/identity').json() is None
            assert visitor.request.get(f'{base}/api/links/by-token').status == 404
            assert brief not in visitor.request.get(base).text()
            layout(receiving, 'unregistered-reader')

            receiving.get_by_role('button', name='受ける', exact=True).click()
            expect(receiving.get_by_role('form', name='メールでログイン')).to_be_visible()
            layout(receiving, 'recipient-registration')
            register(receiving, receiver_email)
            expect(detail).to_contain_text(f'{receiver_email}として受け取ります')
            expect(detail.get_by_role('button', name='受ける', exact=True)).to_be_disabled()
            layout(receiving, 'recipient-onboarding')
            # The stand-in for Stripe returns straight to the payouts page, which leads back to the request.
            with receiving.expect_navigation(url='**/me/payouts?onboarding=return'):
                detail.get_by_role('button', name='受取先を登録', exact=True).click()
            expect(detail.get_by_role('checkbox', name='内容・金額・期限を確認しました', exact=True)).to_be_visible()
            expect(receiving).to_have_url(url)
            assert receiving.evaluate("sessionStorage.getItem('favor.recipient-return')") is None
            expect(detail.get_by_role('heading', name='売上の受け取り')).not_to_be_visible()
            detail.get_by_role('checkbox', name='内容・金額・期限を確認しました', exact=True).check()

            def lose_acceptance(route):
                if route.request.method != 'POST':
                    route.continue_()
                    return
                result = route.fetch()
                assert result.status == 200
                route.abort('failed')

            receiving.route('**/link.data', lose_acceptance)
            detail.get_by_role('button', name='受ける', exact=True).click()
            expect(receiving.get_by_role('alert')).to_contain_text('接続を確認できませんでした')
            receiving.unroute('**/link.data', lose_acceptance)
            # The page re-reads the link after the lost answer, so the acceptance already shows.
            expect(detail).to_contain_text('受諾済み')
            expect(detail.get_by_role('button', name='受ける', exact=True)).to_have_count(0)
            layout(receiving, 'accepted')
            visiting.reload()
            expect(visiting.get_by_role('alert')).to_contain_text('この依頼リンクは利用できません')
            assert len(receiver.request.get(f'{base}/api/requests').json()['requests']) == 1

            detail.get_by_role('link', name='受けた依頼へ', exact=True).click()
            work = receiving.get_by_role('article', name='依頼の詳細', exact=True)
            expect(work).to_contain_text('制作中')
            expect(work.locator('.detail-facts > div').filter(has=work.page.locator('dt', has_text='受取額'))).to_contain_text('¥11,040')
            work.get_by_label('納品ファイルを選択', exact=True).set_input_files({'name': 'empty.txt', 'mimeType': 'text/plain', 'buffer': b''})
            work.get_by_role('button', name='作品を渡す', exact=True).click()
            expect(work.get_by_role('alert')).to_contain_text('空でないファイル')
            work.get_by_label('納品ファイルを選択', exact=True).set_input_files([
                {'name': '物語.txt', 'mimeType': 'text/plain', 'buffer': '星の物語。'.encode()},
                {'name': 'メモ.txt', 'mimeType': 'text/plain', 'buffer': '波の音とともに。'.encode()},
            ])
            work.get_by_role('button', name='作品を渡す', exact=True).click()
            expect(work).to_contain_text('納品済み')
            expect(work).to_contain_text('売上をStripeに反映しました')
            expect(work.locator('.delivery-files').get_by_role('link')).to_have_count(2)
            work.get_by_role('button', name='作品を差し替える', exact=True).click()
            latest = '海辺の喫茶店には、星を待つ席があった。'.encode()
            png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f000501020007fa0e9e0000000049454e44ae426082')
            work.get_by_label('納品ファイルを選択', exact=True).set_input_files([
                {'name': '完成版.txt', 'mimeType': 'text/plain', 'buffer': latest},
                {'name': 'イラスト.png', 'mimeType': 'image/png', 'buffer': png},
            ])
            work.get_by_role('button', name='差し替える', exact=True).click()
            expect(work).to_contain_text('第2版')
            layout(receiving, 'delivered')
            receiving.get_by_role('button', name=re.compile(receiver_email)).click()
            receiving.get_by_role('menuitem', name='受取先', exact=True).click()
            payout = receiving.get_by_role('region', name='売上の受け取り', exact=True)
            expect(payout).to_contain_text('8%（税込）')
            expect(payout.locator('.detail-facts > div').filter(has=receiving.locator('dt', has_text='振込手数料'))).to_contain_text('無料')
            expect(payout).to_contain_text('毎週金曜日')
            layout(receiving, 'payouts')
            receiving.go_back()
            expect(work).to_contain_text('第2版')

            page.reload()
            page.get_by_role('navigation').get_by_role('link', name=re.compile('^送った依頼')).click()
            layout(page, 'sent-list')
            page.get_by_role('list', name='送った依頼', exact=True).get_by_role('link', name=re.compile(brief[:10])).click()
            delivered = page.get_by_role('article', name='依頼の詳細', exact=True)
            expect(delivered).to_contain_text('第2版')
            with page.expect_download() as download_info:
                delivered.get_by_role('link', name=re.compile('完成版.txt')).click()
            assert Path(download_info.value.path()).read_bytes() == latest
            layout(page, 'download')

            delivered_id = sender.request.get(f'{base}/api/requests').json()['requests'][0]['id']
            text_id = next(f['id'] for f in sender.request.get(f'{base}/api/requests/{delivered_id}').json()['files'] if f['name'] == '完成版.txt')
            visiting.goto(base)
            expect(visiting.get_by_role('heading', name='公開作品', exact=True)).to_be_visible()
            expect(visiting.get_by_role('link', name=re.compile(brief[:10]))).to_be_visible()
            layout(visiting, 'home-with-work')
            visiting.get_by_role('link', name='作品を見る', exact=True).click()
            expect(visiting).to_have_url(re.compile(r'/works$'))
            expect(visiting.get_by_role('heading', name='公開作品', exact=True)).to_be_visible()
            visiting.get_by_role('link', name=re.compile(brief[:10])).click()
            shown = visiting.get_by_role('article', name='作品', exact=True)
            expect(shown).to_contain_text(brief)
            expect(shown.get_by_role('img', name='イラスト.png')).to_be_visible()
            assert visiting.request.get(f'{base}/works/{delivered_id}/files/{text_id}').status == 404
            layout(visiting, 'work')

            receiving.get_by_role('button', name=re.compile(receiver_email)).click()
            receiving.get_by_role('menuitem', name='ログアウト', exact=True).click()
            expect(receiving.get_by_role('link', name='ログイン', exact=True)).to_be_visible()
            receiving.get_by_role('link', name='ログイン', exact=True).click()
            layout(receiving, 'email-login')
            register(receiving, receiver_email.upper())
            receiving.get_by_role('navigation').get_by_role('link', name=re.compile('^受けた依頼')).click()
            receiving.get_by_role('list', name='受けた依頼', exact=True).get_by_role('link', name=re.compile(brief[:10])).click()
            expect(receiving.get_by_role('article', name='依頼の詳細')).to_contain_text('第2版')

            brief2 = '今回は見送りを確認するための依頼です。'
            compose(page, brief2)
            review(page)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            card2, old_url = created_url(page, brief2)
            confirm_action(card2, 'リンクを再発行', 'リンクを再発行しますか？')
            expect(card2.get_by_label('依頼リンク', exact=True)).not_to_have_value(old_url)
            card2, new_url = created_url(page, brief2)
            visiting.goto(old_url)
            expect(visiting.get_by_role('alert')).to_contain_text('この依頼リンクは利用できません')
            visiting.goto(new_url)
            expect(visiting.get_by_role('article', name='依頼', exact=True)).to_contain_text(brief2)
            decline_button = visiting.get_by_role('button', name='見送る', exact=True)
            confirmation = visiting.get_by_role('group', name='この依頼を見送りますか？', exact=True)
            for cancel in ['button', 'escape']:
                decline_button.click()
                expect(confirmation.get_by_role('button', name='戻る', exact=True)).to_be_focused()
                if cancel == 'button':
                    confirmation.get_by_role('button', name='戻る', exact=True).click()
                else:
                    visiting.keyboard.press('Escape')
                expect(decline_button).to_be_focused()
                current_link = visitor.request.get(f'{base}/api/links/by-token', headers={'X-Favor-Link': new_url.split('link#')[1]})
                assert current_link.json()['state'] == 'pending'
            decline_button.click()
            layout(visiting, 'decline-confirmation')
            confirmation.get_by_role('button', name='見送る', exact=True).click()
            expect(visiting.get_by_role('status')).to_contain_text('依頼を見送りました')
            assert visitor.request.get(f'{base}/api/auth/identity').json() is None
            layout(visiting, 'declined')
            expect(card2).to_contain_text('仮押さえを解除しました', timeout=15000)

            brief4 = 'メールで届ける匿名の依頼です。'
            compose(page, brief4)
            page.get_by_role('radio', name='メール', exact=True).check()
            page.get_by_label('宛先のメールアドレス', exact=True).fill(receiver_email)
            page.get_by_role('radio', name='匿名').check()
            layout(page, 'compose-mail')
            review(page)
            expect(page.locator('.review-facts')).to_contain_text(receiver_email)
            expect(page.locator('.review-facts')).to_contain_text('匿名')
            page.get_by_role('button', name='編集に戻る', exact=True).click()
            expect(page.get_by_label('宛先のメールアドレス', exact=True)).to_have_value(receiver_email)
            expect(page.get_by_role('radio', name='匿名')).to_be_checked()
            review(page)
            layout(page, 'review-mail')
            page.get_by_role('button', name='メールで送る', exact=True).click()
            expect(page.get_by_role('status')).to_contain_text(f'{receiver_email}へ送りました')
            card4 = page.get_by_role('article', name='依頼リンク').filter(has_text=brief4)
            expect(card4).to_contain_text(receiver_email)
            expect(card4.get_by_role('button', name='メールを送り直す')).to_be_visible()
            mail4 = json.loads((Path(os.environ['FAVOR_TEST_MAIL_DIR']) / (hashlib.sha256(receiver_email.encode()).hexdigest() + '.json')).read_text())
            assert '匿名の依頼者' in mail4['text']
            url4 = re.search(r'https?://\S+/link#[A-Za-z0-9_-]{43}', mail4['text']).group(0)
            tokens.append(url4.split('link#')[1])
            visiting.goto(url4)
            expect(visiting.get_by_role('heading', name='宛先のメールアドレスでログイン')).to_be_visible()
            layout(visiting, 'mailed-login')
            receiving.goto(url4)
            mailed = receiving.get_by_role('article', name='依頼', exact=True)
            expect(mailed).to_contain_text(brief4)
            expect(mailed).to_contain_text('匿名の依頼者から')
            expect(receiving.get_by_role('button', name='今後、メールでの依頼を受け取らない')).to_be_visible()
            layout(receiving, 'mailed-link')
            confirm_action(card4, '取り消す', 'この依頼を取り消しますか？')
            expect(card4).to_contain_text('仮押さえを解除しました')

            brief3 = '取り消す依頼です。'
            compose(page, brief3)
            review(page)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            card3, url3 = created_url(page, brief3)
            card3.get_by_role('button', name='取り消す', exact=True).click()
            page.keyboard.press('Escape')
            expect(card3.get_by_role('button', name='取り消す', exact=True)).to_be_focused()
            active_link = sender.request.get(f'{base}/api/links').json()['links']
            assert next(link for link in active_link if link['brief'] == brief3)['state'] == 'pending'
            confirm_action(card3, '取り消す', 'この依頼を取り消しますか？')
            expect(card3).to_contain_text('仮押さえを解除しました')
            visiting.goto(url3)
            expect(visiting.get_by_role('alert')).to_contain_text('この依頼リンクは利用できません')
            brief5 = '受けたあとで中止する依頼です。'
            compose(page, brief5)
            review(page)
            page.get_by_role('button', name='リンクを作成', exact=True).click()
            _, url5 = created_url(page, brief5)
            receiving.goto(url5)
            receiving.get_by_role('checkbox', name='内容・金額・期限を確認しました', exact=True).check()
            receiving.get_by_role('button', name='受ける', exact=True).click()
            receiving.get_by_role('link', name='受けた依頼へ', exact=True).click()
            stopped = receiving.get_by_role('article', name='依頼の詳細', exact=True)
            stopped.get_by_role('button', name='中止する', exact=True).click()
            layout(receiving, 'cancel-confirmation')
            receiving.keyboard.press('Escape')
            expect(stopped.get_by_role('button', name='中止する', exact=True)).to_be_focused()
            expect(stopped).to_contain_text('制作中')
            confirm_action(stopped, '中止する', 'この依頼を中止しますか？')
            expect(stopped).to_contain_text('仮押さえを解除しました')
            layout(receiving, 'cancelled')
            page.get_by_role('navigation').get_by_role('link', name=re.compile('^送った依頼')).click()
            layout(page, 'sent-list-many')
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
