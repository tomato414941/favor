"""Browser regression against an isolated demo server (see scripts/browser.mjs)."""
import os
from pathlib import Path
import re
import sys
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210"
    artifacts = Path(os.environ.get("COMMISSION_SCREENSHOT_DIR") or tempfile.mkdtemp(prefix="commission-browser-"))
    artifacts.mkdir(parents=True, exist_ok=True)
    console_errors = []
    page_errors = []
    injected_failure = {"active": False, "count": 0, "key": None}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ja-JP", accept_downloads=True)
        page = context.new_page()

        def console(message):
            if message.type == "error" and not (injected_failure["active"] and "net::ERR_FAILED" in message.text):
                console_errors.append(message.text)

        page.on("console", console)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        try:
            page.goto(base_url)
            page.wait_for_load_state("networkidle")
            expect(page.get_by_role("heading", name="好きな創作を、 その人の自由で。")).to_be_visible()
            print("Rendered controls:", page.get_by_role("button").all_text_contents())
            page.screenshot(path=str(artifacts / "desktop-compose.png"), full_page=True)

            def compose(brief, amount="12000", payment="ポイント", visibility="匿名"):
                page.get_by_role("navigation").get_by_role("button", name="依頼を送る", exact=True).click()
                page.get_by_label("ジャンル", exact=True).select_option("text")
                page.get_by_label("依頼内容", exact=True).fill(brief)
                page.get_by_label("依頼金額", exact=True).fill(amount)
                page.get_by_role("radio", name=re.compile(f"^{visibility} ")).check()
                page.get_by_role("radio", name=re.compile(f"^{payment} ")).check()
                page.get_by_role("checkbox", name=re.compile("^見積もり・打ち合わせ")).check()

            def role(name):
                page.get_by_role("button", name=f"{name}で体験", exact=True).click()
                expect(page.get_by_role("button", name=f"{name}で体験", exact=True)).to_have_attribute("aria-pressed", "true")

            def detail():
                return page.get_by_role("article", name="依頼の詳細")

            def session():
                result = context.request.get(f"{base_url}/api/session")
                assert result.ok
                return result.json()

            # Simulate a committed request whose HTTP response never reaches the client.
            compose("海辺の喫茶店を舞台にした、星の物語をお願いします。")

            def lose_first_response(route):
                if route.request.method != "POST":
                    route.continue_()
                    return
                result = route.fetch()
                assert result.status == 201
                injected_failure["count"] += 1
                injected_failure["key"] = route.request.headers["idempotency-key"]
                route.abort("failed")

            injected_failure["active"] = True
            page.route("**/api/requests", lose_first_response)
            page.get_by_role("button", name="支払いを確保して送信", exact=True).click()
            expect(page.get_by_role("alert")).to_contain_text("接続を確認できませんでした")
            page.unroute("**/api/requests", lose_first_response)
            retry_keys = []
            page.on("request", lambda request: retry_keys.append(request.headers.get("idempotency-key")) if request.method == "POST" and request.url.endswith("/api/requests") else None)
            page.get_by_role("button", name="支払いを確保して送信", exact=True).click()
            expect(page.get_by_role("status")).to_contain_text("依頼を送りました")
            injected_failure["active"] = False
            assert injected_failure["count"] == 1
            assert retry_keys[0] == injected_failure["key"], "A retry must reuse its original operation key"
            assert len(context.request.get(f"{base_url}/api/requests").json()["requests"]) == 1
            assert session()["pointsBalance"] == 50000
            assert session()["pointsAvailable"] == 38000
            expect(detail()).to_contain_text("承認待ち")
            page.reload()
            page.wait_for_load_state("networkidle")
            page.get_by_role("navigation").get_by_role("button", name=re.compile("依頼一覧")).click()
            expect(detail()).to_contain_text("星の物語")

            role("作り手")
            expect(page.get_by_role("heading", name="届いた依頼", exact=True)).to_be_visible()
            expect(detail()).to_contain_text("匿名の依頼者")
            assert "あなた" not in detail().inner_text()
            page.get_by_role("button", name="この依頼を承認する", exact=True).click()
            expect(detail()).to_contain_text("制作中")
            expect(detail()).to_contain_text("ポイント · 支払済み")

            # File validation, multiple files, and creator-initiated redelivery.
            page.get_by_label("納品ファイルを選択", exact=True).set_input_files({"name": "empty.txt", "mimeType": "text/plain", "buffer": b""})
            page.get_by_role("button", name="ファイルを納品", exact=True).click()
            expect(detail().get_by_role("alert")).to_contain_text("空でないファイル")
            page.get_by_label("納品ファイルを選択", exact=True).set_input_files([
                {"name": "物語.txt", "mimeType": "text/plain", "buffer": "海辺の喫茶店には、星を待つ席があった。".encode()},
                {"name": "朗読メモ.txt", "mimeType": "text/plain", "buffer": "波の音に合わせて。".encode()},
            ])
            page.get_by_role("button", name="ファイルを納品", exact=True).click()
            expect(detail()).to_contain_text("納品済み")
            expect(detail().get_by_role("link")).to_have_count(2)
            page.get_by_text("ファイルを再納品する", exact=True).click()
            latest = "海辺の喫茶店には、星を待つ席がひとつあった。".encode()
            page.get_by_label("納品ファイルを選択", exact=True).set_input_files({"name": "物語・完成版.txt", "mimeType": "text/plain", "buffer": latest})
            page.get_by_role("button", name="ファイルを納品", exact=True).click()
            expect(detail()).to_contain_text("第2版")
            expect(detail().get_by_role("link")).to_have_count(1)
            page.screenshot(path=str(artifacts / "desktop-delivered.png"), full_page=True)

            role("依頼者")
            assert session()["pointsBalance"] == 38000
            assert session()["pointsAvailable"] == 38000
            page.get_by_role("navigation").get_by_role("button", name=re.compile("依頼一覧")).click()
            with page.expect_download() as download_info:
                detail().get_by_role("link", name=re.compile("物語・完成版.txt")).click()
            download = download_info.value
            assert download.suggested_filename == "物語・完成版.txt"
            assert Path(download.path()).read_bytes() == latest
            expect(detail().get_by_role("button", name="依頼を取り消す", exact=True)).to_have_count(0)

            compose("取消の確認用の依頼です。", amount="5000", visibility="非表示")
            page.get_by_role("button", name="支払いを確保して送信", exact=True).click()
            expect(detail()).to_contain_text("取消の確認用")
            assert session()["pointsAvailable"] == 33000
            page.once("dialog", lambda dialog: dialog.accept())
            page.get_by_role("button", name="依頼を取り消す", exact=True).click()
            expect(detail()).to_contain_text("確保解除済み")
            assert session()["pointsAvailable"] == 38000

            compose("カード返金の確認用の依頼です。", amount="3000", payment="カード", visibility="公開")
            page.get_by_role("button", name="支払いを確保して送信", exact=True).click()
            expect(detail()).to_contain_text("カード返金の確認用")
            role("作り手")
            page.get_by_role("button", name="この依頼を承認する", exact=True).click()
            expect(detail()).to_contain_text("カード · 支払済み")
            page.once("dialog", lambda dialog: dialog.accept())
            page.get_by_role("button", name="制作をギブアップする", exact=True).click()
            expect(detail()).to_contain_text("カードへの返金処理が完了しました")
            page.screenshot(path=str(artifacts / "desktop-refunded.png"), full_page=True)

            role("依頼者")
            # Check actual user-facing copy, including the full form and detail states.
            for unwanted in ["実装中", "未実装", "TODO", "仕様反映", "開発者向け", "次の作業", "下書き"]:
                assert unwanted not in page.locator("body").inner_text()
            assert len(page.locator("select#genre option").all_text_contents()) == 7
            for width in [768, 390, 320]:
                page.set_viewport_size({"width": width, "height": 844})
                page.evaluate("document.fonts.ready")
                overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
                assert not overflow, f"Horizontal overflow at {width}px"
                if width == 390:
                    page.screenshot(path=str(artifacts / "mobile-compose.png"), full_page=True)
                    compose("スマートフォンからの依頼です。", amount="2000", payment="カード", visibility="非表示")
                    page.get_by_role("button", name="支払いを確保して送信", exact=True).click()
                    expect(detail()).to_contain_text("スマートフォンからの依頼")
                    role("作り手")
                    page.once("dialog", lambda dialog: dialog.accept())
                    page.get_by_role("button", name="見送る", exact=True).click()
                    expect(detail()).to_contain_text("作り手が依頼を見送りました")
                    page.screenshot(path=str(artifacts / "mobile-declined.png"), full_page=True)
                    role("依頼者")
            assert not console_errors, console_errors
            assert not page_errors, page_errors
            print("PASS: retry idempotency, anonymous approval, multiple files, redelivery, download, points, withdrawal, card refund, mobile decline, responsive layout, UI copy, browser errors")
            print(f"Screenshots: {artifacts}")
        except Exception:
            page.screenshot(path=str(artifacts / "failure.png"), full_page=True)
            print(f"Failure screenshot: {artifacts / 'failure.png'}")
            print("Browser errors:", console_errors, page_errors)
            raise
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
