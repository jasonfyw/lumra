import { Icon, type IconName } from '@/components/ui';

/** Full-page recipient notice (expired, not found, rate limited): same calm layout everywhere (J4). */
export function GalleryNotice({
  title,
  body,
  icon = 'clock',
}: {
  title: string;
  body: string;
  icon?: IconName;
}) {
  return (
    <main className="lm-gate">
      <div className="lm-gate-icon">
        <Icon name={icon} size={24} />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h1 className="lm-title-display-sm">{title}</h1>
        <p className="lm-gate-body">{body}</p>
      </div>
    </main>
  );
}
