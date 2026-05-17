import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type ActionItem, type MeetingDetailResponse } from '../lib/api';

type Tab = 'summary' | 'items' | 'transcript';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

function ItemRow({ it }: { it: ActionItem }) {
  const statusColor: Record<string, string> = {
    未開始: 'bg-slate-100 text-slate-600',
    進行中: 'bg-blue-50 text-blue-700',
    已完成: 'bg-emerald-50 text-emerald-700',
  };
  const priColor: Record<string, string> = {
    高: 'text-red-600',
    中: 'text-amber-600',
    低: 'text-slate-500',
  };
  return (
    <div className="space-y-1 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="font-mono text-xs text-slate-400">{it.code ?? '—'}</div>
        <span className={`rounded px-2 py-0.5 text-xs ${statusColor[it.status] ?? ''}`}>
          {it.status}
        </span>
      </div>
      <div
        className={`text-sm ${it.status === '已完成' ? 'text-slate-400 line-through' : 'text-slate-800'}`}
      >
        {it.description}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-slate-500">
        <span>負責人：{it.assignee ?? '—'}</span>
        <span className={priColor[it.priority ?? ''] ?? 'text-slate-500'}>
          優先：{it.priority ?? '—'}
        </span>
        <span>截止：{it.due_date ?? '—'}</span>
      </div>
      {it.notes && <div className="text-xs text-slate-400">備註：{it.notes}</div>}
    </div>
  );
}

export default function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('summary');

  const { data, isLoading, error } = useQuery<MeetingDetailResponse>({
    queryKey: ['meeting', id],
    queryFn: () => api.get<MeetingDetailResponse>(`/api/meetings/${id}`),
    enabled: !!id,
  });

  const transcriptQuery = useQuery<{ markdown: string }>({
    queryKey: ['meeting', id, 'transcript'],
    queryFn: () => api.get<{ markdown: string }>(`/api/meetings/${id}/transcript`),
    enabled: !!id && tab === 'transcript',
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  const { meeting, action_items } = data;

  return (
    <div className="space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
        <ArrowLeft className="h-4 w-4" /> 回會議記錄
      </Link>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h1 className="text-xl font-semibold text-slate-800">{meeting.title}</h1>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500 md:grid-cols-4">
          <div>
            <div className="text-slate-400">開始時間</div>
            <div>{formatDateTime(meeting.start_time)}</div>
          </div>
          <div>
            <div className="text-slate-400">結束時間</div>
            <div>{formatDateTime(meeting.end_time)}</div>
          </div>
          <div>
            <div className="text-slate-400">時長</div>
            <div>{meeting.duration_minutes != null ? `${meeting.duration_minutes} 分鐘` : '—'}</div>
          </div>
          <div>
            <div className="text-slate-400">Meet ID</div>
            <div className="font-mono">{meeting.meet_id}</div>
          </div>
        </div>
        {meeting.participants && meeting.participants.length > 0 && (
          <div className="mt-3 text-xs text-slate-500">
            參與者：{meeting.participants.join('、')}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {[
          { k: 'summary', label: '摘要' },
          { k: 'items', label: `Action Items (${action_items.length})` },
          { k: 'transcript', label: '逐字稿' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as Tab)}
            className={[
              'px-4 py-2 text-sm',
              tab === t.k
                ? 'border-b-2 border-blue-600 font-medium text-blue-700'
                : 'text-slate-500 hover:text-slate-800',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <div className="rounded-md border border-slate-200 bg-white p-5">
          {meeting.summary ? (
            <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700">
              {meeting.summary}
            </p>
          ) : (
            <p className="text-sm text-slate-400">尚未產生摘要</p>
          )}
        </div>
      )}

      {tab === 'items' && (
        <div className="grid gap-2 md:grid-cols-2">
          {action_items.length === 0 && (
            <div className="text-sm text-slate-500">此會議目前沒有 Action Items</div>
          )}
          {action_items.map((it) => (
            <ItemRow key={it.id} it={it} />
          ))}
        </div>
      )}

      {tab === 'transcript' && (
        <div className="rounded-md border border-slate-200 bg-white p-5">
          {transcriptQuery.isLoading && <LoadingSpinner label="載入逐字稿…" />}
          {transcriptQuery.error && <ErrorBanner error={transcriptQuery.error} />}
          {transcriptQuery.data && (
            <pre className="whitespace-pre-wrap text-xs leading-6 text-slate-700">
              {transcriptQuery.data.markdown || '尚無逐字稿'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
