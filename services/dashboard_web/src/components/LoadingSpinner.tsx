import { Loader2 } from 'lucide-react';

export default function LoadingSpinner({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
