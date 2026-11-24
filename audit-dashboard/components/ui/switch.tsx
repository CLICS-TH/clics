'use client';
// The dashboard's one on/off switch: the Settings page's rules and the Booth Mode switches. It used to be five
// hand-copied blocks on the overview plus two in BoothCard, each a bare 28px button announced as a toggle button.
//
//   role="switch" + aria-checked   a screen reader says "switch, on", not "toggle button, pressed"
//   a native <button>              Space and Enter toggle it, and it takes focus like any control
//   44px hit area on every pointer the visible track is 28px; the button around it is the target, so the coarse
//                                  pointer floor in globals.css never stretches the track into a 44px pill
//   one solid focus ring           drawn on the track, from --ring (contrast.test.ts pins it)
//   `busy`                         a save is in flight: aria-disabled, never `disabled`. Disabling the control a
//                                  keyboard user just pressed blurs it and drops focus to <body>. The dimming
//                                  skips the focused switch, or its ring would fade with it. A press while busy
//                                  is ignored here, so a second write cannot start before the first lands.
//   `disabled`                     nothing to switch yet (the value is not loaded): not focusable, dimmed
//
// The off track is outlined in --field and its thumb filled with it, so "off" clears the 3:1 non-text bar against
// the page; the old bg-muted track measured about 1.1:1 and read as nothing at all.
import * as React from 'react';
import { cn } from '@/lib/utils';

export type SwitchProps = Omit<React.ComponentProps<'button'>, 'onClick' | 'onChange' | 'type' | 'role' | 'aria-checked' | 'children'> & {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  busy?: boolean;
};

export function Switch({ checked, onCheckedChange, busy = false, disabled, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={busy || undefined}
      disabled={disabled}
      data-slot="switch"
      data-state={checked ? 'on' : 'off'}
      onClick={() => { if (!busy) onCheckedChange(!checked); }}
      className={cn(
        'group/switch inline-flex h-11 w-14 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-disabled:cursor-wait aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex h-7 w-12 items-center rounded-full border-2 transition-colors',
          'group-focus-visible/switch:outline-2 group-focus-visible/switch:outline-offset-2 group-focus-visible/switch:outline-ring',
          checked ? 'border-primary bg-primary' : 'border-field bg-background',
        )}
      >
        <span
          className={cn(
            'block size-5 rounded-full transition-transform',
            checked ? 'translate-x-5.5 bg-primary-foreground' : 'translate-x-0.5 bg-field',
          )}
        />
      </span>
    </button>
  );
}
