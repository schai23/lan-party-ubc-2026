import { useEffect, useRef, useState } from 'react';
import type Phaser from 'phaser';
import { readPlayParams } from '../env';
import { router } from '../sidekick/router';
import { frameStats, mainThreadJobMsLastSecond, store } from '../sidekick/store';
import { DEFAULT_DISPATCH, talk } from './dialogue';
import type { NpcId } from '@sidekick/shared';

const params = readPlayParams();
(window as unknown as { __sidekick: typeof store }).__sidekick = store; // debugging aid (console)

function useTicker(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Sparkline() {
  const ref = useRef<HTMLCanvasElement>(null);
  useTicker(250);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const f = store.frames;
    if (!f.length) return;
    const t1 = f[f.length - 1].t;
    const max = 100;
    // guide lines at 16.7 ms and 50 ms
    ctx.strokeStyle = '#2a3140';
    ctx.lineWidth = 1;
    for (const g of [16.7, 50]) {
      const y = h - (g / max) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#5ce1e6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    f.forEach((p, i) => {
      const x = w - ((t1 - p.t) / 5000) * w;
      const y = h - (Math.min(p.ms, max) / max) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  return <canvas ref={ref} width={360} height={70} className="spark" />;
}

function LoadPanel() {
  useTicker(250);
  if (!store.panelVisible) return null;
  const fs = frameStats();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const linked = store.helpers.length > 0 && store.online && !store.forceLocal;
  const stubs = store.integrations.filter((i) => !i.configured);
  const d = store.dispatch ?? DEFAULT_DISPATCH;
  const earnedTotal = store.earnings?.helpers.reduce((s, h) => s + h.usdc, 0) ?? 0;
  return (
    <aside className="panel">
      <div className={`mode ${linked ? 'linked' : 'local'}`}>
        {linked ? `LINKED (${store.helpers.length} helper${store.helpers.length === 1 ? '' : 's'})` : 'LOCAL ONLY'}
        {store.forceLocal && <span className="sub"> · forced (L)</span>}
      </div>
      {!store.online && <div className="warn">{store.offlineReason || 'connecting…'}</div>}

      <div className="grid2">
        <div className="metric"><span>FPS</span><b>{fs.fps.toFixed(0)}</b></div>
        <div className="metric"><span>Frame avg</span><b>{fs.avg.toFixed(1)} ms</b></div>
        <div className="metric"><span>Frame p95</span><b className={fs.p95 > 50 ? 'bad' : fs.p95 < 20 ? 'good' : ''}>{fs.p95.toFixed(1)} ms</b></div>
        <div className="metric"><span>Main-thread jobs</span><b>{mainThreadJobMsLastSecond().toFixed(0)} ms/s</b></div>
      </div>
      <Sparkline />
      {mem && <div className="row">JS heap {(mem.usedJSHeapSize / 1048576).toFixed(0)} MB</div>}

      <h3>Jobs (offloaded / local)</h3>
      <table className="jobs">
        <tbody>
          {(['pathfind', 'areagen', 'simtick', 'dialogue'] as const).map((t) => {
            const s = store.stats[t];
            return (
              <tr key={t}>
                <td>{t}</td>
                <td className="good">{s.remote}</td>
                <td>{s.local}</td>
                <td className="dim">
                  {s.lastRemoteMs ? `${s.lastRemoteMs.toFixed(0)}ms rt` : ''} {s.lastLocalMs ? `${s.lastLocalMs.toFixed(0)}ms local` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        Pathfind round trip:{' '}
        <b>
          {store.stats.pathfind.remote
            ? `avg ${(store.stats.pathfind.remoteMsSum / store.stats.pathfind.remote).toFixed(0)} · last ${store.stats.pathfind.lastRemoteMs.toFixed(0)} ms`
            : '—'}
        </b>
        <span className="dim">
          {' '}(deadline {router.deadlines.pathfind} ms{store.stats.pathfind.remoteFailed ? `, ${store.stats.pathfind.remoteFailed} failed→local` : ''})
        </span>
      </div>
      <div className="row">
        Dialogue time-to-first-audio:{' '}
        <b>{store.ttfaMs == null ? '—' : `${(store.ttfaMs / 1000).toFixed(2)} s`}</b>
        {store.ttfaSource && <span className="dim"> ({store.ttfaSource})</span>}
      </div>
      <div className="row">Gate area: <span className="dim">{store.areaStatus}</span></div>

      <h3>Helpers</h3>
      {store.helpers.length === 0 && <div className="dim">none linked — scan the QR to help</div>}
      {store.helpers.map((h) => (
        <div key={h.helperId} className="helper">
          <b>{h.displayName}</b> <span className="tag">{h.caps.kind}</span>
          {h.paused && <span className="tag bad">paused</span>}
          <div className="dim">{h.caps.jobTypes.join(', ')} · inflight {h.inflight}</div>
        </div>
      ))}

      <h3>Settlements</h3>
      {store.settlements.length === 0 && (
        <div className="dim">{!store.solanaConfigured && earnedTotal === 0 ? 'Solana not configured' : 'waiting for first settlement…'}</div>
      )}
      {store.settlements.map((s) => (
        <div key={s.signature} className="settle">
          <a href={s.explorerUrl} target="_blank" rel="noreferrer">{s.signature.slice(0, 10)}…</a> {s.name} +{s.units}u ·{' '}
          {s.usdc.toFixed(4)} USDC
        </div>
      ))}

      <h3>Dispatch</h3>
      <div className="row">
        <span className="tag">{d.source}</span> {d.worldEvent.title}
      </div>

      <div className="badges">
        <div className="powered">Powered by Solana · QuickNode Streams · ElevenLabs · Grok Bot · Privy</div>
        {store.voice === 'browser' && <span className="tag warn">Voice: browser fallback</span>}
        {stubs.map((s) => (
          <span key={s.name} className="tag warn" title={s.stub}>stub: {s.name}</span>
        ))}
        {!store.integrationsLoaded && <span className="tag warn">integrations unknown (server offline)</span>}
      </div>
    </aside>
  );
}

function QrBox() {
  useTicker(500);
  if (!store.panelVisible) return null;
  if (!store.roomCode) return null;
  return (
    <div className="qr">
      {store.qrDataUrl && <img src={store.qrDataUrl} alt="pair QR" />}
      <div className="code">{store.roomCode}</div>
      <div className="dim small">scan to help</div>
    </div>
  );
}

function Hud() {
  useTicker(250);
  const sim = store.sim;
  const dlg = store.dialogue;
  const [typed, setTyped] = useState('');
  return (
    <>
      <div className="hud">
        <div className="title">Lanternfall</div>
        {sim ? (
          <>
            <div>Weather: <b>{sim.weather}</b></div>
            <div className="prices">
              {Object.entries(sim.prices).slice(0, 6).map(([k, v]) => (
                <span key={k}>{k} <b>{typeof v === 'number' ? v.toFixed(1) : String(v)}</b></span>
              ))}
            </div>
          </>
        ) : (
          <div className="dim">simulating…</div>
        )}
        <div className="dim small">WASD move · Space talk · G gate · R reset area · L local · P panel · 1/2/3 NPCs</div>
      </div>
      {store.nearNpc && (
        <div className="talkbar">
          <div>
            {store.listening ? 'Listening… release to send' : `Hold Space (or the mic) to talk to ${store.nearNpc.name}`}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const npc = store.nearNpc?.id as NpcId | undefined;
              if (npc && typed.trim()) void talk(npc, typed.trim(), params.model);
              setTyped('');
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type and press Enter" />
          </form>
        </div>
      )}
      {(dlg.text || dlg.status) && dlg.npcName && (
        <div className="bubble">
          <div className="who">{dlg.npcName} <span className="dim small">via {dlg.source}</span></div>
          {dlg.player && <div className="player">“{dlg.player}”</div>}
          <div>{dlg.text || dlg.status}</div>
        </div>
      )}
    </>
  );
}

export default function PlayPage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let game: Phaser.Game | null = null;
    let cancelled = false;
    void router.start();
    void import('./game').then(({ createGame }) => {
      if (!cancelled && ref.current) game = createGame(ref.current, params);
    });
    return () => {
      cancelled = true;
      game?.destroy(true);
    };
  }, []);
  return (
    <div className="play">
      <div ref={ref} className="stage" />
      <Hud />
      <QrBox />
      <LoadPanel />
      <MicButton />
    </div>
  );
}

function MicButton() {
  useTicker(250);
  if (!store.nearNpc) return null;
  return (
    <button
      className={`mic ${store.listening ? 'on' : ''}`}
      onPointerDown={() => void import('./game').then((g) => g.micDown())}
      onPointerUp={() => void import('./game').then((g) => g.micUp(params.model))}
    >
      {store.listening ? 'REC' : 'MIC'}
    </button>
  );
}
