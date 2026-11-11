import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Flag,
  FlagsProvider,
  type TransmitLike,
  useFlag,
  useFlagEnabled,
  useFlagsRealtime,
} from './index.js';

afterEach(cleanup);

function Probe() {
  const limit = useFlag('max_items' as never, 10 as never) as number;
  const enabled = useFlagEnabled('new_player' as never);
  return (
    <p>
      {String(limit)}|{String(enabled)}
    </p>
  );
}

function Live(props: { transmit: TransmitLike; onChange: (version: string) => void }) {
  useFlagsRealtime(props);
  return null;
}

describe('flags-react', () => {
  it('reads values, with the fallback for flags the server did not send', () => {
    render(
      <FlagsProvider values={{ new_player: true }}>
        <Probe />
      </FlagsProvider>,
    );
    expect(screen.getByText('10|true')).toBeTruthy();
  });

  it('renders <Flag> by boolean or by variant', () => {
    render(
      <FlagsProvider values={{ new_player: false, checkout: 'one_page' }}>
        <Flag name={'new_player' as never} fallback={<span>old</span>}>
          <span>new</span>
        </Flag>
        <Flag name={'checkout' as never} is={['one_page', 'two_page']}>
          <span>one page</span>
        </Flag>
      </FlagsProvider>,
    );
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.queryByText('new')).toBeNull();
    expect(screen.getByText('one page')).toBeTruthy();
  });

  it('throws outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/FlagsProvider/);
  });

  it('calls onChange when the server broadcasts a new ruleset version', async () => {
    let handler: ((message: { version: string }) => void) | undefined;
    const deleted = vi.fn();
    const transmit: TransmitLike = {
      subscription: () => ({
        create: async () => {},
        onMessage: (fn) => {
          handler = fn as never;
          return () => {
            handler = undefined;
          };
        },
        delete: async () => deleted(),
      }),
    };
    const onChange = vi.fn();
    const view = render(<Live transmit={transmit} onChange={onChange} />);
    await act(async () => {});
    handler?.({ version: '7' });
    expect(onChange).toHaveBeenCalledWith('7');
    view.unmount();
    expect(handler).toBeUndefined();
    expect(deleted).toHaveBeenCalled();
  });
});
