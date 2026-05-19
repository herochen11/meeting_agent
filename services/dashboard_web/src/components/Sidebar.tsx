import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Calendar, CheckSquare, FileBarChart, LogOut, Mic, Settings, Video } from 'lucide-react';

import { getStoredDept, logout } from '../lib/auth';
import BotConsole from './BotConsole';

type Props = { admin?: boolean };

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition',
    isActive
      ? 'bg-blue-50 font-medium text-blue-700'
      : 'text-slate-600 hover:bg-slate-100',
  ].join(' ');

export default function Sidebar({ admin }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dept = getStoredDept();

  async function handleLogout() {
    await logout();
    // 清掉 React Query 所有快取，避免再登入別部門時看到舊資料
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  return (
    <aside className="flex h-full w-60 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="text-lg font-semibold text-slate-800">NoirsBoxes</div>
        <div className="text-xs text-slate-500">會議管理</div>
      </div>

      <div className="border-b border-slate-200 px-4 py-3">
        {admin ? (
          <div className="text-sm font-medium text-amber-700">Admin 模式</div>
        ) : (
          <>
            <div className="text-xs text-slate-500">目前部門</div>
            <div className="text-sm font-medium text-slate-800">
              {dept?.name ?? '—'}
            </div>
          </>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {admin ? (
          <NavLink to="/admin/departments" className={navItemClass}>
            <Settings className="h-4 w-4" />
            部門管理
          </NavLink>
        ) : (
          <>
            <NavLink to="/" end className={navItemClass}>
              <Video className="h-4 w-4" />
              會議記錄
            </NavLink>
            <NavLink to="/action-items" className={navItemClass}>
              <CheckSquare className="h-4 w-4" />
              Action Items
            </NavLink>
            <NavLink to="/record" className={navItemClass}>
              <Mic className="h-4 w-4" />
              本地錄音
            </NavLink>
            <NavLink to="/calendar" className={navItemClass}>
              <Calendar className="h-4 w-4" />
              月曆
            </NavLink>
            <NavLink to="/reports" className={navItemClass}>
              <FileBarChart className="h-4 w-4" />
              報表
            </NavLink>
          </>
        )}
      </nav>

      {!admin && (
        <div className="p-3">
          <BotConsole />
        </div>
      )}

      <div className="border-t border-slate-200 p-3">
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          <LogOut className="h-4 w-4" />
          登出
        </button>
      </div>
    </aside>
  );
}
