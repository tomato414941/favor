import { Link } from 'react-router';
import type { Route } from './+types/work';
import { SiteHeader } from '../components/Header';
import { date } from '../components/format';
import { Footer } from '../components/ui';
import { imageUrl, isImage, WorkImages } from '../components/Works';
import { useSite } from '../root';
import { favorOf } from '../server/context';
import { problem } from '../server/session';

export function loader({ context, params, request }: Route.LoaderArgs) {
  const favor = favorOf(context);
  try {
    return { work: favor.service.publicWork(params.id), origin: favor.pageOrigin(request) };
  } catch (error) {
    return problem(error);
  }
}

const excerpt = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** Titles and a preview image for links shared elsewhere. */
export const meta: Route.MetaFunction = ({ loaderData }) => {
  if (!loaderData) return [{ title: 'Favor' }];
  const { work, origin } = loaderData;
  const title = `${work.creatorName}の作品 · Favor`;
  const image = work.files.find((file) => isImage(file.name));
  return [
    { title },
    { name: 'description', content: excerpt(work.brief) },
    { property: 'og:title', content: title },
    { property: 'og:description', content: excerpt(work.brief) },
    { property: 'og:type', content: 'article' },
    { property: 'og:url', content: `${origin}/works/${work.id}` },
    ...(image ? [{ property: 'og:image', content: `${origin}${imageUrl(work, image.id)}` }] : []),
    { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' },
  ];
};

export default function Work({ loaderData: { work } }: Route.ComponentProps) {
  const { identity } = useSite();
  return (
    <>
      <SiteHeader identity={identity} active="works" />
      <main className="shell works-page">
        <article className="work" aria-label="作品">
          <WorkImages work={work} />
          <p className="work-parties">
            {work.clientName} → {work.creatorName}
          </p>
          <div className="brief-block">
            <div className="brief-label">依頼内容</div>
            <p>{work.brief}</p>
          </div>
          <p className="hint">
            納品 第{work.deliveryVersion}版 · 依頼 {date(work.createdAt)}
          </p>
          <p>
            <Link to="/works">作品一覧へ</Link>
          </p>
        </article>
      </main>
      <Footer />
    </>
  );
}
