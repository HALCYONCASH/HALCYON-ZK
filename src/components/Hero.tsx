// The scene behind the home page: a sunset sky, outlined clouds that drift, a sun on the horizon and its path on the lake, far mountains,
// grass and reeds at the shore, birds, sparkles. Pure SVG drawn here so it ships with the site and never loads a file; it fills the hero
// (sliced, centred on the sun) and the words sit on top of it.
type CloudSpec = { x: number; y: number; s: number; tone: string; cls?: string };
const CLOUD_BLOBS: [number, number, number, number][] = [[0, 0, 62, 40], [52, -22, 70, 46], [118, -8, 58, 38], [160, 12, 46, 30], [-30, 14, 40, 26], [70, 18, 90, 30]];
function Cloud({ x, y, s, tone, cls }: CloudSpec) {
  const blobs = CLOUD_BLOBS.map(([cx, cy, rx, ry]) => ({ cx: x + cx * s, cy: y + cy * s, rx: rx * s, ry: ry * s }));
  return (
    <g className={`cloud ${cls || ''}`}>
      {blobs.map((b, i) => <ellipse key={`o${i}`} {...b} fill={tone} stroke="#4a5486" strokeWidth={3.4} />)}
      {blobs.map((b, i) => <ellipse key={`f${i}`} {...b} fill={tone} />)}
    </g>
  );
}
function Sparkle({ x, y, s = 1, cls = '' }: { x: number; y: number; s?: number; cls?: string }) {
  return <path className={`twinkle ${cls}`} style={{ transformOrigin: `${x}px ${y}px` }} d={`M ${x} ${y - 9 * s} Q ${x} ${y} ${x + 9 * s} ${y} Q ${x} ${y} ${x} ${y + 9 * s} Q ${x} ${y} ${x - 9 * s} ${y} Q ${x} ${y} ${x} ${y - 9 * s} Z`} fill="#fff" stroke="#4a5486" strokeWidth={1} />;
}
const Bird = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => <path d={`M ${x - 14 * s} ${y} q 7 ${-9 * s} ${14 * s} 0 q 7 ${-9 * s} ${14 * s} 0`} fill="none" stroke="#4a5486" strokeWidth={2} strokeLinecap="round" />;
const Reeds = ({ x, y, flip = false }: { x: number; y: number; flip?: boolean }) => {
  const d = flip ? -1 : 1;
  return <g stroke="#4a5486" strokeWidth={2} strokeLinecap="round" fill="none" transform={`translate(${x} ${y})`}>
    <path d={`M 0 0 q ${6 * d} -44 ${-4 * d} -82`} /><path d={`M ${22 * d} 6 q ${2 * d} -40 ${12 * d} -70`} /><path d={`M ${42 * d} 10 q ${8 * d} -34 ${-2 * d} -64`} /><path d={`M ${-18 * d} 4 q ${-2 * d} -30 ${8 * d} -52`} />
    <path d={`M ${-4 * d} -62 q ${-14 * d} -4 ${-20 * d} -18`} /><path d={`M ${30 * d} -44 q ${12 * d} -6 ${16 * d} -20`} />
  </g>;
};
const HORIZON = 380;

