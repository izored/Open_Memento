import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Icon } from '@/components/Icon';
import { PageHeader } from '@/components/PageHeader';
import { ChangelogModal, cmpVersion } from '@/components/ChangelogModal';
import { MeshIntroModal } from '@/components/MeshIntroModal';
import { MeshConflictModal } from '@/components/MeshConflictModal';
import { MeshPairingPanel } from '@/components/MeshPairingPanel';
import { meshApi, type MeshBatch } from '@/lib/api';
import { ONBOARDING_KEY } from '@/lib/onboarding';
import { useInstall, shellBridge } from '@/lib/install';
import { useAppStore } from '@/stores/appStore';
import { useIsMobile } from '@/lib/useBreakpoint';
import { CookiesUpload } from '@/components/CookiesUpload';
import { useConfirm } from '@/components/ConfirmModal';
import { systemApi, maintenanceApi, backupApi, settingsApi, memoApi, collectionApi, type AppSettings, type LibraryIntegrity, type MusicRelayStatus, type TelegramRelayStatus } from '@/lib/api';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { OllamaModel } from '@/types';

type BuiltWithEntry = { name: string; url: string; desc: string };

const BUILT_WITH_LEAD =
  'openMemo is mostly other people’s work. Every one of these is free and open source, written by someone who gave it away, and openMemo would not exist without any of them. Hover a name to see what it does here.';

