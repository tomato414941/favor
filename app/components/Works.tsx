import type { WorkView } from '../../src/shared';

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);
export const imageUrl = (work: WorkView, fileId: string) => `/works/${work.id}/files/${fileId}`;

export function WorkImages({ work }: { work: WorkView }) {
  const images = work.files.filter((file) => isImage(file.name));
  const others = work.files.filter((file) => !isImage(file.name));
  return (
    <>
      {images.map((file) => (
        <img key={file.id} className="work-image" src={imageUrl(work, file.id)} alt={file.name} />
      ))}
      {others.length > 0 && (
        <p className="hint">画像以外の納品ファイル: {others.map((file) => file.name).join('、')}</p>
      )}
    </>
  );
}
