"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../../auth-token';

export type Pt = { x: number; y: number };
export type Stroke = { kind: 'stroke'; tool: 'pen' | 'highlighter' | 'eraser'; color: string; width: number; points: Pt[] };
export type BoardOp = { seq: number; id: string; userId: string; op: Stroke };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Cfg = any;
export type BoardStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

const authHeaders = (): Record<string, string> => {
  const t = getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

export function useBoard(boardId: string | undefined, userId: string) {
  const [status, setStatus] = useState<BoardStatus>('connecting');
  const [config, setConfig] = useState<Cfg>(null);
  const [canDraw, setCanDraw] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [grants, setGrants] = useState<Record<string, boolean>>({});
  const opsRef = useRef<BoardOp[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const lastAdded = useRef<BoardOp[]>([]);
  const resetFlag = useRef(false);

  useEffect(() => {
    if (!boardId || typeof window === 'undefined') { setStatus('closed'); return; }
    let stop = false; let attempt = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const addOp = (o: BoardOp) => {
      if (!o || !o.op || seen.current.has(o.id)) return;
      seen.current.add(o.id); opsRef.current.push(o); lastAdded.current.push(o);
    };
    const connect = async () => {
      if (stop) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const res = await fetch(`/api/board/boards/${encodeURIComponent(boardId)}/ticket`, { method: 'POST', headers: authHeaders(), credentials: 'include' });
         if (res.status === 409) { stop = true; setStatus('closed'); return; }
        if (!res.ok) throw new Error(res.status === 403 ? 'You do not have access to this board.' : `Board ticket request failed (${res.status}).`);
        const { ticket } = await res.json() as { ticket: string };
        if (stop) return;
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${window.location.host}/api/board/boards/${encodeURIComponent(boardId)}/ws?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;
        ws.onmessage = ev => {
          let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; } // eslint-disable-line @typescript-eslint/no-explicit-any
          if (m.type === 'hello') {
            attempt = 0; setError(null);
            setConfig(m.config); setCanDraw(!!m.canDraw); setCanManage(!!m.canManage);
            seen.current = new Set(); opsRef.current = []; lastAdded.current = []; resetFlag.current = true;
            for (const o of m.ops ?? []) addOp(o);
            setStatus('live'); setVersion(v => v + 1);
          } else if (m.type === 'op') { addOp(m as BoardOp); setVersion(v => v + 1); }
          else if (m.type === 'config') { setConfig(m.config); }
           else if (m.type === 'grant') {
             setGrants(g => ({ ...g, [m.userId]: !!m.canDraw }));
             if (m.userId === userId) setCanDraw(!!m.canDraw);
           }
           else if (m.type === 'closed') { stop = true; setCanDraw(false); setStatus('closed'); ws.close(); }
          else if (m.type === 'error') { setError(m.message || m.code || 'Board error'); }
        };
        ws.onclose = () => {
          if (stop) return;
          setStatus('reconnecting'); attempt += 1;
          timer = setTimeout(connect, Math.min(8000, 800 * 2 ** Math.min(attempt, 4)));
        };
        ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? e.message : 'Board connection failed.');
        setStatus('reconnecting'); attempt += 1;
        timer = setTimeout(connect, Math.min(8000, 800 * 2 ** Math.min(attempt, 4)));
      }
    };
    void connect();
    return () => { stop = true; if (timer) clearTimeout(timer); wsRef.current?.close(); };
  }, [boardId, userId]);

  const send = useCallback((m: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
    return false;
  }, []);
  const sendStroke = useCallback((op: Stroke) => {
    const id = crypto.randomUUID();
    return send({ type: 'op', id, op });
  }, [send]);
  const sendConfig = useCallback((c: Cfg) => send({ type: 'config', config: c }), [send]);
  const sendGrant = useCallback((userId: string, d: boolean) => { const ok = send({ type: 'grant', userId, canDraw: d }); if (ok) setGrants(g => ({ ...g, [userId]: d })); return ok; }, [send]);
  const drain = useCallback(() => { const r = resetFlag.current; resetFlag.current = false; const a = lastAdded.current; lastAdded.current = []; return { reset: r, added: a, all: opsRef.current }; }, []);

  return { status, config, canDraw, canManage, error, version, grants, sendStroke, sendConfig, sendGrant, drain, dismissError: () => setError(null) };
}
