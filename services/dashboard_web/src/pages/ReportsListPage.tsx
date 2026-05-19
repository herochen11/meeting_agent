import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarRange, FileBarChart } from 'lucide-react';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type Report } from '../lib/api';

type TabKey = 'all' | 'weekly' | 'monthly';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // 純日期欄位（YYYY-MM-DD）直接顯示即可；created_at 才要補 Z
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
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

function typeBadge(type: Report['type']) {
  if (type === 'weekly') {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-blue-50 text-blue-700">
        週報
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-purple-50 text-purple-700">
      月報
    </span>
  );
}

export default function ReportsListPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('all');

  const { data, isLoading, error } = useQuery<Report[]>({
    queryKey: ['reports'],
    queryFn: () => api.get<Report[]>('/api/reports'),
  });

  const filtered = useMemo(() => {
    if (!data) return null;
    if (tab === 'all') return data;
    return data.filter((r) => r.type === tab);
  }, [data, tab]);

  const counts = useMemo(() => {
    if (!data) return { all: 0, weekly: 0, monthly: 0 };
    return {
      all: data.length,
      weekly: data.filter((r) => r.type === 'weekly').length,
      monthly: data.filter((r) => r.type === 'monthly').length,
    };
  }, [data]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">報表</h1>
        <p className="text-sm text-slate-500">
          自動產生的週報與月報，彙整會議與 Action Items 進度
        </p>
      </div>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorBanner error={error} />}

      {data && (
        <>
          <div className="flex gap-1 border-b border-slate-200">
            {(
              [
                { k: 'all', label: `全部 (${counts.all})` },
                { k: 'weekly', label: `週報 (${counts.weekly})` },
                { k: 'monthly', label: `月報 (${counts.monthly})` },
              ] as Array<{ k: TabKey; label: string }>
            ).map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
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

          {filtered && filtered.length === 0 && (
            <div className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              <FileBarChart className="mx-auto mb-2 h-8 w-8 text-slate-300" />
              <div>目前還沒有產生的報表。</div>
              <div className="mt-1 text-xs text-slate-400">
                週報每週一早上 9 點自動產生（涵蓋上週一 ~ 上週日），月報每月 1 號早上 9 點自動產生（涵蓋上個月整月）。
              </div>
            </div>
          )}

          {filtered && filtered.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">類型</th>
                    <th className="px-4 py-2 font-medium">標題</th>
                    <th className="px-4 py-2 font-medium">期間</th>
                    <th className="px-4 py-2 font-medium">產生時間</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/reports/${r.id}`)}
                      className="cursor-pointer hover:bg-slate-50"
                    >
                      <td className="px-4 py-3">{typeBadge(r.type)}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">{r.title}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <span className="inline-flex items-center gap-1 text-xs">
                          <CalendarRange className="h-3.5 w-3.5 text-slate-400" />
                          {formatDate(r.period_start)} ~ {formatDate(r.period_end)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {formatDate(r.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
