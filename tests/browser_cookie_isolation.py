"""別サイトから親ドメインにCookieを設定されても、本人の認証と依頼の所有権を保持する。"""
import http.cookies
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright


def main():
    origin = 'https://commission.example.test'
    other_origin = 'https://other.example.test'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    backend = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='commission-cookie-isolation-') as data:
        environment = {**os.environ, 'COMMISSION_PUBLIC_ORIGIN': origin, 'COMMISSION_PORT': str(port),
                       'COMMISSION_DATA_DIR': data, 'COMMISSION_AUTH_MODE': 'email', 'COMMISSION_TRUST_PROXY': 'none'}
        server = subprocess.Popen([shutil.which('node'), '--import', 'tsx', 'tests/browser_email_server.ts'],
                                  cwd=Path(__file__).resolve().parents[1], env=environment,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def api(path, body=None, cookie=None):
            headers = {'Host': urllib.parse.urlparse(origin).netloc, 'Origin': origin, 'X-Commission-Action': '1'}
            if cookie:
                headers['Cookie'] = cookie
            if body is not None:
                headers['Content-Type'] = 'application/json'
            request = urllib.request.Request(backend + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
            return urllib.request.urlopen(request, timeout=5)

        try:
            for _ in range(50):
                try:
                    with api('/api/health') as response:
                        assert response.status == 200
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise AssertionError('Cookie isolation test server did not start')
            def code(email):
                mail = Path(data) / 'mail' / (hashlib.sha256(email.encode()).hexdigest() + '.json')
                return json.loads(mail.read_text())['code']

            with api('/api/auth/email/start', {'email': 'other@example.test'}) as response:
                parsed = http.cookies.SimpleCookie()
                parsed.load(response.headers['Set-Cookie'])
                proof = '; '.join(f'{name}={item.value}' for name, item in parsed.items())
            with api('/api/auth/email/verify', {'code': code('other@example.test')}, proof) as response:
                parsed = http.cookies.SimpleCookie()
                for value in response.headers.get_all('Set-Cookie'):
                    parsed.load(value)
                cookie_name = '__Host-commission_session'
                other_session = parsed[cookie_name].value
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                context = browser.new_context()
                unexpected_origins = []

                def route_request(route):
                    request = route.request
                    parsed = urllib.parse.urlparse(request.url)
                    request_origin = f'{parsed.scheme}://{parsed.netloc}'
                    if request_origin == other_origin:
                        route.fulfill(status=200, content_type='text/html', body='<html><body>Cookie scope probe</body></html>')
                    elif request_origin == origin:
                        headers = {**request.headers, 'Host': parsed.netloc}
                        headers.pop('accept-encoding', None)
                        local = urllib.request.Request(backend + parsed.path + (('?' + parsed.query) if parsed.query else ''),
                                                       method=request.method, data=request.post_data_buffer, headers=headers)
                        try:
                            response = urllib.request.urlopen(local, timeout=5)
                        except urllib.error.HTTPError as error:
                            response = error
                        with response:
                            route.fulfill(status=response.status, headers=dict(response.headers.items()), body=response.read())
                    else:
                        unexpected_origins.append(request_origin)
                        route.abort()

                # Both HTTPS origins terminate in this isolated test, never on the network.
                context.route('**/*', route_request)
                page = context.new_page()
                page.goto(origin)
                page.wait_for_load_state('networkidle')
                credentials = {'email': 'original@example.test'}

                def post(path, body):
                    return page.evaluate('''async ({path, body}) => {
                        const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json',
                            'X-Commission-Action':'1', 'Idempotency-Key':crypto.randomUUID()}, body:JSON.stringify(body)});
                        return {status: response.status, body: await response.json()};
                    }''', {'path': path, 'body': body})

                assert post('/api/auth/email/start', credentials)['status'] == 200
                registration = post('/api/auth/email/verify', {'code': code(credentials['email'])})
                assert registration['status'] == 200
                original_cookie = next(cookie for cookie in context.cookies() if cookie['name'] == cookie_name)
                page.goto(other_origin)
                page.evaluate('''({name, token}) => {
                    for (const cookieName of [name, 'commission_session']) {
                        for (const path of ['/', '/api']) {
                            document.cookie = cookieName + '=' + token + '; Domain=example.test; Path=' + path + '; Secure; SameSite=Strict';
                        }
                    }
                }''', {'name': cookie_name, 'token': other_session})
                page.goto(origin)
                page.wait_for_load_state('networkidle')
                identity = page.evaluate("async () => (await fetch('/api/auth/identity')).json()")
                assert identity['email'] == credentials['email']
                created = post('/api/links', {'brief': 'Cookie分離を確認するテスト依頼です。', 'amount': 12000,
                                              'visibility': 'hidden', 'nsfw': False, 'agreeToRules': True})
                assert created['status'] == 201
                with api('/api/links', cookie=f"{cookie_name}={original_cookie['value']}") as response:
                    assert json.load(response)['links'][0]['id'] == created['body']['link']['id']
                with api('/api/links', cookie=f'{cookie_name}={other_session}') as response:
                    assert json.load(response)['links'] == []
                assert post('/api/auth/logout', {})['status'] == 200
                assert page.evaluate("async () => (await fetch('/api/auth/identity')).json()") is None
                assert post('/api/auth/email/start', credentials)['status'] == 200
                logged_in = post('/api/auth/email/verify', {'code': code(credentials['email'])})
                assert logged_in['status'] == 200
                assert logged_in['body']['email'] == credentials['email']
                assert not unexpected_origins, unexpected_origins
                context.close()
                browser.close()
                print('PASS: 親ドメインへのCookie設定を受けても、本人の認証・依頼の所有権・ログアウトと再ログインを保護する')
        finally:
            server.terminate()
            server.wait(timeout=5)


if __name__ == '__main__':
    main()
