import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type MeetingListItem } from '../lib/api';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
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
  const map: Record<string, string> = {
    completed: 'bg-emerald-50 text-emerald-700',
    active: 'bg-blue-50 text-blue-700',
    failed: 'bg-red-50 text-red-700',
  };
  const cls = map[status] ?? 'bg-slate-100 text-slate-600';
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

export default function MeetingsListPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery<MeetingListItem[]>({
    queryKey: ['meetings'],
    queryFn: () => api.get<MeetingListItem[]>('/api/meetings'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">會議記錄</h1>
        <p className="text-sm text-slate-500">點任一場會議查看摘要、Action Items 與逐字稿</p>
      </div>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorBanner error={error} />}

      {data && data.length === 0 && (
        <div className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          目前沒有會議記錄
        </div>
      )}

      {data && data.length > 0 && (
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
              {data.map((m) => (
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
