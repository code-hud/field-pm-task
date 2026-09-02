import { direction } from '../lib/format.js';

const GLYPH = { 1: '▲', '-1': '▼', 0: '■' };
const CLASS = { 1: 'delta--up', '-1': 'delta--down', 0: 'delta--flat' };
const WORD = { 1: 'up', '-1': 'down', 0: 'unchanged' };

/**
 * A signed change. Direction is carried three ways — the sign in the text, the
 * glyph, and the color — so it never depends on color alone.
 */
export function Delta({ value, children, className = '' }) {
  const sign = direction(value ?? 0);
  return (
    <span className={`delta ${CLASS[sign]} ${className}`.trim()}>
      <span className="delta__glyph" aria-hidden="true">
        {GLYPH[sign]}
      </span>
      <span className="visually-hidden">{WORD[sign]} </span>
      <span>{children}</span>
    </span>
  );
}
