"""Invitation journeys, isolated browser identities and rendered-copy checks."""
import re
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect


def check_invitations(browser, base_url, artifacts):
    contexts = []
    pages = []
    errors = []
    lost_response = {"active": False, "token": None, "key": None}

    def new_page():
        context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ja-JP", accept_downloads=True)
        contexts.append(context)
        page = context.new_page()
        pages.append(page)
        page.on("pageerror", lambda error: errors.append(str(error)))

        def console(message):
            if message.type != "error":
                return
            if lost_response["active"] and "net::ERR_FAILED" in message.text:
                return
            location = message.location.get("url", "")
            # These denials are intentional test cases, not JavaScript/runtime failures.
            if "/api/invitation" in location and ("404" in message.text or "409" in message.text):
                return
            errors.append(message.text)

        page.on("console", console)
        return context, page

    def audit(page, name):
        text = page.locator("body").inner_text()
        for unwanted in ["実装中", "未実装", "TODO", "仕様反映", "開発者向け", "次の作業", "設計意図"]:
            assert unwanted not in text, (name, unwanted)
        assert "ジャンル" not in text
        page.screenshot(path=str(artifacts / f"{name}-desktop.png"), full_page=True)
        for width in [768, 390, 320]:
            page.set_viewport_size({"width": width, "height": 844})
            page.evaluate("document.fonts.ready")
            assert not page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), (name, width)
            if width == 390:
                page.screenshot(path=str(artifacts / f"{name}-mobile.png"), full_page=True)
        page.set_viewport_size({"width": 1280, "height": 900})

    def identity(context):
        return context.request.get(f"{base_url}/api/auth/identity").json()

    def compose(page, handle, brief, visibility="匿名"):
        page.get_by_label("相手のSNSアカウント", exact=True).fill(handle)
        page.get_by_label("依頼内容", exact=True).fill(brief)
        page.get_by_role("radio", name=re.compile(f"^{visibility} ")).check()
        page.get_by_role("checkbox", name=re.compile("^見積もり・打ち合わせ")).check()

    def invitation_card(page, handle):
        return page.get_by_role("article", name=f"{handle}への招待", exact=True)

    def reissue(page, card):
        page.once("dialog", lambda dialog: dialog.accept())
        card.get_by_role("button", name="リンクを再発行", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("リンクを再発行しました")
        return card.get_by_label("招待リンク", exact=True).input_value()

    try:
        sender_context, sender = new_page()
        sender.goto(base_url)
        sender.wait_for_load_state("networkidle")
        sender.get_by_role("navigation").get_by_role("button", name="招待を送る", exact=True).click()
        expect(sender.get_by_role("heading", name="招待リンクを作成", exact=True)).to_be_visible()
        expect(sender.get_by_role("combobox")).to_have_count(0)
        expect(sender.get_by_role("radio", name=re.compile("^ポイント "))).to_have_count(0)
        brief = "招待で届ける、夜の灯台を舞台にした物語をお願いします。"
        compose(sender, "@mio_demo", brief)
        expect(sender.get_by_text("あなたのSNSからリンクを送ると、相手にアカウントが伝わります。サービス内の匿名表示とは別です。", exact=True)).to_be_visible()
        audit(sender, "invitation-compose")

        # A lost creation response must not make another invitation/hold on retry.
        def lose_creation(route):
            if route.request.method != "POST":
                route.continue_()
                return
            result = route.fetch()
            assert result.status == 201
            lost_response["token"] = result.json()["token"]
            lost_response["key"] = route.request.headers["idempotency-key"]
            route.abort("failed")

        lost_response["active"] = True
        sender.route("**/api/invitations", lose_creation)
        sender.get_by_role("button", name="支払いを確保してリンク作成", exact=True).click()
        expect(sender.get_by_role("alert")).to_contain_text("接続を確認できませんでした")
        sender.unroute("**/api/invitations", lose_creation)
        retried_keys = []
        sender.on("request", lambda request: retried_keys.append(request.headers.get("idempotency-key")) if request.method == "POST" and request.url.endswith("/api/invitations") else None)
        sender.get_by_role("button", name="支払いを確保してリンク作成", exact=True).click()
        expect(sender.get_by_role("status")).to_contain_text("作成済みの招待を確認しました")
        lost_response["active"] = False
        assert retried_keys[0] == lost_response["key"]
        data = sender_context.request.get(f"{base_url}/api/invitations").json()["invitations"]
        assert len(data) == 1
        initial = data[0]
        card = invitation_card(sender, "@mio_demo")
        expect(card.get_by_label("招待リンク", exact=True)).to_have_count(0)
        link = reissue(sender, card)
        assert parse_qs(urlparse(link).fragment)["invite"][0] != lost_response["token"]
        sender_context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base_url)
        card.get_by_role("button", name="コピー", exact=True).click()
        expect(sender.get_by_role("status")).to_contain_text("招待リンクをコピーしました")
        assert sender.evaluate("navigator.clipboard.readText()") == link
        audit(sender, "invitation-share")

        recipient_context, recipient = new_page()
        request_urls = []
        def remember_request(request):
            request_urls.extend([request.url, request.headers.get("referer", "")])

        recipient.on("request", remember_request)
        recipient.goto(link)
        recipient.wait_for_load_state("networkidle")
        expect(recipient.get_by_role("heading", name="アカウントを確認", exact=True)).to_be_visible()
        assert identity(recipient_context) is None
        assert brief not in recipient.locator("body").inner_text()
        assert "¥12,000" not in recipient.locator("body").inner_text()
        assert brief not in recipient.content()
        expect(recipient.get_by_role("article", name="届いた招待", exact=True)).to_have_count(0)
        audit(recipient, "invitation-locked")

        recipient.get_by_role("button", name="空のアカウントで確認", exact=True).click()
        expect(recipient.get_by_role("alert")).to_contain_text("この招待を確認できません")
        assert identity(recipient_context)["registered"] is False
        assert brief not in recipient.locator("body").inner_text()
        expect(recipient.get_by_role("button", name="登録して依頼を受ける", exact=True)).to_have_count(0)

        recipient.get_by_role("button", name="澪のアカウントで確認", exact=True).click()
        received = recipient.get_by_role("article", name="届いた招待", exact=True)
        expect(received).to_contain_text(brief)
        expect(received).to_contain_text("匿名の依頼者")
        assert "青葉" not in received.inner_text()
        assert identity(recipient_context)["registered"] is False
        assert recipient_context.request.get(f"{base_url}/api/session").status == 401
        expect(recipient.get_by_role("button", name="登録して依頼を受ける", exact=True)).to_be_disabled()
        audit(recipient, "invitation-verified")

        # Rotation invalidates a link even for a previously authenticated recipient.
        new_link = reissue(sender, card)
        assert new_link != link
        current = sender_context.request.get(f"{base_url}/api/invitations").json()["invitations"][0]
        assert current["expiresAt"] == initial["expiresAt"]
        assert current["deliverBy"] == initial["deliverBy"]
        recipient.reload()
        recipient.wait_for_load_state("networkidle")
        expect(recipient.get_by_role("alert")).to_contain_text("この招待を確認できません")
        expect(received).to_have_count(0)
        assert brief not in recipient.locator("body").inner_text()
        recipient.goto(new_link)
        recipient.wait_for_load_state("networkidle")
        expect(received).to_contain_text(brief)
        recipient.get_by_role("checkbox", name=re.compile("^サービスに登録し")).check()
        recipient.get_by_role("button", name="登録して依頼を受ける", exact=True).click()
        expect(recipient.get_by_role("status")).to_contain_text("依頼を受け取りました")
        assert identity(recipient_context)["registered"] is True
        expect(received).to_contain_text("カード · 支払済み")
        recipient.get_by_role("link", name="依頼一覧へ", exact=True).click()
        expect(recipient.get_by_role("heading", name="届いた依頼", exact=True)).to_be_visible()
        detail = recipient.get_by_role("article", name="依頼の詳細", exact=True)
        expect(detail).to_contain_text(brief)
        expect(detail).to_contain_text("澪 / mio")
        request = recipient_context.request.get(f"{base_url}/api/requests").json()["requests"][0]
        assert request["createdAt"] == initial["createdAt"]
        assert request["deliverBy"] == initial["deliverBy"]
        assert request["viewerRole"] == "creator"
        story = "灯台の明かりが、帰る場所を照らしていた。".encode()
        recipient.get_by_label("納品ファイルを選択", exact=True).set_input_files({"name": "灯台の物語.txt", "mimeType": "text/plain", "buffer": story})
        recipient.get_by_role("button", name="ファイルを納品", exact=True).click()
        expect(detail).to_contain_text("納品済み")
        audit(recipient, "invitation-delivered")
        for invitation_link in [link, new_link]:
            token = parse_qs(urlparse(invitation_link).fragment)["invite"][0]
            assert all(token not in url for url in request_urls), "Invitation token must not enter request URLs or referrers"

        sender.get_by_role("button", name="最新の状態を確認", exact=True).click()
        expect(card).to_contain_text("受諾済み")
        card.get_by_role("button", name="依頼一覧で確認", exact=True).click()
        sent_detail = sender.get_by_role("article", name="依頼の詳細", exact=True)
        expect(sent_detail).to_contain_text(brief)
        with sender.expect_download() as downloaded:
            sent_detail.get_by_role("link", name=re.compile("灯台の物語.txt")).click()
        with open(downloaded.value.path(), "rb") as saved:
            assert saved.read() == story

        sender.get_by_role("navigation").get_by_role("button", name="招待を送る", exact=True).click()
        compose(sender, "@sora_demo", "静かな森の作品をお願いします。", "非表示")
        sender.get_by_role("button", name="支払いを確保してリンク作成", exact=True).click()
        expect(sender.get_by_role("status")).to_contain_text("招待リンクを作成しました")
        sora_link = invitation_card(sender, "@sora_demo").get_by_label("招待リンク", exact=True).input_value()
        sora_context, sora = new_page()
        sora.goto(sora_link)
        sora.wait_for_load_state("networkidle")
        sora.get_by_role("button", name="空のアカウントで確認", exact=True).click()
        expect(sora.get_by_role("article", name="届いた招待", exact=True)).to_contain_text("静かな森")
        sora.once("dialog", lambda dialog: dialog.accept())
        sora.get_by_role("button", name="見送る", exact=True).click()
        expect(sora.get_by_role("status")).to_contain_text("招待を見送りました")
        assert identity(sora_context)["registered"] is False
        expect(sora.get_by_role("article", name="届いた招待", exact=True)).to_contain_text("確保解除済み")
        sora.once("dialog", lambda dialog: dialog.accept())
        sora.get_by_role("button", name="今後の招待を停止する", exact=True).click()
        expect(sora.get_by_role("status")).to_contain_text("招待の受信を停止しました")
        assert identity(sora_context)["registered"] is False
        audit(sora, "invitation-declined")

        sender.get_by_role("button", name="別の招待を作る", exact=True).click()
        compose(sender, "@sora_demo", "受信停止された相手への依頼です。", "非表示")
        sender.get_by_role("button", name="支払いを確保してリンク作成", exact=True).click()
        expect(sender.get_by_role("alert")).to_contain_text("この相手は招待を受け付けていません")
        assert len(sender_context.request.get(f"{base_url}/api/invitations").json()["invitations"]) == 2

        # A registered creator can also be a sender; cancelling releases the invitation.
        sender.get_by_role("button", name="作り手で体験", exact=True).click()
        sender.get_by_role("navigation").get_by_role("button", name="招待を送る", exact=True).click()
        compose(sender, "@mio_demo", "取り消す招待です。", "非表示")
        sender.get_by_role("button", name="支払いを確保してリンク作成", exact=True).click()
        expect(sender.get_by_role("status")).to_contain_text("招待リンクを作成しました")
        sender.once("dialog", lambda dialog: dialog.accept())
        invitation_card(sender, "@mio_demo").get_by_role("button", name="招待を取り消す", exact=True).click()
        expect(sender.get_by_role("status")).to_contain_text("支払確保を解除しました")
        expect(invitation_card(sender, "@mio_demo")).to_contain_text("確保解除済み")
        audit(sender, "invitation-withdrawn")
        assert not errors, errors
        print("PASS: invitation privacy, wrong account, retry without duplicate hold, clipboard, link rotation, registration on acceptance, delivery, download, unregistered decline/opt-out, withdrawal, UI text and responsive layouts")
    except Exception:
        for index, page in enumerate(pages):
            page.screenshot(path=str(artifacts / f"invitation-failure-{index}.png"), full_page=True)
        print("Invitation browser errors:", errors)
        raise
    finally:
        for context in contexts:
            context.close()
