import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type MeetingListItem } from '../lib/api';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  // DB 存的是 UTC 但沒帶時區，要強制當 UTC 解析（補 Z），不然 JS 會當成本機時間
  const isoUtc = iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(isoUtc);
  return d.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function statusBadge(status: string) {
  if (status === '會議進行中') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs bg-emerald-50 text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
        {status}
      </span>
    );
  }
  if (status === '逐字稿處理中') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs bg-amber-50 text-amber-700">
        <svg
          className="h-3 w-3 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
        </svg>
        {status}
      </span>
    );
  }
  const map: Record<string, string> = {
    completed: 'bg-blue-50 text-blue-700',
    active: 'bg-blue-50 text-blue-700',
    failed: 'bg-red-50 text-red-700',
  };
  const cls = map[status] ?? 'bg-slate-100 text-slate-600';
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

function sortMeetings(meetings: MeetingListItem[]): MeetingListItem[] {
  // 排序優先級：會議進行中 > 逐字稿處理中 > 其他（按 start_time DESC NULLS LAST）
  function priority(status: string): number {
    if (status === '會議進行中') return 0;
    if (status === '逐字稿處理中') return 1;
    return 2;
  }
  return [...meetings].sort((a, b) => {
    const pa = priority(a.status);
    const pb = priority(b.status);
    if (pa !== pb) return pa - pb;
    const aTs = a.start_time ? new Date(a.start_time).getTime() : -Infinity;
    const bTs = b.start_time ? new Date(b.start_time).getTime() : -Infinity;
    return bTs - aTs;
  });
}

export default function MeetingsListPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery<MeetingListItem[]>({
    queryKey: ['meetings'],
    queryFn: () => api.get<MeetingListItem[]>('/api/meetings'),
    refetchInterval: 15_000,
  });

  const sorted = data ? sortMeetings(data) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">會議記錄</h1>
        <p className="text-sm text-slate-500">點任一場會議查看摘要、Action Items 與逐字稿</p>
      </div>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorBanner error={error} />}

      {sorted && sorted.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          目前沒有會議記錄
        </div>
      )}

      {sorted && sorted.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">開始時間</th>
                <th className="px-4 py-2 font-medium">標題</th>
                <th className="px-4 py-2 font-medium">狀態</th>
                <th className="px-4 py-2 font-medium">時長</th>
                <th className="px-4 py-2 font-medium">Meet ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => navigate(`/meetings/${m.id}`)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-4 py-3 text-slate-600">{formatTime(m.start_time)}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{m.title}</td>
                  <td className="px-4 py-3">{statusBadge(m.status)}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {m.duration_minutes != null ? `${m.duration_minutes} 分鐘` : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{m.meet_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
