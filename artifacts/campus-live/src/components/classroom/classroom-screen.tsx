"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useGetSessionToken, useEndSession } from '@workspace/api-client-react';
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant } from 'livekit-client';
import { ChevronLeft, CircleAlert, LoaderCircle, LogOut, Mic, MicOff, Monitor, Power, RefreshCw, Video, VideoOff, Headphones, ShieldCheck } from 'lucide-react';
import { getAccessToken } from '../../auth-token';
import { useBoard, type Cfg } from './use-board';
import { BoardCanvas } from './board-canvas';
import { AttendancePanel } from './attendance-panel';

type Info = { session: { id: string; title: string; status: string }; boardId: string | null; userId: string; role: 'teacher' | 'student' | 'viewer' | 'observer'; canManage: boolean; canDraw: boolean; mediaConfigured: boolean };
type Media = { state: 'idle' | 'connecting' | 'connected' | 'error' | 'off'; message?: string };
const panel = 'rounded-2xl border border-[hsl(var(--classroom-border))] bg-[hsl(var(--classroom-panel))]';
const ctl = 'btn min-h-[44px] border border-[hsl(var(--classroom-border))] bg-transparent text-[hsl(var(--classroom-text))] hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--classroom-ready))]';

function Tile({ p, audioOnly }: { p: Participant; audioOnly: boolean }) {
  const vref = useRef<HTMLVideoElement>(null); const aref = useRef<HTMLAudioElement>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    const h = () => bump(n => n + 1);
    p.on(RoomEvent.TrackSubscribed as never, h as never);
    const evs = ['trackMuted', 'trackUnmuted', 'trackPublished', 'trackUnpublished', 'trackSubscribed', 'trackUnsubscribed', 'localTrackPublished', 'localTrackUnpublished'];
    evs.forEach(e => p.on(e as never, h as never));
    return () => { evs.forEach(e => p.off(e as never, h as never)); p.off(RoomEvent.TrackSubscribed as never, h as never); };
  }, [p]);
  const cam = p.getTrackPublication(Track.Source.Camera); const scr = p.getTrackPublication(Track.Source.ScreenShare); const mic = p.getTrackPublication(Track.Source.Microphone);
  const vt = (scr?.track ?? cam?.track); const showVideo = !audioOnly && !!vt && !(vt === cam?.track && cam?.isMuted);
  useEffect(() => { const el = vref.current; if (el && vt && showVideo) { vt.attach(el); return () => { vt.detach(el); }; } return undefined; }, [vt, showVideo]);
  useEffect(() => { const el = aref.current; const t = mic?.track; if (el && t && !p.isLocal) { t.attach(el); return () => { t.detach(el); }; } return undefined; }, [mic?.track, p.isLocal]);
  const name = p.name || p.identity;
  return <div className="relative aspect-video overflow-hidden rounded-xl border border-[hsl(var(--classroom-border))] bg-[hsl(var(--brand-forest))]">
    {showVideo ? <video ref={vref} autoPlay playsInline muted className="h-full w-full object-cover"/> : <div className="grid h-full w-full place-items-center"><div className="grid h-12 w-12 place-items-center rounded-full bg-[hsl(var(--brand-mint))] text-sm font-bold text-[hsl(var(--brand-mint-ink))]">{name.slice(0, 2).toUpperCase()}</div></div>}
    <audio ref={aref} autoPlay/>
    <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-[hsl(var(--classroom-bg)/.7)] px-2 py-1 text-[11px]">{mic && !mic.isMuted ? <Mic size={12}/> : <MicOff size={12}/>}<span className="truncate">{name}{p.isLocal ? ' (you)' : ''}</span></div>
  </div>;
}

export function ClassroomScreen({ sessionId }: { sessionId: string }) {
  const [mounted, setMounted] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return; let dead = false; setInfoErr(null); setInfo(null);
    const t = getAccessToken();
    fetch(`/api/live/sessions/${encodeURIComponent(sessionId)}/classroom`, { headers: t ? { Authorization: `Bearer ${t}` } : {}, credentials: 'include' })
      .then(async r => { if (!r.ok) throw new Error(r.status === 403 ? 'You are not part of this class session.' : r.status === 404 ? 'This session could not be found.' : `Classroom could not be opened (${r.status}).`); return r.json() as Promise<Info>; })
      .then(d => { if (!dead) setInfo(d); }).catch(e => { if (!dead) setInfoErr(e instanceof Error ? e.message : 'Classroom could not be opened.'); });
    return () => { dead = true; };
  }, [mounted, sessionId, tries]);

  return <div className="min-h-dvh bg-[hsl(var(--classroom-bg))] p-3 text-[hsl(var(--classroom-text))] md:p-6">
    <div className="mx-auto max-w-[1400px]">
      {!mounted || (!info && !infoErr) ? <div className="space-y-3" aria-label="Loading classroom"><div className="skeleton h-10 w-72"/><div className="skeleton h-[50vh] w-full"/></div>
        : infoErr || !info ? <div role="alert" className={`${panel} mx-auto mt-10 max-w-md p-8 text-center`}><CircleAlert className="mx-auto mb-3 text-[hsl(var(--classroom-warn))]"/><b>Classroom unavailable</b><p className="text-sm text-[hsl(var(--classroom-muted))]">{infoErr}</p><div className="flex justify-center gap-2"><button className={ctl} onClick={() => setTries(n => n + 1)}><RefreshCw size={15}/>Try again</button><Link href="/live/sessions" className={ctl}>Back</Link></div></div>
        : <Room_ info={info} sessionId={sessionId}/>}
    </div>
  </div>;
}

