import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { AI_POSTING_CATEGORIES, AI_PROPOSAL_CATEGORIES } from '../../../firebase/functions/aiDraftSchema.js';
import { Modal } from './Modal.jsx';

const AIDraftContext = createContext(null);
export function AIDraftScope({ assistant, children }) { return <AIDraftContext.Provider value={assistant}>{children}</AIDraftContext.Provider>; }
const fieldName = id => String(id || '').replace(/^(proposal|independent)-/, '');
function SparkIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z" /></svg>; }
export function AIDraftLaunch() {
  const assistant = useContext(AIDraftContext);
  if (!assistant || assistant.disabled) return null;
  return <button type="button" className="ai-draft-launch" aria-expanded={assistant.open} onClick={() => assistant.setOpen(!assistant.open)}><SparkIcon />Draft with AI</button>;
}
export function AIDraftFieldTools({ field }) {
  const assistant = useContext(AIDraftContext), key = fieldName(field);
  if (!assistant || assistant.disabled) return null;
  if (key === 'title') return <><AIDraftLaunch />{!assistant.open && <SimilarProposals compact result={assistant.similar} />}</>;
  if (!Object.hasOwn(assistant.accepted, key)) return null;
  return <div className="ai-field-tools"><span><SparkIcon />AI draft · review before publishing</span><button type="button" disabled={assistant.busy} onClick={() => assistant.request({ field: key })}>Regenerate</button><button type="button" disabled={assistant.busy} onClick={() => assistant.clear(key)}>Clear</button></div>;
}

