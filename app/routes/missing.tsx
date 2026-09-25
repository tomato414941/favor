import { data } from 'react-router';

export function loader() {
  throw data({ message: 'ページが見つかりません。' }, { status: 404 });
}
export default function Missing() {
  return null;
}
