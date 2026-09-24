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
            for phrase in ["TODO", "FIXME", "実装済み", "実装予定", "開発者向け", "設計意図", "PKCE", "OAuth"]:
                assert phrase not in body, f"Unwanted application copy: {phrase}"

        def layout(page, name):
            for width in [320, 390, 768, 1280]:
                page.set_viewport_size({"width": width, "height": 900})
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"Overflow: {name} at {width}"
                if width in [390, 1280]:
                    page.screenshot(path=str(artifacts / f"{name}-{width}.png"), full_page=True)
            check_copy(page)

        def login(page, persona):
            page.get_by_role("button", name="Xでログイン", exact=True).click()
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
            expect(page.get_by_role("heading", name="ログイン", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="Xでログイン", exact=True)).to_be_visible()
            assert sender.request.get(f"{base}/api/auth/identity").json() is None
            layout(page, "x-login")
            print("Login controls:", page.get_by_role("button").all_text_contents())

            login(page, "青葉")
            expect(page.get_by_role("heading", name="登録内容の確認", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="登録する", exact=True)).to_be_enabled()
            assert sender.request.get(f"{base}/api/auth/identity").json()["registered"] is False
            assert sender.request.get(f"{base}/api/session").status == 401
            layout(page, "x-registration")
            page.get_by_role("button", name="登録する", exact=True).click()
            expect(page.get_by_role("heading", name="依頼リンクを作成", exact=True)).to_be_visible()
            page.get_by_label("依頼内容", exact=True).fill(private_brief)
            page.get_by_role("checkbox", name=re.compile("^見積もり・打ち合わせ")).check()
            page.get_by_role("button", name="支払いを確保してリンク作成", exact=True).click()
            card = page.get_by_role("article", name="依頼リンク", exact=True)
            link = card.get_by_label("依頼リンク", exact=True).input_value()
            private_tokens.append(link.split("#link=")[1])
            layout(page, "x-request-link")

            receiving = recipient.new_page()
            receiving.goto(link)
            expect(receiving.get_by_role("article", name="依頼", exact=True)).to_contain_text(private_brief)
            assert recipient.request.get(f"{base}/api/auth/identity").json() is None
            receiving.get_by_role("button", name="受諾へ進む").click()
            receiving.get_by_role("button", name="Xでログイン", exact=True).click()
            receiving.get_by_role("link", name="確認を中止する").click()
            expect(receiving.get_by_role("alert")).to_contain_text("Xでの確認を中止しました")
            assert receiving.url == link
            receiving.get_by_role("button", name="受諾へ進む").click()
            login(receiving, "澪")
            expect(receiving.get_by_role("article", name="依頼", exact=True)).to_contain_text("澪として受け取ります")
            assert receiving.url == link
            receiving.get_by_role("checkbox", name="内容・金額・期限を確認しました", exact=True).check()
            receiving.get_by_role("button", name="この依頼を受ける", exact=True).click()
            expect(receiving.get_by_role("article", name="依頼", exact=True)).to_contain_text("受諾済み")
            layout(receiving, "x-received")
            receiving.get_by_role("link", name="受けた依頼へ", exact=True).click()
            detail = receiving.get_by_role("article", name="依頼の詳細", exact=True)
            expect(detail).to_contain_text("制作中")
            assert recipient.request.get(f"{base}/api/auth/identity").json()["registered"] is True
            detail.get_by_label("納品ファイルを選択", exact=True).set_input_files({"name": "作品.txt", "mimeType": "text/plain", "buffer": "夜空の物語".encode()})
            detail.get_by_role("button", name="ファイルを納品", exact=True).click()
            expect(detail).to_contain_text("納品済み")
            layout(receiving, "x-delivered")
            for request in requests:
                assert all(token not in request.url for token in private_tokens)
                assert all(token not in request.headers.get("referer", "") for token in private_tokens)
            assert not page_errors, page_errors
            print("PASS: 任意のXログインでも秘密リンクに戻り、受諾・納品する")
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
