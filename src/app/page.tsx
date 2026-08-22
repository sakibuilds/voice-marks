"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Status = "idle" | "recording" | "recorded";
type RecognitionCtor = new () => any;

interface Phrase {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface Mark {
  id: number;
  time: number;
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

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => normalize(line))
    .filter(Boolean);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function bullets(items: string[]): string {
  if (!items.length) return "Nothing clear enough to extract yet.";
  return items.map((item) => `- ${item}`).join("\n");
}

function cleanAction(sentence: string): string {
  return sentence.replace(/^[•\-\d.\s]+/, "").replace(/[.!?]+$/, "").trim();
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
  const [transcriptDraft, setTranscriptDraft] = useState("");

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

  useEffect(() => {
    phrasesRef.current = phrases;
  }, [phrases]);

  useEffect(() => {
    marksRef.current = marks;
  }, [marks]);

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

  const buildTranscript = useCallback((list: Phrase[]) => {
    const finals = list.filter((p) => p.text.trim());
    if (!finals.length) return "";
    return finals.map((p) => `[${fmt(p.start)}] ${p.text}`).join("\n");
  }, []);

  const buildPlainTranscript = useCallback((list: Phrase[]) => {
    return normalize(list.map((p) => p.text.trim()).filter(Boolean).join(" "));
  }, []);

  const pushPhrase = useCallback((text: string, start: number, end: number, interim: boolean) => {
    if (!interim) {
      const p: Phrase = { id: ++phraseSeq, start, end, text };
      setPhrases((prev) => {
        const next = [...prev, p];
        setTranscriptDraft(buildPlainTranscript(next));
        return next;
      });
      lastFinalRef.current = text;
      setLiveCaption("");
      liveRef.current = "";
    } else {
      setLiveCaption(text);
      liveRef.current = text;
    }
  }, [buildPlainTranscript]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
        MediaRecorder.isTypeSupported(m)
      ) || "";
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
      setTranscriptDraft("");
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
          if (statusRef.current === "recording") {
            try {
              recog.start();
            } catch {
              // noop
            }
          }
        };
        try {
          recog.start();
        } catch {
          // noop
        }
      }
    } catch (err) {
      console.error(err);
      alert("Microphone access was denied or unavailable. Allow mic access in your browser and try again.");
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
        // noop
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
    setTranscriptDraft("");
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
      // noop
    }
  }, []);

  const copyButton = useCallback((key: string) => {
    return copied === key ? "Copied ✓" : "Copy";
  }, [copied]);

  const deleteMark = useCallback((id: number) => {
    setMarks((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const recording = status === "recording";
  const transcript = normalize(transcriptDraft);

  const sentences = useMemo(() => splitSentences(transcript), [transcript]);

  const markHighlights = useMemo(() => {
    return unique(
      marks
        .map((mark) => cleanAction(mark.label))
        .filter((label) => label.length > 20)
    ).slice(0, 5);
  }, [marks]);

  const actionItems = useMemo(() => {
    const actionRegex = /\b(will|need to|needs to|should|must|follow up|follow-up|send|share|review|confirm|decide|schedule|call|email|ship|deliver|publish|draft|prepare)\b/i;
    return unique(
      sentences
        .filter((sentence) => actionRegex.test(sentence))
        .map(cleanAction)
        .filter((item) => item.length > 18)
    ).slice(0, 6);
  }, [sentences]);

  const decisions = useMemo(() => {
    const decisionRegex = /\b(decided|agreed|approved|resolved|plan|priority|focus|important|final|direction)\b/i;
    return unique(
      sentences
        .filter((sentence) => decisionRegex.test(sentence))
        .map(cleanAction)
        .filter((item) => item.length > 20)
    ).slice(0, 4);
  }, [sentences]);

  const quotes = useMemo(() => {
    const candidates = unique([
      ...markHighlights,
      ...sentences.filter((sentence) => sentence.length > 60 && sentence.length < 180),
    ]);
    return candidates.slice(0, 4);
  }, [markHighlights, sentences]);

  const summary = useMemo(() => {
    const summaryParts = unique([
      ...markHighlights.slice(0, 2),
      ...decisions.slice(0, 2),
      ...sentences.slice(0, 2),
    ]).slice(0, 3);
    if (!summaryParts.length) {
      return "Paste a transcript or record a conversation to generate a reusable voice-output pack.";
    }
    return summaryParts.join(" ");
  }, [decisions, markHighlights, sentences]);

  const followUpDraft = useMemo(() => {
    if (!transcript) {
      return "Subject: Follow-up\n\nThanks for the conversation. Once you add or record a transcript here, this draft will turn into a ready follow-up note.";
    }

    const actionLine = actionItems.length
      ? `Next steps I captured:\n${actionItems.map((item) => `- ${item}`).join("\n")}`
      : "No explicit next steps were clear enough to list yet.";

    return `Subject: Follow-up from the conversation\n\nThanks for the conversation. Here is the quick recap I captured:\n\n${summary}\n\n${actionLine}\n\nIf I missed or overstated anything, reply with corrections and I will tighten it.`;
  }, [actionItems, summary, transcript]);

  const crmNote = useMemo(() => {
    if (!transcript) {
      return "Conversation note\n- Waiting for transcript input\n- Summary will appear here\n- Action items will appear here";
    }

    const lines = [
      "Conversation note",
      `Summary: ${summary}`,
      `Signals: ${decisions.length ? decisions.join(" | ") : "No strong decision signals extracted"}`,
      `Next steps: ${actionItems.length ? actionItems.join(" | ") : "No explicit next step captured"}`,
    ];

    return lines.join("\n");
  }, [actionItems, decisions, summary, transcript]);

  const showNotes = useMemo(() => {
    if (!transcript) {
      return "Highlights\n- Add or record a transcript\n- Mark moments while recording\n- This panel will turn those moments into reusable notes";
    }
    return `Highlights\n${bullets(quotes)}`;
  }, [quotes, transcript]);

  const structuredTranscript = useMemo(() => buildTranscript(phrases), [buildTranscript, phrases]);
  const stats = useMemo(() => {
    const words = transcript ? transcript.split(/\s+/).filter(Boolean).length : 0;
    return {
      words,
      sentences: sentences.length,
      marks: marks.length,
      phrases: phrases.length,
    };
  }, [marks.length, phrases.length, sentences.length, transcript]);

  const outputCards = [
    { key: "summary", title: "Summary", body: summary },
    { key: "actions", title: "Action items", body: bullets(actionItems) },
    { key: "followup", title: "Follow-up draft", body: followUpDraft },
    { key: "crm", title: "CRM / recap note", body: crmNote },
    { key: "highlights", title: "Highlights / quote pulls", body: showNotes },
  ];

  return (
    <main className="min-h-screen w-full max-w-6xl mx-auto px-5 py-6">
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🎙️</span>
          <h1 className="text-2xl font-bold tracking-tight">Voice Marks</h1>
          <span className="chip">capture → reusable output pack</span>
        </div>
        <p className="text-sm text-[#9aa7b4] max-w-3xl leading-6">
          Record live conversations or paste a transcript. Mark the good moments while you speak,
          then turn the raw voice capture into a clean summary, action list, follow-up draft,
          CRM note, and highlight pack.
        </p>
      </header>

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
                {status === "idle" && "Ready to record or paste transcript"}
                {status === "recording" && (captionSupported ? "Recording + live captions" : "Recording")}
                {status === "recorded" && `${phrases.filter((p) => p.text.trim()).length} caption lines · ${marks.length} marks`}
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
                <button className="btn" onClick={() => setTranscriptDraft(buildPlainTranscript(phrases))}>
                  Use recorded transcript
                </button>
                <button className="btn btn-ghost" onClick={reset}>
                  ✕ Clear
                </button>
              </>
            )}
          </div>
        </div>

        {recording && captionSupported && (
          <div className="mt-4 p-3 rounded-xl bg-[#1c2430] border border-[#2a3342] min-h-[3rem] text-[15px] leading-relaxed">
            {liveCaption ? liveCaption : <span className="text-[#9aa7b4] text-sm">Listening… speak to see captions</span>}
          </div>
        )}

        {recording && !captionSupported && (
          <div className="mt-4 p-3 rounded-xl bg-[#1c2430] border border-[#2a3342] text-sm text-[#e6b84d]">
            Live captions need Chrome or Edge. Recording, timing, markers, and playback still work.
          </div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold">Transcript workspace</h2>
              <p className="text-xs text-[#9aa7b4] mt-1">
                Works with live voice capture or any pasted transcript.
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-ghost text-xs" onClick={() => copyText(transcript, "plain-transcript")}>
                {copyButton("plain-transcript")}
              </button>
              {phrases.length > 0 && (
                <button className="btn btn-ghost text-xs" onClick={() => copyText(structuredTranscript, "timed-transcript")}>
                  {copyButton("timed-transcript")}
                </button>
              )}
            </div>
          </div>

          <textarea
            value={transcriptDraft}
            onChange={(e) => setTranscriptDraft(e.target.value)}
            placeholder="Paste a transcript here, or record above and then tighten the wording before copying the output pack."
            className="w-full min-h-[320px] rounded-2xl border border-[#2a3342] bg-[#1c2430] px-4 py-3 text-sm leading-6 text-[#e6edf3] outline-none focus:border-[#6e8cff]"
          />

          <div className="grid sm:grid-cols-4 gap-3 mt-4">
            <div className="rounded-xl border border-[#2a3342] bg-[#1c2430] p-3">
              <div className="text-xs text-[#9aa7b4] mb-1">Words</div>
              <div className="text-lg font-semibold">{stats.words}</div>
            </div>
            <div className="rounded-xl border border-[#2a3342] bg-[#1c2430] p-3">
              <div className="text-xs text-[#9aa7b4] mb-1">Sentences</div>
              <div className="text-lg font-semibold">{stats.sentences}</div>
            </div>
            <div className="rounded-xl border border-[#2a3342] bg-[#1c2430] p-3">
              <div className="text-xs text-[#9aa7b4] mb-1">Marked moments</div>
              <div className="text-lg font-semibold">{stats.marks}</div>
            </div>
            <div className="rounded-xl border border-[#2a3342] bg-[#1c2430] p-3">
              <div className="text-xs text-[#9aa7b4] mb-1">Caption lines</div>
              <div className="text-lg font-semibold">{stats.phrases}</div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {outputCards.map((card) => (
            <article key={card.key} className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="font-semibold">{card.title}</h2>
                <button className="btn btn-ghost text-xs" onClick={() => copyText(card.body, card.key)}>
                  {copyButton(card.key)}
                </button>
              </div>
              <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-[#d5dee7] m-0 font-sans">
                {card.body}
              </pre>
            </article>
          ))}
        </section>
      </div>

      {status === "recorded" && blobUrl && (
        <section className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4 mt-6 fade-in">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">▶ Playback</h2>
            <span className="chip">{fmt(phrases[phrases.length - 1]?.end ?? now ?? 0)} total</span>
          </div>
          <audio ref={audioRef} controls className="w-full" src={blobUrl} preload="auto" />
        </section>
      )}

      {(marks.length > 0 || phrases.length > 0 || recording) && (
        <section className="grid gap-6 lg:grid-cols-2 mt-6">
          <article className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4 fade-in">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">✦ Marked moments</h2>
              {marks.length > 0 && (
                <button className="btn btn-ghost text-xs" onClick={() => copyText(bullets(markHighlights), "mark-list")}>
                  {copyButton("mark-list")}
                </button>
              )}
            </div>
            {marks.length === 0 ? (
              <p className="text-sm text-[#9aa7b4]">Mark moments during recording to pull out the strongest parts fast.</p>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-y-auto">
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
                    <span className="tabular-nums text-xs text-[#6e8cff] font-semibold w-10 shrink-0">{fmt(m.time)}</span>
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
            )}
          </article>

          <article className="rounded-2xl border border-[#2a3342] bg-[#161b22] p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Transcript timeline</h2>
              {phrases.length > 0 && (
                <button className="btn btn-ghost text-xs" onClick={() => copyText(structuredTranscript, "timeline-copy")}>
                  {copyButton("timeline-copy")}
                </button>
              )}
            </div>

            {recording && !phrases.length && !liveCaption && (
              <p className="text-sm text-[#9aa7b4]">Captions will appear here as you speak.</p>
            )}
            {status === "recorded" && phrases.filter((p) => p.text.trim()).length === 0 && (
              <p className="text-sm text-[#9aa7b4]">
                No captions captured for this recording. You can still use the audio player and paste your own transcript into the workspace above.
              </p>
            )}

            <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
              {phrases
                .filter((p) => p.text.trim() || liveCaption)
                .map((p, i) => (
                  <li key={`p${p.id}-${i}`} className="flex items-start gap-3 group">
                    <button
                      className="text-[11px] text-[#6e8cff] font-semibold tabular-nums pt-0.5 shrink-0 w-10 text-left hover:underline"
                      onClick={() => seekTo(p.start)}
                      title="Jump to this point"
                    >
                      {fmt(p.start)}
                    </button>
                    <span className="text-sm leading-relaxed">{p.text}</span>
                  </li>
                ))}
            </ul>
          </article>
        </section>
      )}
    </main>
  );
}
