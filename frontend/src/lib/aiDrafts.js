import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase.js';
import { validateDraftOutput } from '../../../firebase/functions/aiDraftSchema.js';

async function call(name, data) {
  if (!functions) throw new Error('AI assistance is unavailable. You can continue writing your form.');
  return (await httpsCallable(functions, name, { timeout: 35000 })(data)).data;
}
export async function generateAIDraft(data) {
  const result = await call('draftWithAI', data);
  if (!result || !result.suggestions || Object.keys(result.suggestions).some(key => !data.requestedFields.includes(key))) throw new Error('Invalid AI response');
  const validated = validateDraftOutput({ message: result.message, suggestions: Object.fromEntries(data.requestedFields.map(key => [key, result.suggestions?.[key] ?? null])), suggestedTags: result.suggestedTags }, data.kind, data.requestedFields);
  return { ...result, ...validated };
}
export const findSimilarProposals = data => call('findSimilarProposals', data);
export function aiErrorMessage(error) {
  const code = String(error?.code || '').replace('functions/', '');
  if (code === 'resource-exhausted') return error.message || 'AI assistance has reached its limit. Please try again later.';
  if (code === 'unauthenticated') return 'Sign in again to use AI assistance. Your form is unchanged.';
  if (code === 'permission-denied') return 'AI assistance is unavailable for this form. Your text is unchanged.';
  if (code === 'deadline-exceeded') return 'The assistant took too long. Your form is unchanged; you can try again.';
  if (code === 'invalid-argument') return error.message || 'Check the title and shorten the conversation before trying again.';
  return 'AI assistance is unavailable right now. Your text is safe; continue writing or try again later.';
}
