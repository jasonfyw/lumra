import type {
  ApiResponse,
  DeleteGalleryResponse,
  DeleteMediaResponse,
  GalleryDetail,
  PublishGalleryRequest,
  PublishGalleryResponse,
  ReorderMediaResponse,
  SetGalleryPasswordResponse,
  UpdateGalleryRequest,
} from '@lumra/contracts';

/** Browser helpers for the owner-only editor endpoints (T15/T16/T19). Cookies carry auth. */
export type ApiOutcome<T> =
  { ok: true; data: T } | { ok: false; code: string; message: string; retryable: boolean };

const NETWORK_ERROR = {
  ok: false as const,
  code: 'network',
  message: 'Network error. Check your connection and try again.',
  retryable: true,
};

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiOutcome<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const json = (await res.json()) as ApiResponse<T>;
    if (json.error) return { ok: false, ...json.error };
    return { ok: true, data: json.data };
  } catch {
    return NETWORK_ERROR;
  }
}

const g = (id: string) => `/api/v1/galleries/${encodeURIComponent(id)}`;

export const getGalleryRequest = (id: string) => call<GalleryDetail>('GET', g(id));

export const updateGalleryRequest = (id: string, body: UpdateGalleryRequest) =>
  call<GalleryDetail>('PATCH', g(id), body);

export const deleteGalleryRequest = (id: string) => call<DeleteGalleryResponse>('DELETE', g(id));

export const publishGalleryRequest = (id: string, body: PublishGalleryRequest) =>
  call<PublishGalleryResponse>('POST', `${g(id)}/publish`, body);

export const setPasswordRequest = (id: string, password: string | null) =>
  call<SetGalleryPasswordResponse>('PUT', `${g(id)}/password`, { password });

export const reorderMediaRequest = (id: string, orderedIds: string[]) =>
  call<ReorderMediaResponse>('PATCH', `${g(id)}/media/order`, { orderedIds });

export const deleteMediaRequest = (id: string, mediaId: string) =>
  call<DeleteMediaResponse>('DELETE', `${g(id)}/media/${encodeURIComponent(mediaId)}`);

/** `<input type="datetime-local">` value (local wall time) → ISO UTC (`…Z`), or null if empty. */
export function localInputToUtcIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value); // no offset → interpreted in the browser's local zone
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO UTC → `datetime-local` value in the browser's zone (minute precision). */
export function utcIsoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
