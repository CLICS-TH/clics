'use client';
import { Slider } from '@/components/ui/slider';

const DOMAINS = [
  { key: 'd1', label: 'Clinical Question Intelligence', weight: '15%' },
  { key: 'd2', label: 'Reasoning Depth', weight: '20%' },
  { key: 'd3', label: 'Contextual Integration', weight: '15%' },
  { key: 'd4', label: 'Iterative Inquiry', weight: '15%' },
  { key: 'd5', label: 'Critical Appraisal', weight: '15%' },
  { key: 'd6', label: 'Reflective Synthesis', weight: '10%' },
  { key: 'd7', label: 'AI Literacy & Prompt Skill', weight: '10%' },
];

interface Props {
  scores: Record<string, number>;
  onChange: (key: string, value: number) => void;
  disabled?: boolean;
}

export function DomainSliders({ scores, onChange, disabled }: Props) {
  return (
    <div className="space-y-5">
      {DOMAINS.map(({ key, label, weight }) => (
        <div key={key}>
          <div className="flex justify-between mb-1">
            <span className="text-sm font-medium">{label}</span>
            <span className="text-sm text-muted-foreground">{weight} · <strong>{scores[key] ?? 0}/5</strong></span>
          </div>
          <Slider min={0} max={5} step={1} value={scores[key] ?? 0}
            aria-label={`${label} (0–5)`}
            onValueChange={(v) => onChange(key, v as number)} disabled={disabled} className="w-full" />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1 px-0.5">
            <span>0 ไม่พบ</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5 ดีเยี่ยม</span>
          </div>
        </div>
      ))}
    </div>
  );
}
