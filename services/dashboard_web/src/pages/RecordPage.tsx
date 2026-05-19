import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Loader2, Mic, Square } from 'lucide-react';

import ErrorBanner from '../components/ErrorBanner';
import { getStoredDept } from '../lib/auth';

type Phase = 'idle' | 'recording' | 'uploading' | 'done';

function defaultTitle(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `本地錄音 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 選一個瀏覽器支援、speaches 能讀的 audio mime type。
 * Chrome/Edge：webm;opus、Safari：mp4。其他 fallback 給 browser 自選。
 */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export default function RecordPage() {
  const dept = getStoredDept();
  const [phase, setPhase] = useState<Phase>('idle');
  const [title, setTitle] = useState(defaultTitle());
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [volume, setVolume] = useState(0); // 0~1
  const [resultMeetId, setResultMeetId] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const mimeTypeRef = useRef<string | undefined>(undefined);

  // 清乾淨所有錄音相關資源（停止 stream / 取消 raf / 關 audio context）
  function cleanup() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  async function startRecording() {
    setError(null);
    setElapsed(0);
    setVolume(0);
    chunksRef.current = [];
    setResultMeetId(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      mimeTypeRef.current = mimeType;
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        void uploadRecording();
      };

      recorder.start(1000); // 每秒切一塊

      // 音量分析（用 AnalyserNode）
      const AudioContextCls =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioContextCls) {
        const audioCtx = new AudioContextCls();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;

        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteTimeDomainData(buf);
          // 算 RMS
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setVolume(Math.min(1, rms * 2.5)); // 放大一點，靜音時接近 0
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      }

      // 計時
      startedAtRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 200);

      setPhase('recording');
    } catch (err) {
      cleanup();
      setPhase('idle');
      const message = err instanceof Error ? err.message : '無法存取麥克風';
      setError(`錄音啟動失敗：${message}`);
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    // 停 raf / timer，但保留 stream 直到 onstop 上傳完才 cleanup
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPhase('uploading');
  }

  async function uploadRecording() {
    try {
      const mime = mimeTypeRef.current ?? 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mime });
      if (blob.size === 0) {
        throw new Error('沒有錄到任何音訊');
      }

      const form = new FormData();
      // 副檔名跟著 mime 選個合理的
      const ext = mime.includes('mp4') ? 'm4a' : 'webm';
      form.append('audio', blob, `recording.${ext}`);
      form.append('title', title);

      const res = await fetch('/api/recordings', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });

      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        const msg =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${res.status}`;
        throw new Error(msg);
      }

      const meetId =
        parsed && typeof parsed === 'object' && 'meet_id' in parsed
          ? String((parsed as { meet_id: unknown }).meet_id)
          : null;
      setResultMeetId(meetId);
      setPhase('done');
    } catch (err) {
      const message = err instanceof Error ? err.message : '上傳失敗';
      setError(`上傳失敗：${message}`);
      setPhase('idle');
    } finally {
      cleanup();
    }
  }

  function resetForNext() {
    setPhase('idle');
    setError(null);
    setTitle(defaultTitle());
    setElapsed(0);
    setVolume(0);
    setResultMeetId(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">本地錄音</h1>
        <p className="text-sm text-slate-500">
          直接從這台電腦的麥克風錄音，上傳後會自動轉錄並產生摘要與 Action Items
          {dept ? ` — 部門：${dept.name}` : ''}
        </p>
      </div>

      {error && <ErrorBanner error={error} />}

      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="space-y-1 pb-4">
          <label className="text-sm font-medium text-slate-700">會議標題</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={phase !== 'idle'}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            placeholder="例：5/18 產品提案討論"
          />
          <p className="text-xs text-slate-500">未填則自動以日期時間命名</p>
        </div>

        <div className="flex flex-col items-center justify-center gap-4 border-t border-slate-100 pt-6">
          {phase === 'idle' && (
            <button
              onClick={startRecording}
              className="flex items-center gap-2 rounded-full bg-red-600 px-8 py-4 text-base font-semibold text-white shadow-md transition hover:bg-red-700"
            >
              <Mic className="h-6 w-6" />
              開始錄音
            </button>
          )}

          {phase === 'recording' && (
            <>
              <div className="flex items-center gap-3 text-lg font-mono text-slate-800">
                <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-red-500" />
                錄音中 — {formatDuration(elapsed)}
              </div>
              <div className="h-3 w-64 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-emerald-500 transition-all duration-75"
                  style={{ width: `${Math.round(volume * 100)}%` }}
                />
              </div>
              <button
                onClick={stopRecording}
                className="flex items-center gap-2 rounded-full bg-slate-800 px-6 py-3 text-sm font-medium text-white shadow-md transition hover:bg-slate-900"
              >
                <Square className="h-4 w-4" />
                停止
              </button>
            </>
          )}

          {phase === 'uploading' && (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-5 w-5 animate-spin" />
              上傳中…
            </div>
          )}

          {phase === 'done' && (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex items-center gap-2 text-base font-medium text-emerald-700">
                <CheckCircle2 className="h-6 w-6" />
                已上傳，1-3 分鐘內 dashboard 會出現摘要
              </div>
              {resultMeetId && (
                <div className="text-xs text-slate-500">
                  Meet ID: <span className="font-mono">{resultMeetId}</span>
                </div>
              )}
              <div className="flex gap-3">
                <Link
                  to="/"
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  返回會議列表
                </Link>
                <button
                  onClick={resetForNext}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  再錄一段
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
        <p className="font-medium text-slate-700">使用說明</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>瀏覽器會請求麥克風權限，請允許</li>
          <li>建議在安靜環境錄音，背景噪音會降低轉錄品質</li>
          <li>停止後音檔會自動上傳，後端用 speaches (faster-whisper) 轉錄為中文</li>
          <li>轉錄完成後會自動產生摘要、Action Items，並寫入會議列表</li>
        </ul>
      </div>
    </div>
  );
}
