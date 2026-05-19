import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Link2Off,
  Users,
  Video,
  X,
} from 'lucide-react';

import ErrorBanner from '../components/ErrorBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { api, ApiError } from '../lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CalendarEvent = {
  id: string;
  title: string;
  start: string; // ISO datetime
  end: string;
  description?: string;
  attendees?: { email: string; displayName?: string }[];
  meetUrl?: string;
  meetingCode?: string;
  source_account_email?: string;
};

type CalendarAccount = {
  id: number;
  google_email: string;
  active: boolean;
  created_at: string;
};

type AccountsResponse = {
  accounts: CalendarAccount[];
};

type EventsResponse = {
  events: CalendarEvent[];
  errors?: { email: string; message: string }[];
};

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

// 把 mock events 散落在「目前看的這個月」，方便 Brian 不論何時打開都看得到事件。
function buildMockEvents(anchor: Date): CalendarEvent[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth(); // 0-based

  function mk(
    day: number,
    startH: number,
    startM: number,
    durMin: number,
    overrides: Partial<CalendarEvent> & { title: string; id: string },
  ): CalendarEvent {
    const start = new Date(year, month, day, startH, startM, 0);
    const end = new Date(start.getTime() + durMin * 60_000);
    return {
      id: overrides.id,
      title: overrides.title,
      start: start.toISOString(),
      end: end.toISOString(),
      description: overrides.description,
      attendees: overrides.attendees,
      meetUrl: overrides.meetUrl,
      meetingCode: overrides.meetingCode,
    };
  }

  return [
    mk(3, 10, 0, 60, {
      id: 'mock-1',
      title: '週會',
      description: '每週固定週會，過上週進度 + 對齊本週重點。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
        { email: 'ron@mdv.com.tw', displayName: 'Ron' },
        { email: 'sales@mdv.com.tw', displayName: '業務團隊' },
      ],
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      meetingCode: 'abc-defg-hij',
    }),
    mk(7, 14, 30, 45, {
      id: 'mock-2',
      title: '客戶 demo — A 客戶',
      description: '展示 PD-35 v2.1 韌體更新後的快充表現，需要準備 demo 機台 1 台。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
        { email: 'guest@partner.com', displayName: '客戶代表' },
      ],
      meetUrl: 'https://meet.google.com/xyz-1234-uvw',
      meetingCode: 'xyz-1234-uvw',
    }),
    mk(10, 9, 0, 30, {
      id: 'mock-3',
      title: 'PD-35 進度回顧',
      description: '硬體 / 韌體 / QA 三方對齊本月里程碑。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
        { email: 'ron@mdv.com.tw', displayName: 'Ron' },
      ],
    }),
    mk(10, 16, 0, 60, {
      id: 'mock-4',
      title: '面試 — 韌體工程師候選人',
      description: '請先看履歷，準備 USB-C PD 相關技術問題。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
      ],
    }),
    mk(15, 11, 0, 60, {
      id: 'mock-5',
      title: '跨部門月度同步',
      description: '業務 / RD / 行政三方月會，請各部門帶 KPI 數字。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
        { email: 'ron@mdv.com.tw', displayName: 'Ron' },
      ],
      meetUrl: 'https://meet.google.com/mno-pqrs-tuv',
      meetingCode: 'mno-pqrs-tuv',
    }),
    mk(21, 13, 0, 30, {
      id: 'mock-6',
      title: '報價單 review',
      description: '討論 Q2 五大客戶報價策略。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
      ],
    }),
    mk(24, 10, 0, 90, {
      id: 'mock-7',
      title: 'Workshop — 新 Dashboard 功能規劃',
      description: 'NoirsBoxes 內部 workshop，討論下一季 Dashboard 路線圖。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
        { email: 'ron@mdv.com.tw', displayName: 'Ron' },
        { email: 'sales@mdv.com.tw', displayName: '業務團隊' },
      ],
      meetUrl: 'https://meet.google.com/qrs-tuvw-xyz',
      meetingCode: 'qrs-tuvw-xyz',
    }),
    mk(28, 15, 0, 45, {
      id: 'mock-8',
      title: '月底結算會議',
      description: '盤點本月 Action Items 完成度。',
      attendees: [
        { email: 'brian@mdv.com.tw', displayName: 'Brian' },
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Query hook
// ---------------------------------------------------------------------------

function useCalendarAccounts() {
  return useQuery<AccountsResponse>({
    queryKey: ['calendar', 'accounts'],
    queryFn: () => api.get<AccountsResponse>('/api/calendar/accounts'),
  });
}

function useCalendarEvents(anchor: Date, enabled: boolean) {
  // 帶 year/month 進 key 讓切月份時 cache 不打架
  const key = `${anchor.getFullYear()}-${anchor.getMonth()}`;
  // 抓「月曆網格」涵蓋範圍：前月最後一週起點 ~ 下月開頭，讓「上月 / 下月延伸進當月格」的事件也撈得到
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfCalendarGrid(monthStart);
  const gridEnd = addDays(gridStart, 42); // 6 週 = 42 天，exclusive end
  return useQuery<CalendarEvent[]>({
    queryKey: ['calendar', 'events', key],
    queryFn: async () => {
      try {
        const data = await api.get<EventsResponse>(
          `/api/calendar/events?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(gridEnd.toISOString())}`,
        );
        return data.events ?? [];
      } catch (err) {
        // 後端失敗時優雅降級顯示 mock；ErrorBanner 仍會把錯誤 surface 出來
        if (err instanceof ApiError) {
          console.warn('[CalendarPage] /api/calendar/events 失敗，fallback 到 mock：', err.message);
        } else {
          console.warn('[CalendarPage] /api/calendar/events 失敗', err);
        }
        throw err;
      }
    },
    enabled,
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfCalendarGrid(d: Date): Date {
  // 月曆左上角：把當月 1 號往前推到該週的週日
  const first = startOfMonth(d);
  const weekday = first.getDay(); // 0=Sun
  return new Date(first.getFullYear(), first.getMonth(), 1 - weekday);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function formatTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(s.getHours())}:${pad(s.getMinutes())} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);

  const accountsQuery = useCalendarAccounts();
  const accounts = accountsQuery.data?.accounts ?? [];
  const connected = accounts.length > 0;
  const primaryEmail = accounts[0]?.google_email;

  const eventsQuery = useCalendarEvents(anchor, connected);

  // OAuth callback redirect 回來時，根據 query string 顯示 notice 並 invalidate accounts
  useEffect(() => {
    const flag = searchParams.get('connected');
    const errorCode = searchParams.get('error');
    if (flag === '1') {
      setConnectNotice('✅ 已成功連結 Google 行事曆');
      queryClient.invalidateQueries({ queryKey: ['calendar', 'accounts'] });
      // 清掉 query string，避免重新整理重複顯示
      const next = new URLSearchParams(searchParams);
      next.delete('connected');
      next.delete('error');
      setSearchParams(next, { replace: true });
    } else if (flag === '0' && errorCode) {
      setConnectNotice(`⚠️ 連結失敗：${errorCode}`);
      const next = new URLSearchParams(searchParams);
      next.delete('connected');
      next.delete('error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, queryClient]);

  const disconnectMutation = useMutation({
    mutationFn: (accountId: number) => api.del(`/api/calendar/accounts/${accountId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar', 'accounts'] });
      queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
      setConnectNotice('已中斷 Google 行事曆連結');
    },
    onError: (err) => {
      setConnectNotice(`中斷連結失敗：${(err as Error).message}`);
    },
  });

  const joinMutation = useMutation({
    mutationFn: (meetId: string) => api.post('/api/bot/join', { meet_id: meetId }),
    onSuccess: () => {
      setJoinNotice('✅ 已派 bot 加入會議，請至 Telegram 群組確認');
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setJoinNotice(`❌ 派 bot 失敗：${msg}`);
    },
  });

  // 把 events 按日期 bucket，方便每個 day cell O(1) 查
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    if (!eventsQuery.data) return map;
    for (const ev of eventsQuery.data) {
      const d = new Date(ev.start);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    // 同一天內按開始時間排
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    }
    return map;
  }, [eventsQuery.data]);

  function handleConnect() {
    // 直接 top-level navigation 進 OAuth flow（會帶 session cookie）
    window.location.href = '/api/calendar/connect';
  }

  function handleDisconnect() {
    const account = accounts[0];
    if (!account) return;
    disconnectMutation.mutate(account.id);
  }

  function gotoPrevMonth() {
    setAnchor((cur) => new Date(cur.getFullYear(), cur.getMonth() - 1, 1));
  }
  function gotoNextMonth() {
    setAnchor((cur) => new Date(cur.getFullYear(), cur.getMonth() + 1, 1));
  }
  function gotoToday() {
    setAnchor(new Date());
  }

  // ---------- State A: not connected ----------
  if (!accountsQuery.isLoading && !connected) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">月曆</h1>
          <p className="text-sm text-slate-500">查看 Google 行事曆，並讓系統自動加入 Google Meet 會議</p>
        </div>

        <div className="mx-auto mt-12 max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
            <CalendarPlus className="h-7 w-7 text-blue-600" />
          </div>
          <h2 className="text-lg font-semibold text-slate-800">尚未連結 Google 行事曆</h2>
          <p className="mt-2 text-sm text-slate-500">
            連結後可以在這裡看到行事曆事件，並讓系統自動加入 Google Meet 會議。
          </p>

          <button
            onClick={handleConnect}
            className="mt-6 w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
          >
            連結 Google 行事曆
          </button>

          <p className="mt-3 text-xs text-slate-400">
            需要 Google Workspace 帳號 — 連結即代表同意系統讀取你的行事曆事件
          </p>

          {connectNotice && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-left text-xs text-amber-800">
              {connectNotice}
            </div>
          )}

          {accountsQuery.error && (
            <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-left text-xs text-rose-700">
              無法取得連結狀態：{(accountsQuery.error as Error).message}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------- State B: connected ----------
  // 月曆網格：6 週 x 7 天 = 42 個 cell
  const gridStart = startOfCalendarGrid(anchor);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));
  const today = new Date();

  const selectedDayEvents = selectedDay
    ? eventsByDay.get(`${selectedDay.getFullYear()}-${selectedDay.getMonth()}-${selectedDay.getDate()}`) ?? []
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">月曆</h1>
          <p className="text-sm text-slate-500">查看 Google 行事曆，並讓系統自動加入 Google Meet 會議</p>
        </div>
        {primaryEmail && (
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
            <span>
              已連結 <span className="font-medium text-slate-800">{primaryEmail}</span>
              {accounts.length > 1 && (
                <span className="ml-1 text-slate-400">（+{accounts.length - 1} 個）</span>
              )}
            </span>
            <button
              onClick={handleDisconnect}
              disabled={disconnectMutation.isPending}
              className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600 disabled:opacity-50"
              title="中斷連結"
            >
              <Link2Off className="h-3.5 w-3.5" />
              {disconnectMutation.isPending ? '中斷中…' : '中斷連結'}
            </button>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={gotoPrevMonth}
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
            aria-label="上個月"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-[8rem] text-center text-base font-semibold text-slate-800">
            {anchor.getFullYear()} 年 {anchor.getMonth() + 1} 月
          </div>
          <button
            onClick={gotoNextMonth}
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
            aria-label="下個月"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={gotoToday}
            className="ml-1 rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            今天
          </button>
        </div>

        <div className="flex items-center gap-1 text-xs">
          {/* View switcher — 目前只實作「月」，日 / 週留 placeholder 給 Phase 3 */}
          {/* TODO: 後端 + 日 / 週 view 支援後啟用其他 button */}
          <button
            disabled
            className="rounded-md px-3 py-1 text-slate-400 line-through"
            title="日視圖 — 待實作"
          >
            日
          </button>
          <button
            disabled
            className="rounded-md px-3 py-1 text-slate-400 line-through"
            title="週視圖 — 待實作"
          >
            週
          </button>
          <button className="rounded-md bg-blue-50 px-3 py-1 font-medium text-blue-700">月</button>
        </div>
      </div>

      {accountsQuery.error && <ErrorBanner error={accountsQuery.error} />}
      {eventsQuery.error && <ErrorBanner error={eventsQuery.error} />}
      {accountsQuery.isLoading && <LoadingSpinner label="檢查連結狀態…" />}
      {connectNotice && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {connectNotice}
        </div>
      )}

      {/* Calendar grid */}
      {connected && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          {/* Week header */}
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-medium text-slate-500">
            {WEEKDAY_LABELS.map((w, i) => (
              <div
                key={w}
                className={[
                  'py-2',
                  i === 0 || i === 6 ? 'text-slate-400' : '',
                ].join(' ')}
              >
                週{w}
              </div>
            ))}
          </div>

          {/* Loading skeleton for events */}
          {eventsQuery.isLoading && (
            <div className="grid grid-cols-7">
              {Array.from({ length: 42 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-square min-h-[6rem] animate-pulse border-b border-r border-slate-100 bg-slate-50/50"
                />
              ))}
            </div>
          )}

          {!eventsQuery.isLoading && (
            <div className="grid grid-cols-7">
              {cells.map((cell) => {
                const key = `${cell.getFullYear()}-${cell.getMonth()}-${cell.getDate()}`;
                const dayEvents = eventsByDay.get(key) ?? [];
                const visible = dayEvents.slice(0, 3);
                const extra = dayEvents.length - visible.length;
                const inMonth = isSameMonth(cell, anchor);
                const isToday = isSameDay(cell, today);

                return (
                  <button
                    key={key}
                    onClick={() => setSelectedDay(cell)}
                    className={[
                      'min-h-[6rem] border-b border-r border-slate-100 p-1.5 text-left transition',
                      inMonth ? 'bg-white' : 'bg-slate-50/40',
                      'hover:bg-blue-50/40',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={[
                          'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs',
                          isToday
                            ? 'bg-blue-600 font-semibold text-white'
                            : inMonth
                              ? 'text-slate-700'
                              : 'text-slate-400',
                        ].join(' ')}
                      >
                        {cell.getDate()}
                      </span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {visible.map((ev) => (
                        <div
                          key={ev.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEvent(ev);
                          }}
                          className={[
                            'truncate rounded px-1 py-0.5 text-[11px] leading-tight',
                            ev.meetUrl
                              ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                          ].join(' ')}
                          title={ev.title}
                        >
                          {ev.meetUrl && '🎥 '}
                          <span className="font-mono">
                            {new Date(ev.start).toLocaleTimeString('zh-TW', {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                            })}
                          </span>{' '}
                          {ev.title}
                        </div>
                      ))}
                      {extra > 0 && (
                        <div className="px-1 text-[11px] text-slate-500">更多 +{extra}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!eventsQuery.isLoading && eventsQuery.data && eventsQuery.data.length === 0 && (
            <div className="border-t border-slate-100 p-8 text-center text-sm text-slate-500">
              本月行事曆沒有事件
            </div>
          )}
        </div>
      )}

      {/* Day-view modal */}
      {selectedDay && (
        <Modal onClose={() => setSelectedDay(null)} title={formatDateLong(selectedDay)}>
          {selectedDayEvents.length === 0 ? (
            <div className="text-sm text-slate-500">這一天沒有事件</div>
          ) : (
            <ul className="space-y-2">
              {selectedDayEvents.map((ev) => (
                <li
                  key={ev.id}
                  onClick={() => {
                    setSelectedDay(null);
                    setSelectedEvent(ev);
                  }}
                  className="cursor-pointer rounded-md border border-slate-200 p-3 hover:bg-slate-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-slate-800">{ev.title}</div>
                    {ev.meetUrl && (
                      <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                        <Video className="h-3 w-3" />
                        Meet
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-slate-500">
                    {formatTimeRange(ev.start, ev.end)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}

      {/* Event detail modal */}
      {selectedEvent && (
        <Modal
          onClose={() => {
            setSelectedEvent(null);
            setJoinNotice(null);
          }}
          title={selectedEvent.title}
        >
          <EventDetail
            event={selectedEvent}
            joinNotice={joinNotice}
            joining={joinMutation.isPending}
            onJoin={() => {
              const meetId = extractMeetIdFromUrl(selectedEvent.meetUrl);
              if (!meetId) {
                setJoinNotice('❌ 無法從 Meet URL 取出會議代碼');
                return;
              }
              joinMutation.mutate(meetId);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function Modal({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
            aria-label="關閉"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function extractMeetIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  // 標準格式：https://meet.google.com/abc-defg-hij
  const m = /meet\.google\.com\/([a-z0-9-]+)/i.exec(url);
  if (!m) return null;
  const code = m[1]!;
  // 後端寬鬆 regex：^[a-z0-9-]{3,32}$
  if (!/^[a-z0-9-]{3,32}$/i.test(code)) return null;
  return code;
}

function EventDetail({
  event,
  joinNotice,
  joining,
  onJoin,
}: {
  event: CalendarEvent;
  joinNotice: string | null;
  joining: boolean;
  onJoin: () => void;
}) {
  return (
    <div className="space-y-4 text-sm text-slate-700">
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-400">時間</div>
        <div className="mt-0.5 font-mono">
          {new Date(event.start).toLocaleDateString('zh-TW', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })}{' '}
          · {formatTimeRange(event.start, event.end)}
        </div>
      </div>

      {event.description && (
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">說明</div>
          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{event.description}</p>
        </div>
      )}

      {event.attendees && event.attendees.length > 0 && (
        <div>
          <div className="flex items-center gap-1 text-xs uppercase tracking-wide text-slate-400">
            <Users className="h-3 w-3" />
            參與者（{event.attendees.length}）
          </div>
          <ul className="mt-1 space-y-0.5">
            {event.attendees.map((a) => (
              <li key={a.email} className="text-xs text-slate-600">
                {a.displayName ? (
                  <>
                    <span className="font-medium text-slate-800">{a.displayName}</span>{' '}
                    <span className="text-slate-400">·</span>{' '}
                    <span className="font-mono">{a.email}</span>
                  </>
                ) : (
                  <span className="font-mono">{a.email}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {event.meetUrl && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
          <div className="flex items-center gap-2 text-xs text-blue-700">
            <Video className="h-4 w-4" />
            <span className="font-medium">Google Meet</span>
            {event.meetingCode && (
              <span className="font-mono text-blue-600">{event.meetingCode}</span>
            )}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-blue-700/80">
            {event.meetUrl}
          </div>
          <div className="mt-3 flex gap-2">
            <a
              href={event.meetUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100"
            >
              在 Google Meet 開啟
            </a>
            <button
              onClick={onJoin}
              disabled={joining}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {joining ? '派發中…' : '立即加入（派 bot）'}
            </button>
          </div>
          {joinNotice && (
            <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {joinNotice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
