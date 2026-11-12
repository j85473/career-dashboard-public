import { isGeneralRemoteOption, isUnknownOrBroadUSOption, splitLocationOptions } from './jobLocationPolicy';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';

// The shared pattern lists the state codes and full names in the same order.
const stateParts = US_STATE_LOCATION_PATTERN.slice(3, -1).split('|');
const codes = stateParts.filter(name => name.length === 2);
const names = stateParts.filter(name => name.length > 2);
const codePattern = new RegExp(`\\b(?:${codes.join('|')})\\b`, 'g');
const namePattern = new RegExp(`\\b(?:${[...names].sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');
const nameCodes = new Map(names.map((name, index) => [name.toLowerCase(), codes[index]]));
function states(value: string): Set<string> {
  const found = new Set([...value.matchAll(codePattern)].map(match => match[0]));
  for (const match of value.matchAll(namePattern)) found.add(nameCodes.get(match[0].toLowerCase())!);
  return found;
}

/** A labeled work location can narrow a generic feed label. Coverage prose cannot. */
export function descriptionWorkLocation(location: string | null | undefined, description: string): string | undefined {
  const options = splitLocationOptions(location || 'Unknown Location');
  const generic = (option: string) => isGeneralRemoteOption(option) || isUnknownOrBroadUSOption(option);
  if (!options.length || !options.some(generic)) return undefined;
  const candidates = new Map<string, string>();
  for (const line of description.split(/\r?\n/)) {
    const value = /^\s*(?:#{1,6}\s*|[-*•]\s*)?(?:(?:job|work|position)\s+)?location\s*:\s*(.{2,180}?)\s*$/i.exec(line.replace(/\*\*/g, ''))?.[1];
    if (!value || /https?:\/\/|[<>]/i.test(value) || !/[a-z]/i.test(value)) continue;
    // Sentence-style location explanations are not a bounded location field.
    if (/\b(?:customers?|accounts?|coverage|covers?|territor(?:y|ies)|headquarters|offices? in|may|can|anywhere|nationwide|preferred|optional|including)\b/i.test(value)) continue;
    if (!states(value).size) continue;
    candidates.set(value.toLowerCase(), value);
  }
  if (candidates.size !== 1) return undefined;
  const candidate = [...candidates.values()][0];
  const requiredStates = states(candidate);
  const concrete = options.filter(option => !generic(option));
  // A multi-location posting can legitimately include a nationwide option.
  // Narrow it only when every concrete location corroborates the same states.
  if (concrete.some(option => {
    const listed = states(option);
    return !listed.size || [...listed].some(state => !requiredStates.has(state));
  })) return undefined;
  const scoped = options.some(isGeneralRemoteOption) && !/\b(?:remote|hybrid|onsite|on-site)\b/i.test(candidate)
    ? `${candidate} (Remote)` : candidate;
  return [...new Set([...concrete, scoped])].join('; ');
}
