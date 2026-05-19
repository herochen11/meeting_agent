import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, LogIn, LogOut, Mic } from 'lucide-react';

import { api, type BotStatusResponse, type BotStatusEntry } from '../lib/api';

function extractMeetId(input: string): string {
  // Accept full Meet URL or just the xxx-xxxx-xxx code.
  const trimmed = input.trim();
  const match = trimmed.match(/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})/i);
  return match ? match[1] : trimmed;
}

interface StatusVisual {
  label: string;
  dotClass: string;
  badgeClass: string;
}

function statusVisual(status: BotStatusEntry['status']): StatusVisual {
  switch (status) {
    case '等待加入':
      return {
        label: '等待加入',
        dotClass: 'bg-amber-500 animate-pulse',
        badgeClass: 'bg-amber-50 text-amber-700',
      };
    case '進行中':
      return {
        label: '進行中',
        dotClass: 'bg-emerald-500 animate-pulse',
        badgeClass: 'bg-emerald-50 text-emerald-700',
      };
    case '逐字稿處理中':
      return {
        label: '逐字稿處理中',
        dotClass: 'bg-slate-400',
        badgeClass: 'bg-slate-100 text-slate-700',
      };
  }
}

export default function BotConsole() {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<BotStatusResponse>({
    queryKey: ['bot-status'],
    queryFn: () => api.get<BotStatusResponse>('/api/bot/status'),
    refetchInterval: 10_000,
  });

  const joinMut = useMutation({
    mutationFn: (meet_id: string) => api.post('/api/bot/join', { meet_id }),
    onSuccess: () => {
      setInput('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['bot-status'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : '加入失敗');
    },
  });

  const stopMut = useMutation({
    mutationFn: (meet_id: string) => api.post('/api/bot/stop', { meet_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-status'] }),
  });

  // 統計：等待加入 / 進行中 / 本地錄音處理中
  const waitingCount =
    data?.bots.filter((b) => b.status === '等待加入').length ?? 0;
  const runningCount =
    data?.bots.filter((b) => b.status === '進行中').length ?? 0;
  const localCount =
    data?.bots.filter((b) => b.source === 'local-recording').length ?? 0;

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-slate-700">
        <Bot className="h-4 w-4" />
        <span>Bot 控制台</span>
      </div>

      <div className="text-xs text-slate-500">
        {isLoading
          ? '查詢中…'
          : data && data.count > 0
            ? [
                runningCount > 0 ? `${runningCount} 進行中` : null,
                waitingCount > 0 ? `${waitingCount} 等待加入` : null,
                localCount > 0 ? `${localCount} 本地錄音` : null,
              ]
                .filter(Boolean)
                .join('、') || '目前沒有處理中項目'
            : '目前沒有處理中項目'}
      </div>

      {data?.warning && (
        <div className="text-xs text-amber-700">{data.warning}</div>
      )}

      {data && data.bots.length > 0 && (
        <div className="space-y-1">
          {data.bots.map((b) => {
            const vis = statusVisual(b.status);
            const isWaiting = b.status === '等待加入';
            const isLocal = b.source === 'local-recording';
            // 本地錄音顯示用「mic」icon 取代狀態 dot、不顯示停止按鈕
            const displayLabel = isLocal ? '本地錄音處理中' : vis.label;
            const localDisplayName = isLocal
              ? b.title || b.meet_id
              : b.meet_id;
            return (
              <div
                key={b.meet_id}
                className="space-y-1 rounded border border-slate-200 px-2 py-1.5"
              >
                {/* Row 1: 圖示 + 名稱（佔滿可用寬度） */}
                <div className="flex items-center gap-1.5 min-w-0">
                  {isLocal ? (
                    <Mic className="h-3 w-3 flex-shrink-0 text-violet-600" />
                  ) : (
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${vis.dotClass}`}
                    />
                  )}
                  <span
                    className="flex-1 min-w-0 font-mono text-xs text-slate-700 truncate"
                    title={isLocal ? b.title ?? b.meet_id : b.meet_id}
                  >
                    {localDisplayName}
                  </span>
                </div>
                {/* Row 2: 狀態 badge（自己一行避免擠壓） */}
                <div>
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${
                      isLocal
                        ? 'bg-violet-50 text-violet-700'
                        : vis.badgeClass
                    }`}
                  >
                    {displayLabel}
                  </span>
                </div>
                {!isLocal && (
                  <button
                    onClick={() => stopMut.mutate(b.meet_id)}
                    disabled={isWaiting || stopMut.isPending}
                    title={
                      isWaiting
                        ? 'Bot 尚未實際加入會議，無法停止；請等待 host 接受或於 Vexa 容器啟動完成後再試'
                        : undefined
                    }
                    className="flex w-full items-center justify-center gap-1 rounded bg-red-50 px-2 py-1 text-xs text-red-600 whitespace-nowrap hover:bg-red-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    <LogOut className="h-3 w-3" />
                    停止 bot
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Meet 連結或 ID"
          className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
        />
        <button
          disabled={!input.trim() || joinMut.isPending}
          onClick={() => joinMut.mutate(extractMeetId(input))}
          className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          <LogIn className="h-3 w-3" />
          加入
        </button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