function Room_({ info, sessionId }: { info: Info; sessionId: string }) {
  const board = useBoard(info.boardId ?? undefined, info.userId);
  const [, navigate] = useLocation();
  const token = useGetSessionToken(); const end = useEndSession();
  const roomRef = useRef<Room | null>(null);
  const [media, setMedia] = useState<Media>({ state: 'idle' });
  const [people, setPeople] = useState<Participant[]>([]);
  const [audioOnly, setAudioOnly] = useState(false);
  const [mic, setMic] = useState(false); const [cam, setCam] = useState(false); const [scr, setScr] = useState(false);
  const [ctlErr, setCtlErr] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const isTeacher = info.role === 'teacher';
  const canDraw = board.canDraw;

  const refresh = useCallback(() => { const r = roomRef.current; if (r) setPeople([r.localParticipant, ...Array.from(r.remoteParticipants.values())]); }, []);
  const join = useCallback(async () => {
    setMedia({ state: 'connecting' });
    try {
      const j = await token.mutateAsync({ sessionId });
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.ParticipantConnected, refresh).on(RoomEvent.ParticipantDisconnected, refresh).on(RoomEvent.TrackSubscribed, refresh).on(RoomEvent.TrackUnsubscribed, refresh)
        .on(RoomEvent.ParticipantPermissionsChanged, refresh)
        .on(RoomEvent.Disconnected, () => { setMedia(m => m.state === 'off' ? m : { state: 'error', message: 'Media connection was lost.' }); setPeople([]); })
        .on(RoomEvent.Reconnecting, () => setMedia({ state: 'connecting', message: 'Reconnecting media...' })).on(RoomEvent.Reconnected, () => setMedia({ state: 'connected' }));
      await room.connect(j.url, j.token);
      setMedia({ state: 'connected' }); refresh();
    } catch (e) {
      const m = e as { status?: number; message?: string };
      setMedia({ state: 'error', message: m.status === 503 ? 'Live media is not configured for this school yet. The board still works.' : `Could not connect media: ${m.message ?? 'unknown error'}` });
    }
  }, [token, sessionId, refresh]);
  const joinRef = useRef(join); joinRef.current = join;
  useEffect(() => { if (info.mediaConfigured) void joinRef.current(); else setMedia({ state: 'off', message: 'Live media is not configured. The board still works.' }); return () => { roomRef.current?.disconnect(); roomRef.current = null; }; }, [info.mediaConfigured]);

  const toggle = async (kind: 'mic' | 'cam' | 'scr') => {
    const lp = roomRef.current?.localParticipant; if (!lp) return; setCtlErr(null);
    try {
      if (kind === 'mic') { await lp.setMicrophoneEnabled(!mic); setMic(!mic); }
      if (kind === 'cam') { await lp.setCameraEnabled(!cam); setCam(!cam); }
      if (kind === 'scr') { await lp.setScreenShareEnabled(!scr); setScr(!scr); }
      refresh();
    } catch (e) { setCtlErr(e instanceof Error ? e.message : 'Device could not be started. Check browser permissions.'); }
  };
  const leave = () => { roomRef.current?.disconnect(); navigate('/live/sessions'); };
  const connected = media.state === 'connected';
  const remotes = people.filter((p): p is RemoteParticipant => !p.isLocal);
  useEffect(() => {
    for (const participant of people.filter((p): p is RemoteParticipant => !p.isLocal)) {
      for (const publication of participant.videoTrackPublications.values()) {
        publication.setSubscribed(!audioOnly);
      }
    }
  }, [audioOnly, people]);
  const microphoneGrant = async (participant: RemoteParticipant) => {
    setCtlErr(null);
    try {
      const response = await fetch(`/api/live/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participant.identity)}/permissions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken() ?? ''}` },
        body: JSON.stringify({ canPublish: !participant.permissions?.canPublish }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error?.message ?? 'Could not update microphone permission.');
      }
    } catch (cause) { setCtlErr(cause instanceof Error ? cause.message : 'Could not update microphone permission.'); }
  };

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3"><Link href="/live/sessions" aria-label="Back to live classes" className="grid h-10 w-10 place-items-center rounded-lg border border-[hsl(var(--classroom-border))] hover:bg-white/5"><ChevronLeft size={18}/></Link>
        <div className="min-w-0"><div className="text-[10px] font-bold uppercase tracking-[.17em] text-[hsl(var(--classroom-ready))]">Campus Live classroom - {info.role}</div><h1 className="display m-0 truncate text-xl font-extrabold">{info.session.title}</h1></div></div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]" role="status">
        <span className="flex items-center gap-2 rounded-full border border-[hsl(var(--classroom-border))] px-3 py-1.5"><span className={`h-2 w-2 rounded-full ${board.status === 'live' ? 'bg-[hsl(var(--status-good))]' : 'bg-[hsl(var(--classroom-warn))]'}`}/>Board {board.status}</span>
        <span className="flex items-center gap-2 rounded-full border border-[hsl(var(--classroom-border))] px-3 py-1.5"><span className={`h-2 w-2 rounded-full ${connected ? 'bg-[hsl(var(--status-good))]' : 'bg-[hsl(var(--classroom-warn))]'}`}/>Media {media.state}</span>
      </div>
    </div>
    {ended && <div role="status" className={`${panel} p-3 text-sm`}>This session has ended.</div>}
    {board.error && <div role="alert" className="flex items-center gap-2 rounded-lg bg-[hsl(var(--classroom-danger-bg))] p-3 text-xs text-[hsl(var(--classroom-danger))]"><CircleAlert size={14}/>{board.error}<button className="ml-auto underline" onClick={board.dismissError}>Dismiss</button></div>}
    <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
      <section className={`${panel} flex flex-col p-3`} aria-label="Whiteboard">
        <BoardCanvas board={board} userCanDraw={canDraw}/>
        <p className="m-2 text-[11px] text-[hsl(var(--classroom-muted))]">{canDraw ? 'You can draw on this board.' : 'View only. Your teacher can allow you to draw.'}</p>
        {isTeacher && board.config && <ConfigEditor cfg={board.config} onSave={board.sendConfig}/>}
      </section>
      <aside className="space-y-3">
        <div className={`${panel} p-3`}>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold"><Video size={14}/>Live media</div>
          {media.state === 'connecting' && <div className="flex items-center gap-2 text-xs"><LoaderCircle className="animate-spin" size={14}/>{media.message ?? 'Connecting media...'}</div>}
          {(media.state === 'error' || media.state === 'off') && <div role="alert" className="text-xs text-[hsl(var(--classroom-warn))]">{media.message}{media.state === 'error' && <button className="ml-2 underline" onClick={() => void join()}>Retry</button>}</div>}
          {connected && <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">{people.length ? people.map(p => <Tile key={p.sid} p={p} audioOnly={audioOnly}/>) : null}</div>}
          {connected && !remotes.length && <p className="mb-0 mt-2 text-[11px] text-[hsl(var(--classroom-muted))]">Nobody else is in the room yet.</p>}
          {ctlErr && <p role="alert" className="mb-0 mt-2 text-[11px] text-[hsl(var(--classroom-danger))]">{ctlErr}</p>}
        </div>
        {isTeacher && remotes.length > 0 && info.session.status !== 'ended' && <div className={`${panel} p-3`}><div className="mb-2 text-xs font-bold">Drawing access</div>
          <ul className="m-0 list-none space-y-1 p-0">{remotes.map(p => { const on = !!board.grants[p.identity]; return <li key={p.identity} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{p.name || p.identity}</span><button aria-pressed={on} onClick={() => board.sendGrant(p.identity, !on)} className={`rounded-lg px-3 py-2 text-[11px] font-bold ${on ? 'bg-[hsl(var(--classroom-ready))] text-[hsl(var(--brand-ink))]' : 'border border-[hsl(var(--classroom-border))]'}`}>{on ? 'Revoke' : 'Allow draw'}</button></li>; })}</ul></div>}
         {isTeacher && remotes.length > 0 && <div className={`${panel} p-3`}><h2 className="m-0 mb-2 text-xs font-bold">Student microphones</h2>{remotes.filter(p => {
           try { return JSON.parse(p.metadata || '{}').role === 'student'; } catch { return false; }
         }).map(p => <div key={p.identity} className="flex items-center gap-2 py-1 text-xs"><span className="min-w-0 flex-1 truncate">{p.name || p.identity}</span><button className={ctl} onClick={() => void microphoneGrant(p)}>{p.permissions?.canPublish ? 'Revoke mic' : 'Allow mic'}</button></div>)}</div>}
         <AttendancePanel sessionId={sessionId} canManage={info.canManage} ended={ended || info.session.status === 'ended'}/>
        <div className={`${panel} flex items-center gap-2 p-3 text-[11px] text-[hsl(var(--classroom-muted))]`}><ShieldCheck size={14}/>Recording is off. Only invited members can join.</div>
      </aside>
    </div>
    <div role="toolbar" aria-label="Classroom controls" className="sticky bottom-2 z-10 flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-[hsl(var(--classroom-border))] bg-[hsl(var(--classroom-panel))] p-2">
       {connected && (isTeacher || roomRef.current?.localParticipant.permissions?.canPublish) && <button aria-pressed={mic} aria-label={mic ? 'Mute microphone' : 'Unmute microphone'} className={ctl} onClick={() => void toggle('mic')}>{mic ? <Mic size={16}/> : <MicOff size={16}/>}<span className="hidden sm:inline">{mic ? 'Mute' : 'Unmute'}</span></button>}
      {connected && isTeacher && <button aria-pressed={cam} aria-label={cam ? 'Turn camera off' : 'Turn camera on'} className={ctl} onClick={() => void toggle('cam')}>{cam ? <Video size={16}/> : <VideoOff size={16}/>}<span className="hidden sm:inline">Camera</span></button>}
      {connected && isTeacher && <button aria-pressed={scr} aria-label={scr ? 'Stop sharing screen' : 'Share screen'} className={ctl} onClick={() => void toggle('scr')}><Monitor size={16}/><span className="hidden sm:inline">{scr ? 'Stop share' : 'Share screen'}</span></button>}
      <button aria-pressed={audioOnly} aria-label="Audio only mode" className={ctl} onClick={() => setAudioOnly(a => !a)}><Headphones size={16}/><span className="hidden sm:inline">{audioOnly ? 'Audio only on' : 'Audio only'}</span></button>
      <button className={ctl} onClick={leave}><LogOut size={16}/>Leave</button>
      {isTeacher && <button disabled={end.isPending || ended} className="btn min-h-[44px] bg-[hsl(var(--classroom-danger-bg))] text-[hsl(var(--classroom-danger))]" onClick={() => { if (window.confirm('End this session for everyone?')) end.mutate({ sessionId }, { onSuccess: () => { setEnded(true); roomRef.current?.disconnect(); } }); }}><Power size={16}/>{end.isPending ? 'Ending...' : 'End session'}</button>}
    </div>
    {end.isError && <p role="alert" className="text-xs text-[hsl(var(--classroom-danger))]">Could not end the session. Please try again.</p>}
  </div>;
}

