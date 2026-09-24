import { useEffect, useState } from 'react';
import { SiteHeader } from './Header';
import type { IdentitySession, WorkView } from '../src/shared';
import { api } from './api';
import { Arrow, Link } from './ui';
import './Home.css';

export function Home({
  identity,
  onLogout,
}: {
  identity: IdentitySession | null;
  onLogout: () => Promise<void>;
}) {
  const [works, setWorks] = useState<WorkView[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ works: WorkView[] }>('/works').then(
      (data) => active && setWorks(data.works.slice(0, 3)),
      () => active && setError(true),
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="home">
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <SiteHeader identity={identity} active={null} onLogout={onLogout} />
      <main className="shell">
        <div className="home-actions">
          <Link className="primary" href="/me/new">
            お願いを書く <Arrow />
          </Link>
        </div>
        <section className="home-works" aria-labelledby="home-works-title">
          <div className="home-section-heading">
            <h1 id="home-works-title">公開作品</h1>
            <Link href="/works">
              作品を見る <Arrow />
            </Link>
          </div>
          {error ? (
            <p className="home-empty" role="alert">
              作品を読み込めませんでした
            </p>
          ) : works === null ? (
            <p className="home-empty" role="status">
              読み込み中…
            </p>
          ) : works.length === 0 ? (
            <p className="home-empty">公開された作品はまだありません</p>
          ) : (
            <ul className="home-gallery">
              {works.map((work) => {
                const image = work.files.find((file) => /\.(png|jpe?g|gif|webp)$/i.test(file.name));
                return (
                  <li key={work.id}>
                    <Link href={`/works/${work.id}`}>
                      {image && (
                        <img
                          src={`/api/works/${work.id}/files/${image.id}`}
                          alt={image.name}
                          loading="lazy"
                        />
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
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </div>
  );
}
