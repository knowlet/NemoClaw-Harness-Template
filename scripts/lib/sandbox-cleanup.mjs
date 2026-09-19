/** UNOFFICIAL: classify a sandbox destroy result for the quickstart runner. */

// Only phrasings that describe the sandbox itself count. A bare "not found" is
// deliberately excluded: "gateway not found" or "provider not found" says
// nothing about whether the sandbox still exists. An unrecognised phrasing fails
// closed, so the run reports a cleanup failure and prints the real message
// instead of claiming success.
const ABSENCE_PHRASES = [
  String.raw`(?:does not|doesn\u0027t|no longer)\s+exist`,
  String.raw`is not present`,
  String.raw`is no longer present`,
  String.raw`is (?:already )?absent`,
  String.raw`was already absent`,
].join('|');

// A line that also reports a failure is describing a failed deletion, whatever
// else it says about the sandbox, so it can never confirm absence.
const FAILURE_MARKER = /fail|denied|error|cannot|unable|refus/i;

const QUOTED_NAME = '[\u0022\u0027]?'; // " or ' around the sandbox name

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True only when the output says, about this sandbox, that it is not there.
 * The phrase and the name must be adjacent on one line, and that line must not
 * report a failure, so neither an unrelated missing dependency nor a failed
 * deletion can be mistaken for a missing sandbox.
 */
export function confirmsSandboxAbsent(text, sandbox) {
  if (typeof text !== 'string' || typeof sandbox !== 'string' || sandbox === '') return false;
  const pattern = new RegExp(
    '\\bsandbox\\s+' + QUOTED_NAME + escapeForRegExp(sandbox) + QUOTED_NAME + '\\s+(?:' + ABSENCE_PHRASES + ')\\b',
    'i',
  );
  return text
    .split(/\r?\n/)
    .some((entry) => pattern.test(entry) && !FAILURE_MARKER.test(entry));
}

/** A zero exit is success. A nonzero exit is success only for a confirmed absence. */
export function classifyDestroyResult({ code, stdout = '', stderr = '', sandbox } = {}) {
  const text = (String(stdout) + String.fromCharCode(10) + String(stderr)).trim();
  if (code === 0) return { ok: true, absent: false, detail: null, text };
  if (confirmsSandboxAbsent(text, sandbox)) return { ok: true, absent: true, detail: null, text };
  const detail = text.split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  return { ok: false, absent: false, detail: detail || ('exit ' + String(code)), text };
}
