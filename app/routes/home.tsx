import { Link } from 'react-router';
import type { Route } from './+types/home';
import { SiteHeader } from '../components/Header';
import { Arrow, DemoBanner, Footer } from '../components/ui';
import { imageUrl, isImage } from '../components/Works';
import { useSite } from '../root';
import { favorOf } from '../server/context';

export function loader({ context }: Route.LoaderArgs) {
  return { works: favorOf(context).service.publicWorks().slice(0, 3) };
}

export default function Home({ loaderData: { works } }: Route.ComponentProps) {
  const { identity } = useSite();
  return (
    <div className="home">
      <DemoBanner />
      <SiteHeader identity={identity} active={null} />
      <main className="shell">
        <div className="home-actions">
          <Link className="primary" to="/me/new">
            お願いを書く <Arrow />
          </Link>
        </div>
        <section className="home-works" aria-labelledby="home-works-title">
          <div className="home-section-heading">
            <h1 id="home-works-title">公開作品</h1>
            <Link to="/works">
              作品を見る <Arrow />
            </Link>
          </div>
          {works.length === 0 ? (
            <p className="home-empty">公開された作品はまだありません</p>
          ) : (
            <ul className="home-gallery">
              {works.map((work) => {
                const image = work.files.find((file) => isImage(file.name));
                return (
                  <li key={work.id}>
                    <Link to={`/works/${work.id}`}>
                      {image && (
                        <img src={imageUrl(work, image.id)} alt={image.name} loading="lazy" />
                      )}
                      <span className="home-work-brief">{work.brief}</span>
                      <span className="home-work-author">{work.creatorName}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
}
