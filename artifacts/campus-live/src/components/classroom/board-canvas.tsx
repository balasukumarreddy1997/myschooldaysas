"use client";
import { useEffect, useRef, useState } from 'react';
import { Eraser, Highlighter, Pen } from 'lucide-react';
import type { BoardOp, Cfg, Pt, Stroke, useBoard } from './use-board';

const W = 1600;
const H = 900;
type Board = ReturnType<typeof useBoard>;

function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (!s.points?.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = s.tool === 'highlighter' ? s.width * 3 : s.width;
  ctx.strokeStyle = s.color;
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1;
  ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
  if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
  ctx.stroke(); ctx.restore();
}

function paintBackground(ctx: CanvasRenderingContext2D, cfg: Cfg) {
  const bg = cfg?.background ?? {};
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = bg.color || 'transparent'; ctx.fillRect(0, 0, W, H);
  const sp = Math.max(12, Number(bg.spacing) || 32);
  ctx.strokeStyle = bg.lineColor || 'rgba(120,140,135,.4)'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1;
  const line = (a: number, b: number, c: number, d: number) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); };
  if (bg.type === 'ruled') for (let y = sp; y < H; y += sp) line(0, y, W, y);
  else if (bg.type === 'grid' || bg.type === 'graph') for (let y = sp; y < H; y += sp) { line(0, y, W, y); for (let x = sp; x < W; x += sp) line(x, 0, x, H); }
  else if (bg.type === 'dots') for (let y = sp; y < H; y += sp) for (let x = sp; x < W; x += sp) ctx.fillRect(x - 1, y - 1, 2, 2);
  else if (bg.type === 'music') for (let g = 0; g < 8; g++) for (let i = 0; i < 5; i++) { const y = 80 + g * 105 + i * 12; line(60, y, W - 60, y); }
}

export function BoardCanvas({ board, userCanDraw }: { board: Board; userCanDraw: boolean }) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<'pen' | 'highlighter' | 'eraser'>('pen');
  const [color, setColor] = useState('');
  const [size, setSize] = useState(0);
  const cfg = board.config;
  const palette: string[] = cfg?.palette ?? [];
  const sizes: number[] = cfg?.penSizes ?? [];
  const allowed: string[] = cfg?.tools ?? ['pen', 'highlighter', 'eraser'];
  const activeColor = color || palette[0] || '';
  const activeSize = size || sizes[1] || sizes[0] || 4;

  useEffect(() => { const c = bgRef.current?.getContext('2d'); if (c && cfg) paintBackground(c, cfg); }, [cfg]);

  useEffect(() => {
    const ctx = inkRef.current?.getContext('2d'); if (!ctx) return;
    const { reset, added, all } = board.drain();
    if (reset) { ctx.clearRect(0, 0, W, H); for (const o of all) paintStroke(ctx, o.op); }
    else for (const o of added as BoardOp[]) paintStroke(ctx, o.op);
  }, [board.version, board]);

  const pos = (e: React.PointerEvent): Pt => {
    const r = inkRef.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * W * 10) / 10, y: Math.round(((e.clientY - r.top) / r.height) * H * 10) / 10 };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!userCanDraw || board.status !== 'live' || !activeColor) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    live.current = { kind: 'stroke', tool, color: activeColor, width: tool === 'eraser' ? activeSize * 3 : activeSize, points: [pos(e)] };
    inkRef.current?.getContext('2d') && paintStroke(inkRef.current.getContext('2d')!, live.current);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = live.current; if (!s) return;
    const p = pos(e); const prev = s.points[s.points.length - 1]; s.points.push(p);
    if (s.tool !== 'highlighter') paintStroke(inkRef.current!.getContext('2d')!, { ...s, points: [prev, p] });
  };
  const up = () => {
    const s = live.current; live.current = null; if (!s) return;
    board.sendStroke(s); // server echoes op back; local preview painted already, echo repaints identical stroke
  };

  const tools = [{ id: 'pen', label: 'Pen', Icon: Pen }, { id: 'highlighter', label: 'Highlighter', Icon: Highlighter }, { id: 'eraser', label: 'Eraser', Icon: Eraser }] as const;
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    {userCanDraw && <div role="toolbar" aria-label="Drawing tools" className="flex flex-wrap items-center gap-2 rounded-xl border border-[hsl(var(--classroom-border))] bg-[hsl(var(--classroom-panel))] p-2">
      {tools.filter(t => allowed.includes(t.id)).map(({ id, label, Icon }) => <button key={id} aria-label={label} aria-pressed={tool === id} onClick={() => setTool(id)} className={`grid h-10 w-10 place-items-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--classroom-ready))] ${tool === id ? 'bg-[hsl(var(--classroom-ready))] text-[hsl(var(--brand-ink))]' : 'text-[hsl(var(--classroom-text))] hover:bg-white/10'}`}><Icon size={18}/></button>)}
      <span className="mx-1 h-6 w-px bg-[hsl(var(--classroom-border))]"/>
      {palette.map(c => <button key={c} aria-label={`Ink colour ${c}`} aria-pressed={activeColor === c} onClick={() => setColor(c)} style={{ background: c }} className={`h-7 w-7 rounded-full border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--classroom-ready))] ${activeColor === c ? 'border-[hsl(var(--classroom-text))]' : 'border-transparent'}`}/>)}
      <span className="mx-1 h-6 w-px bg-[hsl(var(--classroom-border))]"/>
      {sizes.map(s => <button key={s} aria-label={`Stroke width ${s}`} aria-pressed={activeSize === s} onClick={() => setSize(s)} className={`grid h-9 w-9 place-items-center rounded-lg hover:bg-white/10 ${activeSize === s ? 'bg-white/15' : ''}`}><span className="rounded-full bg-[hsl(var(--classroom-text))]" style={{ width: Math.min(s + 2, 22), height: Math.min(s + 2, 22) }}/></button>)}
    </div>}
    <div className="relative w-full overflow-hidden rounded-xl border border-[hsl(var(--classroom-border))] bg-[hsl(var(--paper))]" style={{ aspectRatio: `${W} / ${H}` }}>
      <canvas ref={bgRef} width={W} height={H} className="absolute inset-0 h-full w-full" aria-hidden="true"/>
      <canvas ref={inkRef} width={W} height={H} role="img" aria-label={userCanDraw ? 'Shared whiteboard. Draw with mouse, pen or touch.' : 'Shared whiteboard, view only.'}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className={`absolute inset-0 h-full w-full ${userCanDraw ? 'cursor-crosshair' : 'cursor-default'}`} style={{ touchAction: userCanDraw ? 'none' : 'auto' }}/>
      {!cfg && <div className="absolute inset-0 grid place-items-center text-xs text-[hsl(var(--muted-foreground))]">Connecting to board...</div>}
    </div>
  </div>;
}
