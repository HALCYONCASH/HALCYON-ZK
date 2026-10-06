import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Shell from './components/Shell';
import Home from './pages/Home';
import Coins from './pages/Coins';
import CoinPage from './pages/Coin';
import Launch from './pages/Launch';
import Modules from './pages/Modules';
import Stocks from './pages/Stocks';
import Docs from './pages/Docs';
import Stats from './pages/Stats';
import Me from './pages/Me';

function ScrollTop() { const { pathname, hash } = useLocation(); useEffect(() => { if (hash) { const el = document.getElementById(hash.slice(1)); if (el) { el.scrollIntoView({ block: 'start' }); return; } } window.scrollTo(0, 0); }, [pathname, hash]); return null; }
export default function App() {
  return (
    <BrowserRouter>
      <ScrollTop />
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/coins" element={<Coins />} />
          <Route path="/c/:token" element={<CoinPage />} />
          <Route path="/launch" element={<Launch />} />
          <Route path="/modules" element={<Modules />} />
          <Route path="/stocks" element={<Stocks />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/me" element={<Me />} />
          <Route path="*" element={<main className="wrap page"><div className="empty card">Nothing here.</div></main>} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
