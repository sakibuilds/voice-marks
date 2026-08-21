"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "recording" | "recorded";
type RecognitionCtor = new () => any;

interface Phrase {
  id: number;
  start: number; // seconds into recording
  end: number;
  text: string;
}
interface Mark {
  id: number;
  time: number; // seconds into recording
  label: string;
  phraseId: number | null;
}

function fmt(t: number | null): string {
  if (t == null || !isFinite(t)) return "0:00";
  const total = Math.max(0, Math.floor(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

let phraseSeq = 0;
let markSeq = 0;

export default function VoiceMarksPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [captionSupported, setCaptionSupported] = useState(true);
  const [liveCaption, setLiveCaption] = useState("");
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [activeMark, setActiveMark] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recogRef = useRef<any>(null);
  const startTimeRef = useRef(0);
  const lastFinalRef = useRef("");
  const phrasesRef = useRef<Phrase[]>([]);
  const marksRef = useRef<Mark[]>([]);
  const liveRef = useRef("");
  const statusRef = useRef<Status>("idle");
  statusRef.current = status;

  const nowPhrase = useCallback(() => {
    return liveRef.current.trim() || lastFinalRef.current.trim();
  }, []);

  // keep refs in sync for use inside recognition callbacks
  useEffect(() => {
    phrasesRef.current = phrases;
  }, [phrases]);
  useEffect(() => {
    marksRef.current = marks;
  }, [marks]);

  // ticker while recording
  useEffect(() => {
    if (status !== "recording") return;
    const id = setInterval(() => {
      setNow((performance.now() - startTimeRef.current) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    const Ctor: RecognitionCtor | undefined =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setCaptionSupported(Boolean(Ctor));
  }, []);

  const ensureRecognition = useCallback(() => {
    const Ctor: RecognitionCtor | undefined =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return null;
    const recog = new Ctor();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = "en-IN";
    return recog;
  }, []);

  const pushPhrase = useCallback((text: string, start: number, end: number, interim: boolean) => {
    if (!interim) {
      const p: Phrase = { id: ++phraseSeq, start, end, text };
      setPhrases((prev) => [...prev, p]);
      lastFinalRef.current = text;
      setLiveCaption("");
      liveRef.current = "";
    } else {
      setLiveCaption(text);
      liveRef.current = text;
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
        if (audioRef.current) audioRef.current.src = url;
      };

      startTimeRef.current = performance.now();
      setPhrases([]);
      setMarks([]);
      setNow(0);
      setActiveMark(null);
      setStatus("recording");

      rec.start();

      const recog = ensureRecognition();
      if (recog) {
        recogRef.current = recog;
        recog.onresult = (ev: any) => {
          let interim = "";
          let final = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            const text = r[0].transcript.trim();
            if (r.isFinal) final += (final ? " " : "") + text;
            else interim += (interim ? " " : "") + text;
          }
          const t = (performance.now() - startTimeRef.current) / 1000;
          if (final) pushPhrase(final, Math.max(0, t - 2), t, false);
          if (interim) pushPhrase(interim, Math.max(0, t - 2), t, true);
        };
        recog.onend = () => {
          // SpeechRecognition stops abruptly on silence; restart if we're still recording
          if (statusRef.current === "recording") {
            try {
              recog.start();
            } catch {
              /* noop */
            }
          }
        };
        try {
          recog.start();
        } catch {
          /* noop */
        }
      }
    } catch (err) {
      console.error(err);
      alert(
        "Microphone access was denied or unavailable. Allow mic access in your browser and try again."
      );
    }
  }, [ensureRecognition, pushPhrase]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (recogRef.current) {
      try {
        recogRef.current.stop();
      } catch {
        /* noop */
      }
      recogRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    setStatus("recorded");
  }, []);

  const addMark = useCallback(() => {
    const t = (performance.now() - startTimeRef.current) / 1000;
    const label = nowPhrase() || `Moment at ${fmt(t)}`;
    setMarks((prev) => [...prev, { id: ++markSeq, time: t, label, phraseId: null }]);
  }, [nowPhrase]);

  const seekTo = useCallback((time: number, markId?: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, time);
    audio.play().catch(() => undefined);
    if (markId != null) setActiveMark(markId);
  }, []);

  const reset = useCallback(() => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setPhrases([]);
    setMarks([]);
    setLiveCaption("");
    setNow(0);
    setActiveMark(null);
    setStatus("idle");
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
  }, [blobUrl]);

  const copyText = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard may not be available */
    }
  }, []);

  const buildTranscript = useCallback(() => {
    const finals = phrasesRef.current.filter((p) => p.text.trim());
    if (!finals.length) return "";
    return finals.map((p) => `[${fmt(p.start)}] ${p.text}`).join("\n");
  }, []);

  const buildNotes = useCallback(() => {
    const ms = marksRef.current;
    if (!ms.length) return "";
    return ms
      .map((m) => `[${fmt(m.time)}] ${m.label}`)
      .join("\n");
  }, []);

  const copyButton = (key: string, fn: () => string) =>
    copied === key ? "Copied ✓" : "Copy";

  const deleteMark = useCallback((id: number) => {
    setMarks((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const recording = status === "recording";

  if (!captionSupported) {
    // still functional: recording + markers + seekable playback, just no captions
  }

  return (
    <main className="min-h-screen flex flex-col px-5 py-6 max-w-3xl mx-auto w-full">
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🎙️</span>
          <h1 className="text-xl font-bold tracking-tight">Voice Marks</h1>
        </div>
        <p className="text-sm text-[#9aa7b4]">
          Record interviews, podcasts, and panels. Real-time captions while you record, tap to
          mark the key moments, then jump straight back to them.
        </p>
      </header>

      {/* Control deck */}
      <section className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-5 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-sm font-bold"
              style={{
                background: status === "idle" ? "#1c2430" : status === "recording" ? "#ff6670" : "#22d3a5",
                color: "#fff",
              }}
            >
              {status === "recording" ? (
                <span className="rec-pulse w-10 h-10 rounded-full bg-[#ff6670]" />
              ) : status === "recorded" ? (
                "✓"
              ) : (
                "●"
              )}
            </div>
            <div>
              <div className="text-lg font-semibold tabular-nums">{fmt(now)}</div>
              <div className="text-xs text-[#9aa7b4]">
                {status === "idle" && "Ready"}
                {status === "recording" && (captionSupported ? "Recording + captions" : "Recording")}
                {status === "recorded" && `${phrases.filter((p) => p.text.trim()).length} caption lines · ${marks.length} markers`}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {status === "idle" && (
              <button className="btn btn-danger" onClick={startRecording}>
                ● Start recording
              </button>
            )}
            {recording && (
              <>
                <button className="btn" onClick={addMark}>
                  ✦ Mark moment
                </button>
                <button className="btn btn-primary" onClick={stopRecording}>
                  ⏹ Stop
                </button>
              </>
            )}
            {status === "recorded" && (
              <>
                <button className="btn btn-danger" onClick={startRecording}>
                  ● Record again
                </button>
                <button className="btn btn-ghost" onClick={reset}>
                  ✕ Clear
                </button>
              </>
            )}
          </div>
        </div>

        {/* live caption */}
        {recording && captionSupported && (
          <div className="mt-4 p-3 rounded-xl bg-[#1c2430] border border-[#2a3342] min-h-[3rem] text-[15px] leading-relaxed">
            {liveCaption ? (
              liveCaption
            ) : (
              <span className="text-[#9aa7b4] text-sm">Listening… speak to see captions</span>
            )}
          </div>
        )}
        {recording && !captionSupported && (
          <div className="mt-4 p-3 rounded-xl bg-[#1c2430] border border-[#2a3342] text-sm text-[#e6b84d]">
            Live captions need Chrome / Edge. Recording, timing, markers, and playback still work.
          </div>
        )}
      </section>

      {/* Playback */}
      {status === "recorded" && blobUrl && (
        <section className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4 mb-6 fade-in">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2">▶ Playback</h2>
            <span className="chip">{fmt(phrases[phrases.length - 1]?.end ?? now ?? 0)} total</span>
          </div>
          <audio ref={audioRef} controls className="w-full" src={blobUrl} preload="auto" />
        </section>
      )}

      {/* Marks */}
      {status === "recorded" && marks.length > 0 && (
        <section className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4 mb-6 fade-in">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2">✦ Marked moments</h2>
            <div className="flex gap-2">
              <button className="btn btn-ghost text-xs" onClick={() => copyText(buildNotes(), "notes")}>
                {copyButton("notes", buildNotes)}
              </button>
            </div>
          </div>
          <ul className="space-y-2 max-h-64 overflow-y-auto">
            {marks.map((m) => (
              <li
                key={m.id}
                className={`mark-pop flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition-colors ${
                  activeMark === m.id ? "border-[#6e8cff] bg-[#1c2430]" : "border-[#2a3342] bg-[#1c2430]"
                }`}
                onClick={() => seekTo(m.time, m.id)}
              >
                <button
                  className="btn text-xs px-2.5 py-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(m.time, m.id);
                  }}
                >
                  ▶
                </button>
                <span className="tabular-nums text-xs text-[#6e8cff] font-semibold w-10 shrink-0">
                  {fmt(m.time)}
                </span>
                <span className="text-sm truncate flex-1">{m.label}</span>
                <button
                  className="btn btn-ghost text-xs px-2 py-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteMark(m.id);
                  }}
                  title="Remove marker"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Transcript */}
      {(status === "recorded" || recording) && (
        <section className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2">Transcript</h2>
            {status === "recorded" && (
              <div className="flex gap-2">
                <button
                  className="btn btn-ghost text-xs"
                  onClick={() => copyText(buildTranscript(), "transcript")}
                >
                  {copyButton("transcript", buildTranscript)}
                </button>
              </div>
            )}
          </div>

          {recording && !phrases.length && !liveCaption && (
            <p className="text-sm text-[#9aa7b4]">Captions will appear here as you speak.</p>
          )}
          {status === "recorded" && phrases.filter((p) => p.text.trim()).length === 0 && (
            <p className="text-sm text-[#9aa7b4]">
              No captions captured for this recording (captions need Chrome/Edge). You can still
              listen back to the audio above.
            </p>
          )}

          <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
            {phrases
              .filter((p, i) => p.text.trim() || (i === phrases.length - 1 && liveCaption))
              .map((p, i) => {
                const final = p.text.trim();
                return (
                  <li key={`p${p.id}-${i}`} className="flex items-start gap-3 group">
                    <button
                      className="text-[11px] text-[#6e8cff] font-semibold tabular-nums pt-0.5 shrink-0 w-10 text-left hover:underline"
                      onClick={() => seekTo(p.start)}
                      title="Jump to this point"
                    >
                      {fmt(p.start)}
                    </button>
                    <span className={`text-sm leading-relaxed ${final ? "" : "text-[#9aa7b4] italic"}`}>
                      {p.text}
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      )}
    </main>
  );
}