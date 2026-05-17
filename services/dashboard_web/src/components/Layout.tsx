import { Outlet } from 'react-router-dom';

import Sidebar from './Sidebar';

export default function Layout({ admin = false }: { admin?: boolean }) {
  return (
    <div className="flex h-screen">
      <Sidebar admin={admin} />
      <main className="flex-1 overflow-y-auto bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
