import { fetchAuthSession } from 'aws-amplify/auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Calls the API with the Cognito *access* token; the server reads identity only from it. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new ApiError(401, 'Please sign in again.');
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.retry_after);
  return data as T;
}

export interface Me {
  user_id: string;
  email: string;
  scope: string[];
  grants: Record<string, number>;
  is_admin: boolean;
}

export interface Trace {
  scope: string[];
  filter: unknown;
  retrieved: number;
  dropped_by_postcheck: number;
  below_relevance: number;
  chunks: { title: string; score: number }[];
}

export interface ChatReply {
  answer: string;
  /** False when nothing you may read answers the question. */
  answered: boolean;
  citations: string[];
  trace: Trace;
}

export interface AccessRequest {
  request_id: string;
  tag: string;
  status: 'pending' | 'approved' | 'denied';
  reason: string;
  created_at: number;
  decided_at?: number;
  expires_at?: number;
  email?: string;
  user_id?: string;
}

export interface CatalogDoc {
  doc_id: string;
  title: string;
  description: string;
  tag: string;
  requestable: boolean;
  has_access: boolean;
  request: AccessRequest | null;
}

export interface LibraryDoc {
  title: string;
  project: string;
  source: string;
}

export interface Catalog {
  documents: CatalogDoc[];
  library: LibraryDoc[];
}

export interface Grant {
  user_id: string;
  email: string;
  tag: string;
  expires_at: number;
}

export interface AuditEntry {
  at: number;
  action: string;
  actor: string;
  subject?: string;
  tag?: string;
  check?: string;
  email?: string;
}

export interface AdminOverview {
  pending: AccessRequest[];
  decided: AccessRequest[];
  grants: Grant[];
  audit: AuditEntry[];
}

export const when = (epoch: number) => new Date(epoch * 1000).toLocaleString();
