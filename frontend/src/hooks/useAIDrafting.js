import { useEffect, useRef, useState } from 'react';
import { AI_FIELD_CONFIG, isEmptyAIField } from '../../../firebase/functions/aiDraftSchema.js';
import { aiErrorMessage, findSimilarProposals, generateAIDraft } from '../lib/aiDrafts.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emptyValue = field => field.type === 'categories' ? [] : '';
const defaults = { generate: generateAIDraft, similar: findSimilarProposals };

export function useAIDrafting({ kind, form, setForm, problemId, recordId, disabled = false, includeFraming = false, services = defaults }) {
  const config = (AI_FIELD_CONFIG[kind] || []).filter(field => includeFraming || !['proposedProblem', 'relevance', 'thesisFit'].includes(field.key));
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [suggestions, setSuggestions] = useState({});
  const [accepted, setAccepted] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tags, setTags] = useState([]);
  const [usage, setUsage] = useState(null);
  const sampleSource = import.meta.env.DEV && import.meta.env.VITE_AI_PREVIEW === 'true' ? 'sample' : '';
  const [source, setSource] = useState(sampleSource);
  const [similar, setSimilar] = useState({ items: [], status: 'idle', truncated: false });
  const current = useRef({ form, disabled }); current.current = { form, disabled };
  const alive = useRef(true), generation = useRef(0), lock = useRef(false), bases = useRef({});
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current; }; }, []);
  useEffect(() => {
    ++generation.current; lock.current = false; setBusy(false); setMessages([]); setSuggestions({}); setAccepted({}); setError(''); setOpen(false); setUsage(null); setNotice(''); setSource(sampleSource); setTags([]); bases.current = {}; setSimilar({ items: [], status: 'idle', truncated: false });
  }, [kind, recordId, problemId]);
  useEffect(() => {
    setAccepted(previous => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([key, value]) => same(value, form[key])));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [form]);
  useEffect(() => { if (disabled) { ++generation.current; lock.current = false; setBusy(false); setOpen(false); } }, [disabled]);

  const title = String(form.title || '').trim(), summary = String(form.summary || '').slice(0, 2000), category = form.category || '';
  useEffect(() => { setSuggestions({}); setTags([]); bases.current = {}; }, [title]);
  useEffect(() => {
    if (disabled || !['proposal', 'independent'].includes(kind) || title.length < 8) {
      setSimilar({ items: [], status: 'idle', truncated: false }); return;
    }
    let live = true;
    setSimilar({ items: [], status: 'loading', truncated: false });
    const timer = setTimeout(() => {
      services.similar({ title, summary, category, ...(problemId ? { problemId } : {}), ...(recordId ? { excludeId: recordId } : {}), requestId: crypto.randomUUID() })
        .then(result => { if (live && alive.current) setSimilar({ ...result, status: 'ready' }); })
        .catch(() => { if (live && alive.current) setSimilar({ items: [], status: 'unavailable', truncated: false }); });
    }, 1100);
    return () => { live = false; clearTimeout(timer); };
  }, [title, summary, category, kind, recordId, problemId, disabled, services]);

  const request = async ({ field, prompt } = {}) => {
    if (lock.current || current.current.disabled) return;
    if (title.length < 2) { setError('Enter a title first, then describe what you want to draft.'); setOpen(true); return; }
    const input = current.current.form;
    const requested = field ? [field] : config.filter(item => isEmptyAIField(input[item.key])).map(item => item.key);
    const userMessage = String(prompt || (field ? `Suggest a fresh draft for ${config.find(item => item.key === field)?.label}.` : 'Draft the empty fields from my title and the context I have provided.')).trim();
    if (!userMessage || userMessage.length > 3000) { setError('Keep each message under 3,000 characters.'); return; }
    const history = [...messages, { role: 'user', content: userMessage }];
    if (history.length > 8) { setError('This conversation has reached eight messages. Start a new conversation to continue; your form stays intact.'); return; }
    lock.current = true; setBusy(true); setError(''); setNotice(''); setOpen(true);
    const epoch = ++generation.current;
    const basedOn = Object.fromEntries(requested.map(key => [key, input[key]]));
    setMessages(history);
    try {
      const result = await services.generate({ kind, title, fields: Object.fromEntries(config.map(item => [item.key, input[item.key] ?? emptyValue(item)])), requestedFields: requested, messages: history,
        ...(problemId ? { problemId } : {}), ...(recordId ? { recordId } : {}), requestId: crypto.randomUUID() });
      if (!alive.current || epoch !== generation.current || current.current.disabled) return;
      if (String(current.current.form.title || '').trim() !== title) { setNotice('The title changed while AI was drafting. Generate again to use the updated title.'); return false; }
      for (const key of Object.keys(result.suggestions || {})) bases.current[key] = basedOn[key];
      setSuggestions(previous => ({ ...previous, ...result.suggestions }));
      setMessages([...history, { role: 'assistant', content: result.message }]);
      setTags(result.suggestedTags || []); setUsage(result.usage); setSource(result.source || '');
      if (result.similarProposals && ['proposal', 'independent'].includes(kind)) setSimilar({ ...result.similarProposals, status: result.similarProposals.unavailable ? 'unavailable' : 'ready' });
      if (!Object.keys(result.suggestions || {}).length) setNotice('No fields were filled. Add more context in the conversation or review your existing text.');
      return true;
    } catch (cause) { if (alive.current && epoch === generation.current) setError(aiErrorMessage(cause)); return false; }
    finally { if (epoch === generation.current) { lock.current = false; setBusy(false); } }
  };
  const canAccept = key => !current.current.disabled && (isEmptyAIField(form[key]) || (Object.hasOwn(accepted, key) && same(accepted[key], form[key]) && same(bases.current[key], form[key])));
  const accept = keys => {
    if (current.current.disabled) return;
    const chosen = keys.filter(key => config.some(field => field.key === key) && Object.hasOwn(suggestions, key) && !isEmptyAIField(suggestions[key]) && canAccept(key));
    if (!chosen.length) { setNotice('Your existing text is protected. Clear a field yourself before accepting a suggestion.'); return; }
    const patch = Object.fromEntries(chosen.map(key => [key, suggestions[key]]));
    // Recheck current values inside the updater: typing during a request must win.
    setForm(previous => {
      const safe = Object.fromEntries(Object.entries(patch).filter(([key]) => isEmptyAIField(previous[key]) || (Object.hasOwn(accepted, key) && same(accepted[key], previous[key]) && same(bases.current[key], previous[key]))));
      return Object.keys(safe).length ? { ...previous, ...safe, aiAssisted: true } : previous;
    });
    setAccepted(previous => ({ ...previous, ...patch }));
    setSuggestions(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !chosen.includes(key))));
    setNotice(`${chosen.length} ${chosen.length === 1 ? 'field added' : 'fields added'}. Review the draft before saving or publishing.`);
  };
  const clear = key => {
    if (current.current.disabled) return;
    const field = config.find(item => item.key === key);
    if (field && Object.hasOwn(accepted, key)) setForm(previous => same(previous[key], accepted[key]) ? { ...previous, [key]: emptyValue(field) } : previous);
    setSuggestions(previous => Object.fromEntries(Object.entries(previous).filter(([name]) => name !== key)));
    setAccepted(previous => Object.fromEntries(Object.entries(previous).filter(([name]) => name !== key)));
  };
  const discard = () => {
    for (const key of Object.keys(accepted)) clear(key);
    setSuggestions({}); setTags([]); setNotice('AI suggestions discarded. Text you edited has been kept.');
  };
  return { kind, config, form, open, setOpen, disabled, messages, suggestions, accepted, busy, error, notice, tags, usage, source, similar,
    request, accept, clear, discard, canAccept,
    editSuggestion: (key, value) => setSuggestions(previous => ({ ...previous, [key]: value })),
    resetChat: () => { if (!busy) { setMessages([]); setError(''); setNotice('Conversation cleared. Your form has been kept.'); } },
  };
}
