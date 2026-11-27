'use client';

import { Icon } from '@/components/ui';

/**
 * Floating bulk-action bar, fixed bottom-center. Always mounted so it can slide up when the
 * first photo is selected; while empty it is inert and hidden from assistive tech.
 */
export function SelectionBar({
  count,
  total,
  disabled,
  onSelectAll,
  onDelete,
  onClear,
}: {
  count: number;
  total: number;
  disabled?: boolean;
  onSelectAll: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const open = count > 0;
  const allSelected = count === total;
  const text = 'lm-btn lm-btn-secondary lm-btn-sm min-h-11';
  return (
    <div
      role="toolbar"
      aria-label="Selected photos"
      aria-hidden={!open}
      inert={!open}
      data-testid="selection-bar"
      className={[
        'fixed bottom-[max(env(safe-area-inset-bottom),16px)] left-1/2 z-40 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-raised)]',
        'transition-[transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none',
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-[200%] opacity-0',
      ].join(' ')}
    >
      <span className="px-3 text-[14px] font-medium whitespace-nowrap" aria-live="polite">
        {count} selected
      </span>
      <button type="button" className={text} onClick={onSelectAll} disabled={disabled}>
        {allSelected ? 'Select none' : 'Select all'}
      </button>
      <button
        type="button"
        className={`${text} text-[var(--color-danger)]`}
        onClick={onDelete}
        disabled={disabled}
      >
        <Icon name="trash" size={18} />
        Delete
      </button>
      <button
        type="button"
        className="lm-iconbtn size-11"
        aria-label="Clear selection"
        title="Clear selection (Esc)"
        onClick={onClear}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}
