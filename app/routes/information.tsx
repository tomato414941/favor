import { Link } from 'react-router';
import type { Route } from './+types/information';
import { PLATFORM_FEE_PERCENT } from '../../src/shared';
import { SiteHeader } from '../components/Header';
import { DemoBanner, Footer } from '../components/ui';
import { favorOf } from '../server/context';
import { useSite } from '../root';

const titles = {
  legal: '特定商取引法に基づく表記',
  contact: 'お問い合わせ',
  privacy: 'プライバシーポリシー',
  terms: '利用規約',
};
type Page = keyof typeof titles;
export async function loader({ context, params }: Route.LoaderArgs) {
  const favor = favorOf(context);
  if (!Object.hasOwn(titles, params.page) || !favor.publicProfile)
    throw new Response(null, { status: 404 });
  const page = params.page as Page;
  const policy = favor.service.policy;
  return {
    page,
    title: titles[page],
    profile: favor.publicProfile,
    terms: {
      acceptanceDays:
        Math.min(policy.acceptanceMs, policy.deliveryMs, policy.authorizationMs) / 86400000,
      deliveryDays: policy.deliveryMs / 86400000,
    },
  };
}
export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData?.title ?? 'Favor'} · Favor` },
];

export default function Information({
  loaderData: { page, title, profile, terms },
}: Route.ComponentProps) {
  const { identity } = useSite();
  const email = <a href={`mailto:${profile.email}`}>{profile.email}</a>;
  const disclosure = '請求があれば、申込み前に氏名・住所・電話番号を遅滞なくメールで開示します。';
  const cancellation = (
    <>
      <p>
        依頼者による取消は受諾前まで可能です。作り手の辞退・中止、または期限切れの場合は、カードの仮押さえを解除します。
      </p>
      <p>
        受諾後は依頼者都合での取消、納品後は好みやイメージの違いによる返金を受け付けていません。二重決済やファイルの不具合などは、
        {email}へご連絡ください。法令上認められる解除・返金の権利を制限するものではありません。
      </p>
    </>
  );
  return (
    <>
      <DemoBanner />
      <SiteHeader identity={identity} active={null} />
      <main className="shell information-page">
        <h1>{title}</h1>
        {page === 'contact' && (
          <>
            <p>{email}</p>
            <p>{profile.contactHours}</p>
            <p>依頼についてのお問い合わせには、ログイン後の依頼詳細ページのURLを添えてください。</p>
            {profile.discloseOnRequest && <p>{disclosure}</p>}
          </>
        )}
        {page === 'legal' && (
          <>
            <dl className="business-facts">
              <div>
                <dt>運営者</dt>
                <dd>{profile.name ?? '請求に応じて開示'}</dd>
              </div>
              <div>
                <dt>事業形態</dt>
                <dd>{profile.businessType === 'individual' ? '個人事業' : '法人'}</dd>
              </div>
              {profile.representative && (
                <div>
                  <dt>運営責任者</dt>
                  <dd>{profile.representative}</dd>
                </div>
              )}
              <div>
                <dt>所在地</dt>
                <dd>{profile.address ?? '請求に応じて開示'}</dd>
              </div>
              <div>
                <dt>電話番号</dt>
                <dd>{profile.phone ?? '請求に応じて開示'}</dd>
              </div>
              <div>
                <dt>メールアドレス</dt>
                <dd>{email}</dd>
              </div>
              <div>
                <dt>お問い合わせ受付</dt>
                <dd>{profile.contactHours}</dd>
              </div>
              <div>
                <dt>料金</dt>
                <dd>
                  依頼の確認画面に表示する金額。作り手の受取額から利用料{PLATFORM_FEE_PERCENT}
                  %（税込、1円未満切捨て）を差し引きます。
                </dd>
              </div>
              <div>
                <dt>その他の費用</dt>
                <dd>インターネット接続にかかる通信料は利用者の負担です。</dd>
              </div>
              <div>
                <dt>支払方法・時期</dt>
                <dd>クレジットカード。作成時に利用枠を仮押さえし、納品時に支払いを確定します。</dd>
              </div>
              <div>
                <dt>提供時期</dt>
                <dd>
                  納品期限は作成から最長{terms.deliveryDays}
                  日以内です。カードの仮押さえ期限によって短くなります。作成後の依頼画面に確定した期限を表示し、納品後にファイルをダウンロードできます。
                </dd>
              </div>
            </dl>
            {profile.discloseOnRequest && (
              <p>
                {disclosure}窓口は{email}です。
              </p>
            )}
            <h2>取消・返金</h2>
            {cancellation}
            <h2>動作環境</h2>
            <p>
              JavaScriptとCookieが有効な、最新版のChrome・Safari・Firefox・Edgeをご利用ください。
            </p>
          </>
        )}
        {page === 'terms' && (
          <>
            <p>この規約は、Favorを通じて依頼を送る方と、依頼を受ける方に適用します。</p>
            <h2>依頼と納品</h2>
            <p>
              作り手は受ける依頼を選べます。表現や仕上がりは作り手に任せ、見積もり・打ち合わせ・修正依頼は行いません。作り手は納品前に制作を中止できます。
            </p>
            <p>
              受諾期限は作成から{terms.acceptanceDays}日以内、納品期限は最長{terms.deliveryDays}
              日以内です。カードの仮押さえ期限によって短くなるため、依頼画面に表示される期限をご確認ください。
            </p>
            <h2>支払いと受取</h2>
            <p>
              依頼の作成時にカードの利用枠を仮押さえし、納品時に支払いを確定します。作り手はStripeで受取先を登録します。利用料は依頼額の
              {PLATFORM_FEE_PERCENT}%（税込、1円未満切捨て）で、受取額から差し引きます。
            </p>
            <p>
              返金やカード会社への異議申し立てがある場合は、送金を保留し、結果に応じて売上を調整します。送金済みの場合も、取消分を受取先の残高から回収することがあります。
            </p>
            <h2>取消・返金</h2>
            {cancellation}
            <h2>作品と公開範囲</h2>
            <p>
              作品の著作権は作り手に帰属します。権利の譲渡を含みません。Favor内での公開範囲は依頼時の設定に従います。非公開の設定は、作り手によるSNS等での作品発表を制限するものではありません。
            </p>
            <h2>利用上の注意</h2>
            <p>
              他人の権利を侵害する依頼、嫌がらせ、不正な決済、法令に反する利用はできません。これらが確認された場合は、取引やアカウントの利用を停止することがあります。
            </p>
            <p>
              お問い合わせは{email}へお送りください。個人情報の取扱いは
              <Link to="/privacy">プライバシーポリシー</Link>をご確認ください。
            </p>
          </>
        )}
        {page === 'privacy' && (
          <>
            <p>
              Favorの運営者（<Link to="/legal">運営者情報</Link>
              ）は、サービスの提供に必要な個人情報を次のとおり取り扱います。
            </p>
            <h2>取得する情報と利用目的</h2>
            <p>
              アカウントの識別情報、メールアドレス、表示名を、ログインと利用者の識別に使用します。依頼の本文、宛先、金額、納品ファイル、決済・受取先の識別情報と取引履歴を、依頼の管理、決済、納品、返金、お問い合わせ対応に使用します。
            </p>
            <p>アクセス情報と操作履歴を、不正利用の防止や障害対応に使用します。</p>
            <p>ログイン状態の維持と不正操作の防止のため、Cookieを使用します。</p>
            <h2>外部サービス</h2>
            <p>
              認証にはClerk、決済と受取先の本人確認にはStripe、メール送信にはResendを使用し、各処理に必要な情報を委託先へ渡します。カード番号や本人確認書類はStripeが直接取り扱います。
            </p>
            <h2>情報の公開と管理</h2>
            <p>
              依頼・作品・表示名は、依頼時の公開設定に従って表示します。決済情報とメールアドレスは一般公開しません。依頼リンクは、渡す相手を確認して共有してください。
            </p>
            <p>
              情報へのアクセスを制限し、サービスの提供と法令上必要な期間、情報を保管します。目的外の第三者提供は、本人の同意がある場合または法令に基づく場合を除いて行いません。
            </p>
            <h2>お問い合わせ</h2>
            <p>
              情報の開示・訂正・削除などについては、{email}
              へご連絡ください。本人確認のうえ対応します。法令上の保存義務などにより削除できない情報は、その理由をお伝えします。
            </p>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
