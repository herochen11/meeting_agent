import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, LogIn, LogOut } from 'lucide-react';

import { api, type BotStatusResponse } from '../lib/api';

function extractMeetId(input: string): string {
  // Accept full Meet URL or just the xxx-xxxx-xxx code.
  const trimmed = input.trim();
  const match = trimmed.match(/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})/i);
  return match ? match[1] : trimmed;
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
            ? `目前 ${data.count} 個 bot 在會議中`
            : '目前沒有 bot 在會議中'}
      </div>

      {data?.bots.map((b) => (
        <div
          key={b.meet_id}
          className="flex items-center justify-between rounded border border-slate-200 px-2 py-1"
        >
          <span className="font-mono text-xs">{b.meet_id}</span>
          <button
            onClick={() => stopMut.mutate(b.meet_id)}
            className="flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-xs text-red-600 hover:bg-red-100"
          >
            <LogOut className="h-3 w-3" />
            停止
          </button>
        </div>
      ))}

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
