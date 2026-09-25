import { Link } from 'react-router';
import type { Route } from './+types/me-works';
import { visibilityLabels } from '../components/format';
import { WorkImages } from '../components/Works';
import { useMe } from './me';

export const meta: Route.MetaFunction = () => [{ title: '自分の作品 · Favor' }];

export default function MyWorks() {
  const { requests } = useMe();
  const mine = requests.filter(
    (request) => request.viewerRole === 'creator' && request.state === 'delivered',
  );
  return (
    <div className="list-panel">
      <h1 className="page-title">自分の作品</h1>
      {mine.length ? (
        <ul className="works-list">
          {mine.map((request) => (
            <li key={request.id}>
              <Link to={`/me/requests/${request.id}`}>
                <WorkImages work={request} />
                <span className="work-parties">
                  {visibilityLabels[request.visibility]} · {request.clientName}から
                </span>
                <span className="work-brief">{request.brief}</span>
              </Link>
              {request.visibility !== 'hidden' && (
                <p className="hint">
                  <Link to={`/works/${request.id}`}>作品ページを見る</Link>
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">作品はまだありません</p>
      )}
    </div>
  );
}