function ConfigEditor({ cfg, onSave }: { cfg: Cfg; onSave: (c: Cfg) => boolean }) {
  const [type, setType] = useState<string>(cfg.background?.type ?? 'blank');
  const [spacing, setSpacing] = useState<number>(cfg.background?.spacing ?? 32);
  const [color, setColor] = useState<string>(cfg.background?.color ?? '');
  const [msg, setMsg] = useState('');
  const save = () => { const ok = onSave({ ...cfg, background: { ...cfg.background, type, spacing, ...(color ? { color } : {}) } }); setMsg(ok ? 'Board updated.' : 'Not connected; try again shortly.'); };
  return <details className="mt-2 rounded-xl border border-[hsl(var(--classroom-border))] p-3"><summary className="cursor-pointer text-xs font-bold">Board settings</summary>
    <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
      <label className="block">Background<select className="field mt-1 !bg-[hsl(var(--classroom-bg))] !text-[hsl(var(--classroom-text))]" value={type} onChange={e => setType(e.target.value)}>{['blank', 'ruled', 'grid', 'dots', 'graph', 'music'].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <label className="block">Line spacing<input type="number" min={12} max={80} className="field mt-1 !w-24 !bg-[hsl(var(--classroom-bg))] !text-[hsl(var(--classroom-text))]" value={spacing} onChange={e => setSpacing(Number(e.target.value) || 32)}/></label>
      <label className="block">Paper colour<input type="color" className="mt-1 block h-11 w-14 rounded-lg" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff'} onChange={e => setColor(e.target.value)}/></label>
      <button className={ctl} onClick={save}>Apply to everyone</button><span role="status" className="text-[hsl(var(--classroom-muted))]">{msg}</span>
    </div></details>;
}
