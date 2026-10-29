import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAIDrafting } from '../../src/hooks/useAIDrafting.js';
import { AIDraftPanel, AIDraftScope } from '../../src/components/AIDraftPanel.jsx';
import { Field } from '../../src/components/Field.jsx';

const empty = { title: 'Delivery route optimisation', businessContext: '', summary: '', currentApproach: '', currentLimitations: '', expectedOutcome: '', successCriteria: '', dataAvailability: '', categories: [], amount: '120', currency: 'USDT', expiryDays: 30 };
const output = { message: 'Here is an editable first draft.', suggestions: { summary: 'A proposed route optimisation study.', categories: ['optimisation'] }, suggestedTags: ['Optimisation'], usage: { remainingToday: 19 } };
afterEach(() => { cleanup(); vi.useRealTimers(); });
function Workspace({ services, disabled = false, kind = 'problem', initial = {} }) {
  const [form, setForm] = useState({ ...empty, ...initial });
  const assistant = useAIDrafting({ kind, form, setForm, services, disabled });
  return <><AIDraftScope assistant={assistant}><form><Field htmlFor="title" label="Title">{({id}) => <input id={id} value={form.title} onChange={event => setForm(previous => ({ ...previous, title: event.target.value }))}/>}</Field><Field htmlFor="summary" label="Summary">{({id}) => <textarea id={id} value={form.summary} onChange={event => setForm(previous => ({ ...previous, summary: event.target.value }))}/>}</Field><output data-testid="form">{JSON.stringify(form)}</output></form></AIDraftScope><AIDraftPanel assistant={assistant}/></>;
}
function launch() { fireEvent.click(screen.getByRole('button', { name: 'Draft with AI' })); }
function generate() { fireEvent.click(screen.getByRole('button', { name: 'Generate from title' })); }
it('reviews suggestions before filling only empty fields and never generates payment fields', async () => {
  const services = { generate: vi.fn(async () => output), similar: vi.fn() };
  render(<Workspace services={services}/>); launch(); generate();
  await screen.findByRole('region', { name: 'Suggested fields' });
  expect(screen.getByLabelText('Summary').value).toBe('');
  expect(services.generate.mock.calls[0][0].requestedFields).not.toContain('amount');
  expect(services.generate.mock.calls[0][0].fields).not.toHaveProperty('currency');
  fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
  expect(screen.getByLabelText('Summary').value).toBe(output.suggestions.summary);
  const state = JSON.parse(screen.getByTestId('form').textContent);
  expect(state).toMatchObject({ aiAssisted: true, amount: '120', currency: 'USDT', expiryDays: 30, categories: ['optimisation'] });
  expect(screen.getByText(/AI draft · review/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'My own revised text' } });
  await waitFor(() => expect(screen.queryByText(/AI draft · review/)).toBeNull());
});
it('keeps author text written during a request and when suggestions are discarded', async () => {
  let resolve; const services = { generate: vi.fn(() => new Promise(done => {resolve=done;})), similar: vi.fn() };
  render(<Workspace services={services}/>); launch(); generate();
  fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Written while waiting' } });
  await act(async () => resolve(output));
  fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
  expect(screen.getByLabelText('Summary').value).toBe('Written while waiting');
  fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));
  expect(screen.getByLabelText('Summary').value).toBe('Written while waiting');
});
it('regenerates and clears a single untouched AI field without touching other fields', async () => {
  const services = { generate: vi.fn().mockResolvedValueOnce(output).mockResolvedValueOnce({ ...output, suggestions: { summary: 'A revised suggestion.' } }), similar: vi.fn() };
  render(<Workspace services={services}/>); launch(); generate(); await screen.findByText('Here is an editable first draft.');
  fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(services.generate).toHaveBeenCalledTimes(2));
  expect(services.generate.mock.calls[1][0].requestedFields).toEqual(['summary']);
  const suggested = await screen.findByRole('region', { name: 'Suggested fields' });
  expect(screen.getByLabelText('Summary').value).toBe(output.suggestions.summary);
  expect(screen.getByText(/Replacement ready for Problem description.*current text is unchanged.*Accept replacement/)).toBeTruthy();
  expect(within(suggested).getByText(/Replacement suggestion · not applied/)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close AI drafting panel' }));
  expect(screen.getByText(/Replacement ready · not applied/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review replacement' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Fields (1)' }).getAttribute('aria-selected')).toBe('true'));
  expect(services.generate).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Accept replacement' }));
  expect(screen.getByLabelText('Summary').value).toBe('A revised suggestion.');
  expect(screen.queryByRole('button', { name: 'Review replacement' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  const state=JSON.parse(screen.getByTestId('form').textContent);
  expect(state.summary).toBe(''); expect(state.categories).toEqual(['optimisation']);
});
it('preserves the typed prompt and form when generation fails', async () => {
  const services={generate:vi.fn().mockRejectedValue({code:'functions/resource-exhausted',message:'You have used today’s 20 AI requests.'}),similar:vi.fn()};
  render(<Workspace services={services} initial={{summary:'My original'}}/>);launch();
  fireEvent.change(screen.getByLabelText('Tell the assistant more'),{target:{value:'Keep this prompt for retry'}});
  fireEvent.click(screen.getByRole('button',{name:'Send'}));
  await screen.findByRole('alert'); expect(screen.getByLabelText('Tell the assistant more').value).toBe('Keep this prompt for retry'); expect(screen.getByLabelText('Summary').value).toBe('My original');
});
it('keeps the original field and removes a stale alternative when regeneration yields no suggestion', async () => {
  const services = { generate: vi.fn().mockResolvedValueOnce(output)
    .mockResolvedValueOnce({ ...output, suggestions: { summary: 'An earlier alternative.' } })
    .mockResolvedValueOnce({ ...output, message: 'Quantity-bearing text was withheld. Enter quantities yourself.', suggestions: {} }), similar: vi.fn() };
  render(<Workspace services={services}/>); launch(); generate();
  await screen.findByRole('region', { name: 'Suggested fields' });
  fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await screen.findByText(/Replacement ready for Problem description/);
  fireEvent.click(within(screen.getByRole('region', { name: 'Suggested fields' })).getByRole('button', { name: 'Regenerate' }));
  await screen.findByText(/No replacement was generated for Problem description/);
  expect(screen.queryByRole('region', { name: 'Suggested fields' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review replacement' })).toBeNull();
  expect(screen.getByLabelText('Summary').value).toBe(output.suggestions.summary);
  expect(services.generate).toHaveBeenCalledTimes(3);
});
it('explains the pending replacement and preserves the field if regeneration fails', async () => {
  let reject;
  const services = { generate: vi.fn().mockResolvedValueOnce(output).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })), similar: vi.fn() };
  render(<Workspace services={services}/>); launch(); generate();
  await screen.findByRole('region', { name: 'Suggested fields' });
  fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  expect(screen.getByText(/Generating a new suggestion for Problem description.*until you accept it/)).toBeTruthy();
  expect(screen.getByLabelText('Summary').value).toBe(output.suggestions.summary);
  await act(async () => reject({ code: 'functions/unavailable' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/Generating a new suggestion for Problem description/)).toBeNull();
  expect(screen.getByLabelText('Summary').value).toBe(output.suggestions.summary);
});
it('does not accept a stale result after the title changes and hides AI on published edits', async () => {
  let resolve; const services={generate:()=>new Promise(done=>{resolve=done;}),similar:vi.fn()};
  const view=render(<Workspace services={services}/>);launch();generate();
  fireEvent.change(screen.getByLabelText('Title'),{target:{value:'A completely different problem'}});
  await act(async()=>resolve(output)); expect(screen.queryByRole('region',{name:'Suggested fields'})).toBeNull(); expect(screen.getByText(/title changed while AI/)).toBeTruthy();
  view.rerender(<Workspace services={services} disabled/>); expect(screen.queryByRole('button',{name:'Draft with AI'})).toBeNull();
});
it('shows debounced permission-filtered matches without a generation request', async () => {
  vi.useFakeTimers(); const services={generate:vi.fn(),similar:vi.fn(async()=>({items:[{id:'p1',title:'Hybrid route planning',summary:'A published research proposal.',route:'proposal/p1',reason:'Related terms: routing, delivery'}],truncated:true}))};
  render(<Workspace kind="independent" services={services}/>);
  await act(async()=>{vi.advanceTimersByTime(1200);});
  expect(screen.getByRole('link',{name:/Hybrid route planning/}).getAttribute('href')).toBe('#/proposal/p1'); expect(services.generate).not.toHaveBeenCalled();
  expect(screen.getByText(/not the full collection/)).toBeTruthy();
});
