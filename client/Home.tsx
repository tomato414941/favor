import { useEffect, useState } from 'react';
import '@fontsource/newsreader/500-italic.css';
import type { WorkView } from '../src/shared';
import { api } from './api';
import { Arrow, Link } from './ui';
import './Home.css';

export function Home() {
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
      <header className="home-header home-shell">
        <Link className="home-wordmark" href="/" aria-label="Favor ホーム">
          Favor
        </Link>
        <nav aria-label="メインナビゲーション">
          <Link href="/works">作品</Link>
          <Link href="/sent">ログイン</Link>
        </nav>
      </header>
      <main className="home-shell">
        <section className="home-hero" aria-labelledby="home-title">
          <div className="home-intro">
            <h1 id="home-title">Favor</h1>
            <div className="home-actions">
              <Link className="home-create" href="/new">
                お願いを書く <Arrow />
              </Link>
              <Link className="home-browse" href="/works">
                作品を見る
              </Link>
            </div>
          </div>
          <svg className="home-letter" viewBox="0 0 520 430" fill="none" aria-hidden="true">
            <g transform="rotate(8 276 260)">
              <path d="M84 213 267 88l185 125v167H84Z" fill="#e7b58b" />
              <path d="m84 213 183 112 185-112" stroke="#c1845c" strokeWidth="1.5" />
            </g>
            <g transform="rotate(-9 260 211)">
              <path d="M131 65h266v276H131Z" fill="#d6bfa7" opacity=".25" />
              <path d="M123 54h266v276H123Z" fill="#fffcf6" stroke="#d8cebe" />
              <path d="M157 186h191m-191 28h191m-191 28h133" stroke="#dcd6cb" strokeWidth="1.5" />
              <path
                d="m276 94-4 25 23 10-25 4-5 25-10-23-26 3 19-18-11-23 23 12Z"
                stroke="#b04d32"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </g>
            <g transform="rotate(8 276 260)">
              <path d="m84 213 183 112 185-112v167H84Z" fill="#edc5a2" />
              <path d="M84 380 242 316m210 64L292 316" stroke="#c9936a" strokeWidth="1.5" />
              <path d="m84 213 183 112 185-112" stroke="#c9936a" strokeWidth="1.5" />
              <path d="M84 213v167h368V213" stroke="#c9936a" strokeWidth="1.5" />
            </g>
          </svg>
        </section>
        <section className="home-works" aria-labelledby="home-works-title">
          <div className="home-section-heading">
            <h2 id="home-works-title">作品</h2>
            <Link href="/works">
              一覧へ <Arrow />
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
      <footer className="home-footer home-shell">Favor</footer>
    </div>
  );
}
