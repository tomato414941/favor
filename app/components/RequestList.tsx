import { Link } from 'react-router';
import type { RequestLinkView, RequestView } from '../../src/shared';
import { yen } from './format';
import { LinkStatus } from './Links';
import { RequestStatus } from './RequestDetail';

/** Requests and, for the sender, links still waiting, newest first. */
export function RequestList({
  side,
  requests,
  links,
}: {
  side: 'sent' | 'received';
  requests: RequestView[];
  links: RequestLinkView[];
}) {
  const title = side === 'sent' ? '送った依頼' : '受けた依頼';
  const rows = [
    ...requests.map((request) => ({
      id: request.id,
      createdAt: request.createdAt,
      href: `/me/requests/${request.id}`,
      brief: request.brief,
      person: request.viewerRole === 'creator' ? request.clientName : request.creatorName,
      amount: request.amount,
      status: <RequestStatus request={request} />,
    })),
    ...links.map((link) => ({
      id: link.id,
      createdAt: link.createdAt,
      href: `/me/links/${link.id}`,
      brief: link.brief,
      person: link.recipientEmail ?? 'リンクで共有',
      amount: link.amount,
      status: <LinkStatus link={link} />,
    })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="list-panel">
      <h1 className="page-title">{title}</h1>
      {rows.length ? (
        <ul className="request-list" aria-label={title}>
          {rows.map((row) => (
            <li key={row.id}>
              <Link className="request-row" to={row.href}>
                <span className="request-excerpt">{row.brief}</span>
                <span className="request-person">{row.person}</span>
                <span className="request-amount">{yen(row.amount)}</span>
                {row.status}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          <p>{side === 'sent' ? '送った依頼はありません' : '受けた依頼はありません'}</p>
          {side === 'sent' && (
            <Link className="quiet-button" to="/me/new">
              お願いを書く
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