export default function Hero() {
  return (
    <svg className="scene" viewBox="0 0 1600 600" preserveAspectRatio="xMidYMid slice" role="img" aria-label="A calm pastel landscape at sunset: clouds, mountains, a lake with the sun on it, reeds at the shore">
      <defs>
        <linearGradient id="hz-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#cfe2f6" /><stop offset=".38" stopColor="#e4d9f3" /><stop offset=".62" stopColor="#f6d7e4" /><stop offset=".84" stopColor="#fbe2d0" /><stop offset="1" stopColor="#fdebd6" /></linearGradient>
        <linearGradient id="hz-lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a6d6ee" /><stop offset=".6" stopColor="#bfe3f2" /><stop offset="1" stopColor="#d2ecf5" /></linearGradient>
        <radialGradient id="hz-glow" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#fff4d2" stopOpacity=".95" /><stop offset=".45" stopColor="#ffe9d2" stopOpacity=".5" /><stop offset="1" stopColor="#ffe9d2" stopOpacity="0" /></radialGradient>
        <linearGradient id="hz-path" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff3d4" stopOpacity=".9" /><stop offset="1" stopColor="#fff3d4" stopOpacity="0" /></linearGradient>
        <linearGradient id="hz-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#dcd6f5" /><stop offset="1" stopColor="#c5bfec" /></linearGradient>
        <linearGradient id="hz-mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d6efdf" /><stop offset="1" stopColor="#b9e1cb" /></linearGradient>
        <linearGradient id="hz-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#dff2d2" /><stop offset="1" stopColor="#c3e3b4" /></linearGradient>
      </defs>
      <rect width="1600" height="600" fill="url(#hz-sky)" />
      <circle cx="800" cy={HORIZON} r="230" fill="url(#hz-glow)" />
      <Cloud x={120} y={116} s={0.85} tone="#fdf3e2" cls="slow" />
      <Cloud x={330} y={196} s={0.52} tone="#f7f1fb" cls="fast" />
      <Cloud x={520} y={66} s={0.42} tone="#fbeff5" />
      <Cloud x={1010} y={58} s={0.38} tone="#f7f1fb" cls="fast" />
      <Cloud x={1170} y={108} s={0.92} tone="#fdf3e2" cls="slow" />
      <Cloud x={1370} y={236} s={0.58} tone="#fbeff5" />
      <Bird x={400} y={206} /><Bird x={442} y={190} s={0.75} /><Bird x={1232} y={176} /><Bird x={1272} y={164} s={0.7} />
      <Sparkle x={222} y={62} /><Sparkle x={474} y={142} s={0.7} cls="d1" /><Sparkle x={1120} y={152} s={0.8} cls="d2" /><Sparkle x={1414} y={82} s={0.6} cls="d3" /><Sparkle x={1504} y={172} s={0.7} cls="d1" /><Sparkle x={92} y={204} s={0.6} cls="d2" /><Sparkle x={690} y={236} s={0.5} cls="d3" /><Sparkle x={920} y={248} s={0.5} cls="d1" />
      <circle cx="800" cy={HORIZON} r="68" fill="#fff5d8" />
      <path d="M 0 380 L 0 308 C 90 258 170 230 260 248 C 330 262 380 308 450 326 C 520 344 580 362 640 380 Z" fill="url(#hz-far)" stroke="#4a5486" strokeWidth={2.2} strokeLinejoin="round" />
      <path d="M 1600 380 L 1600 298 C 1500 244 1420 222 1330 244 C 1260 260 1220 304 1150 326 C 1080 346 1020 364 960 380 Z" fill="url(#hz-far)" stroke="#4a5486" strokeWidth={2.2} strokeLinejoin="round" />
      <path d="M 0 380 L 0 340 C 100 310 200 306 300 332 C 380 352 440 372 520 380 Z" fill="url(#hz-mid)" stroke="#4a5486" strokeWidth={2.2} strokeLinejoin="round" />
      <path d="M 1600 380 L 1600 334 C 1500 306 1410 310 1310 336 C 1230 356 1160 374 1080 380 Z" fill="url(#hz-mid)" stroke="#4a5486" strokeWidth={2.2} strokeLinejoin="round" />
      <rect x="0" y={HORIZON} width="1600" height={600 - HORIZON} fill="url(#hz-lake)" />
      <rect x="690" y={HORIZON} width="220" height="220" fill="url(#hz-path)" opacity=".55" />
      <g className="shimmer" fill="#fff3d4">
        <ellipse cx="800" cy="400" rx="62" ry="7" opacity=".9" /><ellipse cx="800" cy="422" rx="54" ry="7" opacity=".8" /><ellipse cx="800" cy="446" rx="46" ry="7" opacity=".7" /><ellipse cx="800" cy="472" rx="38" ry="7" opacity=".6" /><ellipse cx="800" cy="500" rx="31" ry="7" opacity=".5" /><ellipse cx="800" cy="530" rx="24" ry="7" opacity=".4" /><ellipse cx="800" cy="560" rx="18" ry="7" opacity=".3" /><ellipse cx="800" cy="588" rx="12" ry="6" opacity=".2" />
      </g>
      <path d="M 0 380 C 300 376 700 384 1600 379" fill="none" stroke="#4a5486" strokeWidth={2} />
      <g stroke="#ffffff" strokeWidth={2} opacity=".7" strokeLinecap="round" fill="none"><path d="M 200 428 q 30 -6 60 0" /><path d="M 290 470 q 40 -6 80 0" /><path d="M 560 448 q 30 -5 60 0" /><path d="M 1010 464 q 50 -7 100 0" /><path d="M 1250 508 q 40 -6 80 0" /><path d="M 1380 436 q 30 -5 60 0" /><path d="M 460 528 q 40 -6 80 0" /><path d="M 1120 548 q 30 -5 60 0" /></g>
      <path d="M 0 600 L 0 502 C 80 488 180 502 280 542 C 340 566 400 592 440 600 Z" fill="url(#hz-near)" stroke="#4a5486" strokeWidth={2.2} strokeLinejoin="round" />
      <path d="M 1600 600 L 1600 508 C 1520 492 1420 502 1320 538 C 1260 562 1200 590 1160 600 Z" fill="url(#hz-near)" stroke="#4a5486" strokeWidth={2.2} strokeLinejoin="round" />
      <Reeds x={96} y={520} /><Reeds x={1494} y={528} flip />
    </svg>
  );
}
