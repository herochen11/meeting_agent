import { AlertTriangle } from 'lucide-react';

export default function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '發生未知錯誤';
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}
