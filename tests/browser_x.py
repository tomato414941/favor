"""X OAuth UI regression using isolated, intercepted provider responses only."""
from html import escape
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import expect, sync_playwright


def main():
    base = sys.argv[1]
    artifacts = Path(os.environ.get("COMMISSION_SCREENSHOT_DIR") or tempfile.mkdtemp(prefix="commission-x-browser-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    private_brief = "星の喫茶店を舞台にした、ふたりだけの物語をお願いします。"
    private_tokens = []
    requests = []
    page_errors = []
    oauth_visits = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        def new_context():
            context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ja-JP", accept_downloads=True)
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
            context.on("request", lambda request: requests.append(request))
            context.on("page", lambda page: page.on("pageerror", lambda error: page_errors.append(str(error))))

            def authorize(route):
                request = route.request
                query = parse_qs(urlparse(request.url).query)
                oauth_visits.append(request.url)
                assert query["client_id"] == ["browser-fixture-client"]
                assert query["scope"] == ["tweet.read users.read"]
                assert query["code_challenge_method"] == ["S256"]
                assert query["redirect_uri"] == [f"{base}/api/auth/x/callback"]
                assert "referer" not in request.headers
                assert all(token not in request.url for token in private_tokens)
                links = []
                for code, name in [("sender", "青葉"), ("recipient", "澪"), ("other", "空")]:
                    url = query["redirect_uri"][0] + "?" + urlencode({"state": query["state"][0], "code": code})
                    links.append(f'<p><a href="{escape(url)}">{name}として続ける</a></p>')
                cancel = query["redirect_uri"][0] + "?" + urlencode({"state": query["state"][0], "error": "access_denied"})
                route.fulfill(status=200, content_type="text/html", body=f'<!doctype html><html lang="ja"><meta charset="utf-8"><title>OAuth browser fixture</title><h1>検証用アカウント</h1>{"".join(links)}<p><a href="{escape(cancel)}">確認を中止する</a></p></html>')

            context.route("https://x.com/i/oauth2/authorize**", authorize)
            return context

        def check_copy(page):
            body = page.locator("body").inner_text()
            for phrase in ["TODO", "FIXME", "実装済み", "実装予定", "開発者向け", "設計意図", "PKCE", "OAuth", "ジャンル", "@mio_demo", "作り手で体験", "依頼者で体験", "実際のSNSへの接続や請求はありません"]:
                assert phrase not in body, f"Unwanted application copy: {phrase}"

        def layout(page, name):
            for width in [320, 390, 768, 1280]:
                page.set_viewport_size({"width": width, "height": 900})
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"Overflow: {name} at {width}"
                if width in [390, 1280]:
                    page.screenshot(path=str(artifacts / f"{name}-{width}.png"), full_page=True)
            check_copy(page)

        def login(page, persona, invitation=False):
            page.get_by_role("button", name="Xでアカウントを確認" if invitation else "Xでログイン", exact=True).click()
            expect(page.get_by_role("heading", name="検証用アカウント")).to_be_visible()
            page.get_by_role("link", name=f"{persona}として続ける", exact=True).click()
            page.wait_for_load_state("networkidle")
            assert "auth=" not in page.url and "code=" not in page.url and "flow=" not in page.url

        sender = new_context()
        recipient = new_context()
        opt_out = new_context()
        try:
            page = sender.new_page()
            page.goto(base)
            page.wait_for_load_state("networkidle")
            expect(page.get_by_role("heading", name="いつものアカウントで。")).to_be_visible()
            expect(page.get_by_role("button", name="Xでログイン", exact=True)).to_be_visible()
            assert sender.request.get(f"{base}/api/auth/identity").json() is None
            layout(page, "x-login")
            print("Login controls:", page.get_by_role("button").all_text_contents())

            login(page, "青葉")
            expect(page.get_by_role("heading", name="ここから、はじめよう。")).to_be_visible()
            expect(page.get_by_role("button", name="同意して登録する")).to_be_disabled()
            assert sender.request.get(f"{base}/api/auth/identity").json()["registered"] is False
            assert sender.request.get(f"{base}/api/session").status == 401
            layout(page, "x-registration")
            page.get_by_role("checkbox", name=re.compile("依頼のルールとアカウント情報")).check()
            page.get_by_role("button", name="同意して登録する").click()
            expect(page.get_by_role("heading", name="あなたの依頼", exact=True)).to_be_visible()
            assert sender.request.get(f"{base}/api/session").json()["pointsBalance"] == 0
            assert "commission_session" not in page.evaluate("document.cookie")
            page.get_by_role("button", name="ログアウト", exact=True).click()
            expect(page.get_by_role("button", name="Xでログイン", exact=True)).to_be_visible()
            login(page, "青葉")
            expect(page.get_by_role("heading", name="あなたの依頼", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="同意して登録する")).to_have_count(0)

            def compose(handle, brief):
                page.get_by_role("navigation").get_by_role("button", name="招待を送る", exact=True).click()
                page.get_by_label("相手のXアカウント", exact=True).fill(handle)
                page.get_by_label("依頼内容", exact=True).fill(brief)
                page.get_by_role("radio", name=re.compile("^匿名 ")).check()
                page.get_by_role("checkbox", name=re.compile("^見積もり・打ち合わせ")).check()

            compose("https://x.com/Mio_fixture", private_brief)
            layout(page, "x-invitation-compose")
            original_key = []

            def lose_response(route):
                if route.request.method != "POST":
                    route.continue_()
                    return
                result = route.fetch()
                assert result.status == 201
                original_key.append(route.request.headers["idempotency-key"])
                route.abort("failed")

            page.route("**/api/invitations", lose_response)
            page.get_by_role("button", name="支払いを確保してリンク作成").click()
            expect(page.get_by_role("alert")).to_contain_text("接続を確認できませんでした")
            page.unroute("**/api/invitations", lose_response)
            with page.expect_request(lambda request: request.method == "POST" and request.url.endswith("/api/invitations")) as retry:
                page.get_by_role("button", name="支払いを確保してリンク作成").click()
            assert retry.value.headers["idempotency-key"] == original_key[0]
            expect(page.get_by_role("status")).to_contain_text("作成済みの招待を確認しました")
            assert len(sender.request.get(f"{base}/api/invitations").json()["invitations"]) == 1
            page.on("dialog", lambda dialog: dialog.accept())
            page.get_by_role("button", name="リンクを再発行", exact=True).click()
            expect(page.get_by_label("招待リンク", exact=True)).to_be_visible()
            link = page.get_by_label("招待リンク", exact=True).input_value()
            private_tokens.append(parse_qs(urlparse(link).fragment)["invite"][0])
            page.get_by_role("button", name="コピー", exact=True).click()
            expect(page.get_by_role("status")).to_contain_text("コピーしました")
            assert page.evaluate("navigator.clipboard.readText()") == link

            other_page = recipient.new_page()
            other_page.goto(link)
            other_page.wait_for_load_state("networkidle")
            assert private_brief not in other_page.locator("body").inner_text()
            layout(other_page, "x-invitation-private")
            # A provider cancellation also returns to the same private invitation.
            other_page.get_by_role("button", name="Xでアカウントを確認", exact=True).click()
            other_page.get_by_role("link", name="確認を中止する", exact=True).click()
            expect(other_page.get_by_role("alert")).to_contain_text("確認を中止しました")
            assert other_page.url == link
            assert recipient.request.get(f"{base}/api/auth/identity").json() is None
            login(other_page, "空", invitation=True)
            assert other_page.url == link
            expect(other_page.get_by_role("alert")).to_contain_text("この招待を確認できません")
            assert private_brief not in other_page.locator("body").inner_text()
            assert recipient.request.get(f"{base}/api/auth/identity").json()["registered"] is False
            other_page.get_by_role("button", name="ログアウト", exact=True).click()
            login(other_page, "澪", invitation=True)
            assert other_page.url == link
            expect(other_page.get_by_role("article", name="届いた招待")).to_contain_text(private_brief)
            expect(other_page.get_by_role("article", name="届いた招待")).to_contain_text("匿名の依頼者")
            assert recipient.request.get(f"{base}/api/auth/identity").json()["registered"] is False
            layout(other_page, "x-invitation-verified")
            other_page.get_by_role("checkbox", name=re.compile("^サービスに登録し")).check()
            other_page.get_by_role("button", name="登録して依頼を受ける", exact=True).click()
            expect(other_page.get_by_role("status")).to_contain_text("依頼を受け取りました")
            other_page.get_by_role("link", name="依頼一覧へ", exact=True).click()
            expect(other_page.get_by_role("heading", name="あなたの依頼", exact=True)).to_be_visible()
            detail = other_page.get_by_role("article", name="依頼の詳細")
            expect(detail).to_contain_text("制作中")
            other_page.locator("input[type=file]").set_input_files({"name": "星の物語.txt", "mimeType": "text/plain", "buffer": "ふたりの物語。".encode()})
            other_page.get_by_role("button", name="ファイルを納品", exact=True).click()
            expect(detail).to_contain_text("納品済み")
            layout(other_page, "x-delivered")

            page.get_by_role("navigation").get_by_role("button", name=re.compile("^依頼一覧")).click()
            expect(page.get_by_role("article", name="依頼の詳細")).to_contain_text("納品済み", timeout=10000)
            with page.expect_download() as download:
                page.get_by_role("link", name=re.compile("星の物語.txt")).click()
            assert Path(download.value.path()).read_text() == "ふたりの物語。"

            compose("@sora_fixture", "静かな雨を題材に、自由に作ってください。")
            page.get_by_role("button", name="支払いを確保してリンク作成").click()
            sora_link = page.get_by_role("article", name="@sora_fixtureへの招待").get_by_label("招待リンク", exact=True).input_value()
            private_tokens.append(parse_qs(urlparse(sora_link).fragment)["invite"][0])
            opt_page = opt_out.new_page()
            opt_page.on("dialog", lambda dialog: dialog.accept())
            opt_page.goto(sora_link)
            opt_page.wait_for_load_state("networkidle")
            login(opt_page, "空", invitation=True)
            opt_page.get_by_role("button", name="見送る", exact=True).click()
            expect(opt_page.get_by_role("status")).to_contain_text("見送りました")
            opt_page.get_by_role("button", name="今後の招待を停止する", exact=True).click()
            expect(opt_page.get_by_role("status")).to_contain_text("受信を停止しました")
            assert opt_out.request.get(f"{base}/api/auth/identity").json()["registered"] is False
            layout(opt_page, "x-declined")

            # No invitation token or private brief is sent to X or in an HTTP URL/referrer.
            for request in requests:
                assert all(token not in request.url and token not in request.headers.get("referer", "") for token in private_tokens)
                if request.url.startswith("https://x.com/"):
                    assert private_brief not in (request.post_data or "")
                if request.url.startswith(base) and request.url.endswith("/api/auth/x/start"):
                    assert request.post_data_json == {}
            assert len(oauth_visits) >= 6
            assert not page_errors, page_errors
            print("X browser regression: PASS")
            print("Screenshots:", artifacts)
        except Exception:
            for index, context in enumerate([sender, recipient, opt_out]):
                for tab, page in enumerate(context.pages):
                    page.screenshot(path=str(artifacts / f"failure-{index}-{tab}.png"), full_page=True)
            print("Failure screenshots:", artifacts)
            raise
        finally:
            sender.close()
            recipient.close()
            opt_out.close()
            browser.close()


if __name__ == "__main__":
    main()
