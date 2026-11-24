// TSX port of physician-ui/public/js/booth-faces.js (same path data, translated to JSX: no innerHTML). Line art on a
// 48 grid, stroke in currentColor, aria-hidden: the text next to a face carries the word.
import type { BoothFeedbackMood } from '@/lib/types';

export const MOODS: readonly BoothFeedbackMood[] = ['stressed', 'confused', 'neutral', 'enjoyed', 'excited'];

const Dot = ({ x }: { x: number }) => <circle cx={x} cy="21" r="2" fill="currentColor" stroke="none" />;

function Face({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg className="face" width={size} height={size} viewBox="0 0 48 48" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle className="skin" cx="24" cy="24" r="20" />
      {children}
    </svg>
  );
}

const PARTS: Record<BoothFeedbackMood, React.ReactNode> = {
  stressed: <><path d="M14 18l5 3-5 3M34 18l-5 3 5 3" /><path d="M15 33q2.25-2.5 4.5 0t4.5 0 4.5 0 4.5 0" /></>,
  confused: <><Dot x={17} /><Dot x={31} /><path d="M28 15l6 2.5" /><path d="M17 33q4-3 7-1t7-2" /></>,
  neutral: <><Dot x={17} /><Dot x={31} /><path d="M17 32h14" /></>,
  enjoyed: <><Dot x={17} /><Dot x={31} /><path d="M15 29q9 8 18 0" /></>,
  excited: (
    <>
      <path d="M13 22q4-5 8 0M27 22q4-5 8 0" />
      <path d="M14 28h20q-1.5 10-10 10t-10-10z" fill="currentColor" fillOpacity=".2" />
      <path d="M42 3v6M39 6h6" strokeWidth="2" />
    </>
  ),
};

export function MoodFace({ mood, size = 28 }: { mood: BoothFeedbackMood; size?: number }) {
  return <Face size={size}>{PARTS[mood]}</Face>;
}

/** The slider's one face, its mouth bending from a frown (t = 0) to a smile (t = 1). */
export function ScaleFace({ t, size = 28 }: { t: number; size?: number }) {
  const c = -8 + 16 * t;
  const end = 31 - c * 0.25;
  return (
    <Face size={size}>
      {t >= 0.95 ? <path d="M13 22q4-5 8 0M27 22q4-5 8 0" /> : <><Dot x={17} /><Dot x={31} /></>}
      {t <= 0.1 && <path d="M12 17.5l7-3M36 17.5l-7-3" />}
      {t >= 0.7 && (
        <>
          <circle cx="12.5" cy="28" r="3" fill="currentColor" fillOpacity=".18" stroke="none" />
          <circle cx="35.5" cy="28" r="3" fill="currentColor" fillOpacity=".18" stroke="none" />
        </>
      )}
      <path d={`M15 ${end} Q24 ${31 + c} 33 ${end}`} />
    </Face>
  );
}
