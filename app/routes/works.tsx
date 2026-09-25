import { Link } from 'react-router';
import type { Route } from './+types/works';
import { SiteHeader } from '../components/Header';
import { Footer } from '../components/ui';
import { WorkImages } from '../components/Works';
import { useSite } from '../root';
import { favorOf } from '../server/context';

export const meta: Route.MetaFunction = () => [{ title: '公開作品 · Favor' }];

export function loader({ context }: Route.LoaderArgs) {
  return { works: favorOf(context).service.publicWorks() };
}

export default function Works({ loaderData: { works } }: Route.ComponentProps) {
  const { identity } = useSite();
  return (
    <>
      <SiteHeader identity={identity} active="works" />
      <main className="shell works-page">
        <h1>公開作品</h1>
        {works.length === 0 && <p className="empty-works">公開された作品はまだありません。</p>}
        {works.length > 0 && (
          <ul className="works-list">
            {works.map((work) => (
              <li key={work.id}>
                <Link to={`/works/${work.id}`}>
                  <WorkImages work={work} />
                  <span className="work-parties">
                    {work.clientName} → {work.creatorName}
                  </span>
                  <span className="work-brief">{work.brief}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      <Footer />
    </>
  );
}
