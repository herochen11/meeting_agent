import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, type ActionItem, type MeetingDetailResponse } from '../lib/api';

type Tab = 'summary' | 'items';

const ownerColors = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-purple-100 text-purple-700',
  'bg-pink-100 text-pink-700',
  'bg-cyan-100 text-cyan-700',
  'bg-indigo-100 text-indigo-700',
];

function ownerChipColor(name: string | null): string {
  if (!name) return 'bg-slate-100 text-slate-600';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ownerColors[h % ownerColors.length];
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  // DB 存的是 UTC 但沒帶時區，要強制當 UTC 解析（補 Z），不然 JS 會當成本機時間
  const isoUtc = iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  return new Date(isoUtc).toLocaleString('zh-TW', { hour12: false });
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

/** 排序：未完成（未開始/進行中）優先，然後依負責人、code 二次排序 */
function sortItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => {
    const aDone = a.status === '已完成' ? 1 : 0;
    const bDone = b.status === '已完成' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;

    const aOwner = a.assignee ?? '￿'; // 未指派排最後
    const bOwner = b.assignee ?? '￿';
    const ownerCmp = aOwner.localeCompare(bOwner, 'zh-Hant');
    if (ownerCmp !== 0) return ownerCmp;

    const aCode = a.code ?? '';
    const bCode = b.code ?? '';
    return aCode.localeCompare(bCode);
  });
}

/** 按負責人分組（保留 sortItems 後的順序） */
function groupByOwner(items: ActionItem[]): Array<[string, ActionItem[]]> {
  const m = new Map<string, ActionItem[]>();
  for (const it of items) {
    const key = it.assignee ?? '未指派';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(it);
  }
  return [...m.entries()];
}

function OwnerGroup({ owner, items }: { owner: string; items: ActionItem[] }) {
  return (
    <div className="space-y-2">
      <div
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ownerChipColor(owner)}`}
      >
        {owner}
        <span className="ml-1 opacity-70">({items.length})</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {items.map((it) => (
          <ItemRow key={it.id} it={it} />
        ))}
      </div>
    </div>
  );
}

export default function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('summary');
  const [showCompleted, setShowCompleted] = useState(false);

  const { data, isLoading, error } = useQuery<MeetingDetailResponse>({
    queryKey: ['meeting', id],
    queryFn: () => api.get<MeetingDetailResponse>(`/api/meetings/${id}`),
    enabled: !!id,
  });

  const { pending, completed } = useMemo(() => {
    const items = data?.action_items ?? [];
    const sorted = sortItems(items);
    return {
      pending: sorted.filter((it) => it.status !== '已完成'),
      completed: sorted.filter((it) => it.status === '已完成'),
    };
  }, [data]);

  const pendingGroups = useMemo(() => groupByOwner(pending), [pending]);
  const completedGroups = useMemo(() => groupByOwner(completed), [completed]);

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
          { k: 'summary', label: '總結' },
          { k: 'items', label: `Action Items (${action_items.length})` },
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
            <div className="prose prose-slate prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{meeting.summary}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-slate-400">尚未產生總結</p>
          )}
        </div>
      )}

      {tab === 'items' && (
        <div className="space-y-5">
          {action_items.length === 0 && (
            <div className="text-sm text-slate-500">此會議目前沒有 Action Items</div>
          )}

          {pending.length > 0 && (
            <div className="space-y-4">
              <div className="text-xs font-medium text-slate-500">
                未完成（{pending.length}）
              </div>
              {pendingGroups.map(([owner, ownerItems]) => (
                <OwnerGroup key={owner} owner={owner} items={ownerItems} />
              ))}
            </div>
          )}

          {completed.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-t border-slate-200 pt-4">
                <div className="text-xs font-medium text-slate-500">
                  已完成（{completed.length}）
                </div>
                <button
                  onClick={() => setShowCompleted((v) => !v)}
                  title={showCompleted ? '收起已完成' : '展開已完成'}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition ${
                    showCompleted
                      ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                      : 'bg-white text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  {showCompleted ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showCompleted ? '收起' : '展開'}
                </button>
              </div>
              {showCompleted &&
                completedGroups.map(([owner, ownerItems]) => (
                  <OwnerGroup key={owner} owner={owner} items={ownerItems} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