function BuiltWith({ entries }: { entries: BuiltWithEntry[] }) {
  // Auto-scrolling band. The track is rendered twice back-to-back and animated
  // -50% so the loop is seamless; hovering the band pauses it. Hovering a pill
  // swaps the lead line for that project's description (no floating tooltip),
  // and the line reverts when the pointer leaves the band.
  const [hover, setHover] = useState<BuiltWithEntry | null>(null);
  const loop = [...entries, ...entries];
  return (
    <>
      <p className="om-built-with-lead" aria-live="polite">
        {hover ? (
          <>
            <span className="om-bw-lead-name">{hover.name}</span> {hover.desc}
          </>
        ) : (
          BUILT_WITH_LEAD
        )}
      </p>
      <div className="om-bw-band" onMouseLeave={() => setHover(null)}>
        <div className="om-bw-track">
          {loop.map((d, i) => (
            <a
              key={`${d.name}-${i}`}
              className="om-bw-pill"
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-hidden={i >= entries.length}
              tabIndex={i >= entries.length ? -1 : 0}
              onMouseEnter={() => setHover(d)}
              onFocus={() => setHover(d)}
            >
              {d.name}
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

// Everything openMemo leans on that somebody else wrote and gave away.
// Kept honest rather than short: if it does real work in this app it belongs
// here, and a name people would recognise is not the same as a name that
// earned its place. Ordered by what it does, since the band scrolls past in
// this order: the app itself, reading what you saved, getting things in, the
// intelligence (all of it local), then what holds it together.
const BUILT_WITH: BuiltWithEntry[] = [
  { name: 'React', url: 'https://react.dev', desc: 'The UI library every screen is built on, components, hooks, the whole shape of the frontend.' },
  { name: 'Vite', url: 'https://vitejs.dev', desc: 'Dev server and build tool. Instant reloads while building, a small bundle when shipping.' },
  { name: 'TypeScript', url: 'https://www.typescriptlang.org', desc: 'Types across the whole frontend, so a renamed field breaks the build instead of a card.' },
  { name: 'React Router', url: 'https://reactrouter.com', desc: 'Every address in the app. A collection, a Space and a memo each get a real URL you can bookmark.' },
  { name: 'TanStack Query', url: 'https://tanstack.com/query', desc: 'Frontend cache and data fetching. Keeps memos, stats and collections in sync without manual wiring.' },
  { name: 'Zustand', url: 'https://github.com/pmndrs/zustand', desc: 'Tiny state store for the sidebar, filters and appearance. No boilerplate, no providers.' },
  { name: 'Motion', url: 'https://motion.dev', desc: 'Every spring, fade and layout animation in the UI. The sidebar collapse, the filter pill, the card transitions.' },
  { name: 'dnd-kit', url: 'https://dndkit.com', desc: 'The drag and drop behind reordering memos and dropping a card into a collection or a Space.' },
  { name: 'Radix UI', url: 'https://www.radix-ui.com', desc: 'The unstyled primitives under the dialogs, menus, tabs and tooltips, so keyboard and screen reader behaviour is right by default.' },
  { name: 'Lucide', url: 'https://lucide.dev', desc: 'The icon set. Nearly every glyph in the interface that is not hand drawn.' },
  { name: 'Lenis', url: 'https://lenis.darkroom.engineering', desc: 'The smooth scrolling on long pages and the music rails.' },
  { name: 'date-fns', url: 'https://date-fns.org', desc: 'Turns timestamps into the readable dates on every card and memo page.' },
  { name: 'MDXEditor', url: 'https://mdxeditor.dev', desc: 'The rich Markdown editor for notes and memo content. What you see is what you get, with real Markdown underneath.' },
  { name: 'pdf.js', url: 'https://mozilla.github.io/pdf.js/', desc: 'Draws a saved PDF page by page inside openMemo, on a canvas the app owns, with no network and no browser viewer.' },
  { name: 'PDFium', url: 'https://pdfium.googlesource.com/pdfium/', desc: 'Renders page one of a PDF into the picture on its card, through the pypdfium2 wheel.' },
  { name: 'CodeMirror', url: 'https://codemirror.net', desc: 'The syntax highlighted viewer for an uploaded source file, with line numbers and search inside the file.' },
  { name: 'react-markdown', url: 'https://github.com/remarkjs/react-markdown', desc: 'Renders Markdown safely wherever openMemo shows it: notes, summaries, extracted article text.' },
  { name: 'pypdf', url: 'https://github.com/py-pdf/pypdf', desc: 'Reads the text out of a PDF so it can be searched, embedded and asked about.' },
  { name: 'python-docx', url: 'https://github.com/python-openxml/python-docx', desc: 'Reads Word documents into plain text on the way in.' },
  { name: 'openpyxl', url: 'https://foss.heptapod.net/openpyxl/openpyxl', desc: 'Reads spreadsheets into text, so a saved workbook is searchable rather than opaque.' },
  { name: 'Pillow', url: 'https://python-pillow.org', desc: 'Every image openMemo writes: thumbnails, covers, and the page rendered off a PDF.' },
  { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp', desc: 'Pulls title, description and thumbnails from YouTube and social video links, and downloads the media when you make a memo local.' },
  { name: 'gallery-dl', url: 'https://github.com/mikf/gallery-dl', desc: 'Fetches photo posts and carousels at full resolution, which the video tools cannot do at all.' },
  { name: 'FFmpeg', url: 'https://ffmpeg.org', desc: 'Pulls the still frame off a video for its card, and converts audio when a memo is made local.' },
  { name: 'Playwright', url: 'https://playwright.dev', desc: 'The headless browser behind the link scraper, so a page that needs JavaScript still saves properly.' },
  { name: 'Beautiful Soup', url: 'https://www.crummy.com/software/BeautifulSoup/', desc: 'Reads the HTML of a saved page apart to find the article inside it.' },
  { name: 'readability-lxml', url: 'https://github.com/buriy/python-readability', desc: 'Decides which part of a cluttered page is actually the article.' },
  { name: 'Mutagen', url: 'https://mutagen.readthedocs.io', desc: 'Reads artist, album and title tags off an uploaded music file.' },
  { name: 'Ollama', url: 'https://ollama.com', desc: 'Runs the local models behind chat, summaries and embeddings. No cloud round trip, no API key.' },
  { name: 'Whisper', url: 'https://github.com/openai/whisper', desc: 'The speech recognition model behind every transcript openMemo makes on your own machine.' },
  { name: 'faster-whisper', url: 'https://github.com/SYSTRAN/faster-whisper', desc: 'The fast runtime that actually executes Whisper here, on a GPU or a CPU.' },
  { name: 'ChromaDB', url: 'https://www.trychroma.com', desc: 'Vector store for memo embeddings. Makes search by meaning possible against your own library.' },
  { name: 'FastAPI', url: 'https://fastapi.tiangolo.com', desc: 'The Python web framework powering the API. Async first, type safe through Pydantic.' },
  { name: 'Uvicorn', url: 'https://www.uvicorn.org', desc: 'The server the backend actually runs on.' },
  { name: 'SQLAlchemy', url: 'https://www.sqlalchemy.org', desc: 'Describes every table once, and talks to the database asynchronously so one slow query cannot block the rest.' },
  { name: 'SQLite', url: 'https://sqlite.org', desc: 'The single file database holding every memo, collection, tag and chat. Embedded, no configuration, fast.' },
  { name: 'Pydantic', url: 'https://docs.pydantic.dev', desc: 'Validates everything crossing the API boundary, and every setting read at startup.' },
  { name: 'HTTPX', url: 'https://www.python-httpx.org', desc: 'Every outbound request openMemo makes, all of them ones you asked for.' },
  { name: 'APScheduler', url: 'https://github.com/agronholm/apscheduler', desc: 'Runs the quiet background jobs: backups, integrity checks, re-filing memo types.' },
  { name: 'cryptography', url: 'https://cryptography.io', desc: 'Encrypts the Mesh sync channel between your two machines with AES-256-GCM.' },
  { name: 'Zeroconf', url: 'https://github.com/python-zeroconf/python-zeroconf', desc: 'Lets two of your machines find each other on the network with no address typed in.' },
  { name: 'nginx', url: 'https://nginx.org', desc: 'Serves the built frontend and passes the API through, in the Docker build.' },
  { name: 'Docker', url: 'https://www.docker.com', desc: 'How openMemo installs on a machine without you assembling a Python and Node toolchain first.' },
];

type Stats = {
  total_memos: number;
  total_collections: number;
  total_tags: number;
  memos_this_week: number;
  by_type: Record<string, number>;
  storage?: { db_bytes: number; files_bytes: number; cache_bytes: number; total_bytes: number };
};

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function SettingCard({
  title,
  eyebrow,
  span,
  className = '',
  children,
}: {
  title: string;
  eyebrow: string;
  span?: 2 | 3 | 4 | 6;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`om-setting-card${span ? ` s${span}` : ''}${className ? ` ${className}` : ''}`}>
      <div className="om-setting-head">
        <span className="mono om-setting-eyebrow">{eyebrow}</span>
        <h3 className="om-setting-title">{title}</h3>
      </div>
      <div className="om-setting-body">{children}</div>
    </div>
  );
}

function RecentlyDeletedModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const modalRef = useRef<HTMLDivElement>(null);
  const { data: deleted = [], isLoading } = useQuery({
    queryKey: ['memos', 'deleted'],
    queryFn: memoApi.listDeleted,
  });

  useEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener('wheel', stop);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', stop);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const restore = async (id: string) => {
    try {
      await memoApi.restore(id);
      queryClient.invalidateQueries({ queryKey: ['memos'] });
      queryClient.invalidateQueries({ queryKey: ['memos', 'deleted'] });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <>
      <div className="om-backdrop" onClick={onClose} />
      <div ref={modalRef} className="om-modal" role="dialog" aria-label="Recently Deleted">
        <div className="om-modal-head">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="mono om-modal-eyebrow">Trash</span>
            <b style={{ fontSize: 16, fontWeight: 600 }}>Recently Deleted</b>
          </div>
          <button className="om-icon-btn" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="om-modal-body" style={{ gap: 8 }}>
          {isLoading && <p className="om-hint-readable">Loading…</p>}
          {!isLoading && deleted.length === 0 && (
            <p className="om-hint-readable" style={{ fontSize: 13, color: 'var(--text-4)' }}>No recently deleted memos.</p>
          )}
          {deleted.map((m) => (
            <div key={m.id} className="om-setting-row" style={{ gap: 10 }}>
              <div className="om-setting-row-text" style={{ minWidth: 0 }}>
                <p style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</p>
                <span className="mono" style={{ fontSize: 11 }}>{m.type} · {m.deleted_at ? new Date(m.deleted_at).toLocaleDateString() : ''}</span>
              </div>
              <button className="om-btn-secondary" onClick={() => restore(m.id)}>Restore</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function TrashRow() {
  // Recently-deleted lives as a row inside the Files card now, not its own card.
  const [open, setOpen] = useState(false);
  const { data: deleted = [], isLoading } = useQuery({
    queryKey: ['memos', 'deleted'],
    queryFn: memoApi.listDeleted,
  });

  // No own `om-setting-row` — the caller already wraps this in one. A nested
  // row would collapse to content width inside the parent's space-between flex,
  // so "Open trash" wouldn't right-align with the other controls.
  return (
    <>
      <div className="om-setting-row-text">
        <p>Recently deleted</p>
        {isLoading ? (
          <span className="om-skel" />
        ) : (
          <span className="mono">{deleted.length} deleted memo{deleted.length === 1 ? '' : 's'} can be restored</span>
        )}
      </div>
      <button className="om-btn-secondary" onClick={() => setOpen(true)}>Open trash</button>
      {open && <RecentlyDeletedModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** Library integrity: do the files the database references still exist?
 *
 *  On 2026-08-04 a test run deleted 435 media files and openMemo served pages
 *  normally for ninety minutes, because nothing ever asked. It asks hourly now,
 *  and this is where the answer shows up. */
function LibraryIntegrityRows() {
  const [state, setState] = useState<LibraryIntegrity | null>(null);
  const [busy, setBusy] = useState(false);
  // Two-step repair: the first click asks the server what it WOULD re-pull,
  // the second commits. Queueing fetches against real hosts is not something
  // to do on one click of a button somebody found by accident.
  const [plan, setPlan] = useState<{ memos: number } | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repaired, setRepaired] = useState<number | null>(null);
  // The slow half stays OFF unless asked for. Re-reading every degraded memo
  // can be hundreds of page loads, and a button that quietly opts you into that
  // is the thing the never-default-on rule exists to stop.
  const [alsoDegraded, setAlsoDegraded] = useState(false);

  useEffect(() => {
    settingsApi.libraryIntegrity().then(setState).catch(() => setState(null));
  }, []);

  const checkNow = async () => {
    setBusy(true);
    try { setState(await settingsApi.libraryIntegrityCheck()); }
    catch { /* leave the last known result on screen */ }
    finally { setBusy(false); }
  };

  const missing = state ? state.missing_media + state.missing_thumbs : 0;
  const incident = state?.status === 'incident';
  const wrongPulls = state ? state.pictureless_videos + state.degraded_reads : 0;

  return (
    <>
      <div className="om-setting-row">
        <div className="om-setting-row-text">
          <p>Library integrity</p>
          <span className="mono">
            {!state
              ? 'Checking…'
              : missing === 0
                ? `All ${state.with_media} media files and ${state.with_thumb} thumbnails are on disk`
                : `${state.missing_media} media file${state.missing_media === 1 ? '' : 's'} and ${state.missing_thumbs} thumbnail${state.missing_thumbs === 1 ? '' : 's'} missing of ${state.with_media + state.with_thumb}`}
          </span>
        </div>
        <button className="om-btn-secondary" onClick={checkNow} disabled={busy}>
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {/* Loud only when it is news. A library that has been missing the same
          59 uploads for a month is a known state; more missing than at the
          last check is an incident, and saying so early is the entire point. */}
      {state && (missing > 0 || state.silent_videos > 0 || state.pictureless_videos > 0 || state.degraded_reads > 0) && (
        <div
          role="status"
          style={{
            border: `1px solid var(${incident ? '--border-danger, #D65C5C' : '--border-warning, #E5C07B'})`,
            background: `var(${incident ? '--bg-danger, rgba(198,40,40,0.08)' : '--bg-warning, rgba(186,117,23,0.08)'})`,
            borderRadius: 10, padding: '10px 12px', margin: '4px 0 8px',
          }}
        >
          <p style={{ margin: 0, fontWeight: 500, color: `var(${incident ? '--text-danger, #C62828' : '--text-warning, #BA7517'})` }}>
            {incident
              ? `${state.delta} more file${state.delta === 1 ? '' : 's'} went missing since the last check`
              : missing > 0
                ? `${missing} file${missing === 1 ? '' : 's'} referenced by your library are missing from disk`
                /* Nothing is missing: this panel is open for a wrong pull, and
                   saying "0 files are missing" above copy about wrong pulls
                   reads as a bug and contradicts the row directly above. */
                : `${wrongPulls} memo${wrongPulls === 1 ? '' : 's'} did not come back from ${wrongPulls === 1 ? 'its' : 'their'} source correctly`}
          </p>
          <span className="mono" style={{ display: 'block', marginTop: 4 }}>
            {state.recoverable > 0 && (
              <>{state.recoverable} can be re-downloaded from their source. </>
            )}
            {state.unrecoverable > 0 && (
              <>{state.unrecoverable} were uploads with no source and exist nowhere else. </>
            )}
            {state.missing_thumbs > 0 && (
              <>{state.missing_thumbs} missing thumbnail{state.missing_thumbs === 1 ? '' : 's'} can be regenerated. </>
            )}
            {state.silent_videos > 0 && (
              <>{state.silent_videos} video{state.silent_videos === 1 ? ' has' : 's have'} no sound. Often the original has none either — plenty of clips are posted muted — so this is worth a look rather than an alarm. Re-pull one from its own page to try again. </>
            )}
            {state.pictureless_videos > 0 && (
              <>{state.pictureless_videos === 1 ? '1 memo is' : `${state.pictureless_videos} memos are`} filed as a video but {state.pictureless_videos === 1 ? 'holds' : 'hold'} a file with no pictures in it. That is the song a photo post was playing, saved instead of the photos. Re-pulling brings the pictures back. </>
            )}
            {state.degraded_reads > 0 && (
              <>{state.degraded_reads === 1 ? '1 memo was' : `${state.degraded_reads} memos were`} saved from a read that could not find the post inside the page, usually a cookie notice getting in the way, so {state.degraded_reads === 1 ? 'it may be' : 'they may be'} missing photos the post actually has. Re-pulling often fixes it, and openMemo already tried once on its own. </>
            )}
            {incident && 'Stop writing to the disk before investigating — see docs/DISASTER-RECOVERY.md.'}
          </span>

          {/* The repair, in the same box as the diagnosis. Without this the
              panel names a problem and leaves the user to find the memos
              themselves among a thousand, which is not a fix. Two clicks:
              the first only asks what would be touched. */}
          {wrongPulls > 0 && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="om-btn-secondary"
                disabled={repairing}
                onClick={async () => {
                  setRepairing(true);
                  try {
                    if (!plan) {
                      const r = await maintenanceApi.repullWrongPulls({ pictureless: true, degraded: alsoDegraded, dryRun: true });
                      setPlan({ memos: r.memos });
                    } else {
                      const r = await maintenanceApi.repullWrongPulls({ pictureless: true, degraded: alsoDegraded, dryRun: false });
                      setRepaired(r.queued);
                      setPlan(null);
                      // The counts just changed. Leaving the panel showing the
                      // old ones reads as the repair having done nothing.
                      settingsApi.libraryIntegrity().then(setState).catch(() => {});
                    }
                  } catch { /* leave the panel as it was */ }
                  finally { setRepairing(false); }
                }}
              >
                {repairing ? 'Working…' : plan ? `Re-pull ${plan.memos} memo${plan.memos === 1 ? '' : 's'}` : 'Repair these'}
              </button>
              {state.degraded_reads > 0 && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} className="mono">
                  <input
                    type="checkbox"
                    checked={alsoDegraded}
                    onChange={(e) => { setAlsoDegraded(e.target.checked); setPlan(null); }}
                  />
                  Also re-read the {state.degraded_reads} that could not be read properly (slower)
                </label>
              )}
              <span className="mono">
                {repaired !== null
                  ? `Queued ${repaired}. They update as each one finishes.`
                  : plan
                    ? 'Fetches each post again. Click to start.'
                    : 'Check what can be repaired.'}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}


/** Music relay: the lossless source behind Apple Music and Spotify pulls.
 *
 *  Off by default, because it is a third-party service. While the toggle is off
 *  every relay and music-link route 404s and nothing is sent to the relay at
 *  all — the switch is enforced on the server, not just hidden here.
 *
 *  Switched on, it still needs a session, and the relay only issues one after a
 *  challenge a person completes in a browser. That is the point of the
 *  challenge, so openMemo hands you the link and waits rather than trying to
 *  answer it for you. */
function MusicRelayRows({ profile, save }: { profile: AppSettings | null; save: (p: Partial<AppSettings>) => void }) {
  const enabled = profile?.music_relay_enabled ?? false;
  const [state, setState] = useState<MusicRelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const pollRef = useRef<number | null>(null);

  const refresh = () => { settingsApi.musicRelayStatus().then(setState).catch(() => setState(null)); };
  // Status is readable while off (it answers `enabled: false` and nothing else),
  // so re-read on the flip to pick up an existing session when switching on.
  useEffect(() => {
    refresh();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [enabled]);

  const toggle = () => {
    if (!profile) return;
    setMsg('');
    save({ music_relay_enabled: !profile.music_relay_enabled });
  };

  const verify = async () => {
    setBusy(true); setMsg('');
    try {
      const { challenge_url } = await settingsApi.musicRelayVerifyStart(window.location.origin);
      window.open(challenge_url, '_blank', 'noopener');
      setMsg('Complete the challenge in the tab that opened. This will update when it lands.');
      // The relay redirects the browser straight back to openMemo, so nothing
      // notifies this component — poll until the session shows up, and give up
      // after five minutes rather than spinning forever.
      const started = Date.now();
      pollRef.current = window.setInterval(async () => {
        try {
          const next = await settingsApi.musicRelayStatus();
          setState(next);
          if (next.verified || Date.now() - started > 5 * 60_000) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setBusy(false);
            setMsg(next.verified ? 'Verified ✓' : 'Gave up waiting. Try again when you have a minute.');
          }
        } catch { /* keep waiting */ }
      }, 3000);
    } catch (e) {
      setBusy(false);
      setMsg(e instanceof Error ? e.message : 'Could not start verification');
    }
  };

  const disconnect = async () => {
    try { setState(await settingsApi.musicRelayDisconnect()); setMsg(''); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
  };

  return (
    <div className="om-setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div className="om-setting-row-text" style={{ maxWidth: 560, flex: 1 }}>
          <p>Music relay</p>
          <span className="mono">
            Pull Apple Music and Spotify links as lossless FLAC, through a shared community relay
            run by someone else. Off by default: while it is off, openMemo never contacts the relay
            and Apple Music and Spotify links are not accepted. Everything else (YouTube,
            SoundCloud, Instagram, and music files you add yourself) works either way.
          </span>
        </div>
        <button type="button" className="om-add-toggle" onClick={toggle} aria-pressed={enabled}>
          <span className={'om-add-toggle-switch' + (enabled ? ' on' : '')}>
            <span className="om-add-toggle-knob" />
          </span>
        </button>
      </div>

      {enabled && (
        <span className="mono" style={{ maxWidth: 560 }}>
          The relay only answers verified clients, so it needs a one-off challenge you complete in
          your browser. Nothing is signed up for and no account is involved.
        </span>
      )}

      {enabled && state && !state.verified && (
        <div
          role="status"
          style={{
            border: '1px solid var(--border-warning, #E5C07B)',
            background: 'var(--bg-warning, rgba(186,117,23,0.08))',
            borderRadius: 10, padding: '10px 12px', maxWidth: 560,
          }}
        >
          <p style={{ margin: 0, fontWeight: 500, color: 'var(--text-warning, #BA7517)' }}>
            {state.expired ? 'The music relay session has expired' : 'Apple Music and Spotify pulls are not working'}
          </p>
          <span className="mono" style={{ display: 'block', marginTop: 4 }}>
            Every Apple Music and Spotify download fails until this is verified. Everything else
            (YouTube, SoundCloud, Instagram, uploads) is unaffected.
          </span>
        </div>
      )}

      {enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {state?.verified ? (
            <>
              <span style={{ color: 'var(--text-success, #1D9E75)', fontWeight: 500 }}>
                Verified ✓{state.expires_in_days !== null ? ` · ${state.expires_in_days} days left` : ''}
              </span>
              <button className="om-btn-secondary" onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <button className="om-btn-secondary" onClick={verify} disabled={busy}>
              {busy ? 'Waiting for you…' : 'Verify'}
            </button>
          )}
        </div>
      )}
      {enabled && msg && <span className="mono" style={{ fontSize: 11 }}>{msg}</span>}
    </div>
  );
}

/** Instagram connect: the final-fallback session for IG pulls. Two ways in —
 *  paste a session (safe, no password) or username/password (convenient, but IG
 *  may checkpoint your main account; the UI warns). Feeds the shared cookie jar. */
function InstagramConnectRows() {
  const [status, setStatus] = useState<{ connected: boolean; who: string | null } | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof settingsApi.instagramHealth>> | null>(null);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [cookies, setCookies] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState<'password' | 'session'>('password');

  const refresh = () => {
    settingsApi.instagramStatus().then(setStatus).catch(() => setStatus(null));
    settingsApi.instagramHealth().then(setHealth).catch(() => setHealth(null));
  };
  useEffect(() => { refresh(); }, []);

  const doLogin = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await settingsApi.instagramLogin(user.trim(), pass);
      setStatus({ connected: r.connected, who: r.who });
      setPass(''); setMsg(r.connected ? 'Connected ✓' : '');
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Login failed'); }
    finally { setBusy(false); }
  };
  const doImport = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await settingsApi.instagramImportSession(cookies);
      setStatus(r); setCookies(''); setMsg(r.connected ? 'Connected ✓' : '');
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Import failed'); }
    finally { setBusy(false); }
  };
  const doDisconnect = async () => {
    setBusy(true); setMsg('');
    try { setStatus(await settingsApi.instagramDisconnect()); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="om-setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
      <div className="om-setting-row-text" style={{ maxWidth: 560 }}>
        <p>Instagram login</p>
        <span className="mono">
          openMemo pulls Instagram post media through a login. Connect an account here and every Instagram save — photos, carousels, reels — resolves. The session is stored only on this machine (in <code>yt_cookies.txt</code>), never sent anywhere. Use a throwaway account.
        </span>
      </div>

      {/* The silent-degradation warning. Instagram saves never fail outright —
          a blocked tier still produces a memo, just a poorer one (a reel as a
          still, a carousel as one photo), which is exactly how six weeks of
          bad saves went unnoticed. Say it out loud instead. */}
      {health && health.status !== 'ok' && (
        <div
          role="status"
          style={{
            border: '1px solid var(--border-warning, #E5C07B)',
            background: 'var(--bg-warning, rgba(186,117,23,0.08))',
            borderRadius: 10, padding: '10px 12px', maxWidth: 560,
          }}
        >
          <p style={{ margin: 0, fontWeight: 500, color: 'var(--text-warning, #BA7517)' }}>
            {health.status === 'session_expired'
              ? 'Instagram session no longer works'
              : 'Instagram saves are running without a session'}
          </p>
          <span className="mono" style={{ display: 'block', marginTop: 4 }}>
            {health.degraded} of the last {health.checked} Instagram saves fell back to
            reading the public page. Those still save, but only what a logged-out
            visitor can see: reels can miss their video and carousels can arrive as a
            single photo.{' '}
            {health.status === 'session_expired'
              ? 'Reconnect below to fix it.'
              : 'Connect an account below to fix it.'}
          </span>
        </div>
      )}

      {status?.connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text-success, #1D9E75)', fontWeight: 500 }}>
            Connected{status.who ? ` (${status.who})` : ''} ✓
          </span>
          <button className="om-btn-secondary" onClick={doDisconnect} disabled={busy}>Disconnect</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="om-btn-secondary" style={{ opacity: mode === 'password' ? 1 : 0.6 }} onClick={() => setMode('password')}>Username & password</button>
            <button className="om-btn-secondary" style={{ opacity: mode === 'session' ? 1 : 0.6 }} onClick={() => setMode('session')}>Import session</button>
          </div>

          {mode === 'password' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
              <input className="om-input" placeholder="Instagram username" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
              <input className="om-input" type="password" placeholder="Password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
              <button className="om-btn-secondary" onClick={doLogin} disabled={busy || !user || !pass}>
                {busy ? 'Logging in…' : 'Log in'}
              </button>
              <span className="mono" style={{ color: 'var(--text-warning, #BA7517)' }}>
                Heads up: automated logins can trip Instagram's checks and flag your account. For your main account, prefer "Import session". The password is used once to sign in and is never stored.
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
              <textarea
                className="om-input"
                placeholder="Paste your Instagram cookies.txt (Netscape format) — export it from a browser where you're logged in"
                value={cookies}
                onChange={(e) => setCookies(e.target.value)}
                rows={4}
                style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
              />
              <button className="om-btn-secondary" onClick={doImport} disabled={busy || !cookies.trim()}>
                {busy ? 'Importing…' : 'Import session'}
              </button>
            </div>
          )}
        </>
      )}
      {msg && <span className="mono" style={{ color: msg.includes('✓') ? 'var(--text-success, #1D9E75)' : 'var(--text-danger, #E24B4A)' }}>{msg}</span>}
    </div>
  );
}

/** In-brand dropdown for the app-wide default chat model. Writes to the
 *  persisted `chatModel` in the app store (read by every Ask/chat surface) AND
 *  to the server-side `chat_model` setting, so backend-initiated calls
 *  (summaries without an explicit model) use the same default. */
function MeshRows({ profile, save }: { profile: AppSettings | null; save: (p: Partial<AppSettings>) => void }) {
  const enabled = profile?.mesh_enabled ?? false;
  const [introOpen, setIntroOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictCount, setConflictCount] = useState(0);
  const [batches, setBatches] = useState<MeshBatch[]>([]);
  const [meshError, setMeshError] = useState('');

  // Everything Mesh exposes 404s while it is off, so a failure here is the
  // normal disabled state rather than something worth showing the user.
  useEffect(() => {
    if (!enabled) {
      setConflictCount(0);
      setBatches([]);
      return;
    }
    meshApi.conflicts().then((r) => setConflictCount(r.count)).catch(() => setConflictCount(0));
    meshApi.history(5).then((r) => setBatches(r.batches)).catch(() => setBatches([]));
  }, [enabled, conflictsOpen]);

  // Explain Mesh at the moment it is switched ON, not on every render and not
  // when it is switched off — an explainer that appears while you are turning
  // something off is noise.
  const toggle = () => {
    if (!profile) return;
    const next = !profile.mesh_enabled;
    save({ mesh_enabled: next });
    if (next) setIntroOpen(true);
  };

  return (
    <>
      <div className="om-setting-row">
        <div className="om-setting-row-text">
          <p>Mesh</p>
          <span className="mono">
            Keep this computer and another one on the same library. Both can add and edit; changes flow both ways. No account, no cloud, no server in the middle — you pair them once with a 12-word code. Off by default, and while it is off Mesh costs this install nothing at all.
          </span>
        </div>
        <button
          type="button"
          className="om-add-toggle"
          onClick={toggle}
          aria-pressed={enabled}
        >
          <span className={'om-add-toggle-switch' + (enabled ? ' on' : '')}>
            <span className="om-add-toggle-knob" />
          </span>
        </button>
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>{enabled ? (profile?.mesh_reachable ? 'Ready to pair' : 'Pairing only') : 'How Mesh works'}</p>
          <span className="mono">
            {/* The copy has to track the LISTENER, not just the flag. Bound to
                loopback — the default — pairing works and sync can never
                connect, which is exactly the silent half-working state this
                page used to describe as if it were fine. */}
            {enabled
              ? (profile?.mesh_reachable
                  ? 'Mesh is on and this computer accepts connections from your other one. Pair them below with a 12-word code, once. Nothing leaves your network and no account is involved. '
                  : 'Mesh is on, but this computer only listens to itself, so pairing works and syncing cannot connect yet. Turn on "Reachable from your other computer" below when you are ready. ')
              : 'One library across both computers, paired once with a 12-word code, with nothing in the middle. '}
            <button type="button" onClick={() => setIntroOpen(true)} style={{ color: 'var(--accent)', fontWeight: 500 }}>
              {enabled ? 'Read the walkthrough again' : 'What is Mesh?'}
            </button>
          </span>
        </div>
      </div>
      {enabled && (
        <div className="om-setting-row">
          <div className="om-setting-row-text" style={{ maxWidth: 560 }}>
            <p>Reachable from your other computer</p>
            <span className="mono">
              Opens port 8770 so the other machine can actually sync with this one. Off, openMemo
              listens only to itself: you can still pair, but nothing will ever connect. The port
              speaks a protocol that refuses anyone without your 12-word code, and five bad tries
              earns a lockout — but it is still a port, so it is your call. This also covers
              Tailscale and the like: they appear as ordinary network interfaces, which is how two
              computers on different networks find each other.
            </span>
          </div>
          <button
            type="button"
            className="om-add-toggle"
            onClick={() => profile && save({ mesh_reachable: !profile.mesh_reachable })}
            aria-pressed={!!profile?.mesh_reachable}
          >
            <span className={'om-add-toggle-switch' + (profile?.mesh_reachable ? ' on' : '')}>
              <span className="om-add-toggle-knob" />
            </span>
          </button>
        </div>
      )}
      {enabled && <MeshPairingPanel />}
      {enabled && conflictCount > 0 && (
        <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
          <div className="om-setting-row-text">
            <p>{conflictCount} {conflictCount === 1 ? 'thing needs' : 'things need'} your decision</p>
            <span className="mono">
              Both computers changed the same thing. Nothing has been overwritten — openMemo is waiting for you to choose, and keeping both is the default.
            </span>
          </div>
          <button type="button" className="om-btn-primary" onClick={() => setConflictsOpen(true)}>
            Review
          </button>
        </div>
      )}
      {enabled && batches.length > 0 && (
        <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="om-setting-row-text" style={{ marginBottom: 6 }}>
            <p>Recent syncs</p>
            <span className="mono">Every change Mesh made, and where it came from. Any of these can be undone.</span>
          </div>
          {meshError && (
            <p className="mono" style={{ color: '#EF5048', margin: '0 0 6px' }}>{meshError}</p>
          )}
          {batches.map((b) => (
            <div key={b.batch_id} className="om-mesh-batch">
              <div className="om-mesh-batch-main">
                <b>{b.changes} {b.changes === 1 ? 'change' : 'changes'} from {b.peer || 'a device'}</b>
                <span>{new Date(b.at).toLocaleString()}{b.undone ? ' · undone' : ''}</span>
              </div>
              {!b.undone && (
                <button
                  type="button"
                  className="om-btn-secondary"
                  onClick={async () => {
                    // An undo that fails must say so. Swallowing it would leave
                    // the user believing a sync was reversed when it was not,
                    // which is worse than the original bad sync.
                    try {
                      await meshApi.undo(b.batch_id);
                      setMeshError('');
                    } catch (e) {
                      setMeshError(e instanceof Error ? e.message : 'Could not undo that sync');
                      return;
                    }
                    const r = await meshApi.history(5).catch(() => ({ batches: [] as MeshBatch[] }));
                    setBatches(r.batches);
                  }}
                >
                  Undo
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {introOpen && <MeshIntroModal onClose={() => setIntroOpen(false)} />}
      {conflictsOpen && <MeshConflictModal onClose={() => setConflictsOpen(false)} />}
    </>
  );
}


function TelegramRelayRows({ profile, save }: { profile: AppSettings | null; save: (p: Partial<AppSettings>) => void }) {
  // Waking is a Mac-app claim: powerMonitor lives in the shell, and Docker and
  // dev have no equivalent. Reconnecting is true everywhere.
  const install = useInstall();
  const [tokenInput, setTokenInput] = useState('');
  const [tokenPresent, setTokenPresent] = useState<boolean | null>(null);
  const [tokenError, setTokenError] = useState('');
  const [status, setStatus] = useState<TelegramRelayStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  useEffect(() => {
    settingsApi.telegramStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const present = tokenPresent ?? profile?.telegram_token_present ?? false;
  const enabled = profile?.telegram_enabled ?? false;

  const saveToken = async () => {
    setTokenError('');
    try {
      const r = await settingsApi.setTelegramToken(tokenInput);
      setTokenPresent(r.telegram_token_present);
      setTokenInput('');
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : 'Failed to save token');
    }
  };

  const clearToken = async () => {
    const r = await settingsApi.setTelegramToken('');
    setTokenPresent(r.telegram_token_present);
  };

  // Ask Telegram right now rather than waiting out the interval. Waits for the
  // poll to actually finish and says what it found: a button that fires and
  // shrugs is indistinguishable from a broken one, which is the whole reason
  // people reach for it — they are already unsure the relay is working.
  const checkNow = async () => {
    if (checking) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await settingsApi.telegramPollNow('manual', 20);
      if (!r.kicked) {
        setCheckResult(
          r.skipped_reason === 'throttled'
            ? 'Just checked a moment ago. Try again in a few seconds.'
            : r.skipped_reason === 'no_token'
              ? 'No bot token stored yet.'
              : r.skipped_reason === 'disabled'
                ? 'Turn Telegram capture on first.'
                : 'The relay is not running on this machine. See the status above.',
        );
      } else if (!r.completed) {
        setCheckResult('Still checking. Give it a moment, then reload.');
      } else if (r.last_error) {
        setCheckResult(`Could not reach Telegram: ${r.last_error}`);
      } else {
        setCheckResult(
          r.saved > 0
            ? `Saved ${r.saved} share${r.saved === 1 ? '' : 's'}.`
            : 'Checked. Nothing waiting.',
        );
      }
      // Refresh the card's own status line off the same poll, so "last answered"
      // and the stale banner reflect the check that just ran.
      settingsApi.telegramStatus().then(setStatus).catch(() => {});
    } catch (e) {
      setCheckResult(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  // Show when Telegram last ANSWERED, never when we last tried. The card used
  // to read "Polling. Last check 14:32" through a whole flight with no wifi,
  // because a failed call still stamped the attempt.
  const staleHours = status?.hours_since_success ?? null;
  // The backend decides. Recomputing from the number here would repeat the bug
  // it just fixed: `hours_since_success` is null when Telegram has never once
  // answered, and that reads as healthy while being the worst case there is.
  const stale = enabled && !!status?.stale;
  const statusLine = !present
    ? 'Paste a bot token from @BotFather to begin.'
    : !enabled
      ? 'Token stored. Turn the relay on to start polling.'
      : status?.last_error
        ? `Relay problem: ${status.last_error}`
        : status?.last_success_at
          ? `Polling. Telegram last answered ${new Date(status.last_success_at + 'Z').toLocaleTimeString()}, ${status.saved_count} saved this session.`
          : 'On. First poll runs within a minute.';

  return (
    <>
      {/* Past 20 hours the 24 hour drop is close, and the person who needs to
          know is the one whose shares are about to be discarded. Loud, and only
          then: a normal night with the lid shut never reaches this. */}
      {stale && (
        <div
          role="status"
          style={{
            border: '1px solid var(--border-warning, #E5C07B)',
            background: 'var(--bg-warning, rgba(186,117,23,0.08))',
            borderRadius: 10, padding: '10px 12px', maxWidth: 560, marginBottom: 10,
          }}
        >
          <p style={{ margin: 0, fontWeight: 500, color: 'var(--text-warning, #BA7517)' }}>
            {staleHours === null
              ? 'openMemo has never reached Telegram'
              : `openMemo has not reached Telegram in ${Math.round(staleHours)} hours`}
          </p>
          <span className="mono" style={{ display: 'block', marginTop: 4 }}>
            {staleHours === null
              ? 'Not once since capture was turned on, so nothing you have shared has arrived. The bot token is the usual cause.'
              : 'Telegram drops a share it could not deliver after 24 hours, so everything from the last day is at risk and anything older is already gone. Check this machine is online and openMemo is running.'}
          </span>
        </div>
      )}
      <div className="om-setting-row">
        <div className="om-setting-row-text">
          <p>Telegram capture</p>
          <span className="mono">
            Share any link to your private bot chat and it lands here, filed into "{profile?.telegram_default_collection || 'Bot Inbox'}". openMemo polls Telegram outbound, so there are no open ports, and your shares wait on Telegram while this machine is away. Telegram holds them for 24 hours{install.isMac ? ', and openMemo catches up the moment this Mac wakes' : ''}, but leave it off for longer than a day and Telegram drops the older ones. {statusLine}
          </span>
        </div>
        <button
          type="button"
          className="om-add-toggle"
          onClick={() => profile && save({ telegram_enabled: !profile.telegram_enabled })}
          aria-pressed={enabled}
          disabled={!present}
        >
          <span className={'om-add-toggle-switch' + (enabled && present ? ' on' : '')}>
            <span className="om-add-toggle-knob" />
          </span>
        </button>
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>Bot token</p>
          <span className="mono">
            {present
              ? `Stored on this machine, never shown or sent anywhere else.${profile?.telegram_user_locked || status?.telegram_user_locked ? ' Locked to the first sender.' : ' Locks to the first person who messages the bot.'}`
              : 'From Telegram: @BotFather → /newbot → copy the token.'}
            {tokenError ? ` ${tokenError}` : ''}
          </span>
        </div>
        {present ? (
          <button className="om-btn-secondary" onClick={clearToken}>Remove</button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              className="om-input"
              placeholder="123456:ABC…"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              style={{ width: 180 }}
            />
            <button className="om-btn-secondary" onClick={saveToken} disabled={!tokenInput.trim()}>
              Save
            </button>
          </div>
        )}
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>Pull media locally</p>
          <span className="mono">
            Download the actual photo, video, or audio for every bot save so it survives takedown. Off = bot saves follow the same auto-download rules as a paste.
          </span>
        </div>
        <button
          type="button"
          className="om-add-toggle"
          onClick={() => profile && save({ telegram_force_localize: !profile.telegram_force_localize })}
          aria-pressed={profile?.telegram_force_localize ?? true}
        >
          <span className={'om-add-toggle-switch' + ((profile?.telegram_force_localize ?? true) ? ' on' : '')}>
            <span className="om-add-toggle-knob" />
          </span>
        </button>
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>Check every</p>
          <span className="mono">
            How often openMemo asks Telegram for new shares. Between checks they wait on Telegram,
            and reconnecting asks straight away.{install.isMac ? ' Waking this Mac does too.' : ''}
          </span>
        </div>
        <SettingsPicker
          options={[
            { value: '5', label: '5 minutes' },
            { value: '15', label: '15 minutes' },
            { value: '30', label: '30 minutes' },
            { value: '60', label: '1 hour' },
          ]}
          value={String(profile?.telegram_poll_minutes ?? 15)}
          placeholder="15 minutes"
          onChange={(v) => save({ telegram_poll_minutes: Number(v) })}
          width={130}
        />
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>Check now</p>
          <span className="mono">
            {checkResult
              ?? 'Ask Telegram for waiting shares straight away, without waiting out the interval above.'}
          </span>
        </div>
        <button
          className="om-btn-secondary"
          onClick={checkNow}
          disabled={checking || !present || !enabled}
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
    </>
  );
}

/**
 * Where openMemo looks for Ollama.
 *
 * It was nowhere on this page. The card could say "Offline" and offer no way to
 * do anything about it, because the host was env-only: a compose file on Docker,
 * and a menu-bar sheet on the Mac. On the Mac it is editable here now, through
 * the shell that owns the value; saving restarts the backend and reloads, which
 * the main process handles, so this component simply hands the string over.
 */
function OllamaHostRow({ current, editable }: { current: string; editable: boolean }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = value.trim() !== current;

  const save = async () => {
    const shell = shellBridge();
    if (!shell) return;
    setBusy(true);
    setError('');
    try {
      const r = await shell.setOllamaHost(value.trim());
      if (!r.ok) setError(r.error || 'Could not save the host');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the host');
    } finally {
      setBusy(false);
    }
  };

  if (!editable) {
    return <span className="mono om-setting-val">{current || 'not set'}</span>;
  }
  return (
    <div className="om-inline-control">
      <input
        className="om-input"
        type="text"
        value={value}
        placeholder="http://localhost:11434"
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 210 }}
        disabled={busy}
      />
      <button className="om-btn-secondary" onClick={save} disabled={!dirty || busy}>
        {busy ? 'Restarting…' : 'Save'}
      </button>
      {error && <span className="mono om-setting-val" style={{ color: '#EF5048' }}>{error}</span>}
    </div>
  );
}

/**
 * The three native settings that used to exist only in the menu bar. A Mac user
 * looks in Settings for the launch PIN and Open at Login, and finding neither
 * reads as "openMemo cannot do that", not "look in the menu".
 *
 * Rendered only inside the packaged app: everything here crosses into the main
 * process, and there is no main process in a browser tab.
 */
function SecurityRows() {
  const shell = shellBridge();
  const [locked, setLocked] = useState<boolean | null>(null);
  const [atLogin, setAtLogin] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    if (!shell) return;
    shell.lockStatus().then((s) => setLocked(s.enabled)).catch(() => setLocked(null));
    shell.getOpenAtLogin().then(setAtLogin).catch(() => setAtLogin(null));
  }, [shell]);

  useEffect(refresh, [refresh]);

  // The PIN sheet is a separate native window, so there is no callback when it
  // closes. Re-read on focus instead, which is when the user comes back.
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  if (!shell) return null;

  return (
    <>
      <div className="om-setting-row">
        <div className="om-setting-row-text">
          <p>App lock</p>
          <span className="mono">
            A 4-digit PIN on every launch. On a cold start the backend does not even start until
            you unlock, so a locked app exposes nothing, not even on localhost. Reopening a window
            while openMemo is still running unlocks a backend that is already warm. This is
            separate from the hidden section's passcode: that one guards memos inside an app that
            is already open.
          </span>
        </div>
        <div className="om-inline-control">
          <span className="mono om-setting-val">
            {locked === null ? '' : locked ? 'On' : 'Off'}
          </span>
          <button className="om-btn-secondary" onClick={() => void shell.configureLock()}>
            {locked ? 'Change' : 'Set PIN'}
          </button>
        </div>
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>Open at login</p>
          <span className="mono">
            Start openMemo when you log in. Worth having on if you use phone capture: Telegram holds
            a share for 24 hours and openMemo can only collect it while it is running. With App
            Lock on that means once you unlock, since the backend waits for the PIN.
          </span>
        </div>
        <button
          type="button"
          className="om-add-toggle"
          aria-pressed={!!atLogin}
          onClick={() => void shell.setOpenAtLogin(!atLogin).then(setAtLogin).catch(() => {})}
        >
          <span className={'om-add-toggle-switch' + (atLogin ? ' on' : '')}>
            <span className="om-add-toggle-knob" />
          </span>
        </button>
      </div>
      <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
        <div className="om-setting-row-text">
          <p>Logs</p>
          <span className="mono">Everything the app has printed since it launched. Useful when something did not work.</span>
        </div>
        <button className="om-btn-secondary" onClick={() => void shell.openLogsFolder()}>Open folder</button>
      </div>
    </>
  );
}

function ModelSelect({ models }: { models: OllamaModel[] }) {
  const chatModel = useAppStore((s) => s.chatModel);
  const setChatModel = useAppStore((s) => s.setChatModel);
  const persistServerDefault = (name: string) => {
    settingsApi.update({ chat_model: name }).catch(() => {
      /* server copy is best-effort; local store still drives the UI */
    });
  };
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = chatModel || (models[0]?.name ?? '');

  return (
    <div className="om-model-select" ref={ref}>
      <button
        type="button"
        className="om-model-select-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={models.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mono om-model-select-val">{current || 'No models'}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div className="om-model-select-menu" role="listbox" data-lenis-prevent>
          {models.map((m) => (
            <button
              key={m.name}
              type="button"
              role="option"
              aria-selected={current === m.name}
              className={`om-model-select-opt mono${current === m.name ? ' active' : ''}`}
              onClick={() => {
                setChatModel(m.name);
                persistServerDefault(m.name);
                setOpen(false);
              }}
            >
              <span>{m.name}</span>
              {current === m.name && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One-click vector-index rebuild. Re-embeds every memo with the current
 *  embedding model (incl. nomic task prefixes) and purges ghost chunks left by
 *  deleted memos. Run after changing the embed model or upgrading past 2.2.x. */
function ReindexRow() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await maintenanceApi.reindex();
      setResult(`${r.reindexed_memos} memos re-embedded, ${r.ghost_chunks_purged} stale chunks purged`);
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Reindex failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="om-setting-row">
      <div className="om-setting-row-text">
        <p>Search index</p>
        <span className="mono">{result ?? 'Rebuild embeddings for Ask Memo & related'}</span>
      </div>
      <button type="button" className="om-btn-ghost om-btn-pill" onClick={run} disabled={busy}>
        {busy ? 'Reindexing…' : 'Rebuild'}
      </button>
    </div>
  );
}


/** The Settings cards, in two columns the user arranges by dragging.
 *
 *  This replaced a hard-coded column break. The break was a constant in the
 *  source that had to be re-measured by hand whenever a card changed height,
 *  and it went stale twice in a single afternoon: once when Mesh grew, once
 *  when the scheduled-archive rows came out. Whoever is looking at the page can
 *  see the balance better than a number committed weeks earlier, so they place
 *  the cards and openMemo remembers.
 *
 *  Whole cards are draggable, with no rearrange mode to enter. Two things stop
 *  that fighting the controls inside them: the 8px activation distance the rest
 *  of the app uses, so a click stays a click, and handing the gesture back when
 *  it starts on a form control, since otherwise selecting text in an input
 *  would pick the whole card up instead.
 */
function SortableSettingsCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  // Let the control keep the gesture. dnd-kit's PointerSensor listens on this
  // wrapper, so without this a drag inside a text field selects nothing and
  // walks the card across the page instead.
  const guard = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, select, button, a, [role="slider"], [contenteditable="true"]')) {
      e.stopPropagation();
    }
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={'om-settings-slot' + (isDragging ? ' dragging' : '')}
      onPointerDownCapture={guard}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

type CardLayout = { left: string[]; right: string[] };

function SettingsCardBoard({
  slots,
  layout,
  onLayout,
}: {
  slots: { id: string; label: string; node: React.ReactNode }[];
  layout?: CardLayout | Record<string, never>;
  onLayout: (l: CardLayout) => void;
}) {
  const known = slots.map((s) => s.id);
  const saved = layout && Array.isArray((layout as CardLayout).left) ? (layout as CardLayout) : null;

  // A saved layout is a preference, not a schema. Ids that no longer exist get
  // dropped and cards it has never heard of are appended, so shipping or
  // removing a card cannot leave the page missing one.
  const clean = (ids: string[] | undefined) => (ids ?? []).filter((id) => known.includes(id));
  let left = clean(saved?.left);
  let right = clean(saved?.right);
  if (!saved) {
    const half = Math.ceil(known.length / 2);
    left = known.slice(0, half);
    right = known.slice(half);
  } else {
    const placed = new Set([...left, ...right]);
    right = [...right, ...known.filter((id) => !placed.has(id))];
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const byId = (id: string) => slots.find((s) => s.id === id);
  const colOf = (id: string): 'left' | 'right' => (left.includes(id) ? 'left' : 'right');

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const from = colOf(activeId);
    // Dropping on a column's empty space targets the column; dropping on a card
    // targets that card's column and position.
    const to: 'left' | 'right' =
      overId === 'col-left' ? 'left' : overId === 'col-right' ? 'right' : colOf(overId);
    const next: CardLayout = { left: [...left], right: [...right] };
    next[from] = next[from].filter((id) => id !== activeId);
    const target = next[to];
    const at = target.indexOf(overId);
    target.splice(at === -1 ? target.length : at, 0, activeId);
    onLayout(next);
  };

  const column = (which: 'left' | 'right', ids: string[]) => (
    <SortableContext id={'col-' + which} items={ids} strategy={verticalListSortingStrategy}>
      <div className="om-settings-col">
        {ids.map((id) => {
          const slot = byId(id);
          return slot ? (
            <SortableSettingsCard key={id} id={id}>
              {slot.node}
            </SortableSettingsCard>
          ) : null;
        })}
      </div>
    </SortableContext>
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="om-settings-board">
        {column('left', left)}
        {column('right', right)}
      </div>
    </DndContext>
  );
}

type PickerOption = { value: string; label: string };

/** The app's own dropdown, for anywhere a native <select> would have gone.
 *
 *  A <select> draws its open list with the operating system, not the page, so
 *  in a dark app it opens as a white panel with a blue highlight and no amount
 *  of CSS on the control can reach it. This is the same button-and-menu the
 *  model selector uses, lifted out so Settings has one dropdown rather than one
 *  per author.
 *
 *  `value` may be the empty string on purpose: a picker that fires an ACTION
 *  (restore this snapshot) has no lasting selection, so it shows its
 *  placeholder again as soon as the menu closes.
 */
function SettingsPicker({
  options,
  value,
  placeholder,
  onChange,
  disabled,
  width,
  alignLeft,
}: {
  options: PickerOption[];
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  width?: number;
  alignLeft?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // A menu you cannot dismiss from the keyboard is a trap, and the native
      // control this replaces closed on Escape.
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const picked = options.find((o) => o.value === value);

  return (
    <div className="om-picker" ref={ref}>
      <button
        type="button"
        className="om-picker-btn"
        style={width ? { width } : undefined}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mono om-picker-val" style={{ flex: 1 }}>
          {picked ? picked.label : placeholder}
        </span>
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div
          className={'om-picker-menu' + (alignLeft ? ' om-picker-menu-left' : '')}
          role="listbox"
          data-lenis-prevent
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={value === o.value}
              className={'om-picker-opt mono' + (value === o.value ? ' active' : '')}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
              {value === o.value && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


type AutoFileRule = { domain: string; collection_id: string };

/** The collection picker for a filing rule.
 *
 *  Hidden collections are listed, and marked. Filing into one that is hidden
 *  from the dashboard is the entire point of the feature, so leaving them out
 *  would drop the only option most people are here for.
 */
function CollectionPicker({
  collections,
  value,
  onChange,
}: {
  collections: any[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <SettingsPicker
      options={collections.map((c) => ({
        value: c.id,
        label: c.name + (c.hidden_from_dashboard ? ' (hidden)' : ''),
      }))}
      value={value}
      placeholder="Collection"
      onChange={onChange}
    />
  );
}

/** Site to collection rules. A rule whose collection has since been deleted is
 *  shown as broken rather than dropped, because a rule that silently stopped
 *  working is worse than one that says so. */
function AutoFileRules({ rules, onChange }: { rules: AutoFileRule[]; onChange: (r: AutoFileRule[]) => void }) {
  const { data: collections } = useQuery({
    queryKey: ['collections'],
    queryFn: () => collectionApi.list(),
  });
  const [domain, setDomain] = useState('');
  const [collId, setCollId] = useState('');
  const [error, setError] = useState('');

  // Mirrors normalize_rule_domain on the server, so the row the user sees is
  // the host that will actually be matched. The server normalizes again and is
  // the authority; this exists so nobody adds a rule and then wonders why it
  // reads back differently.
  const normalize = (raw: string): string | null => {
    let t = (raw || '').trim().toLowerCase();
    if (!t) return null;
    if (t.includes('://')) {
      try { t = new URL(t).hostname; } catch { return null; }
    }
    t = t.split('/')[0].split('?')[0].split('#')[0];
    const at = t.split('@');
    t = at[at.length - 1].split(':')[0];
    if (t.startsWith('www.')) t = t.slice(4);
    t = t.replace(/^\.+/, '').replace(/\.+$/, '');
    if (!t || t.indexOf(' ') !== -1 || t.indexOf('.') === -1) return null;
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (!t.split('.').every((part) => label.test(part))) return null;
    return t;
  };

  const list = collections || [];
  const nameFor = (id: string) => list.find((c: any) => c.id === id)?.name;

  const add = () => {
    const host = normalize(domain);
    if (!host) { setError('That does not look like a site address.'); return; }
    if (!collId) { setError('Pick a collection first.'); return; }
    if (rules.some((r) => r.domain === host)) { setError('There is already a rule for ' + host + '.'); return; }
    setError('');
    setDomain('');
    setCollId('');
    onChange(rules.concat([{ domain: host, collection_id: collId }]));
  };

  return (
    <div className="om-autofile">
      {rules.length > 0 && (
        <div className="om-autofile-list">
          {rules.map((r) => {
            const name = nameFor(r.collection_id);
            return (
              <div className="om-autofile-rule" key={r.domain}>
                <span className="mono om-autofile-domain">{r.domain}</span>
                <Icon name="arrowRight" size={13} className="om-autofile-arrow" />
                <span className={'mono om-autofile-target' + (name ? '' : ' broken')}>
                  {name || 'collection deleted, this rule will not fire'}
                </span>
                <button
                  type="button"
                  className="om-btn-ghost om-btn-pill"
                  onClick={() => onChange(rules.filter((x) => x.domain !== r.domain))}
                  aria-label={'Remove the rule for ' + r.domain}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="om-autofile-add">
        <input
          type="text"
          className="om-input"
          value={domain}
          placeholder="example.com, or paste a link"
          onChange={(e) => { setDomain(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <CollectionPicker
          collections={list}
          value={collId}
          onChange={(id) => { setCollId(id); setError(''); }}
        />
        <button type="button" className="om-btn-ghost om-btn-pill" onClick={add}>Add rule</button>
      </div>
      {error && <p className="mono om-autofile-error">{error}</p>}
    </div>
  );
}


export function SettingsPage() {
  const t = useAppStore((s) => s.tweaks);
  const setAppearancePanelOpen = useAppStore((s) => s.setAppearancePanelOpen);
  const openGuide = useAppStore((s) => s.openGuide);
  const showNotice = useAppStore((s) => s.showNotice);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();

  const openAppearance = () => {
    // The live-preview panel is a desktop side panel. On mobile, point the user
    // to what they CAN do here (switch theme from the menu) and to the desktop
    // app for the rest, rather than opening a cramped, half-broken panel.
    if (isMobile) {
      showNotice(
        'Appearance editing — accent, background, layout, columns — is desktop only. On mobile you can still switch light/dark from the menu. Open openMemo on a larger screen to customize the rest.',
        'info',
      );
      return;
    }
    navigate('/');
    setTimeout(() => setAppearancePanelOpen(true), 280);
  };
  const install = useInstall();
  const [ask, confirmModal] = useConfirm();
  const [version, setVersion] = useState('');
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  // null = still loading (skeleton); [] = loaded, none installed.
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  // 'idle' until you click the version number. The check is the one thing here
  // that cannot be answered locally, so it waits to be asked for.
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'current' | 'failed'>('idle');

  const checkForUpdate = async () => {
    // One updater. The shell already checks GitHub on launch and knows how to
    // offer the .dmg; a second check here meant a Mac user could get two
    // prompts telling them two different things. Hand it over and let the
    // native dialog own the whole flow.
    const shell = shellBridge();
    if (shell) {
      void shell.checkForUpdates();
      return;
    }
    setUpdateCheck('checking');
    try {
      const r = await fetch('https://api.github.com/repos/izored/OpenMemo/releases/latest');
      if (!r.ok) throw new Error(String(r.status));
      const latest = (await r.json())?.tag_name?.replace(/^v/, '');
      if (latest && version && cmpVersion(latest, version) > 0) {
        setUpdateAvailable(true);
        setUpdateCheck('idle');
      } else {
        setUpdateCheck('current');
      }
    } catch {
      setUpdateCheck('failed');
    }
  };
  const [backing, setBacking] = useState<'structure' | 'essential' | 'full' | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [autoSnaps, setAutoSnaps] = useState<{ name: string; bytes: number; created_at: string }[]>([]);
  const [maxUploadMb, setMaxUploadMb] = useState<number | null>(null);
  const [maxUploadSaved, setMaxUploadSaved] = useState(false);
  const [profile, setProfile] = useState<AppSettings | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [localizing, setLocalizing] = useState(false);
  const [localizeResult, setLocalizeResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    systemApi
      .health()
      .then((d) => {
        setVersion(d.version || '');
        setOllamaConnected(d.ollama_connected);
        // No update check here. Opening Settings is not a request to talk to
        // GitHub, and openMemo contacts nobody unless you ask (ADR-025 §2).
        // The version number itself is the ask: hover it, click it.
      })
      .catch(() => setOllamaConnected(false));
    systemApi.models().then((d) => setOllamaModels(d.models || [])).catch(() => setOllamaModels([]));
    systemApi.stats(true).then(setStats).catch(() => setStats(null));
    settingsApi.get()
      .then((s) => {
        setMaxUploadMb(s.max_upload_mb);
        setProfile(s);
      })
      .catch(() => {
        setMaxUploadMb(5120);
        setProfile({ max_upload_mb: 5120, display_name: '', email: '', avatar_data_url: '', mailing_list_consent: false, auto_download_audio: true, auto_download_video: true, auto_file_by_source: true, auto_file_rules: [], music_quality: '16', music_provider: 'qobuz', chat_model: '', num_ctx: 0, yt_cookies_present: false, bg_image_ext: '', hidden_passcode_set: false, telegram_enabled: false, telegram_poll_minutes: 15, telegram_default_collection: 'Bot Inbox', telegram_force_localize: true, telegram_token_present: false, telegram_user_locked: false, music_relay_enabled: false, mesh_enabled: false, mesh_reachable: false, settings_card_layout: {}, install_kind: 'dev', platform: '', ollama_host: '' });
      });
  }, []);

  const saveProfile = async (patch: Partial<AppSettings>) => {
    try {
      const next = await settingsApi.update(patch);
      // Merged, not replaced. The PUT reply once omitted every computed key
      // (`telegram_token_present`, `yt_cookies_present`, `install_kind`, …) and
      // this line stored it verbatim, so changing the Telegram poll interval
      // wiped the bot token out of the card and greyed the relay toggle off on
      // perfectly intact state. The backend returns the full shape now; keeping
      // the merge means the next endpoint to answer short cannot blank the page.
      setProfile((prev) => (prev ? { ...prev, ...next } : next));
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const pickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      showNotice('Image too large. Max 2 MB before resize.');
      e.target.value = '';
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Downscale to a 256px square JPEG so settings.json stays small.
        const size = 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        const dataUrl = c.toDataURL('image/jpeg', 0.82);
        saveProfile({ avatar_data_url: dataUrl });
      };
      img.src = r.result as string;
    };
    r.readAsDataURL(f);
    e.target.value = '';
  };

  const runLocalize = async () => {
    if (localizing) return;
    const go = await ask({
      title: 'Localize saved content',
      body: 'Download the remote images in every saved article so the memos survive the source being deleted. On a large library this takes a while.',
      confirmLabel: 'Localize',
    });
    if (!go) return;
    setLocalizing(true);
    setLocalizeResult(null);
    try {
      const r = await maintenanceApi.localize();
      setLocalizeResult(`${r.images_localized} images across ${r.memos_updated} memos`);
    } catch {
      setLocalizeResult('Failed — see server logs');
    } finally {
      setLocalizing(false);
    }
  };

  const saveMaxUpload = async () => {
    if (maxUploadMb == null || !Number.isFinite(maxUploadMb)) return;
    const clamped = Math.max(1, Math.min(Math.round(maxUploadMb), 50 * 1024));
    try {
      const s = await settingsApi.update({ max_upload_mb: clamped });
      setMaxUploadMb(s.max_upload_mb);
      setMaxUploadSaved(true);
      setTimeout(() => setMaxUploadSaved(false), 1500);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void backupApi
      .listAuto()
      .then((r) => setAutoSnaps(r.snapshots))
      .catch(() => setAutoSnaps([]));
  }, []);

  const handleRestoreAuto = async (name: string, when: string) => {
    const go = await ask({
      title: 'Restore this snapshot',
      body: `Everything currently in openMemo is replaced by the database from ${when}. Your uploaded files are not touched.`,
      secondary: 'A copy of your current database is saved first, so this can be walked back.',
      confirmLabel: 'Restore it',
      danger: true,
    });
    if (!go) return;
    setRestoring(true);
    try {
      await backupApi.restoreAuto(name);
      showNotice('Restore complete. Reloading.', 'info');
      location.reload();
    } catch (err) {
      showNotice(`Restore failed: ${(err as Error).message}`);
    } finally {
      setRestoring(false);
    }
  };

  const handleBackup = async (scope: 'structure' | 'essential' | 'full') => {
    setBacking(scope);
    try {
      await backupApi.download(scope);
    } catch (err) {
      showNotice(`Backup failed: ${(err as Error).message}`);
    } finally {
      setBacking(null);
    }
  };

  const handleRestoreClick = async () => {
    const go = await ask({
      title: 'Restore from a backup',
      body: 'Everything currently in openMemo is replaced by whatever is in the backup you pick.',
      secondary: 'A copy of your current database is saved to the pre-restore folder first, so this can be walked back.',
      confirmLabel: 'Choose a backup',
      danger: true,
    });
    if (!go) return;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRestoring(true);
    try {
      await backupApi.restore(file);
      showNotice('Restore complete. Reloading.', 'info');
      location.reload();
    } catch (err) {
      showNotice(`Restore failed: ${(err as Error).message}`);
    } finally {
      setRestoring(false);
      e.target.value = '';
    }
  };

  // Always pulse in dev so the update flow is visible while building.
  const showUpdateDot = updateAvailable || import.meta.env.DEV;

  // Each card is one draggable unit. The JSX is unchanged from when these
  // were plain siblings; only the wrapper moved. Order here is the fallback
  // used until the user arranges them, and any card missing from a saved
  // layout is appended from this list, so a new card can never be stranded.
  const cardSlots: { id: string; label: string; node: React.ReactNode }[] = [
    { id: 'profile', label: 'Profile', node: (
      <>
          {!profile && (
              <SettingCard title="Profile" eyebrow="You">
                <div className="om-profile-grid">
                  <span className="om-skel avatar" />
                  <div className="om-profile-fields">
                    <label className="om-profile-field">
                      <span className="mono">Display name</span>
                      <span className="om-skel ctrl" style={{ width: '100%' }} />
                    </label>
                    <label className="om-profile-field">
                      <span className="mono">Email</span>
                      <span className="om-skel ctrl" style={{ width: '100%' }} />
                    </label>
                  </div>
                </div>
                <div className="om-profile-consent" aria-hidden>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                    <span className="om-skel line" />
                    <span className="om-skel line short" />
                  </div>
                </div>
              </SettingCard>
            )}
          {profile && (
              <SettingCard title="Profile" eyebrow="You">
                <div className="om-profile-grid">
                  <button
                    className="om-profile-avatar"
                    onClick={() => avatarInputRef.current?.click()}
                    title="Change profile picture"
                    style={profile.avatar_data_url ? { backgroundImage: `url(${profile.avatar_data_url})` } : undefined}
                  >
                    {!profile.avatar_data_url && (
                      <span>{(profile.display_name || 'You').slice(0, 2).toUpperCase()}</span>
                    )}
                    <span className="om-profile-avatar-edit"><Icon name="image" size={12} /></span>
                  </button>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={pickAvatar}
                  />
                  <div className="om-profile-fields">
                    <label className="om-profile-field">
                      <span className="mono">Display name</span>
                      <input
                        className="om-input"
                        type="text"
                        value={profile.display_name}
                        placeholder="Your name"
                        onChange={(e) => setProfile({ ...profile, display_name: e.target.value })}
                        onBlur={() => saveProfile({ display_name: profile.display_name })}
                      />
                    </label>
                    <label className="om-profile-field">
                      <span className="mono">Email</span>
                      <input
                        className="om-input"
                        type="email"
                        value={profile.email}
                        placeholder="you@example.com"
                        onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                        onBlur={() => saveProfile({ email: profile.email })}
                      />
                    </label>
                  </div>
                </div>
                <label className="om-profile-consent">
                  <input
                    type="checkbox"
                    checked={profile.mailing_list_consent}
                    onChange={(e) => saveProfile({ mailing_list_consent: e.target.checked })}
                  />
                  <div>
                    <p>Personal email list</p>
                    <span className="mono">
                      Hear about openMemo updates and new apps from the creator. No marketing third parties.
                    </span>
                  </div>
                </label>
                {profileSaved && <span className="mono om-profile-saved">Saved ✓</span>}
              </SettingCard>
            )}

      </>
    ) },
    { id: 'local-ai', label: 'Local AI', node: (
      <>
            <SettingCard title="Local AI" eyebrow="Ollama">
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Connection</p>
                  <span className="mono">Powers chat, RAG, embeddings</span>
                </div>
                {ollamaConnected === null ? (
                  <span className="om-skel sm" />
                ) : (
                  <span className="mono om-setting-val" style={{ color: ollamaConnected ? 'var(--accent)' : '#EF5048' }}>
                    {ollamaConnected ? 'Connected' : 'Offline'}
                  </span>
                )}
              </div>
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Host</p>
                  <span className="mono">
                    {!install.known
                      ? 'Where openMemo looks for Ollama.'
                      : install.isMac && shellBridge()
                        ? 'Where openMemo looks for Ollama. Saving restarts the backend and reloads. If it is not answering, openMemo also tries a built-in fallback list.'
                        : 'Where openMemo looks for Ollama. Set with OLLAMA_HOST where the backend runs, and openMemo tries a built-in fallback list behind it.'}
                    {ollamaConnected === false && (
                      <>
                        {' '}Nothing is answering there. Ollama is yours to run, from{' '}
                        <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontWeight: 500 }}>ollama.com</a>.
                      </>
                    )}
                  </span>
                </div>
                {profile === null ? (
                  <span className="om-skel ctrl" style={{ width: 200 }} />
                ) : (
                  <OllamaHostRow
                    current={profile.ollama_host || ''}
                    editable={install.isMac && !!shellBridge()}
                  />
                )}
              </div>
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Default model</p>
                  <span className="mono">Used across chat and Ask</span>
                </div>
                {ollamaModels === null ? <span className="om-skel ctrl" /> : <ModelSelect models={ollamaModels} />}
              </div>
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Context window</p>
                  <span className="mono">Tokens per AI call (num_ctx). 0 = default (8192). Raise for long transcripts if your RAM allows.</span>
                </div>
                {profile === null ? (
                  <span className="om-skel ctrl" style={{ width: 160 }} />
                ) : (
                  <div className="om-inline-control">
                    <input
                      type="number"
                      min={0}
                      max={131072}
                      step={1024}
                      value={profile.num_ctx || ''}
                      placeholder="8192"
                      onChange={(e) => setProfile({ ...profile, num_ctx: e.target.value === '' ? 0 : Number(e.target.value) })}
                      onBlur={() => saveProfile({ num_ctx: profile.num_ctx })}
                      className="om-input"
                      style={{ width: 96, textAlign: 'right' }}
                    />
                    <span className="mono om-setting-val">tokens</span>
                  </div>
                )}
              </div>
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Installed</p>
                  {ollamaModels === null ? (
                    <span className="om-skel" />
                  ) : (
                    <span className="mono">{ollamaModels.length} model{ollamaModels.length === 1 ? '' : 's'} pulled locally</span>
                  )}
                </div>
                {ollamaModels === null ? <span className="om-skel sm" /> : <span className="mono om-setting-val">{ollamaModels.length}</span>}
              </div>
              <ReindexRow />
            </SettingCard>

      </>
    ) },
    { id: 'files', label: 'Files & limits', node: (
      <>
            <SettingCard title="Files & limits" eyebrow="Files">
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Max upload size</p>
                  <span className="mono">Per file. Any file type is accepted. Default 5120 MB (5 GB).</span>
                </div>
                {profile === null ? (
                  <span className="om-skel ctrl" style={{ width: 200 }} />
                ) : (
                  <div className="om-inline-control">
                    <input
                      type="number"
                      min={1}
                      max={51200}
                      value={maxUploadMb ?? ''}
                      onChange={(e) => setMaxUploadMb(e.target.value === '' ? null : Number(e.target.value))}
                      className="om-input"
                      style={{ width: 92, textAlign: 'right' }}
                    />
                    <span className="mono om-setting-val">MB</span>
                    <button className="om-btn-secondary" onClick={saveMaxUpload} disabled={maxUploadMb == null}>
                      {maxUploadSaved ? 'Saved ✓' : 'Save'}
                    </button>
                  </div>
                )}
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <div className="om-setting-row-text">
                  <p>Auto-download pulled audio</p>
                  <span className="mono">
                    Download audio from SoundCloud, Bandcamp, etc. on save so it plays locally and survives takedown. When off, the memo streams via the platform's embed instead.
                  </span>
                </div>
                <button
                  type="button"
                  className="om-add-toggle"
                  onClick={() => profile && saveProfile({ auto_download_audio: !profile.auto_download_audio })}
                  aria-pressed={profile?.auto_download_audio ?? true}
                >
                  <span className={'om-add-toggle-switch' + ((profile?.auto_download_audio ?? true) ? ' on' : '')}>
                    <span className="om-add-toggle-knob" />
                  </span>
                </button>
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <div className="om-setting-row-text">
                  <p>File by source</p>
                  <span className="mono">
                    Send everything from a site straight into one collection, so a shop you save from often stays out of the way. Only applies when you have not picked a collection yourself.
                  </span>
                </div>
                <button
                  type="button"
                  className="om-add-toggle"
                  onClick={() => profile && saveProfile({ auto_file_by_source: !profile.auto_file_by_source })}
                  aria-pressed={profile?.auto_file_by_source ?? true}
                >
                  <span className={'om-add-toggle-switch' + ((profile?.auto_file_by_source ?? true) ? ' on' : '')}>
                    <span className="om-add-toggle-knob" />
                  </span>
                </button>
              </div>
              {(profile?.auto_file_by_source ?? true) && (
                <AutoFileRules
                  rules={profile?.auto_file_rules ?? []}
                  onChange={(rules) => saveProfile({ auto_file_rules: rules })}
                />
              )}
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <div className="om-setting-row-text">
                  <p>Auto-download embed-less video</p>
                  <span className="mono">
                    Download video that has no inline player (Threads, Reddit, unknown hosts) on save so it plays locally and survives takedown. Embeddable hosts (YouTube, Vimeo, …) stay remote so this won't fill the disk.
                  </span>
                </div>
                <button
                  type="button"
                  className="om-add-toggle"
                  onClick={() => profile && saveProfile({ auto_download_video: !profile.auto_download_video })}
                  aria-pressed={profile?.auto_download_video ?? true}
                >
                  <span className={'om-add-toggle-switch' + ((profile?.auto_download_video ?? true) ? ' on' : '')}>
                    <span className="om-add-toggle-knob" />
                  </span>
                </button>
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <div className="om-setting-row-text">
                  <p>Localize saved content</p>
                  <span className="mono">
                    {localizeResult || 'Download remote images in saved articles so memos survive source deletion'}
                  </span>
                </div>
                <button className="om-btn-secondary" onClick={runLocalize} disabled={localizing}>
                  {localizing ? 'Localizing…' : 'Localize'}
                </button>
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
                <div className="om-setting-row-text" style={{ maxWidth: 560 }}>
                  <p>Cookies for restricted downloads</p>
                  <span className="mono">
                    Lets "Make it local" fetch age-restricted or private videos, and unlocks full-resolution uncropped Instagram photos (without cookies, Instagram only serves a 640px square crop). The cookie file stays on this machine, in <code>{install.dataHome}</code>, as <code>yt_cookies.txt</code>. It is only handed to yt-dlp and gallery-dl to fetch media, never sent to any openMemo service (there isn't one). Use a throwaway account.{' '}
                    <button type="button" onClick={() => openGuide('yt-cookies')} style={{ color: 'var(--accent)', fontWeight: 500 }}>Show me how</button>
                  </span>
                </div>
                <CookiesUpload />
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, flexDirection: 'column', alignItems: 'stretch' }}>
                <InstagramConnectRows />
                <MusicRelayRows profile={profile} save={saveProfile} />
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <TrashRow />
              </div>
            </SettingCard>

      </>
    ) },
    { id: 'extension', label: 'Browser extension', node: (
      <>
            <SettingCard title="Browser extension" eyebrow="Capture">
              <div className="om-ext-card-body">
                <div className="om-ext-cta">
                  <p className="om-ext-cta-sub">
                    Save pages, highlight text, or clip tabs directly from your browser.{' '}
                    {install.isMac
                      ? <>You installed the app, not the source, so grab the <code>chrome-extension</code> folder from GitHub and load it unpacked.</>
                      : install.known
                        ? <>Load unpacked from <code>chrome-extension/</code> in the repo.</>
                        : null}
                    {' '}Point it at <code>{window.location.origin}/api</code>, which is where this window is talking right now.
                    {install.isMac && ' If openMemo ever starts on a different port, come back here for the new one.'}
                  </p>
                  <a
                    className="om-ext-install-btn"
                    href="https://github.com/izored/OpenMemo/tree/main/chrome-extension"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon name="arrowUpRight" size={13} />
                    Install extension
                  </a>
                </div>
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  whileInView={{ y: 0, opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <div className="om-ext-mockup">
                    <div className="om-ext-mockup-header">
                      <div className="om-ext-mockup-logo">O</div>
                      <span className="om-ext-mockup-title">OpenMemo</span>
                      <div className="om-ext-mockup-dot" />
                    </div>
                    <div className="om-ext-mockup-body">
                      <div className="om-ext-mockup-preview">
                        <div className="om-ext-mockup-line" />
                        <div className="om-ext-mockup-line short" />
                      </div>
                      <div className="om-ext-mockup-btn" />
                    </div>
                  </div>
                </motion.div>
              </div>
            </SettingCard>


            {/* Column break. Measured at 1280px after scheduled archives were
                removed: the cards above total 2637px and the cards from here down
                2527px, so the columns land 110px apart. Re-measure and move this
                whenever a card is added, removed, or changes height — see
                CLAUDE.md. Dropping the archive UI shrank Backup & Restore by
                ~1100px and flipped the balance, which is exactly why. */}
      </>
    ) },
    { id: 'phone', label: 'Phone capture', node: (
      <>
            <SettingCard title="Phone capture" eyebrow="Telegram relay">
              <TelegramRelayRows profile={profile} save={saveProfile} />
            </SettingCard>

      </>
    ) },
    // Packaged Mac app only: every row inside crosses into the main process.
    // A card that is absent is handled by the layout (unknown ids are filtered,
    // unplaced known ids are appended), so this can come and go safely.
    //
    // Keyed off the bridge alone, not `install.isMac`. The bridge is there
    // synchronously in the packaged app, while `isMac` is false until the
    // settings fetch lands: gating on both made the card appear one render late
    // and visibly reshuffle the two columns on every Settings open.
    ...(shellBridge()
      ? [{ id: 'security', label: 'Security', node: (
          <SettingCard title="Security" eyebrow="This Mac">
            <SecurityRows />
          </SettingCard>
        ) }]
      : []),
    { id: 'mesh', label: 'Mesh', node: (
      <>
            <SettingCard title="Mesh" eyebrow="Two-way device sync">
              <MeshRows profile={profile} save={saveProfile} />
            </SettingCard>


      </>
    ) },
    { id: 'backup', label: 'Backup & Restore', node: (
      <>
            <SettingCard title="Backup & Restore" eyebrow="Data safety">
              <LibraryIntegrityRows />
              {/* openMemo has been taking automatic database snapshots the whole
                  time (core/autobackup.py) and never said so anywhere. Someone
                  who lost data would not have known to look. */}
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Automatic snapshots</p>
                  <span className="mono">
                    openMemo compresses a copy of the database on a schedule and keeps the recent
                    ones, in <code>{install.dataHome}/backups</code>. Database only: the files you
                    uploaded are not in there, which is what the backups below are for.
                  </span>
                </div>
                {shellBridge() ? (
                  <button className="om-btn-secondary" onClick={() => void shellBridge()?.openBackupsFolder()}>
                    Open folder
                  </button>
                ) : null}
              </div>
              {autoSnaps.length > 0 ? (
                <div className="om-setting-row">
                  <div className="om-setting-row-text">
                    <p>Restore a snapshot</p>
                    <span className="mono">
                      {autoSnaps.length} kept, newest first. Restores the database only.
                    </span>
                  </div>
                  <SettingsPicker
                    options={autoSnaps.map((s) => ({
                      value: s.name,
                      label:
                        new Date(s.created_at).toLocaleString() +
                        ' · ' +
                        (s.bytes / 1024 / 1024).toFixed(1) +
                        ' MB',
                    }))}
                    /* An action, not a selection: nothing stays picked, so the
                       placeholder comes back the moment the menu closes. */
                    value=""
                    placeholder={restoring ? 'Restoring…' : 'Pick a date…'}
                    disabled={restoring}
                    onChange={(name) => {
                      const snap = autoSnaps.find((s) => s.name === name);
                      if (snap) void handleRestoreAuto(snap.name, new Date(snap.created_at).toLocaleString());
                    }}
                  />
                </div>
              ) : null}
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Structure backup</p>
                  <span className="mono">DB, collections, tags, chats — no uploaded files</span>
                </div>
                <button className="om-btn-secondary" onClick={() => handleBackup('structure')} disabled={!!backing || restoring}>
                  {backing === 'structure' ? 'Preparing…' : 'Download'}
                </button>
              </div>
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Essential backup</p>
                  <span className="mono">DB + every file with no source — the part that exists nowhere else</span>
                </div>
                <button className="om-btn-secondary" onClick={() => handleBackup('essential')} disabled={!!backing || restoring}>
                  {backing === 'essential' ? 'Preparing…' : 'Download'}
                </button>
              </div>
              <div className="om-setting-row">
                <div className="om-setting-row-text">
                  <p>Full backup</p>
                  <span className="mono">DB + all uploaded files</span>
                </div>
                <button className="om-btn-secondary" onClick={() => handleBackup('full')} disabled={!!backing || restoring}>
                  {backing === 'full' ? 'Preparing…' : 'Download'}
                </button>
              </div>
              <div className="om-setting-row" style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <div className="om-setting-row-text">
                  <p>Restore from backup</p>
                  <span className="mono">Upload a .zip or .db.gz — overwrites current data</span>
                </div>
                <button className="om-btn-secondary danger" onClick={handleRestoreClick} disabled={!!backing || restoring}>
                  {restoring ? 'Restoring…' : 'Restore'}
                </button>
                <input type="file" ref={fileInputRef} accept=".zip,.gz" style={{ display: 'none' }} onChange={handleFileSelected} />
              </div>
            </SettingCard>

      </>
    ) },
    { id: 'danger', label: 'Danger zone', node: (
      <>
            <SettingCard title="Danger zone" eyebrow="Careful">
              <div className="om-danger-grid">
                <div className="om-setting-row">
                  <div className="om-setting-row-text">
                    <p>Export all Memos</p>
                    <span className="mono">JSON · Markdown bundle</span>
                  </div>
                  <a className="om-btn-secondary" href="/api/export/markdown" target="_blank" rel="noopener noreferrer">Export</a>
                </div>
                <div className="om-setting-row">
                  <div className="om-setting-row-text">
                    <p>Delete cached previews</p>
                    <span className="mono">{stats?.storage ? `Frees ~${fmtBytes(stats.storage.cache_bytes)}` : 'Thumbnail cache'}</span>
                  </div>
                  <button
                    className="om-btn-secondary"
                    onClick={async () => {
                      const go = await ask({
                        title: 'Delete cached previews',
                        body: 'Thumbnails only. They re-cache on their own the next time you see the card.',
                        confirmLabel: 'Clear',
                      });
                      if (!go) return;
                      try {
                        const r = await maintenanceApi.clearCache();
                        systemApi.stats(true).then(setStats).catch(() => {});
                        showNotice(`Cleared ${fmtBytes(r.freed_bytes)} of cached previews.`, 'info');
                      } catch { showNotice('Failed to clear cache.'); }
                    }}
                  >Clear</button>
                </div>
                <div className="om-setting-row">
                  <div className="om-setting-row-text">
                    <p>Reset workspace</p>
                    <span className="mono">Cannot be undone</span>
                  </div>
                  <button
                  className="om-btn-secondary danger"
                  onClick={async () => {
                    const go = await ask({
                      title: 'Reset the whole workspace',
                      body: 'Every memo, collection, tag, chat and uploaded file is deleted. There is no undo and no trash to fish it out of.',
                      secondary: 'Really. Everything goes, and the only way back is a backup you already made.',
                      confirmLabel: 'Delete everything',
                      danger: true,
                    });
                    if (!go) return;
                    try {
                      await maintenanceApi.reset();
                      showNotice('Workspace reset. Reloading.', 'info');
                      location.reload();
                    } catch { showNotice('Failed to reset workspace.'); }
                  }}
                >Reset</button>
                </div>
              </div>
            </SettingCard>


          {/* ── Built with — full-width auto-scroll marquee ─────── */}
      </>
    ) },
    { id: 'built-with', label: 'Built with', node: (
      <>
          <SettingCard title="Built with ❤️" eyebrow="Open source">
            <BuiltWith entries={BUILT_WITH} />
          </SettingCard>
      </>
    ) },
    { id: 'creator', label: 'Made by', node: (
      <>
          <div className="om-setting-card om-creator-card">
            <div className="om-setting-head">
              <span className="mono om-setting-eyebrow">Made by</span>
            </div>
            <div className="om-setting-body">
              <p className="om-creator-name">Reda Izo</p>
              <span className="om-creator-role">Creative Director · openMemo</span>
              <p className="om-creator-bio">
                I build tools I want to use. openMemo keeps the links, files,
                notes and videos worth saving. On your machine.
              </p>
              <div className="om-creator-links">
                <a className="om-creator-link" href="https://dev.izo.red" target="_blank" rel="noopener noreferrer">
                  <Icon name="globe" size={12} /> dev.izo.red
                </a>
                <a className="om-creator-link" href="https://github.com/izored/OpenMemo" target="_blank" rel="noopener noreferrer">
                  <Icon name="github" size={12} /> GitHub
                </a>
              </div>
            </div>
          </div>
      </>
    ) },
  ];

  return (
    <div className="om-settings">
      <PageHeader
        eyebrow="Workspace · Personal"
        title="Settings"
        sub="Everything here is stored on your machine. No cloud, no account."
      />

      <div className="om-bento-stack">

        {/* ── Appearance hero — the headline feature ──────────── */}
        <div
          className="om-ap-hero"
          role="button"
          tabIndex={0}
          onClick={openAppearance}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openAppearance();
            }
          }}
        >
          <div className="om-ap-hero-text">
            <span className="mono om-ap-hero-eyebrow">Look &amp; feel · Live preview</span>
            <h2 className="om-ap-hero-title">Make openMemo yours.</h2>
            <p className="om-ap-hero-sub">
              Theme, accent, card style, layout, columns, background. Tweak it and watch every Memo update live.
            </p>
            <div className="om-ap-hero-actions">
              <span className="om-ap-hero-cta">
                {isMobile ? 'Desktop only — tap for details' : 'Open live preview'} <Icon name="arrowUpRight" size={15} />
              </span>
              <button
                type="button"
                className="om-ap-hero-tour"
                onClick={(e) => {
                  e.stopPropagation();
                  localStorage.removeItem(ONBOARDING_KEY);
                  window.dispatchEvent(new Event('openmemo:retake-tour'));
                }}
              >
                Replay product tour
              </button>
            </div>
          </div>
          <div className="om-ap-hero-vis" aria-hidden>
            <div className="om-ap-hero-window">
              <div className="om-ap-hero-window-bar">
                <span /><span /><span />
              </div>
              <div className="om-ap-hero-window-body">
                <span className="om-ap-hero-accent" style={{ background: t.accent }} />
                <span className="om-ap-hero-mini" />
                <span className="om-ap-hero-mini" />
                <span className="om-ap-hero-mini" />
                <span className="om-ap-hero-mini" />
              </div>
            </div>
            <span className="om-ap-hero-state mono">
              {t.theme} · {t.cardStyle} · {t.layout} · {t.gridColumns} cols
            </span>
          </div>
        </div>

        {/* ── Stats strip — big numbers. Tiles always render (with skeleton
              loaders) so the row reserves its height and never jumps in. ── */}
        <div className="om-stat-strip">
          <div className="om-stat-tile">
            {stats ? <span className="om-stat-num">{stats.total_memos.toLocaleString()}</span> : <span className="om-stat-skel" />}
            <span className="om-stat-lbl">Memos</span>
          </div>
          <div className="om-stat-tile">
            {stats ? <span className="om-stat-num">{stats.total_collections}</span> : <span className="om-stat-skel" />}
            <span className="om-stat-lbl">Collections</span>
          </div>
          <div className="om-stat-tile">
            {stats ? <span className="om-stat-num">{stats.total_tags}</span> : <span className="om-stat-skel" />}
            <span className="om-stat-lbl">Tags</span>
          </div>
          <div className="om-stat-tile">
            {stats ? <span className="om-stat-num">{stats.memos_this_week}</span> : <span className="om-stat-skel" />}
            <span className="om-stat-lbl">This week</span>
          </div>
          <div className="om-stat-tile om-stat-storage">
            <div className="om-stat-storage-top">
              {stats?.storage ? <span className="om-stat-num">{fmtBytes(stats.storage.total_bytes)}</span> : <span className="om-stat-skel" />}
              <span className="om-stat-lbl">On disk</span>
            </div>
            {stats?.storage ? (
              <>
                <div className="om-storage-bar" aria-hidden>
                  <span className="a" style={{ width: `${(stats.storage.files_bytes / Math.max(1, stats.storage.total_bytes)) * 100}%` }} />
                  <span className="b" style={{ width: `${(stats.storage.cache_bytes / Math.max(1, stats.storage.total_bytes)) * 100}%` }} />
                </div>
                <div className="om-storage-legend mono">
                  <span><i className="a" /> Files {fmtBytes(stats.storage.files_bytes)}</span>
                  <span><i className="b" /> Cache {fmtBytes(stats.storage.cache_bytes)}</span>
                  <span>DB {fmtBytes(stats.storage.db_bytes)}</span>
                </div>
              </>
            ) : (
              <span className="om-stat-skel wide" />
            )}
          </div>
        </div>

        {/* ── Cards — masonry so short cards get hugged, no gaps ─ */}
        {/* Cards — two columns the user arranges by dragging (see
            SortableSettingsCard). The old hand-placed om-col-break is gone: it
            was a constant in the source that went stale whenever a card changed
            height, and the person looking at the page can judge it better. */}
        <SettingsCardBoard
          slots={cardSlots}
          layout={profile?.settings_card_layout}
          onLayout={(l) => saveProfile({ settings_card_layout: l })}
        />

      </div>

      <div className="om-settings-footer">
        <a
          className="om-creator-link"
          href="mailto:dev@izo.red?subject=[openMemo Feedback]&body=Hi Reda,%0A%0A"
        >
          <Icon name="message" size={12} /> Feedback
        </a>

        <button
          className="om-version-btn"
          onClick={checkForUpdate}
          disabled={updateCheck === 'checking'}
          title={
            updateAvailable ? 'Update available'
              : updateCheck === 'checking' ? 'Checking…'
              : updateCheck === 'current' ? 'You are on the latest version'
              : updateCheck === 'failed' ? 'Could not reach GitHub'
              : 'Click to check for updates'
          }
        >
          openMemo · v{version || '...'}
          {updateCheck === 'checking' && <span className="om-version-note">checking…</span>}
          {updateCheck === 'current' && <span className="om-version-note">latest</span>}
          {updateCheck === 'failed' && <span className="om-version-note">offline</span>}
          {showUpdateDot && <span className="om-update-dot" />}
        </button>

        <button className="om-creator-link" onClick={() => setChangelogOpen(true)}>
          <Icon name="sparkles" size={12} /> Changelog
        </button>
      </div>

      {confirmModal}
      {changelogOpen && (
        <ChangelogModal current={version || '0.0.0'} onClose={() => setChangelogOpen(false)} />
      )}
    </div>
  );
}
