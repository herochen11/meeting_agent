import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type ReportDetail } from '../lib/api';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const isoUtc = iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  return new Date(isoUtc).toLocaleString('zh-TW', { hour12: false });
}

function typeBadge(type: ReportDetail['type']) {
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

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [showStats, setShowStats] = useState(false);

  const { data, isLoading, error } = useQuery<ReportDetail>({
    queryKey: ['report', id],
    queryFn: () => api.get<ReportDetail>(`/api/reports/${id}`),
    enabled: !!id,
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Link
        to="/reports"
        className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> 回報表列表
      </Link>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="mb-2">{typeBadge(data.type)}</div>
            <h1 className="text-xl font-semibold text-slate-800">{data.title}</h1>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 md:grid-cols-3">
          <div>
            <div className="text-slate-400">期間起</div>
            <div>{formatDate(data.period_start)}</div>
          </div>
          <div>
            <div className="text-slate-400">期間迄</div>
            <div>{formatDate(data.period_end)}</div>
          </div>
          <div>
            <div className="text-slate-400">產生時間</div>
            <div>{formatDate(data.created_at)}</div>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-5">
        {data.content_md ? (
          <div className="prose prose-slate prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content_md}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-slate-400">尚無內容</p>
        )}
      </div>

      {data.stats_json && (
        <div className="rounded-md border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setShowStats((v) => !v)}
            className="flex w-full items-center gap-1 px-4 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
          >
            {showStats ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            原始統計資料 (stats_json)
          </button>
          {showStats && (
            <pre className="overflow-x-auto border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
              {JSON.stringify(data.stats_json, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
