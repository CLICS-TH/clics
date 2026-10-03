// The design-a11y primitives: StateMessage (roles), AiOutput (AI label), the hardened Table, the
// --field Input family, Badge tones, and Modal (focus handling). These are the contracts the pages
// rely on; a regression here is silent in the browser (a <p> that should be a live region, a table
// that scrolls but cannot be reached by keyboard).
import { fireEvent, render, screen } from '@testing-library/react';
import { StateMessage, RETRY_LABEL } from '@/components/ui/state-message';
import { AiOutput } from '@/components/ui/ai-output';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { AI_LABEL } from '@/lib/ai-label';

describe('StateMessage', () => {
  it.each([
    ['loading', 'status'],
    ['empty', 'status'],
    ['error', 'alert'],
    ['locked', 'status'],
    ['notice', 'status'],
  ] as const)('%s is announced as role=%s', (kind, role) => {
    render(<StateMessage kind={kind} title="ข้อความ / Message" />);
    expect(screen.getByRole(role)).toHaveTextContent('ข้อความ / Message');
  });

  it('error offers Retry in its own contrast-safe colour, and calls back', () => {
    const retry = jest.fn();
    render(<StateMessage kind="error" title="โหลดไม่สำเร็จ" onRetry={retry}>รายละเอียด</StateMessage>);
    const btn = screen.getByRole('button', { name: RETRY_LABEL });
    expect(btn).toHaveClass('text-error-text');       // not text-primary (3.11:1)
    fireEvent.click(btn);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('รายละเอียด')).toBeInTheDocument();
  });

  it('a non-error Retry uses the link token and a custom label', () => {
    render(<StateMessage kind="notice" title="t" onRetry={() => {}} retryLabel="อีกครั้ง" />);
    expect(screen.getByRole('button', { name: 'อีกครั้ง' })).toHaveClass('text-link');
  });

  it('locked renders a real heading when asked, with a reason — withheld is not empty', () => {
    render(<StateMessage kind="locked" heading="h2" title="ปิดไว้ / Locked">เพราะรอบสอบเทียบ</StateMessage>);
    expect(screen.getByRole('heading', { level: 2, name: 'ปิดไว้ / Locked' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('เพราะรอบสอบเทียบ');
  });

  it('loading and empty are plain muted lines with no box, and centre on request', () => {
    const { rerender } = render(<StateMessage kind="loading" title="…" center />);
    expect(screen.getByRole('status')).toHaveClass('text-muted-foreground', 'text-center');
    expect(screen.getByRole('status')).not.toHaveClass('border');
    rerender(<StateMessage kind="empty" title="ว่าง" />);
    expect(screen.getByRole('status')).not.toHaveClass('text-center');
  });

  it('forwards aria-describedby so a locked control can point at its reason', () => {
    render(<StateMessage kind="locked" title="t" aria-describedby="why" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-describedby', 'why');
  });
});

describe('AiOutput', () => {
  it('is a group named by a VISIBLE label (colour is never the only signal)', () => {
    render(<AiOutput><p>reply</p></AiOutput>);
    const g = screen.getByRole('group', { name: AI_LABEL.chip });
    expect(g).toHaveTextContent(AI_LABEL.chip);
    expect(g).toHaveTextContent('reply');
    expect(g).toHaveClass('bg-ai-bg', 'border-ai-border', 'text-ai-text');
  });

  it('takes a custom label and a block / bubble variant', () => {
    const { rerender } = render(<AiOutput label={AI_LABEL.score} variant="block">x</AiOutput>);
    expect(screen.getByRole('group', { name: AI_LABEL.score })).toHaveAttribute('data-variant', 'block');
    rerender(<AiOutput variant="bubble">x</AiOutput>);
    expect(screen.getByRole('group')).toHaveAttribute('data-variant', 'bubble');
  });
});

describe('AI_LABEL (approved by the product owner 2026-10-03)', () => {
  it('carries the approved wording and no governance claim', () => {
    expect(AI_LABEL.chip).toBe('AI');
    expect(AI_LABEL.score).toBe('คะแนนจาก AI / AI score');
    // "the AI does not score / is not a verdict" is false for CLICS — keep it out of the label.
    expect(JSON.stringify(AI_LABEL)).not.toMatch(/ไม่ให้คะแนน|ไม่ตัดสิน|ไม่ใช่การตัดสิน|not a verdict|does not score/i);
  });
});

describe('Table', () => {
  function Sample() {
    return (
      <Table label="ตัวอย่าง / Sample">
        <TableHeader>
          <TableRow>
            <TableHead>ชื่อ</TableHead>
            <TableHead num>฿</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableHead scope="row">แถว 1</TableHead>
            <TableCell num>12</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  it('the scroll container is a labelled, keyboard-focusable region', () => {
    render(<Sample />);
    const region = screen.getByRole('region', { name: 'ตัวอย่าง / Sample' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('overflow-x-auto');
  });

  it('header cells default to scope=col and accept scope=row', () => {
    render(<Sample />);
    expect(screen.getByRole('columnheader', { name: 'ชื่อ' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('rowheader', { name: 'แถว 1' })).toHaveAttribute('scope', 'row');
  });

  it('numeric cells are right-aligned tabular figures; text cells are not', () => {
    render(<Sample />);
    expect(screen.getByRole('columnheader', { name: '฿' })).toHaveClass('text-right', 'tabular-nums');
    expect(screen.getByRole('cell', { name: '12' })).toHaveClass('text-right', 'tabular-nums');
    expect(screen.getByRole('columnheader', { name: 'ชื่อ' })).toHaveClass('text-left');
  });

  it('does not force nowrap on bilingual cells', () => {
    render(<Sample />);
    expect(screen.getByRole('cell', { name: '12' })).not.toHaveClass('whitespace-nowrap');
    expect(screen.getByRole('columnheader', { name: 'ชื่อ' })).not.toHaveClass('whitespace-nowrap');
  });
});

describe('Input family on --field', () => {
  it('draws its edge with the 3:1 --field token, never the decorative --border', () => {
    render(<><Input aria-label="a" /><Textarea aria-label="b" /><Select aria-label="c"><option>x</option></Select></>);
    for (const name of ['a', 'b', 'c']) {
      const el = screen.getByLabelText(name);
      expect(el).toHaveClass('border', 'border-field');
      expect(el).not.toHaveClass('border-border');
    }
  });

  it('keeps one border width in every state (focus is the global outline, not a border change)', () => {
    render(<Input aria-label="a" />);
    const cls = screen.getByLabelText('a').className;
    expect(cls).not.toMatch(/focus[^ ]*border-(2|4|8)|focus[^ ]*:border-w/);
  });

  it('is typed text by default and passes props through', () => {
    render(<Input aria-label="a" type="number" min={0} />);
    expect(screen.getByLabelText('a')).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText('a')).toHaveAttribute('min', '0');
  });

  it('Checkbox is a native checkbox on the button-fill accent', () => {
    render(<Checkbox aria-label="ok" />);
    const box = screen.getByRole('checkbox', { name: 'ok' });
    expect(box).toHaveClass('accent-coral-active');
  });
});

describe('Badge tones', () => {
  it.each([
    ['notice', 'bg-notice-bg', 'text-notice-text'],
    ['ok', 'bg-chart-pass-bg', 'text-chart-pass-text'],
    ['error', 'bg-error-bg', 'text-error-text'],
    ['ai', 'bg-ai-bg', 'text-ai-text'],
  ] as const)('%s uses its token pair', (variant, bg, text) => {
    render(<Badge variant={variant}>สถานะ</Badge>);
    expect(screen.getByText('สถานะ')).toHaveClass(bg, text);
  });

  it('the link variant is text-link (bright coral fails 3:1 as small text)', () => {
    render(<Badge variant="link">l</Badge>);
    expect(screen.getByText('l')).toHaveClass('text-link');
    expect(screen.getByText('l')).not.toHaveClass('text-primary');
  });
});

describe('Modal', () => {
  it('is a named modal dialog, focuses in, closes on Escape, and returns focus', () => {
    const onClose = jest.fn();
    function Host({ open }: { open: boolean }) {
      return <><button>opener</button>{open && <Modal title="ความยินยอม / Consent" onClose={onClose}><input aria-label="field" /></Modal>}</>;
    }
    const { rerender } = render(<Host open={false} />);
    const opener = screen.getByText('opener');
    opener.focus();
    rerender(<Host open />);
    expect(screen.getByRole('dialog', { name: 'ความยินยอม / Consent' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('field')).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Host open={false} />);
    expect(opener).toHaveFocus();
  });

  it('a backdrop click does not dismiss a form', () => {
    const onClose = jest.fn();
    render(<Modal title="t" onClose={onClose}><button>b</button></Modal>);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab inside', () => {
    render(<Modal title="t" onClose={() => {}}><button>one</button><button>two</button></Modal>);
    screen.getByText('two').focus();
    fireEvent.keyDown(screen.getByText('two'), { key: 'Tab' });
    expect(screen.getByText('one')).toHaveFocus();
  });

  it('a dialog with nothing focusable keeps focus on the panel', () => {
    render(<Modal title="t" onClose={() => {}}>just text</Modal>);
    // The heading is not focusable, so the panel itself takes focus and Tab stays put.
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});
