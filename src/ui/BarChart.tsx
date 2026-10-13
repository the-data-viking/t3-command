export function BarChart({ points, label, color = "var(--chart-neutral)", ceiling }: {
  points: Array<{ label: string; value: number; detail: string }>;
  label: string; color?: string; ceiling?: number;
}) {
  const max = Math.max(ceiling ?? 0, ...points.map((p) => p.value), 1);
  const width = 320, height = 100, plot = 70;
  const cell = width / Math.max(points.length, 1);
  const gap = Math.min(3, cell * 0.1);
  return (
    <svg className="tele-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}. ${points.map((p) => p.detail).join(". ")}`}>
      <title>{label}</title>
      <line x1="0" x2={width} y1={plot} y2={plot} stroke="var(--muted)" opacity="0.35" />
      {points.map((p, i) => (
        <g key={`${p.label}-${i}`}>
          <rect x={i * cell + gap} y={plot - p.value / max * (plot - 5)} width={cell - gap * 2} height={p.value / max * (plot - 5)} fill={color}><title>{p.detail}</title></rect>
          {(points.length <= 7 || i === 0 || i === points.length - 1) && <text x={points.length <= 7 ? i * cell + cell / 2 : i === 0 ? 0 : width} y={height - 9} textAnchor={points.length <= 7 ? "middle" : i === 0 ? "start" : "end"} fill="var(--muted)" fontSize="9">{p.label}</text>}
        </g>
      ))}
    </svg>
  );
}
