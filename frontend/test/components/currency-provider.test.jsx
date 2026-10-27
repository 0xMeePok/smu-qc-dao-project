import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CurrencyProvider } from '../../src/context/CurrencyProvider.jsx';
import { CurrencyToggle } from '../../src/components/CurrencyToggle.jsx';
import { CurrencyAmount } from '../../src/components/CurrencyAmount.jsx';
const session = vi.hoisted(() => ({address:'member-a',profile:{localCurrency:'SGD',showLocalCurrency:false}}));
vi.mock('../../src/context/SessionContext.jsx', () => ({useSession:()=>session}));
afterEach(() => { cleanup(); vi.useRealTimers(); session.address='member-a'; session.profile={localCurrency:'SGD',showLocalCurrency:false}; });
function response(currency) { const now=Date.now(); return {source:'Google Finance',localCurrency:currency,fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString(),rates:currency==='EUR'?{USD:0.9,SGD:0.7}:{USD:1.3,SGD:1}}; }
function chooseCurrency(value) { fireEvent.click(screen.getByRole('combobox', { name: 'Display currency' })); fireEvent.click(screen.getByRole('option', { name: value })); }
const tree=lookup=><CurrencyProvider lookup={lookup}><CurrencyToggle/><CurrencyAmount amount="10" currency="USDC"/></CurrencyProvider>;
it('toggles estimates, switches currencies, and observes saved profile and account changes', async()=>{
 const lookup=vi.fn(async currency=>response(currency)); const view=render(tree(lookup));
 expect(lookup).not.toHaveBeenCalled(); expect(screen.getByText('USDC 10')).toBeTruthy();
 chooseCurrency('SGD');
 await waitFor(()=>expect(screen.getByText(/≈ SGD/)).toBeTruthy());
 chooseCurrency('EUR');
 await waitFor(()=>expect(screen.getByText(/≈ EUR/)).toBeTruthy());
 session.profile={localCurrency:'SGD',showLocalCurrency:true}; view.rerender(tree(lookup));
 await waitFor(()=>expect(screen.getByText(/≈ SGD/)).toBeTruthy());
 session.address='member-b'; session.profile={localCurrency:'EUR',showLocalCurrency:false}; view.rerender(tree(lookup));
 expect(screen.queryByText(/≈/)).toBeNull(); expect(screen.getByText('USDC 10')).toBeTruthy();
});
it('does not block amounts on lookup failure or malformed responses', async()=>{
 const lookup=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({});
 render(tree(lookup)); chooseCurrency('SGD');
 await waitFor(()=>expect(screen.getByText('FX unavailable · showing tokens')).toBeTruthy());
 expect(screen.getByText('USDC 10')).toBeTruthy();
 chooseCurrency('EUR');
 await waitFor(()=>expect(lookup).toHaveBeenCalledTimes(2));
 await waitFor(()=>expect(screen.getByText('FX unavailable · showing tokens')).toBeTruthy());
});
it('expires an estimate and keeps tokens if the refresh fails', async()=>{
 vi.useFakeTimers(); session.profile.showLocalCurrency=true;
 const lookup=vi.fn().mockImplementationOnce(async currency=>response(currency)).mockRejectedValue(Error('offline'));
 render(tree(lookup)); await act(async()=>{});
 expect(screen.getByText(/≈ SGD/)).toBeTruthy();
 await act(async()=>{vi.advanceTimersByTime(900001);});
 expect(screen.queryByText(/≈/)).toBeNull(); expect(screen.getByText('USDC 10')).toBeTruthy();
 expect(screen.getByText('FX unavailable · showing tokens')).toBeTruthy();
});
