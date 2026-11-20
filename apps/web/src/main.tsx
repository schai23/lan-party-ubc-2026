import { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const PlayPage = lazy(() => import('./play/PlayPage'));
const HelperPage = lazy(() => import('./helper/HelperPage'));

function Home() {
  return (
    <div className="helper-page">
      <h1>Lanternfall · Sidekick</h1>
      <p className="dim">Delay-tolerant game work, moved to helper devices and paid per unit on Solana.</p>
      <div className="buttons">
        <a className="big" href={`/play${window.location.search}`}>Play (host)</a>
        <a className="big secondary" href={`/helper${window.location.search}`}>Help (pair a device)</a>
      </div>
    </div>
  );
}

const path = window.location.pathname.replace(/\/+$/, '') || '/';
const page = path.startsWith('/play') ? <PlayPage /> : path.startsWith('/helper') ? <HelperPage /> : <Home />;
if (path.startsWith('/play')) document.body.classList.add('is-play');

createRoot(document.getElementById('root')!).render(<Suspense fallback={<div className="dim pad">Loading…</div>}>{page}</Suspense>);
