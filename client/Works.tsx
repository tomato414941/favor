import { useEffect, useState } from 'react';
import type { WorkView } from '../src/shared';
import { api } from './api';
import { date } from './format';
import { Link } from './ui';

const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="header shell">
        <Link className="wordmark" href="/">
          Favor
        </Link>
        <nav aria-label="メインナビゲーション">
          <Link href="/works" aria-current="page">
            作品
          </Link>
        </nav>
      </header>
      <main className="shell works-page">{children}</main>
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    load().then(
      (result) => active && setData(result),
      (cause: unknown) =>
        active && setError(cause instanceof Error ? cause.message : 'ページを開けませんでした。'),
    );
    return () => {
      active = false;
    };
  }, deps);
  return { data, error };
}

function WorkImages({ work }: { work: WorkView }) {
  const images = work.files.filter((file) => isImage(file.name));
  const others = work.files.filter((file) => !isImage(file.name));
  return (
    <>
      {images.map((file) => (
        <img
          key={file.id}
          className="work-image"
          src={`/api/works/${work.id}/files/${file.id}`}
          alt={file.name}
        />
      ))}
      {others.length > 0 && (
        <p className="hint">画像以外の納品ファイル: {others.map((file) => file.name).join('、')}</p>
      )}
    </>
  );
}

export function WorksList() {
  const { data, error } = useLoad(
    () => api<{ works: WorkView[] }>('/works').then((result) => result.works),
    [],
  );
  return (
    <Frame>
      <h1>作品</h1>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {data && data.length === 0 && <p className="empty-works">公開された作品はまだありません。</p>}
      {data && data.length > 0 && (
        <ul className="works-list">
          {data.map((work) => (
            <li key={work.id}>
              <Link href={`/works/${work.id}`}>
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
    </Frame>
  );
}

export function WorkPage({ id }: { id: string }) {
  const { data: work, error } = useLoad(() => api<WorkView>(`/works/${id}`), [id]);
  return (
    <Frame>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {work && (
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
            <Link href="/works">作品一覧へ</Link>
          </p>
        </article>
      )}
    </Frame>
  );
}