export function SimilarProposals({ result, compact = false }) {
  if (!result || result.status === 'idle') return null;
  return <section className={`ai-similar${compact ? ' ai-similar-compact' : ''}`} aria-label="Similar proposals">
    <h3>Similar proposals</h3>
    {result.status === 'loading' ? <p role="status">Checking related proposals…</p>
      : result.status === 'unavailable' ? <p>Similarity check unavailable. You can continue writing; this does not mean there are no matches.</p>
        : <>
          {result.items?.length ? <><p>Related work to review as you shape your proposal.</p><ul>{result.items.map(item => <li key={item.id}><a href={`#/${item.route || `proposal/${item.id}`}`} target="_blank" rel="noreferrer">{item.title}<span aria-hidden="true"> ↗</span></a><p>{item.reason}</p><p className="ai-similar-excerpt">{item.summary}</p></li>)}</ul></>
            : <p>No close matches found in the searched proposals.</p>}
          <small>{result.truncated ? 'Search covers recent and related proposals, not the full collection. ' : ''}Matches are advisory and include only proposals you can view.</small>
        </>}
  </section>;
}
function Suggestion({ field, assistant }) {
  const id = useId(), value = assistant.suggestions[field.key];
  const choices = field.type === 'categories' ? AI_POSTING_CATEGORIES : AI_PROPOSAL_CATEGORIES;
  return <article className="ai-suggestion">
    <label htmlFor={id}>{field.label}</label>
    {field.type === 'text' ? <textarea disabled={assistant.busy} id={id} rows={4} maxLength={field.maxLength} value={value} onChange={event => assistant.editSuggestion(field.key, event.target.value)} />
      : field.type === 'categories' ? <div id={id} className="ai-category-choices" role="group" aria-label={field.label}>{choices.map(choice => <label key={choice.value}><input type="checkbox" disabled={assistant.busy} checked={value.includes(choice.value)} onChange={event => assistant.editSuggestion(field.key, event.target.checked ? [...value, choice.value].slice(0,6) : value.filter(item => item !== choice.value))} />{choice.label}</label>)}</div>
        : <select disabled={assistant.busy} id={id} value={value} onChange={event => assistant.editSuggestion(field.key, event.target.value)}>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>}
    <div className="ai-suggestion-actions"><button className="secondary small" type="button" disabled={assistant.busy || !assistant.canAccept(field.key) || (typeof value === 'string' ? !value.trim() : !value.length)} onClick={() => assistant.accept([field.key])}>Accept</button><button type="button" disabled={assistant.busy} onClick={() => assistant.request({ field: field.key })}>Regenerate</button><button type="button" disabled={assistant.busy} onClick={() => assistant.clear(field.key)}>Clear</button></div>
    {!assistant.canAccept(field.key) && <small>Your text is protected. Clear the form field yourself to use this suggestion.</small>}
  </article>;
}
export function AIDraftPanel({ assistant }) {
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches);
  const [input, setInput] = useState('');
  const [tab, setTab] = useState('chat');
  const chat = useRef(null), titleId = useId(), inputId = useId();
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 900px)'), update = () => setMobile(media.matches);
    media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [assistant.messages, assistant.busy]);
  const pendingFields = assistant.config.filter(field => Object.hasOwn(assistant.suggestions, field.key));
  const pendingKey = pendingFields.map(field => field.key).join(',');
  useEffect(() => { if (pendingKey && !assistant.busy) setTab('fields'); }, [pendingKey, assistant.busy]);
  if (!assistant.open || assistant.disabled) return null;
  const submit = async event => { event.preventDefault(); if (!input.trim() || assistant.busy) return; const sent = input; const success = await assistant.request({ prompt: sent }); if (success) setInput(current => current === sent ? '' : current); };
  const navigateTabs = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (Math.max(0, current) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
  };
  const contents = <>
    <header className="ai-panel-header"><div><span className="eyebrow">Writing assistant</span><h2 id={titleId}><SparkIcon />Draft with AI</h2></div><button type="button" className="ai-panel-close" aria-label="Close AI drafting panel" onClick={() => assistant.setOpen(false)}>×</button></header>
    <div className="ai-panel-tabs" role="tablist" aria-label="AI drafting views" onKeyDown={navigateTabs}>
      {[["chat", "Chat"], ["fields", `Fields${pendingFields.length ? ` (${pendingFields.length})` : ""}`], ...(["proposal", "independent"].includes(assistant.kind) ? [["related", `Related${assistant.similar.items?.length ? ` (${assistant.similar.items.length})` : ""}`]] : [])].map(([key, label]) => <button key={key} type="button" role="tab" tabIndex={tab === key ? 0 : -1} id={`${titleId}-${key}`} aria-selected={tab === key} aria-controls={`${titleId}-${key}-panel`} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div className="ai-panel-content">
      {assistant.source === 'sample' && <p className="ai-preview-note">Local preview · sample responses and proposals. OpenAI is not connected.</p>}
      <section role="tabpanel" id={`${titleId}-chat-panel`} aria-labelledby={`${titleId}-chat`} hidden={tab !== "chat"}>
      <p className="ai-panel-intro">Start with your title or describe your idea. Review suggestions before adding them to your form.</p>
      <details className="ai-data-note"><summary>What is shared with AI</summary><p>{assistant.source === "sample" ? "This local preview uses sample replies. In the deployed app, your title, draftable text and conversation are sent to OpenAI when you generate." : "Your title, draftable text and this conversation are sent to OpenAI when you generate."} For proposals, the parent posting and visible related-proposal excerpts are included. Avoid confidential or personal information. Amounts, currency, expiry and team credentials stay yours to enter.</p></details>
      <button type="button" className="primary ai-generate" disabled={assistant.busy || !String(assistant.form.title || '').trim()} onClick={() => assistant.request()}>{assistant.busy ? 'Drafting…' : 'Generate from title'}</button>
      <div className="ai-chat" aria-label="Drafting conversation" role="log" aria-live="polite" ref={chat}>
        {!assistant.messages.length && <p className="ai-chat-empty">“We need a faster way to plan delivery routes. Ask me what you need to know.”</p>}
        {assistant.messages.map((message, index) => <div key={index} className={`ai-message ai-message-${message.role}`}><strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong><p>{message.content}</p></div>)}
        {assistant.busy && <p className="ai-chat-wait" role="status">Preparing suggestions. Your form stays unchanged.</p>}
      </div>
      <form className="ai-chat-composer" onSubmit={submit}>
        <label htmlFor={inputId}>Tell the assistant more</label><textarea id={inputId} value={input} maxLength={3000} rows={3} placeholder="Describe the problem, constraints or outcomes…" onChange={event => setInput(event.target.value)} disabled={assistant.busy} />
        <div><button className="text-button" type="button" disabled={assistant.busy || !assistant.messages.length} onClick={assistant.resetChat}>New conversation</button><button className="secondary small" type="submit" disabled={assistant.busy || !input.trim()}>Send</button></div>
      </form>
      </section>
      {assistant.error && <p className="ai-panel-error" role="alert">{assistant.error}</p>}
      {assistant.notice && <p className="ai-panel-notice" role="status">{assistant.notice}</p>}
      <section role="tabpanel" id={`${titleId}-fields-panel`} aria-labelledby={`${titleId}-fields`} hidden={tab !== "fields"}>
      {!pendingFields.length && <p className="ai-panel-intro">{Object.keys(assistant.accepted).length ? "Suggestions added. Review them in the form, or use Chat to refine your draft." : "Generate a first draft in Chat, then review and accept the fields here."}</p>}
      {pendingFields.length > 0 && <section className="ai-suggestions" aria-label="Suggested fields"><div className="ai-suggestions-heading"><h3>{pendingFields.length} suggested {pendingFields.length === 1 ? 'field' : 'fields'}</h3><div><button type="button" disabled={assistant.busy} onClick={() => assistant.accept(pendingFields.map(field => field.key))}>Accept all</button><button type="button" disabled={assistant.busy} onClick={assistant.discard}>Discard all</button></div></div>{pendingFields.map(field => <Suggestion key={field.key} field={field} assistant={assistant} />)}</section>}
      {assistant.tags.length > 0 && <div className="ai-tag-suggestions"><h3>Suggested discovery tags</h3><div className="tag-list">{assistant.tags.map(tag => <span className="tag-chip static" key={tag}>{tag}</span>)}</div><small>Tags follow the platform taxonomy. Posting tags come from your selected technology areas.</small></div>}
      </section>
      {["proposal", "independent"].includes(assistant.kind) && <section role="tabpanel" id={`${titleId}-related-panel`} aria-labelledby={`${titleId}-related`} hidden={tab !== "related"}><SimilarProposals result={assistant.similar} /></section>}
      {assistant.usage && <p className="ai-panel-usage">{assistant.usage.remainingToday} AI requests left today · Generating and regenerating each use one request.</p>}
    </div>
  </>;
  return mobile ? <Modal className="ai-draft-mobile" labelledBy={titleId} onDismiss={() => assistant.setOpen(false)}>{contents}</Modal>
    : <aside className="ai-draft-panel" aria-label="AI drafting panel">{contents}</aside>;
}
